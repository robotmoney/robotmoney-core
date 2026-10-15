// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md — withdrawals are never blocked
// Canonical: docs/technical/security-model.md §4 — EMERGENCY pauses deposits, ADMIN (timelock) resumes
// Canonical: docs/technical/governance-isomorphism.md — the Safe is a real 2-of-3 SafeProxy on SafeL2
// Implements: core 1494 — owner decision 2026-10-05: "We do not ever freeze withdrawals."
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {NoYieldTestAdapter} from "./helpers/NoYieldTestAdapter.sol";
import {MockPool, MockSwapRouter} from "./BasketVault.t.sol";
import {ISafe, ISafeProxyFactory, _ISafeSetup} from "./SafeIntegration.t.sol";
import {BasketAssetConfigGuard} from "../lib/BasketAssetConfigGuard.sol";
import {Proxied} from "./helpers/Proxied.sol";
import {GovernedUpgrade} from "../lib/GovernedUpgrade.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {IInvestmentCommitteePolicy} from "../gateway/interfaces/IInvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";

/// @title WithdrawalsNeverFrozenTest
/// @notice Withdrawals are never frozen, by anyone. Every shipped vault (rmUSDC, the
///         rmPROTO, rmAGENT, rmRWA), the gateway and the router are built
///         and handed over the way we ship them: `DeployTimelock` moves ADMIN_ROLE to a
///         TimelockController at the 172800 s Base delay whose proposer and executor is a
///         real 2-of-3 Safe, and EMERGENCY_ROLE to the emergency key. Every emergency
///         lever, the gateway deposit pauser and the governance status levers are pulled,
///         then holders with shares and sufficient liquidity exit in full. Deposits revert
///         with `DepositsArePaused` while paused, and `unpauseDeposits` runs only through
///         the Safe and the timelock at the real delay.
/// @dev    Fork test. The Safe is a SafeProxy from the canonical SafeProxyFactory on the
///         canonical SafeL2 singleton, driven by `execTransaction` with two owner
///         signatures. Those contracts exist only on a Base fork, so CI runs this file
///         through scripts/devnet/run-golden-forge-forks.sh against the golden fixture,
///         like SafeIntegration.t.sol. No stub Safe and no pranked Safe.
contract WithdrawalsNeverFrozenTest is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant AMOUNT = 1_000 * ONE_USDC;
    /// @dev Swap proceeds for selling a 1:1 basket position worth `AMOUNT`: above the
    ///      1% TWAP floor of the V3 baskets.
    uint256 internal constant SWAP_OUT = 995 * ONE_USDC;
    /// @dev The Base mainnet timelock delay (security-model.md §4).
    uint256 internal constant MIN_DELAY = 172_800;

    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_SINGLETON_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    TestERC20 internal usdc;
    TestERC20 internal basketToken;
    MockSwapRouter internal swapRouter;
    MockPool internal pool;

    RobotMoneyVault internal rmUsdc;
    ProtocolAssetVault internal rmProto;
    AgentTokenVault internal rmAgent;
    RwaBasketVault internal rmRwa;
    RobotMoneyGateway internal gateway;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    TimelockController internal timelock;
    /// @dev ADR-0014: the timelock `DeployTimelock.runAuthority` deploys before every proxy.
    address internal authority;

    ISafe internal safe;
    uint256[3] internal ownerPks;
    uint256 internal saltNonce;

    address internal emergency = makeAddr("emergency");
    address internal pauser = makeAddr("pauser");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.createSelectFork(vm.envOr("FORK_RPC_URL", string("http://127.0.0.1:8545")));

        DeployTimelock script = new DeployTimelock();
        address deployer = address(script);
        safe = _createSafe();
        assertEq(safe.getThreshold(), 2, "safe threshold must be 2");
        assertEq(safe.getOwners().length, 3, "safe must have 3 owners");

        usdc = new TestERC20();
        basketToken = new TestERC20();
        swapRouter = new MockSwapRouter();
        pool = new MockPool(address(basketToken), address(usdc), uint160(1 << 96));

        // ADR-0014 §4: the timelock is deployed first, and every proxy names it as its upgrade
        // authority. The handover below reuses it (`useExistingTimelock`, the in-process form of
        // TIMELOCK_ADDRESS) and checks every proxy names it.
        DeployTimelock.SafeSpec memory spec =
            DeployTimelock.SafeSpec({owners: safe.getOwners(), threshold: 2});
        vm.prank(deployer);
        authority = address(script.runInProcessAuthority(address(safe), MIN_DELAY, spec));
        script.useExistingTimelock(authority);

        registry = Proxied.vaultRegistryAs(authority, deployer);
        router = Proxied.portfolioRouterAs(authority, address(usdc), address(registry), deployer);
        RouterGovernance governance = new RouterGovernance(address(router), deployer);

        vm.startPrank(deployer);
        router.grantRole(ADMIN_ROLE, address(governance));
        router.grantRole(router.WEIGHT_SETTER_ROLE(), address(governance));
        rmUsdc = Proxied.robotMoneyVaultAs(
            authority,
            usdc,
            type(uint256).max,
            type(uint256).max,
            0,
            makeAddr("feeRecipient"),
            deployer,
            deployer
        );
        NoYieldTestAdapter noYield = new NoYieldTestAdapter(address(usdc), address(rmUsdc));
        rmUsdc.setAdapterAllowed(address(noYield), true);
        rmUsdc.setAdapterCodeHashAllowed(address(noYield).codehash, true);
        rmUsdc.addAdapter(address(noYield), 10_000);
        gateway =
            Proxied.robotMoneyGatewayAs(authority, usdc, rmUsdc, deployer, pauser, address(router));
        _buildOtherVaults(deployer);
        vm.stopPrank();

        // The production handover: ADMIN_ROLE on all four vaults and the gateway,
        // registry, router and governance to the timelock, EMERGENCY_ROLE to the
        // emergency key, the deployer keeps nothing.
        address[] memory vaults = new address[](4);
        vaults[0] = address(rmUsdc);
        vaults[1] = address(rmProto);
        vaults[2] = address(rmAgent);
        vaults[3] = address(rmRwa);
        vm.prank(deployer);
        DeployTimelock.Deployed memory d = script.runInProcessVaults(
            vaults,
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            address(safe),
            emergency,
            MIN_DELAY,
            spec
        );
        timelock = d.timelock;
        assertEq(address(timelock), authority, "the handover reused the upgrade authority");
        address[3] memory others = _others();
        for (uint256 i = 0; i < others.length; i++) {
            assertTrue(IAccessControl(others[i]).hasRole(ADMIN_ROLE, address(timelock)), "admin");
            assertFalse(IAccessControl(others[i]).hasRole(ADMIN_ROLE, deployer), "deployer admin");
        }

        // Register every vault through the Safe and the timelock.
        bytes[] memory calls = new bytes[](4);
        address[4] memory all = [address(rmUsdc), others[0], others[1], others[2]];
        for (uint256 i = 0; i < 4; i++) {
            calls[i] = abi.encodeCall(
                VaultRegistry.registerVault,
                (
                    all[i],
                    VaultRegistry.VaultMetadata({
                        name: "vault", asset: address(usdc), registeredAt: block.timestamp
                    })
                )
            );
        }
        _govern(address(registry), calls);
    }

    // ─── rmUSDC (RobotMoneyVault) ─────────────────────────────────────────────

    /// @notice Every lever with funds still in the adapter: emergency pauseDeposits and
    ///         shutdown, gateway pauseDeposits, governance DepositsPaused then Retired.
    ///         Redeem and withdraw still pay in full.
    function test_rmUSDC_noLeverFreezesExit_fundsInAdapter() public {
        uint256 aliceShares = _depositDirect(address(rmUsdc), alice, AMOUNT);
        _depositDirect(address(rmUsdc), bob, AMOUNT);

        vm.startPrank(emergency);
        rmUsdc.pauseDeposits();
        rmUsdc.shutdownVault();
        vm.stopPrank();
        vm.prank(pauser);
        gateway.pauseDeposits();
        _setStatus(address(rmUsdc), VaultRegistry.VaultStatus.DepositsPaused);
        _setStatus(address(rmUsdc), VaultRegistry.VaultStatus.Retired);
        assertEq(rmUsdc.maxDeposit(alice), 0, "deposits halted");

        assertEq(rmUsdc.maxRedeem(alice), aliceShares, "maxRedeem is the full balance");
        vm.prank(alice);
        assertEq(rmUsdc.redeem(aliceShares, alice, alice), AMOUNT, "alice redeems in full");
        uint256 bobMax = rmUsdc.maxWithdraw(bob);
        assertEq(bobMax, AMOUNT, "maxWithdraw is the full position");
        vm.prank(bob);
        rmUsdc.withdraw(bobMax, bob, bob);
        assertEq(usdc.balanceOf(bob), AMOUNT, "bob withdraws in full");
    }

    /// @notice Every emergency drain lever: `emergencyWithdrawAdapter`, `emergencyWithdraw`,
    ///         `emergencyExcludeAdapter` (security round 1), `forceRemoveAdapter`, pauseDeposits
    ///         and shutdown. Funds move back to the vault and the holders still exit in full.
    function test_rmUSDC_noLeverFreezesExit_afterEmergencyDrain() public {
        uint256 aliceShares = _depositDirect(address(rmUsdc), alice, AMOUNT);
        uint256 bobShares = _depositDirect(address(rmUsdc), bob, AMOUNT);

        vm.startPrank(emergency);
        rmUsdc.emergencyWithdrawAdapter(0);
        rmUsdc.emergencyWithdraw();
        rmUsdc.emergencyExcludeAdapter(0);
        rmUsdc.forceRemoveAdapter(0);
        rmUsdc.pauseDeposits();
        rmUsdc.shutdownVault();
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(rmUsdc)), 2 * AMOUNT, "funds back in the vault");

        vm.prank(alice);
        assertEq(rmUsdc.redeem(aliceShares, alice, alice), AMOUNT, "alice redeems after a drain");
        vm.prank(bob);
        assertEq(rmUsdc.redeem(bobShares, bob, bob), AMOUNT, "bob redeems after a drain");
    }

    /// @notice pauseDeposits, deposit and mint revert DepositsArePaused, redeem while
    ///         paused, the emergency key cannot resume, the Safe resumes through the timelock.
    function test_rmUSDC_pauseDeposits_thenRedeem_thenSafeUnpause() public {
        uint256 aliceShares = _depositDirect(address(rmUsdc), alice, AMOUNT);

        vm.prank(emergency);
        rmUsdc.pauseDeposits();
        assertTrue(rmUsdc.depositsPaused(), "deposits paused");
        _expectDepositsArePaused(address(rmUsdc), RobotMoneyVault.DepositsArePaused.selector);

        vm.prank(alice);
        assertEq(rmUsdc.redeem(aliceShares, alice, alice), AMOUNT, "redeem while paused");

        _expectEmergencyCannotUnpause(address(rmUsdc));
        _governOne(address(rmUsdc), abi.encodeCall(RobotMoneyVault.unpauseDeposits, ()));
        assertFalse(rmUsdc.depositsPaused(), "resumed by the timelock");
        assertGt(_depositDirect(address(rmUsdc), bob, AMOUNT), 0, "deposits restored");
    }

    // ─── Basket vaults ────────────────────────────────────────────────────────

    function test_rmPROTO_noLeverFreezesExit() public {
        _basketNoLeverFreezesExit(rmProto);
    }

    function test_rmAGENT_noLeverFreezesExit() public {
        _basketNoLeverFreezesExit(rmAgent);
    }

    function test_rmRWA_noLeverFreezesExit() public {
        _basketNoLeverFreezesExit(rmRwa);
    }

    function test_rmPROTO_pauseDeposits_thenRedeem_thenSafeUnpause() public {
        _basketPauseThenRedeemThenSafeUnpause(rmProto);
    }

    function test_rmAGENT_pauseDeposits_thenRedeem_thenSafeUnpause() public {
        _basketPauseThenRedeemThenSafeUnpause(rmAgent);
    }

    function test_rmRWA_pauseDeposits_thenRedeem_thenSafeUnpause() public {
        _basketPauseThenRedeemThenSafeUnpause(rmRwa);
    }

    /// @notice Governance cannot set a TWAP window the pool's history does not reach:
    ///         the Safe's timelock execution fails, and the holder still redeems.
    function test_basket_governanceCannotSetTwapWindowBeyondHistory_redeemStillWorks() public {
        uint256 shares = _depositBasket(rmProto, alice, AMOUNT);
        pool.setMaxHistory(3_600);

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(BasketVault.setTwapWindow, (address(basketToken), 7_200));
        (address[] memory targets, uint256[] memory values, bytes32 salt) =
            _schedule(address(rmProto), calls);
        vm.warp(block.timestamp + MIN_DELAY);
        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.executeBatch, (targets, values, calls, bytes32(0), salt)
            ),
            false
        );
        assertEq(rmProto.effectiveTwapWindow(address(basketToken)), 1_800, "window unchanged");

        _fundBasketExit(rmProto);
        vm.prank(alice);
        assertEq(rmProto.redeem(shares, alice, alice), SWAP_OUT, "redeem still works");
    }

    // ─── Router and gateway ───────────────────────────────────────────────────

    /// @notice The router redeems from a vault whose deposits are paused and whose
    ///         registry status is DepositsPaused, then Retired.
    function test_router_redeemsWhileVaultDepositsPausedAndRetired() public {
        uint256 shares = _depositDirect(address(rmUsdc), alice, AMOUNT);
        vm.prank(alice);
        rmUsdc.approve(address(router), shares);
        address[] memory legs = new address[](1);
        legs[0] = address(rmUsdc);
        uint256[] memory half = new uint256[](1);
        half[0] = shares / 2;

        vm.prank(emergency);
        rmUsdc.pauseDeposits();
        _setStatus(address(rmUsdc), VaultRegistry.VaultStatus.DepositsPaused);
        vm.prank(alice);
        uint256[] memory out =
            router.redeemFor(alice, alice, legs, half, new uint256[](1), type(uint256).max);
        assertEq(out[0], AMOUNT / 2, "router redeems from a DepositsPaused vault");

        _setStatus(address(rmUsdc), VaultRegistry.VaultStatus.Retired);
        half[0] = rmUsdc.balanceOf(alice);
        vm.prank(alice);
        out = router.redeemFor(alice, alice, legs, half, new uint256[](1), type(uint256).max);
        assertEq(out[0], AMOUNT / 2, "router redeems from a Retired vault");
        assertEq(usdc.balanceOf(alice), AMOUNT, "alice exits in full through the router");
    }

    /// @notice A gateway agent withdraws on both paths while the deposit pauser has
    ///         paused gateway deposits and the emergency key has paused vault deposits.
    ///         Gateway deposits revert DepositsArePaused; the Safe resumes them.
    function test_gateway_withdrawsWhileGatewayAndVaultDepositsPaused() public {
        address agent = makeAddr("agent");
        address recipient = makeAddr("recipient");
        _selfAuthorize(agent, recipient);

        usdc.mint(agent, 2 * AMOUNT);
        vm.startPrank(agent);
        usdc.approve(address(gateway), 2 * AMOUNT);
        (, uint256 shares) =
            gateway.deposit(bytes32("o-dep"), AMOUNT, uint64(block.timestamp + 60), bytes32("i"));
        vm.stopPrank();

        vm.prank(pauser);
        gateway.pauseDeposits();
        vm.prank(emergency);
        rmUsdc.pauseDeposits();
        assertTrue(gateway.depositsPaused(), "gateway deposits paused");

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DepositsArePaused.selector);
        gateway.deposit(bytes32("o-dep2"), AMOUNT, uint64(block.timestamp + 60), bytes32("j"));

        vm.startPrank(agent);
        rmUsdc.approve(address(gateway), shares);
        (, uint256 assetsOut) = gateway.withdraw(
            bytes32("o-wd"), shares / 2, address(rmUsdc), uint64(block.timestamp + 60), "i"
        );
        vm.stopPrank();
        assertEq(assetsOut, AMOUNT / 2, "gateway withdraw pays while deposits are paused");

        address[] memory legs = new address[](1);
        legs[0] = address(rmUsdc);
        uint256[] memory legShares = new uint256[](1);
        legShares[0] = rmUsdc.balanceOf(agent);
        vm.prank(agent);
        (, uint256[] memory perLeg) = gateway.withdrawFromRouter(
            bytes32("o-wr"),
            legs,
            legShares,
            new uint256[](1),
            uint64(block.timestamp + 60),
            bytes32("k")
        );
        assertEq(perLeg[0], AMOUNT / 2, "router withdrawal pays while deposits are paused");
        assertEq(usdc.balanceOf(recipient), AMOUNT, "USDC to the policy recipient in full");

        vm.prank(pauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, pauser, ADMIN_ROLE
            )
        );
        gateway.unpauseDeposits();
        _governOne(address(gateway), abi.encodeCall(RobotMoneyGateway.unpauseDeposits, ()));
        assertFalse(gateway.depositsPaused(), "gateway deposits resumed by the timelock");
    }

    // ─── Governed upgrade and freeze (ADR-0014 §6, UPG-6) ─────────────────────

    /// @notice Every vault is upgraded to a new implementation through the real Safe and the
    ///         timelock at the Base delay, then frozen the same way. Every exit stays open: rmUSDC
    ///         redeems and withdraws in full, each basket pays `redeemInKind` and the USDC `redeem`,
    ///         with the emergency levers pulled after the freeze.
    function test_allVaults_exitsStayOpenAfterGovernedUpgradeAndFreeze() public {
        uint256 usdcShares = _depositDirect(address(rmUsdc), alice, AMOUNT);
        BasketVault[3] memory baskets = [BasketVault(rmProto), rmAgent, rmRwa];
        uint256[3] memory basketShares;
        for (uint256 i = 0; i < 3; i++) {
            basketShares[i] = _depositBasket(baskets[i], alice, AMOUNT);
        }

        address[4] memory proxies =
            [address(rmUsdc), address(rmProto), address(rmAgent), address(rmRwa)];
        address[4] memory v2 = [
            address(new RobotMoneyVault()),
            address(new ProtocolAssetVault()),
            address(new AgentTokenVault()),
            address(new RwaBasketVault())
        ];
        for (uint256 i = 0; i < 4; i++) {
            _governOne(proxies[i], abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (v2[i], "")));
            _governOne(
                proxies[i], abi.encodeCall(GovernedUpgrade.freezeUpgrades, (v2[i], v2[i].codehash))
            );
            assertTrue(GovernedUpgrade(proxies[i]).upgradesFrozen(), "frozen through the Safe");
        }

        vm.startPrank(emergency);
        rmUsdc.pauseDeposits();
        rmUsdc.shutdownVault();
        for (uint256 i = 0; i < 3; i++) {
            baskets[i].pauseDeposits();
            baskets[i].shutdownVault();
        }
        vm.stopPrank();

        vm.startPrank(alice);
        rmUsdc.withdraw(AMOUNT / 4, alice, alice);
        rmUsdc.redeem(rmUsdc.balanceOf(alice), alice, alice);
        vm.stopPrank();
        assertGt(usdcShares, 0, "alice held rmUSDC");
        assertEq(rmUsdc.balanceOf(alice), 0, "rmUSDC exit in full after the freeze");

        for (uint256 i = 0; i < 3; i++) {
            BasketVault v = baskets[i];
            vm.prank(alice);
            v.redeemInKind(basketShares[i] / 2, alice, alice);
            _fundBasketExit(v);
            swapRouter.setAmountOut(SWAP_OUT / 2);
            uint256 rest = v.balanceOf(alice);
            vm.prank(alice);
            assertGt(v.redeem(rest, alice, alice), 0, "USDC redeem after the freeze");
            assertEq(v.balanceOf(alice), 0, "basket exit in full after the freeze");
        }
        assertGt(basketToken.balanceOf(alice), 0, "redeemInKind paid the basket token");
    }

    // ─── Populated v1 → v2 upgrade of all nine proxies (ADR-0014 "Tests this ADR requires") ──

    /// @dev The two committee proxies the upgrade test adds to the fixture, and its agent.
    InvestmentCommitteePolicy internal icPolicy;
    ConsensusRecommendationReceipt internal receipts;
    address internal upgradeAgent = makeAddr("upgrade-agent");
    address internal upgradeRecipient = makeAddr("upgrade-recipient");

    /// @notice #1808 test plan: populated v1 proxies upgrade to a v2 through the real Safe and the
    ///         timelock at the Base delay, all nine in one scheduled batch, and every piece of state
    ///         survives: balances, allowances, roles, fees, caps, the gateway policy and windows,
    ///         the router weights, the committee vote, the receipts and their release state, and
    ///         the adapter position. The digests are read at the execute timestamp on both sides, so
    ///         time-relative views (rolling windows) compare like for like. Then every exit runs
    ///         synchronously on v2, and the committee surface still records.
    function test_allNineProxies_upgradeThroughSafeKeepsPopulatedState() public {
        _populateForUpgrade();

        address[9] memory proxies = _nineProxies();
        address[9] memory v2 = [
            address(new RobotMoneyVault()),
            address(new ProtocolAssetVault()),
            address(new AgentTokenVault()),
            address(new RwaBasketVault()),
            address(new PortfolioRouter()),
            address(new VaultRegistry()),
            address(new RobotMoneyGateway()),
            address(new InvestmentCommitteePolicy()),
            address(new ConsensusRecommendationReceipt())
        ];
        address[] memory targets = new address[](9);
        bytes[] memory calls = new bytes[](9);
        for (uint256 i = 0; i < 9; i++) {
            targets[i] = proxies[i];
            calls[i] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (v2[i], ""));
        }
        (uint256[] memory values, bytes32 salt) = _scheduleTargets(targets, calls);
        bytes memory exec = abi.encodeCall(
            TimelockController.executeBatch, (targets, values, calls, bytes32(0), salt)
        );
        _safeExec(address(timelock), exec, false); // the delay has not run
        vm.warp(block.timestamp + MIN_DELAY);

        bytes32[9] memory before = _upgradeDigests();
        _safeExec(address(timelock), exec, true);
        bytes32[9] memory afterUpgrade = _upgradeDigests();

        for (uint256 i = 0; i < 9; i++) {
            assertEq(
                address(uint160(uint256(vm.load(proxies[i], ERC1967Utils.IMPLEMENTATION_SLOT)))),
                v2[i],
                "implementation slot moved to v2"
            );
            assertEq(afterUpgrade[i], before[i], "populated state survived the upgrade");
            assertEq(GovernedUpgrade(proxies[i]).upgradeAuthority(), authority, "authority kept");
            assertFalse(GovernedUpgrade(proxies[i]).upgradesFrozen(), "an upgrade does not freeze");
        }

        _exitAndRecordOnV2();
    }

    /// @dev State on every proxy, through the real Safe and timelock where governance owns it.
    function _populateForUpgrade() internal {
        // Balances and the adapter position: alice and bob in rmUSDC (the NoYield adapter takes
        // every deposit), alice in each basket.
        uint256 aliceShares = _depositDirect(address(rmUsdc), alice, AMOUNT);
        _depositDirect(address(rmUsdc), bob, AMOUNT);
        _depositBasket(rmProto, alice, AMOUNT);
        _depositBasket(rmAgent, alice, AMOUNT);
        _depositBasket(rmRwa, alice, AMOUNT);

        // Allowances: alice lets the router pull half her rmUSDC, and bob part of her rmPROTO.
        vm.startPrank(alice);
        rmUsdc.approve(address(router), aliceShares / 2);
        rmProto.approve(bob, 1e18);
        vm.stopPrank();

        // The committee proxies, born on the same timelock and administered by it.
        icPolicy =
            Proxied.investmentCommitteePolicyAs(authority, address(timelock), address(gateway));
        receipts = Proxied.consensusRecommendationReceiptAs(
            authority, address(timelock), address(gateway), address(icPolicy)
        );

        // A gateway policy, a deposit in its window, and a share allowance for the withdraw path.
        _selfAuthorize(upgradeAgent, upgradeRecipient);
        usdc.mint(upgradeAgent, AMOUNT);
        vm.startPrank(upgradeAgent);
        usdc.approve(address(gateway), AMOUNT);
        (, uint256 agentShares) = gateway.deposit(
            bytes32("up-dep"), AMOUNT, uint64(block.timestamp + 60), bytes32("up-dep-key")
        );
        rmUsdc.approve(address(gateway), agentShares);
        vm.stopPrank();

        // Fees, caps, weights, eligibility and the committee wiring: one Safe batch.
        address[] memory vaults = new address[](1);
        vaults[0] = address(rmUsdc);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;
        address[] memory targets = new address[](10);
        bytes[] memory calls = new bytes[](10);
        (targets[0], calls[0]) =
        (address(rmUsdc), abi.encodeCall(RobotMoneyVault.setExitFeeBps, (20)));
        (targets[1], calls[1]) =
        (address(rmUsdc), abi.encodeCall(RobotMoneyVault.setPerDepositCap, (50_000e6)));
        (targets[2], calls[2]) = (address(rmProto), abi.encodeCall(BasketVault.setExitFeeBps, (30)));
        (targets[3], calls[3]) =
        (
            address(registry),
            abi.encodeCall(VaultRegistry.setRouterEligible, (address(rmUsdc), true))
        );
        (targets[4], calls[4]) =
        (address(router), abi.encodeCall(PortfolioRouter.setDefaultWeights, (vaults, bps)));
        (targets[5], calls[5]) =
        (address(router), abi.encodeCall(PortfolioRouter.setVaultCap, (address(rmUsdc), 500_000e6)));
        (targets[6], calls[6]) =
        (address(router), abi.encodeCall(PortfolioRouter.setRouterCap, (900_000e6)));
        (targets[7], calls[7]) =
        (address(gateway), abi.encodeCall(RobotMoneyGateway.setICPolicy, (address(icPolicy))));
        (targets[8], calls[8]) =
        (
            address(gateway),
            abi.encodeCall(RobotMoneyGateway.setConsensusReceipt, (address(receipts)))
        );
        (targets[9], calls[9]) =
        (
            address(icPolicy),
            abi.encodeCall(InvestmentCommitteePolicy.registerAgent, (upgradeAgent, "agent-1"))
        );
        _governTargets(targets, calls);

        // A committee vote and two receipts through the gateway; the Safe releases one.
        vm.startPrank(upgradeAgent);
        gateway.committeeVoteSubmit(_vote(7_000));
        gateway.consensusRecordReceipt(keccak256("up-receipt-1"), keccak256("p1"), "https://r/1");
        gateway.consensusRecordReceipt(keccak256("up-receipt-2"), keccak256("p2"), "https://r/2");
        vm.stopPrank();
        _governOne(
            address(receipts),
            abi.encodeCall(
                ConsensusRecommendationReceipt.releaseReceipt, (keccak256("up-receipt-1"))
            )
        );
        assertEq(receipts.receiptCount(), 2, "two receipts recorded");
        assertTrue(receipts.isReleased(keccak256("up-receipt-1")), "one receipt released");
    }

    /// @dev Synchronous redemptions on every exit after the upgrade, and the committee still records.
    function _exitAndRecordOnV2() internal {
        // rmUSDC: alice half through the router (the surviving allowance), the rest directly; bob
        // withdraws his full position. The 20 bps fee set on v1 applies on v2.
        address[] memory legs = new address[](1);
        legs[0] = address(rmUsdc);
        uint256[] memory legShares = new uint256[](1);
        legShares[0] = rmUsdc.allowance(alice, address(router));
        vm.prank(alice);
        uint256[] memory out =
            router.redeemFor(alice, alice, legs, legShares, new uint256[](1), type(uint256).max);
        assertGt(out[0], 0, "router redeem on v2");
        vm.startPrank(alice);
        rmUsdc.redeem(rmUsdc.balanceOf(alice), alice, alice);
        vm.stopPrank();
        assertEq(rmUsdc.balanceOf(alice), 0, "alice exited rmUSDC");
        assertApproxEqAbs(
            usdc.balanceOf(alice), AMOUNT * (10_000 - 20) / 10_000, 10, "fee survived, no more"
        );
        uint256 bobMax = rmUsdc.maxWithdraw(bob);
        vm.prank(bob);
        rmUsdc.withdraw(bobMax, bob, bob);
        assertEq(rmUsdc.balanceOf(bob), 0, "bob exited rmUSDC");

        // Every basket: half in kind, the rest for USDC.
        BasketVault[3] memory baskets = [BasketVault(rmProto), rmAgent, rmRwa];
        for (uint256 i = 0; i < 3; i++) {
            BasketVault v = baskets[i];
            vm.prank(alice);
            v.redeemInKind(v.balanceOf(alice) / 2, alice, alice);
            _fundBasketExit(v);
            swapRouter.setAmountOut(SWAP_OUT / 2);
            uint256 rest = v.balanceOf(alice);
            vm.prank(alice);
            assertGt(v.redeem(rest, alice, alice), 0, "basket USDC redeem on v2");
            assertEq(v.balanceOf(alice), 0, "basket exit in full on v2");
        }

        // The gateway policy still governs the agent's withdraw.
        uint256 agentShares = rmUsdc.balanceOf(upgradeAgent);
        vm.prank(upgradeAgent);
        (, uint256 assetsOut) = gateway.withdraw(
            bytes32("up-wd"),
            agentShares,
            address(rmUsdc),
            uint64(block.timestamp + 60),
            "up-wd-key"
        );
        assertGt(assetsOut, 0, "gateway withdraw on v2");
        assertEq(usdc.balanceOf(upgradeRecipient), assetsOut, "paid to the policy recipient");

        // The committee surface records on v2 and keeps the v1 records.
        vm.startPrank(upgradeAgent);
        assertEq(gateway.committeeVoteSubmit(_vote(6_000)), 1, "second vote appended");
        gateway.consensusRecordReceipt(keccak256("up-receipt-3"), keccak256("p3"), "https://r/3");
        vm.stopPrank();
        assertEq(receipts.receiptCount(), 3, "v2 appends to the v1 receipt log");
        assertTrue(receipts.isReleased(keccak256("up-receipt-1")), "v1 release kept");
    }

    function _vote(uint16 weightBps)
        internal
        view
        returns (IInvestmentCommitteePolicy.VoteParams memory)
    {
        return IInvestmentCommitteePolicy.VoteParams({
            agent: upgradeAgent,
            vault: address(rmUsdc),
            stance: IInvestmentCommitteePolicy.Stance.Overweight,
            targetWeightBps: weightBps,
            confidence: 70,
            rationaleUri: "https://r/rationale",
            voteJsonHash: keccak256(abi.encode("vote", weightBps)),
            promptHash: keccak256("prompt"),
            inputsDigest: keccak256("inputs"),
            schemaVersion: "1",
            timestamp: uint64(block.timestamp)
        });
    }

    function _nineProxies() internal view returns (address[9] memory) {
        return [
            address(rmUsdc),
            address(rmProto),
            address(rmAgent),
            address(rmRwa),
            address(router),
            address(registry),
            address(gateway),
            address(icPolicy),
            address(receipts)
        ];
    }

    function _upgradeDigests() internal view returns (bytes32[9] memory d) {
        d[0] = _rmUsdcDigest();
        d[1] = _basketDigest(rmProto);
        d[2] = _basketDigest(rmAgent);
        d[3] = _basketDigest(rmRwa);
        d[4] = _routerDigest();
        d[5] = _registryDigest();
        d[6] = _gatewayDigest();
        d[7] = _icDigest();
        d[8] = _receiptDigest();
    }

    /// @dev The role holders the handover set: timelock admin, emergency key, deployer none.
    function _rolesDigest(address p) internal view returns (bytes32) {
        IAccessControl a = IAccessControl(p);
        return keccak256(
            abi.encode(
                a.hasRole(ADMIN_ROLE, address(timelock)),
                a.hasRole(bytes32(0), address(timelock)),
                a.hasRole(EMERGENCY_ROLE, emergency)
            )
        );
    }

    function _rmUsdcDigest() internal view returns (bytes32) {
        (address a0, uint16 cap0, bool active0, uint256 bal0, uint256 target0) =
            rmUsdc.getAdapterInfo(0);
        return keccak256(
            abi.encode(
                keccak256(
                    abi.encode(
                        rmUsdc.totalSupply(),
                        rmUsdc.totalAssets(),
                        rmUsdc.balanceOf(alice),
                        rmUsdc.balanceOf(bob),
                        rmUsdc.balanceOf(upgradeAgent),
                        rmUsdc.allowance(alice, address(router)),
                        rmUsdc.allowance(upgradeAgent, address(gateway)),
                        rmUsdc.exitFeeBps(),
                        rmUsdc.perDepositCap(),
                        rmUsdc.tvlCap(),
                        rmUsdc.feeRecipient()
                    )
                ),
                keccak256(
                    abi.encode(
                        a0,
                        cap0,
                        active0,
                        bal0,
                        target0,
                        usdc.balanceOf(a0),
                        rmUsdc.adapterCount(),
                        address(rmUsdc.exclusionLedger()),
                        rmUsdc.registry()
                    )
                ),
                _rolesDigest(address(rmUsdc))
            )
        );
    }

    function _basketDigest(BasketVault v) internal view returns (bytes32) {
        (bool ok, bytes memory asset0) =
            address(v).staticcall(abi.encodeWithSignature("assets(uint256)", uint256(0)));
        require(ok, "assets(0)");
        return keccak256(
            abi.encode(
                keccak256(
                    abi.encode(
                        v.totalSupply(),
                        v.totalAssets(),
                        v.balanceOf(alice),
                        v.allowance(alice, bob),
                        v.exitFeeBps(),
                        v.perDepositCap(),
                        v.tvlCap(),
                        v.feeRecipient(),
                        v.maxSlippageBps()
                    )
                ),
                keccak256(
                    abi.encode(
                        keccak256(asset0),
                        basketToken.balanceOf(address(v)),
                        v.effectiveTwapWindow(address(basketToken)),
                        address(v.SWAP_ROUTER()),
                        v.registry()
                    )
                ),
                _rolesDigest(address(v))
            )
        );
    }

    function _routerDigest() internal view returns (bytes32) {
        (address[] memory wv, uint256[] memory wb) = router.getWeights();
        (address[] memory dv, uint256[] memory db) = router.getDefaultWeights();
        return keccak256(
            abi.encode(
                keccak256(abi.encode(wv, wb, dv, db, router.votedWeightsActive())),
                router.routerCap(),
                router.vaultCap(address(rmUsdc)),
                router.hasRole(router.WEIGHT_SETTER_ROLE(), address(timelock)),
                _rolesDigest(address(router))
            )
        );
    }

    function _registryDigest() internal view returns (bytes32) {
        (VaultRegistry.VaultMetadata memory m, VaultRegistry.VaultStatus st) =
            registry.getVault(address(rmUsdc));
        return keccak256(
            abi.encode(
                registry.listVaults(),
                registry.routerEligibleCount(),
                registry.isRouterEligible(address(rmUsdc)),
                keccak256(abi.encode(m, st)),
                _rolesDigest(address(registry))
            )
        );
    }

    function _gatewayDigest() internal view returns (bytes32) {
        (bool ok, bytes memory policy) =
            address(gateway).staticcall(abi.encodeWithSignature("agents(address)", upgradeAgent));
        require(ok, "agents(agent)");
        return keccak256(
            abi.encode(
                keccak256(policy),
                gateway.agentOwner(upgradeAgent),
                gateway.hasRole(gateway.AGENT_ROLE(), upgradeAgent),
                gateway.effectiveDepositWindowGross(upgradeAgent),
                gateway.effectiveWithdrawWindowGross(upgradeAgent),
                gateway.agentConsented(upgradeAgent),
                address(gateway.icPolicy()),
                address(gateway.consensusReceipt()),
                gateway.depositsPaused(),
                _rolesDigest(address(gateway))
            )
        );
    }

    function _icDigest() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                icPolicy.voteCount(),
                keccak256(abi.encode(icPolicy.getVote(0))),
                icPolicy.agentId(upgradeAgent),
                icPolicy.hasRole(icPolicy.COMMITTEE_AGENT_ROLE(), upgradeAgent),
                icPolicy.gateway(),
                _rolesDigest(address(icPolicy))
            )
        );
    }

    function _receiptDigest() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                receipts.receiptCount(),
                keccak256(abi.encode(receipts.getReceipt(0), receipts.getReceipt(1))),
                receipts.isReleased(keccak256("up-receipt-1")),
                receipts.isReleased(keccak256("up-receipt-2")),
                receipts.gateway(),
                receipts.icPolicy(),
                _rolesDigest(address(receipts))
            )
        );
    }

    /// @dev The real governance route for a batch over several targets, in order.
    function _governTargets(address[] memory targets, bytes[] memory calls) internal {
        (uint256[] memory values, bytes32 salt) = _scheduleTargets(targets, calls);
        vm.warp(block.timestamp + MIN_DELAY);
        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.executeBatch, (targets, values, calls, bytes32(0), salt)
            ),
            true
        );
    }

    function _scheduleTargets(address[] memory targets, bytes[] memory calls)
        internal
        returns (uint256[] memory values, bytes32 salt)
    {
        values = new uint256[](targets.length);
        salt = keccak256(abi.encode(++saltNonce));
        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.scheduleBatch,
                (targets, values, calls, bytes32(0), salt, MIN_DELAY)
            ),
            true
        );
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _buildOtherVaults(address deployer) internal {
        ISwapRouter sr = ISwapRouter(address(swapRouter));
        address fees = makeAddr("basketFees");
        rmProto = Proxied.protocolAssetVaultAs(
            authority, usdc, sr, 1_000_000e6, 100_000e6, 0, fees, deployer, deployer
        );
        rmAgent = Proxied.agentTokenVaultAs(
            authority, usdc, sr, 1_000_000e6, 100_000e6, 0, fees, deployer, deployer
        );
        rmProto.addAsset(
            address(basketToken), address(pool), 500, address(0), BasketAssetConfigGuard.Venue.V3
        );
        rmAgent.addAsset(
            address(basketToken), address(pool), 500, address(0), BasketAssetConfigGuard.Venue.V3
        );

        rmRwa = Proxied.rwaBasketVaultAs(
            authority, usdc, sr, 1_000_000e6, 100_000e6, 0, fees, deployer, deployer
        );
        rmRwa.addAsset(
            address(basketToken), address(pool), 500, address(0), BasketAssetConfigGuard.Venue.V3
        );
    }

    function _others() internal view returns (address[3] memory) {
        return [address(rmProto), address(rmAgent), address(rmRwa)];
    }

    /// @dev Pull every basket lever, then redeem on the swap path and the idle path.
    function _basketNoLeverFreezesExit(BasketVault v) internal {
        uint256 aliceShares = _depositBasket(v, alice, AMOUNT);
        uint256 bobShares = _depositBasket(v, bob, AMOUNT);

        vm.startPrank(emergency);
        v.pauseDeposits();
        v.shutdownVault();
        vm.stopPrank();
        vm.prank(pauser);
        gateway.pauseDeposits();
        _setStatus(address(v), VaultRegistry.VaultStatus.DepositsPaused);
        _setStatus(address(v), VaultRegistry.VaultStatus.Retired);
        assertEq(v.maxDeposit(alice), 0, "deposits halted");

        // Swap path: alice sells her half of the basket.
        assertEq(v.maxRedeem(alice), aliceShares, "maxRedeem is the full balance");
        _fundBasketExit(v);
        vm.prank(alice);
        assertEq(v.redeem(aliceShares, alice, alice), SWAP_OUT, "alice redeems the proceeds");

        // Idle path: the emergency unwind sells the rest to USDC, then bob redeems it.
        _fundBasketExit(v);
        vm.prank(emergency);
        v.emergencyUnwind();
        vm.prank(bob);
        assertEq(v.redeem(bobShares, bob, bob), SWAP_OUT, "bob redeems after the unwind");
        assertEq(usdc.balanceOf(bob), SWAP_OUT, "bob holds the USDC");
    }

    function _basketPauseThenRedeemThenSafeUnpause(BasketVault v) internal {
        uint256 shares = _depositBasket(v, alice, AMOUNT);

        vm.prank(emergency);
        v.pauseDeposits();
        assertEq(v.maxDeposit(bob), 0, "maxDeposit 0 while deposits are paused");
        _expectDepositsArePaused(address(v), BasketVault.DepositsArePaused.selector);

        _fundBasketExit(v);
        vm.prank(alice);
        assertEq(v.redeem(shares, alice, alice), SWAP_OUT, "redeem while paused");

        // emergencyUnwind sets only depositsPaused; the Safe resume must clear it.
        vm.prank(emergency);
        v.emergencyUnwind();
        _expectEmergencyCannotUnpause(address(v));
        _governOne(address(v), abi.encodeCall(BasketVault.unpauseDeposits, ()));
        assertFalse(v.depositsPaused(), "resumed by the timelock");
        assertGt(v.maxDeposit(bob), 0, "deposits restored");
    }

    function _depositDirect(address v, address who, uint256 amount)
        internal
        returns (uint256 shares)
    {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(v, amount);
        shares = IVault4626(v).deposit(amount, who);
        vm.stopPrank();
    }

    function _depositBasket(BasketVault v, address who, uint256 amount)
        internal
        returns (uint256 shares)
    {
        basketToken.mint(address(swapRouter), amount);
        swapRouter.setAmountOut(amount);
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(v), amount);
        shares = v.deposit(amount, who);
        vm.stopPrank();
    }

    /// @dev Fund the swap router for one position's exit.
    function _fundBasketExit(BasketVault) internal {
        usdc.mint(address(swapRouter), SWAP_OUT);
        swapRouter.setAmountOut(SWAP_OUT);
    }

    function _expectDepositsArePaused(address v, bytes4 selector) internal {
        usdc.mint(bob, AMOUNT);
        vm.startPrank(bob);
        usdc.approve(v, AMOUNT);
        vm.expectRevert(selector);
        IVault4626(v).deposit(AMOUNT, bob);
        vm.expectRevert(selector);
        IVault4626(v).mint(1, bob);
        vm.stopPrank();
    }

    function _expectEmergencyCannotUnpause(address v) internal {
        vm.prank(emergency);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, emergency, ADMIN_ROLE
            )
        );
        IVault4626(v).unpauseDeposits();
    }

    /// @dev The permissionless commit/reveal route; a non-admin agent names itself as
    ///      share receiver.
    function _selfAuthorize(address agent, address recipient) internal {
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 30 days),
            maxPerPayment: 2 * AMOUNT,
            maxPerWindow: 10 * AMOUNT,
            shareReceiver: agent,
            allowedDestinations: new address[](0),
            assetRecipient: recipient,
            maxWithdrawPerPayment: type(uint128).max,
            maxWithdrawPerWindow: type(uint128).max,
            allowedSourceVaults: new address[](0)
        });
        bytes32 salt = keccak256("agent-salt");
        vm.prank(agent);
        gateway.commitAuthorization(keccak256(abi.encode(agent, agent, salt)));
        vm.roll(block.number + 1);
        vm.prank(agent);
        // Revealing for itself is the agent's consent; no signature (issue #1791).
        gateway.revealAuthorization(agent, salt, p, "");
    }

    function _setStatus(address v, VaultRegistry.VaultStatus status) internal {
        _governOne(address(registry), abi.encodeCall(VaultRegistry.setVaultStatus, (v, status)));
    }

    function _governOne(address target, bytes memory data) internal {
        bytes[] memory calls = new bytes[](1);
        calls[0] = data;
        _govern(target, calls);
    }

    /// @dev The real governance route: the Safe schedules a batch on the timelock,
    ///      execution before the delay fails, and the Safe executes after 172800 s.
    function _govern(address target, bytes[] memory calls) internal {
        (address[] memory targets, uint256[] memory values, bytes32 salt) = _schedule(target, calls);
        bytes memory exec = abi.encodeCall(
            TimelockController.executeBatch, (targets, values, calls, bytes32(0), salt)
        );
        _safeExec(address(timelock), exec, false);
        vm.warp(block.timestamp + MIN_DELAY);
        _safeExec(address(timelock), exec, true);
    }

    function _schedule(address target, bytes[] memory calls)
        internal
        returns (address[] memory targets, uint256[] memory values, bytes32 salt)
    {
        uint256 n = calls.length;
        targets = new address[](n);
        values = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            targets[i] = target;
        }
        salt = keccak256(abi.encode(++saltNonce));
        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.scheduleBatch,
                (targets, values, calls, bytes32(0), salt, MIN_DELAY)
            ),
            true
        );
    }

    /// @dev A 2-of-3 SafeProxy on SafeL2 through the canonical factory — the same call
    ///      stage's ceremony makes.
    function _createSafe() internal returns (ISafe created) {
        ownerPks[0] = uint256(keccak256("never-frozen-safe-owner-1"));
        ownerPks[1] = uint256(keccak256("never-frozen-safe-owner-2"));
        ownerPks[2] = uint256(keccak256("never-frozen-safe-owner-3"));
        address[] memory owners = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            owners[i] = vm.addr(ownerPks[i]);
        }
        bytes memory setup = abi.encodeCall(
            _ISafeSetup.setup,
            (owners, 2, address(0), "", SAFE_FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
        created = ISafe(
            ISafeProxyFactory(SAFE_PROXY_FACTORY)
                .createProxyWithNonce(
                    SAFE_SINGLETON_L2, setup, uint256(keccak256("never-frozen-safe"))
                )
        );
    }

    /// @dev `execTransaction` signed by the two lowest-address owners. `expectOk == false`
    ///      asserts the Safe refuses (GS013: the inner call reverted).
    function _safeExec(address to, bytes memory data, bool expectOk) internal {
        bytes32 txHash = safe.getTransactionHash(
            to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), safe.nonce()
        );
        uint256[3] memory pks = ownerPks;
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (vm.addr(pks[j]) < vm.addr(pks[i])) (pks[i], pks[j]) = (pks[j], pks[i]);
            }
        }
        bytes memory sigs = bytes.concat(_sign(pks[0], txHash), _sign(pks[1], txHash));
        if (!expectOk) vm.expectRevert(bytes("GS013"));
        safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    function _sign(uint256 pk, bytes32 txHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, txHash);
        return abi.encodePacked(r, s, v);
    }
}

/// @dev The ERC-4626 entry points and the deposit-pause pair every shipped vault shares.
interface IVault4626 {
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function mint(uint256 shares, address receiver) external returns (uint256);
    function unpauseDeposits() external;
}
