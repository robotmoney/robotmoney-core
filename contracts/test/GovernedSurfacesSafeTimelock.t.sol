// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
// Canonical: docs/technical/governance-isomorphism.md — the test governance path is the production one
// Implements: issue #1644 — the remaining governed surfaces run Safe -> Timelock with two signatures
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
import {ShortlistStubSwapRouter} from "./ProtocolAssetVaultShortlist.t.sol";
import {MockUsdc, MockGovVault} from "./RouterGovernance.t.sol";
import {Proxied} from "./helpers/Proxied.sol";

/// @title GovernedSurfacesSafeTimelockTest
/// @notice One real Safe -> Timelock test for each governed surface that had none: the
///         InvestmentCommitteePolicy, adapter admin, role revoke, `setDefaultWeights` and
///         `setReceiptContract` on RouterGovernance after the handover (issue #1698 deleted
///         the voting surface), and the AgentTokenVault non-asset setters. Two owners sign,
///         the real SafeL2 proxy runs `execTransaction`, the timelock waits, the timelock
///         calls the contract. Nothing pranks the Safe.
contract GovernedSurfacesSafeTimelockTest is SafeGovernance {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 internal constant COMMITTEE_AGENT_ROLE = keccak256("COMMITTEE_AGENT_ROLE");
    uint256 internal constant DELAY = 2 days;
    uint256 internal constant ONE_USDC = 1e6;

    MockUsdc internal usdc;
    address internal safe;
    TimelockController internal timelock;

    RobotMoneyVault internal core;
    RobotMoneyGateway internal gateway;
    InvestmentCommitteePolicy internal ic;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal gov;
    AgentTokenVault internal agentVault;
    MockGovVault internal vaultA;
    MockGovVault internal vaultB;

    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");

    function setUp() public {
        _installSafeSet();
        safe = _newDefaultSafe();
        timelock = _newGovTimelock(safe, DELAY);

        usdc = new MockUsdc();
        core = Proxied.robotMoneyVault(
            usdc, type(uint256).max, type(uint256).max, 0, safe, address(this), address(this)
        );
        gateway = Proxied.robotMoneyGateway(usdc, core, address(this), pauser, address(0));
        ic = Proxied.investmentCommitteePolicy(address(this), address(gateway));
        registry = Proxied.vaultRegistry(address(this));
        router = Proxied.portfolioRouter(address(usdc), address(registry), address(this));
        gov = new RouterGovernance(address(router), address(this));
        agentVault = Proxied.agentTokenVault(
            IERC20(address(usdc)),
            ISwapRouter(address(new ShortlistStubSwapRouter())),
            10_000_000 * ONE_USDC,
            1_000_000 * ONE_USDC,
            0,
            safe,
            address(this),
            address(this)
        );

        // Stage 7: the weight setter holds the router roles (setDefaultWeights needs ADMIN_ROLE).
        router.grantRole(ADMIN_ROLE, address(gov));
        router.grantRole(keccak256("WEIGHT_SETTER_ROLE"), address(gov));
        router.revokeRole(keccak256("WEIGHT_SETTER_ROLE"), address(this));

        // Two router-eligible vaults so a default weight vector is valid.
        vaultA = new MockGovVault(address(usdc));
        vaultB = new MockGovVault(address(usdc));
        registry.registerVault(
            address(vaultA),
            VaultRegistry.VaultMetadata({name: "A", asset: address(usdc), registeredAt: 0})
        );
        registry.registerVault(
            address(vaultB),
            VaultRegistry.VaultMetadata({name: "B", asset: address(usdc), registeredAt: 0})
        );
        registry.setRouterEligible(address(vaultA), true);
        registry.setRouterEligible(address(vaultB), true);

        // Handover: the timelock gets ADMIN_ROLE on each, the deployer gives it up.
        address[5] memory governed =
            [address(core), address(gateway), address(ic), address(gov), address(agentVault)];
        for (uint256 i = 0; i < governed.length; i++) {
            IAccessControl(governed[i]).grantRole(ADMIN_ROLE, address(timelock));
            IAccessControl(governed[i]).revokeRole(ADMIN_ROLE, address(this));
        }
    }

    /// @dev Schedule, refuse an early execute, execute, then refuse the replay. All exact.
    function _runChecked(address target, bytes memory data, bytes32 salt) internal {
        _govSchedule(safe, timelock, target, data, salt, DELAY);
        _expectExecuteRefused(safe, timelock, target, data, salt);
        vm.warp(block.timestamp + DELAY);
        _govExecute(safe, timelock, target, data, salt);
        _expectExecuteRefused(safe, timelock, target, data, salt);
    }

    // ─── InvestmentCommitteePolicy ────────────────────────────────────────────

    function test_icPolicy_registerAndRevokeAgent_viaSafeThenTimelock() public {
        _runChecked(
            address(ic),
            abi.encodeCall(InvestmentCommitteePolicy.registerAgent, (agent, "agent-1")),
            keccak256("ic-register")
        );
        assertTrue(ic.hasRole(COMMITTEE_AGENT_ROLE, agent), "agent registered by the timelock");

        // Role revoke on the same surface.
        _runChecked(
            address(ic),
            abi.encodeCall(InvestmentCommitteePolicy.revokeAgent, (agent)),
            keccak256("ic-revoke")
        );
        assertFalse(ic.hasRole(COMMITTEE_AGENT_ROLE, agent), "agent revoked by the timelock");
    }

    function test_icPolicy_directSafeCallIsRefused_exactReason() public {
        _expectDirectSafeCallRefused(
            safe,
            address(ic),
            abi.encodeCall(InvestmentCommitteePolicy.registerAgent, (agent, "agent-1"))
        );
    }

    // ─── Adapter admin (RobotMoneyVault allowlist) ────────────────────────────

    function test_adapterAdmin_allowAdapterAndCodeHash_viaSafeThenTimelock() public {
        address adapter = makeAddr("adapter");
        _runChecked(
            address(core),
            abi.encodeCall(RobotMoneyVault.setAdapterAllowed, (adapter, true)),
            keccak256("adapter-allow")
        );
        assertTrue(core.adapterAllowed(adapter), "adapter allowed by the timelock");

        bytes32 codeHash = keccak256("adapter-code");
        _runChecked(
            address(core),
            abi.encodeCall(RobotMoneyVault.setAdapterCodeHashAllowed, (codeHash, true)),
            keccak256("adapter-codehash")
        );
        assertTrue(core.adapterCodeHashAllowed(codeHash), "codehash allowed by the timelock");

        // Revoking the allowlist is the same path.
        _runChecked(
            address(core),
            abi.encodeCall(RobotMoneyVault.setAdapterAllowed, (adapter, false)),
            keccak256("adapter-disallow")
        );
        assertFalse(core.adapterAllowed(adapter), "adapter disallowed by the timelock");
    }

    // ─── Role revoke ──────────────────────────────────────────────────────────

    function test_roleRevoke_gatewayAgentRole_viaSafeThenTimelock() public {
        _runChecked(
            address(gateway),
            abi.encodeCall(IAccessControl.grantRole, (AGENT_ROLE, agent)),
            keccak256("grant-agent")
        );
        assertTrue(gateway.hasRole(AGENT_ROLE, agent), "agent role granted");

        _runChecked(
            address(gateway),
            abi.encodeCall(IAccessControl.revokeRole, (AGENT_ROLE, agent)),
            keccak256("revoke-agent")
        );
        assertFalse(gateway.hasRole(AGENT_ROLE, agent), "agent role revoked by the timelock");
    }

    // ─── RouterGovernance after the handover ──────────────────────────────────

    function _sixtyForty() internal view returns (address[] memory vaults, uint256[] memory bps) {
        vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps = new uint256[](2);
        bps[0] = 6000;
        bps[1] = 4000;
    }

    function test_routerGovernance_setDefaultWeights_afterHandover_viaSafeThenTimelock() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        _runChecked(
            address(gov),
            abi.encodeCall(RouterGovernance.setDefaultWeights, (vaults, bps)),
            keccak256("default-weights")
        );
        (address[] memory got, uint256[] memory gotBps) = router.getDefaultWeights();
        assertEq(got.length, 2, "default vector set by the timelock");
        assertEq(got[0], address(vaultA));
        assertEq(gotBps[1], 4000);
        assertFalse(router.votedWeightsActive(), "the default is not an applied vector");
    }

    /// @notice Issue #1698: the register the weight setter's applyReceipt releases from is
    ///         set through the timelock (stage 11 sets it before the handover; a later change
    ///         is a Safe-scheduled operation).
    function test_routerGovernance_setReceiptContract_afterHandover_viaSafeThenTimelock() public {
        ConsensusRecommendationReceipt register =
            Proxied.consensusRecommendationReceipt(address(this), address(gateway), address(ic));
        assertEq(address(gov.receiptContract()), address(0));
        _runChecked(
            address(gov),
            abi.encodeCall(RouterGovernance.setReceiptContract, (address(register))),
            keccak256("receipt-register")
        );
        assertEq(address(gov.receiptContract()), address(register), "register set by the timelock");
    }

    function test_routerGovernance_directSafeCall_isRefused_exactReason() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        _expectDirectSafeCallRefused(
            safe, address(gov), abi.encodeCall(RouterGovernance.setDefaultWeights, (vaults, bps))
        );
    }

    // ─── AgentTokenVault non-asset setters ────────────────────────────────────

    function test_agentTokenVault_nonAssetSetters_viaSafeThenTimelock() public {
        address next = makeAddr("agentVaultFeeRecipient");
        _runChecked(
            address(agentVault),
            abi.encodeCall(BasketVault.setFeeRecipient, (next)),
            keccak256("atv-recipient")
        );
        assertEq(agentVault.feeRecipient(), next, "fee recipient set by the timelock");

        _runChecked(
            address(agentVault),
            abi.encodeCall(BasketVault.setExitFeeBps, (20)),
            keccak256("atv-exit-fee")
        );
        assertEq(agentVault.exitFeeBps(), 20, "exit fee set by the timelock");

        _runChecked(
            address(agentVault),
            abi.encodeCall(BasketVault.setPerDepositCap, (5 * ONE_USDC)),
            keccak256("atv-per-deposit")
        );
        assertEq(agentVault.perDepositCap(), 5 * ONE_USDC, "per-deposit cap set by the timelock");

        _runChecked(
            address(agentVault),
            abi.encodeCall(BasketVault.setTvlCap, (50 * ONE_USDC)),
            keccak256("atv-tvl")
        );
        assertEq(agentVault.tvlCap(), 50 * ONE_USDC, "TVL cap set by the timelock");
    }

    function test_agentTokenVault_directSafeCall_isRefused_exactReason() public {
        _expectDirectSafeCallRefused(
            safe, address(agentVault), abi.encodeCall(BasketVault.setExitFeeBps, (20))
        );
    }
}
