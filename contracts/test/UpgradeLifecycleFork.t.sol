// SPDX-License-Identifier: MIT
// Canonical: docs/technical/contract-upgradeability-plan.md — Delivery step 3 (fork tests for v1 -> v2 state preservation)
// (See also: docs/adr/ADR-0011-governed-uups-upgrades-and-freeze.md; issue 1808)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {GovernedUUPS, GovernedUpgrade} from "../lib/GovernedUUPS.sol";
import {DeployVault} from "../script/DeployVault.s.sol";
import {DeployVaultRegistry} from "../script/DeployVaultRegistry.s.sol";
import {DeployPortfolioRouter} from "../script/DeployPortfolioRouter.s.sol";
import {DeployGateway} from "../script/DeployGateway.s.sol";
import {DeployInvestmentCommitteePolicy} from "../script/DeployInvestmentCommitteePolicy.s.sol";
import {DeployRouterGovernance} from "../script/DeployRouterGovernance.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployAgentTokenVault} from "../script/DeployAgentTokenVault.s.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {
    IConsensusRecommendationReceipt
} from "../gateway/interfaces/IConsensusRecommendationReceipt.sol";

import {ForkSelect} from "./helpers/ForkSelect.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";
import {VaultTestParams} from "./helpers/VaultTestParams.sol";
import {ISafe, ISafeProxyFactory, _ISafeSetup} from "./SafeIntegration.t.sol";
import {
    RobotMoneyVaultV2,
    ProtocolAssetVaultV2,
    AgentTokenVaultV2,
    RwaBasketVaultV2,
    VaultRegistryV2,
    PortfolioRouterV2,
    RobotMoneyGatewayV2,
    InvestmentCommitteePolicyV2,
    ConsensusRecommendationReceiptV2,
    RouterGovernanceV2,
    UPGRADE_V2_MARKER
} from "./helpers/UpgradeV2.sol";

interface IMarker {
    function upgradeMarker() external view returns (uint256);
}

/// @notice Issue 1808, on the Twin chain (a pinned lazy fork of real Base). The production stage
///         scripts deploy the whole core stack as proxies (rmUSDC on the real Aave V3, Compound V3
///         and Moonwell venues, rmPROTO / rmAGENT / rmRWA on the real Uniswap pools), the stack is
///         populated (shares, allowances, adapter positions, basket holdings, a gateway policy, an IC
///         agent, a receipt, router weights and caps), the timelock stage hands it to a real
///         canonical SafeL2 2-of-3 and the CREATE2 timelock, and then every proxy is upgraded v1 ->
///         v2 through Safe -> timelock. Every value is read back and the synchronous redemptions
///         still pay. A second test freezes through the same path and proves a queued upgrade fails.
///
///         CI runs it in forge-fork-vault-regressions through scripts/devnet/forge-fork-tests.ts,
///         which fails a run in which nothing executed. With FORK_RPC_URL unset it skips by name.
contract UpgradeLifecycleForkTest is Test {
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant SWAP_ROUTER_02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_SINGLETON_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    uint256 internal constant DELAY = 2 days;

    bool internal selected;

    DeployTimelock internal timelockScript;
    address internal deployer;
    ISafe internal safe;
    uint256[3] internal ownerPks;
    TimelockController internal timelock;

    address internal pauser = makeAddr("fork-pauser");
    address internal agent = makeAddr("fork-agent");
    address internal shareReceiver = makeAddr("fork-share-receiver");
    address internal holder = makeAddr("fork-holder");
    address internal spender = makeAddr("fork-spender");
    address internal submitter = makeAddr("fork-submitter");
    address internal emergency = makeAddr("fork-emergency");

    RobotMoneyVault internal vault;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RobotMoneyGateway internal gateway;
    InvestmentCommitteePolicy internal ic;
    ConsensusRecommendationReceipt internal receipts;
    RouterGovernance internal governance;
    BasketVault internal proto;
    BasketVault internal agentVault;
    BasketVault internal rwa;

    function setUp() public {
        selected = ForkSelect.selectOrSkip(vm.envOr("FORK_RPC_URL", string("")));
        if (!selected) return;
        timelockScript = new DeployTimelock();
        // The deployer is the timelock script's own address: in process the script's calls come
        // from it, so it must be the account that holds every role before the handover.
        deployer = address(timelockScript);
        safe = _createSafe();
        address predicted = timelockScript.predictTimelock(address(safe), DELAY);
        _deployStack(predicted);
        _populate();
        vm.prank(deployer);
        timelock =
        timelockScript.runInProcessVaults(
            _vaults(),
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            address(safe),
            emergency,
            DELAY,
            DeployTimelock.SafeSpec({owners: _owners(), threshold: 2})
        )
        .timelock;
        assertEq(address(timelock), predicted, "the timelock sits where every proxy pointed");
    }

    // ─── Stack ─────────────────────────────────────────────────────────────────

    function _deployStack(address upgradeTimelock) internal {
        GovernedUUPS.UpgradeMode mode = GovernedUUPS.UpgradeMode.Upgradeable;
        DeployVault vs = new DeployVault();
        vs.setUpgradeConfig(upgradeTimelock, mode);
        deal(USDC, deployer, VaultTestParams.SEED_DEPOSIT_AMOUNT);
        vault =
        vs.runInProcessWithSeed(
            VaultTestParams.params(deployer, USDC),
            makeAddr("fork-seed-receiver"),
            VaultTestParams.SEED_DEPOSIT_AMOUNT
        )
        .vault;

        DeployVaultRegistry rs = new DeployVaultRegistry();
        rs.setUpgradeConfig(upgradeTimelock, mode);
        registry = rs.runInProcessWith(deployer, address(vault), USDC, "Robot Money USDC").registry;

        DeployPortfolioRouter ps = new DeployPortfolioRouter();
        ps.setUpgradeConfig(upgradeTimelock, mode);
        router = ps.runInProcessWith(deployer, address(registry), address(vault), USDC).router;

        DeployGateway gs = new DeployGateway();
        gs.setUpgradeConfig(upgradeTimelock, mode);
        gateway =
        gs.runInProcessWith(deployer, pauser, shareReceiver, USDC, address(vault), address(router))
        .gateway;

        DeployInvestmentCommitteePolicy is_ = new DeployInvestmentCommitteePolicy();
        is_.setUpgradeConfig(upgradeTimelock, mode);
        DeployInvestmentCommitteePolicy.Deployed memory icd =
            is_.runInProcessWith(deployer, address(gateway));
        ic = icd.policy;
        receipts = icd.receipts;

        DeployRouterGovernance gv = new DeployRouterGovernance();
        gv.setUpgradeConfig(upgradeTimelock, mode);
        governance = gv.runInProcessWith(deployer, address(router), address(receipts)).governance;

        DeployProtocolAssetVault pv = new DeployProtocolAssetVault();
        pv.setUpgradeConfig(upgradeTimelock, mode);
        proto = BasketVault(
            pv.runInProcess(_basketParams(), vm.readFile("config/protocol-assets.json")).vault
        );
        DeployAgentTokenVault av = new DeployAgentTokenVault();
        av.setUpgradeConfig(upgradeTimelock, mode);
        agentVault = BasketVault(av.runInProcess(_basketParams(), _agentCfg()).vault);
        DeployRwaBasketVault wv = new DeployRwaBasketVault();
        wv.setUpgradeConfig(upgradeTimelock, mode);
        rwa = BasketVault(
            wv.runInProcess(_basketParams(), vm.readFile("config/rwa-assets.json")).vault
        );
    }

    function _basketParams() internal returns (BasketVaultDeployBase.Params memory) {
        return BasketVaultDeployBase.Params({
            admin: deployer,
            swapRouter: SWAP_ROUTER_02,
            usdc: USDC,
            registry: address(registry),
            tvlCap: 100_000 * 1e6,
            perDepositCap: 10_000 * 1e6,
            exitFeeBps: 0,
            feeRecipient: makeAddr("fork-fee-recipient"),
            navDeviationGuardBps: 2000,
            minPoolLiquidity: 1e6,
            recorder: address(0)
        });
    }

    /// @dev rmAGENT's launch asset (RM on Uniswap V4) needs the recorder's history; the upgrade
    ///      path is the same base contract for any asset list, so this run gives the agent script
    ///      the real V3 wETH pool (as FourVaultInitialState.t.sol does).
    function _agentCfg() internal pure returns (string memory) {
        return string.concat(
            '{"swapRouter02":"0x2626664c2603336E57B271c5C0b26F421741e481","shortlist":[',
            '{"symbol":"wETH","token":"0x4200000000000000000000000000000000000006",',
            '"venue":"UniswapV3","pool":"0xd0b53D9277642d899DF5C87A3966A349A798F224","poolFee":500}]}'
        );
    }

    function _vaults() internal view returns (address[] memory v) {
        v = new address[](4);
        v[0] = address(vault);
        v[1] = address(proto);
        v[2] = address(agentVault);
        v[3] = address(rwa);
    }

    function _proxies() internal view returns (address[10] memory) {
        return [
            address(vault),
            address(proto),
            address(agentVault),
            address(rwa),
            address(registry),
            address(router),
            address(gateway),
            address(ic),
            address(receipts),
            address(governance)
        ];
    }

    function _v2(uint256 i) internal returns (address) {
        if (i == 0) return address(new RobotMoneyVaultV2());
        if (i == 1) return address(new ProtocolAssetVaultV2());
        if (i == 2) return address(new AgentTokenVaultV2());
        if (i == 3) return address(new RwaBasketVaultV2());
        if (i == 4) return address(new VaultRegistryV2());
        if (i == 5) return address(new PortfolioRouterV2());
        if (i == 6) return address(new RobotMoneyGatewayV2());
        if (i == 7) return address(new InvestmentCommitteePolicyV2());
        if (i == 8) return address(new ConsensusRecommendationReceiptV2());
        return address(new RouterGovernanceV2());
    }

    // ─── State ─────────────────────────────────────────────────────────────────

    function _populate() internal {
        vm.startPrank(deployer);
        vault.unpauseDeposits();
        proto.unpauseDeposits();
        router.setRouterCap(50_000e6);
        address[] memory none = new address[](0);
        gateway.authorizeAgent(
            agent,
            IGateway.AgentPolicy({
                active: true,
                validUntil: uint64(block.timestamp + 365 days),
                maxPerPayment: 10_000e6,
                maxPerWindow: 100_000e6,
                shareReceiver: shareReceiver,
                allowedDestinations: none,
                assetRecipient: shareReceiver,
                maxWithdrawPerPayment: 0,
                maxWithdrawPerWindow: 0,
                allowedSourceVaults: none
            })
        );
        ic.registerAgent(submitter, "fork-submitter");
        vm.stopPrank();

        // rmUSDC through the gateway: real Aave / Compound / Moonwell positions.
        deal(USDC, agent, 1_000e6);
        vm.startPrank(agent);
        IERC20(USDC).approve(address(gateway), 1_000e6);
        gateway.deposit(
            bytes32("fork-order"), 1_000e6, uint64(block.timestamp + 300), bytes32("fork-idem")
        );
        vm.stopPrank();
        vm.prank(shareReceiver);
        vault.approve(spender, 4242);

        // rmPROTO directly: real wETH / cbBTC holdings through Uniswap V3.
        deal(USDC, holder, 500e6);
        vm.startPrank(holder);
        IERC20(USDC).approve(address(proto), 500e6);
        proto.deposit(500e6, holder);
        vm.stopPrank();

        // A receipt on the register (recorded the way the gateway forwards it).
        vm.prank(address(gateway));
        receipts.recordReceipt(
            submitter, keccak256("fork-receipt"), keccak256("fork-bytes"), "https://x.invalid/fork"
        );
    }

    struct Snapshot {
        uint256 vaultShares;
        uint256 vaultSupply;
        uint256 vaultAssets;
        uint256 allowance;
        uint256[] adapterBalances;
        uint256 protoShares;
        uint256 protoAssets;
        uint256[] protoHoldings;
        uint256 tvlCap;
        uint256 perDepositCap;
        uint256 exitFeeBps;
        uint256 protoMaxSlippage;
        uint256 protoNavGuard;
        uint256 routerCap;
        address[] defaultVaults;
        uint256[] defaultBps;
        bytes32 policyHash;
        uint256 receiptCount;
    }

    function _snapshot() internal view returns (Snapshot memory s) {
        s.vaultShares = vault.balanceOf(shareReceiver);
        s.vaultSupply = vault.totalSupply();
        s.vaultAssets = vault.totalAssets();
        s.allowance = vault.allowance(shareReceiver, spender);
        uint256 n = vault.adapterCount();
        s.adapterBalances = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            (,,, uint256 bal,) = vault.getAdapterInfo(i);
            s.adapterBalances[i] = bal;
        }
        s.protoShares = proto.balanceOf(holder);
        s.protoAssets = proto.totalAssets();
        uint256 m = proto.assetCount();
        s.protoHoldings = new uint256[](m);
        for (uint256 i = 0; i < m; i++) {
            (address token,,,,,) = proto.assets(i);
            s.protoHoldings[i] = IERC20(token).balanceOf(address(proto));
        }
        s.tvlCap = vault.tvlCap();
        s.perDepositCap = vault.perDepositCap();
        s.exitFeeBps = vault.exitFeeBps();
        s.protoMaxSlippage = proto.maxSlippageBps();
        s.protoNavGuard = proto.navDeviationGuardBps();
        s.routerCap = router.routerCap();
        (s.defaultVaults, s.defaultBps) = router.getDefaultWeights();
        (
            bool active,
            uint64 validUntil,
            uint256 perPayment,
            uint256 perWindow,
            address receiver,,,
        ) = gateway.agents(agent);
        s.policyHash = keccak256(
            abi.encode(
                active, validUntil, perPayment, perWindow, receiver, gateway.agentOwner(agent)
            )
        );
        s.receiptCount = receipts.receiptCount();
    }

    function _assertSame(Snapshot memory a, Snapshot memory b) internal pure {
        assertEq(b.vaultShares, a.vaultShares, "rmUSDC shares");
        assertEq(b.vaultSupply, a.vaultSupply, "rmUSDC supply");
        assertEq(b.vaultAssets, a.vaultAssets, "rmUSDC NAV");
        assertEq(b.allowance, a.allowance, "rmUSDC allowance");
        assertEq(b.adapterBalances.length, a.adapterBalances.length, "adapter count");
        for (uint256 i = 0; i < a.adapterBalances.length; i++) {
            assertEq(b.adapterBalances[i], a.adapterBalances[i], "adapter position");
        }
        assertEq(b.protoShares, a.protoShares, "rmPROTO shares");
        assertEq(b.protoAssets, a.protoAssets, "rmPROTO NAV");
        for (uint256 i = 0; i < a.protoHoldings.length; i++) {
            assertEq(b.protoHoldings[i], a.protoHoldings[i], "rmPROTO holding");
        }
        assertEq(b.tvlCap, a.tvlCap, "tvl cap");
        assertEq(b.perDepositCap, a.perDepositCap, "per-deposit cap");
        assertEq(b.exitFeeBps, a.exitFeeBps, "exit fee");
        assertEq(b.protoMaxSlippage, a.protoMaxSlippage, "rmPROTO slippage bound");
        assertEq(b.protoNavGuard, a.protoNavGuard, "rmPROTO NAV guard");
        assertEq(b.routerCap, a.routerCap, "router cap");
        assertEq(
            keccak256(abi.encode(b.defaultVaults, b.defaultBps)),
            keccak256(abi.encode(a.defaultVaults, a.defaultBps)),
            "router weights"
        );
        assertEq(b.policyHash, a.policyHash, "gateway policy");
        assertEq(b.receiptCount, a.receiptCount, "receipts");
    }

    function _assertRoles() internal view {
        bytes32 adminRole = keccak256("ADMIN_ROLE");
        address[4] memory vs = [address(vault), address(proto), address(agentVault), address(rwa)];
        for (uint256 i = 0; i < vs.length; i++) {
            assertTrue(
                IAccessControl(vs[i]).hasRole(adminRole, address(timelock)),
                "vault admin is the timelock"
            );
            assertTrue(
                IAccessControl(vs[i]).hasRole(keccak256("EMERGENCY_ROLE"), emergency),
                "vault emergency key"
            );
            assertFalse(
                IAccessControl(vs[i]).hasRole(adminRole, deployer), "deployer holds no vault admin"
            );
        }
        assertTrue(registry.hasRole(adminRole, address(timelock)), "registry admin");
        assertTrue(router.hasRole(adminRole, address(governance)), "governance reaches the router");
        assertTrue(
            router.hasRole(router.WEIGHT_SETTER_ROLE(), address(governance)), "weight setter"
        );
        assertTrue(gateway.hasRole(gateway.AGENT_ROLE(), agent), "gateway agent");
        assertTrue(ic.hasRole(ic.COMMITTEE_AGENT_ROLE(), submitter), "committee agent");
        IConsensusRecommendationReceipt.Receipt memory r =
            receipts.getReceiptById(keccak256("fork-receipt"));
        assertEq(r.payloadDigest, keccak256("fork-bytes"), "receipt digest");
    }

    // ─── The tests ─────────────────────────────────────────────────────────────

    /// @notice Every proxy goes v1 -> v2 in one Safe-scheduled timelock batch; all state survives
    ///         and both synchronous redemptions pay.
    function test_fork_upgradeEveryProxy_throughSafeAndTimelock_keepsState() public {
        if (!selected) return;
        address[10] memory p = _proxies();
        address[] memory targets = new address[](10);
        uint256[] memory values = new uint256[](10);
        bytes[] memory payloads = new bytes[](10);
        address[10] memory v2s;
        for (uint256 i = 0; i < 10; i++) {
            v2s[i] = _v2(i);
            targets[i] = p[i];
            payloads[i] = abi.encodeCall(GovernedUUPS.upgradeToAndCall, (v2s[i], ""));
        }
        _safeExec(
            address(timelock),
            abi.encodeCall(
                timelock.scheduleBatch,
                (targets, values, payloads, bytes32(0), bytes32("v2"), DELAY)
            )
        );
        vm.warp(block.timestamp + DELAY);
        // Read every value in the block that executes the upgrade: the venues accrue with time.
        Snapshot memory before = _snapshot();
        _safeExec(
            address(timelock),
            abi.encodeCall(
                timelock.executeBatch, (targets, values, payloads, bytes32(0), bytes32("v2"))
            )
        );

        for (uint256 i = 0; i < 10; i++) {
            assertEq(CoreProxies.implementationOf(p[i]), v2s[i], "implementation slot");
            assertEq(IMarker(p[i]).upgradeMarker(), UPGRADE_V2_MARKER, "runs v2");
            assertEq(GovernedUUPS(p[i]).upgradeTimelock(), address(timelock), "authority kept");
            assertFalse(GovernedUUPS(p[i]).upgradesFrozen(), "not frozen");
        }
        _assertSame(before, _snapshot());
        _assertRoles();

        // Synchronous redemptions: rmUSDC through the real venues, rmPROTO through the real pools.
        uint256 shares = vault.balanceOf(shareReceiver);
        uint256 got = IERC20(USDC).balanceOf(shareReceiver);
        vm.prank(shareReceiver);
        vault.redeem(shares, shareReceiver, shareReceiver);
        assertGe(
            IERC20(USDC).balanceOf(shareReceiver) - got,
            (1_000e6 * 9_999) / 10_000,
            "rmUSDC redeem pays"
        );
        uint256 protoShares = proto.balanceOf(holder);
        vm.prank(holder);
        uint256 out = proto.redeem(protoShares, holder, holder);
        assertGt(out, 0, "rmPROTO redeem pays");
    }

    /// @notice The delayed freeze through Safe -> timelock on the deployed stack: a queued upgrade
    ///         fails after it, nobody can clear it, and withdrawals keep working.
    function test_fork_freezeThroughSafeAndTimelock_blocksAQueuedUpgrade() public {
        if (!selected) return;
        address impl = CoreProxies.implementationOf(address(vault));
        bytes memory upgrade =
            abi.encodeCall(GovernedUUPS.upgradeToAndCall, (address(new RobotMoneyVaultV2()), ""));
        bytes memory freeze = abi.encodeCall(GovernedUUPS.freezeUpgrades, (impl, impl.codehash));
        _safeExec(
            address(timelock),
            abi.encodeCall(
                timelock.schedule, (address(vault), 0, upgrade, bytes32(0), bytes32("up"), DELAY)
            )
        );
        _safeExec(
            address(timelock),
            abi.encodeCall(
                timelock.schedule, (address(vault), 0, freeze, bytes32(0), bytes32("fz"), DELAY)
            )
        );
        vm.warp(block.timestamp + DELAY);
        _safeExec(
            address(timelock),
            abi.encodeCall(timelock.execute, (address(vault), 0, freeze, bytes32(0), bytes32("fz")))
        );
        assertTrue(vault.upgradesFrozen(), "frozen");
        vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
        timelock.execute(address(vault), 0, upgrade, bytes32(0), bytes32("up"));
        assertEq(CoreProxies.implementationOf(address(vault)), impl, "implementation unchanged");

        uint256 shares = vault.balanceOf(shareReceiver);
        vm.prank(shareReceiver);
        vault.redeem(shares, shareReceiver, shareReceiver);
        assertEq(vault.balanceOf(shareReceiver), 0, "withdrawals are not frozen");
    }

    // ─── The canonical Safe ────────────────────────────────────────────────────

    function _createSafe() internal returns (ISafe created) {
        ownerPks[0] = uint256(keccak256("upgrade-safe-owner-1"));
        ownerPks[1] = uint256(keccak256("upgrade-safe-owner-2"));
        ownerPks[2] = uint256(keccak256("upgrade-safe-owner-3"));
        bytes memory setup = abi.encodeCall(
            _ISafeSetup.setup,
            (
                _owners(),
                2,
                address(0),
                "",
                SAFE_FALLBACK_HANDLER,
                address(0),
                0,
                payable(address(0))
            )
        );
        created = ISafe(
            ISafeProxyFactory(SAFE_PROXY_FACTORY)
                .createProxyWithNonce(SAFE_SINGLETON_L2, setup, uint256(keccak256("upgrade-safe")))
        );
    }

    function _owners() internal view returns (address[] memory owners) {
        owners = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            owners[i] = vm.addr(ownerPks[i]);
        }
    }

    function _sortedOwnerPks() internal view returns (uint256[3] memory pks) {
        pks = ownerPks;
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (vm.addr(pks[j]) < vm.addr(pks[i])) (pks[i], pks[j]) = (pks[j], pks[i]);
            }
        }
    }

    function _sign(uint256 pk, bytes32 txHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, txHash);
        return abi.encodePacked(r, s_, v);
    }

    /// @dev execTransaction with the two lowest-address owners' signatures; the inner call must succeed.
    function _safeExec(address to, bytes memory data) internal {
        bytes32 txHash = safe.getTransactionHash(
            to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), safe.nonce()
        );
        uint256[3] memory pks = _sortedOwnerPks();
        bytes memory sigs = bytes.concat(_sign(pks[0], txHash), _sign(pks[1], txHash));
        assertTrue(
            safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs),
            "safe.execTransaction"
        );
    }
}
