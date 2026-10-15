// SPDX-License-Identifier: MIT
// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §3.4
// Canonical: docs/technical/governance-decisions.md §3.4 — the committee and the weight setter are disjoint
// Implements: issue #1248 acceptance criterion 3 and Test plan item 1 —
//             the COMMITTEE_AGENT_ROLE holder set and the weight-setting
//             authority set MUST be disjoint.
// Implements: issue #1698 — voting deleted; the weight setter is RouterGovernance behind the timelock
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {Proxied} from "./helpers/Proxied.sol";

/// @title GovernanceSeparationInvariant
/// @notice Verifies the §3.4 decision that the committee and the weight setter
///         are separate bodies: no address may hold both `COMMITTEE_AGENT_ROLE`
///         on the InvestmentCommitteePolicy and any weight-setting authority:
///         `WEIGHT_SETTER_ROLE` or `ADMIN_ROLE` on the PortfolioRouter, or
///         `ADMIN_ROLE` on RouterGovernance (the timelock's seat, from which
///         `applyReceipt` is reached).
///
///         The two bodies are separately administered (committee agents are
///         allowlisted through the IC policy's `COMMITTEE_AGENT_ROLE`; the
///         weight setter's admin is granted by `ADMIN_ROLE` on
///         `RouterGovernance`). There is deliberately no on-chain link between
///         them — INV-4's signalling-only boundary (`docs/prd.md` §12) is a
///         *control*, not a label, precisely because the parties that recommend
///         and the party that applies never overlap. The invariant asserted
///         here is a deployment-level invariant over that live state.
///
///         It is a security-model change (requiring a new ADR against INV-4)
///         to grant a committee agent any weight-setting authority or to grant
///         the weight setter's admin the COMMITTEE_AGENT_ROLE, so this test
///         fails loudly if that overlap ever appears in the configured topology.
///         There is no voter set and no quorum (issue #1698): the only
///         threshold in the path is the Safe's signer threshold.
contract GovernanceSeparationInvariant is Test {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant WEIGHT_SETTER_ROLE = keccak256("WEIGHT_SETTER_ROLE");

    // ─── Actors ──────────────────────────────────────────────────────────────

    address internal admin = makeAddr("admin");

    // Committee body (InvestmentCommitteePolicy.COMMITTEE_AGENT_ROLE).
    address internal committeeAthena = makeAddr("committee-athena");
    address internal committeeRobotMoney = makeAddr("committee-robotmoney");
    address internal committeeWoon = makeAddr("committee-woon");

    // Applying body: the timelock seat that holds RouterGovernance ADMIN_ROLE.
    address internal timelock = makeAddr("timelock");

    address internal intruder = makeAddr("intruder");

    // ─── Contracts ───────────────────────────────────────────────────────────

    InvestmentCommitteePolicy internal ic;
    PortfolioRouter internal router;
    RouterGovernance internal gov;

    // ─── Setup ───────────────────────────────────────────────────────────────

    function setUp() public {
        // Committee body: InvestmentCommitteePolicy. The gateway address is
        // only required non-zero by the constructor; this invariant asserts
        // role membership (not gateway-routed operations), so a dummy gateway
        // address is sufficient.
        ic = Proxied.investmentCommitteePolicy(admin, makeAddr("gateway"));
        bytes32 committeeRole = ic.COMMITTEE_AGENT_ROLE();
        vm.startPrank(admin);
        ic.grantRole(committeeRole, committeeAthena);
        ic.grantRole(committeeRole, committeeRobotMoney);
        ic.grantRole(committeeRole, committeeWoon);
        vm.stopPrank();

        // Applying body: RouterGovernance wired to a PortfolioRouter the way
        // stage 7 and stage 11 leave it. The weight setter holds the router
        // roles; the timelock holds the weight setter's ADMIN_ROLE and the
        // router's ADMIN_ROLE; the deployer keeps nothing.
        TestERC20 usdc = new TestERC20();
        VaultRegistry registry = Proxied.vaultRegistry(admin);
        router = Proxied.portfolioRouter(address(usdc), address(registry), admin);
        gov = new RouterGovernance(address(router), admin);
        vm.startPrank(admin);
        router.grantRole(ADMIN_ROLE, address(gov));
        router.grantRole(WEIGHT_SETTER_ROLE, address(gov));
        router.revokeRole(WEIGHT_SETTER_ROLE, admin);
        router.grantRole(ADMIN_ROLE, timelock);
        router.revokeRole(ADMIN_ROLE, admin);
        gov.grantRole(ADMIN_ROLE, timelock);
        gov.revokeRole(ADMIN_ROLE, admin);
        vm.stopPrank();
    }

    // ─── The invariant ───────────────────────────────────────────────────────

    /// @dev True iff `account` holds any weight-setting authority.
    function _setsWeights(address account) internal view returns (bool) {
        return router.hasRole(WEIGHT_SETTER_ROLE, account) || router.hasRole(ADMIN_ROLE, account)
            || gov.hasRole(ADMIN_ROLE, account);
    }

    /// @dev True iff `account` has COMMITTEE_AGENT_ROLE AND weight-setting authority.
    function _overlap(bytes32 committeeRole, address account) internal view returns (bool) {
        return ic.hasRole(committeeRole, account) && _setsWeights(account);
    }

    /// @dev True iff no address holds both. Written as a predicate so the whole
    ///      topology can be swept in one place.
    function _separationHolds() internal view returns (bool) {
        bytes32 committeeRole = ic.COMMITTEE_AGENT_ROLE();
        return !_overlap(committeeRole, committeeAthena)
            && !_overlap(committeeRole, committeeRobotMoney)
            && !_overlap(committeeRole, committeeWoon) && !_overlap(committeeRole, timelock)
            && !_overlap(committeeRole, address(gov)) && !_overlap(committeeRole, admin)
            && !_overlap(committeeRole, intruder);
    }

    // ─── AC3: committee and the weight setter are disjoint ───────────────────

    /// @notice The configured committee agents hold COMMITTEE_AGENT_ROLE but
    ///         NO weight-setting authority.
    function test_committeeAgentsSetNoWeights() public view {
        assertFalse(_setsWeights(committeeAthena), "athena must not set weights");
        assertFalse(_setsWeights(committeeRobotMoney), "robotmoney must not set weights");
        assertFalse(_setsWeights(committeeWoon), "woon must not set weights");
    }

    /// @notice The weight setter and its admin (the timelock) hold weight
    ///         authority but do NOT hold COMMITTEE_AGENT_ROLE.
    function test_weightSettersAreNotCommitteeAgents() public view {
        bytes32 committeeRole = ic.COMMITTEE_AGENT_ROLE();
        assertTrue(_setsWeights(address(gov)), "the weight setter must hold the router roles");
        assertTrue(_setsWeights(timelock), "the timelock must reach applyReceipt");
        assertFalse(ic.hasRole(committeeRole, address(gov)), "weight setter is a committee agent");
        assertFalse(ic.hasRole(committeeRole, timelock), "timelock is a committee agent");
    }

    /// @notice The configured committee agents are recognised by the policy.
    function test_committeeHoldersAreRecognisedByPolicy() public view {
        bytes32 committeeRole = ic.COMMITTEE_AGENT_ROLE();
        assertTrue(ic.hasRole(committeeRole, committeeAthena), "athena must be a committee agent");
        assertTrue(
            ic.hasRole(committeeRole, committeeRobotMoney), "robotmoney must be a committee agent"
        );
        assertTrue(ic.hasRole(committeeRole, committeeWoon), "woon must be a committee agent");
    }

    /// @notice The full configured topology satisfies the separation invariant.
    function test_separationInvariantHolds() public view {
        assertTrue(_separationHolds(), "committee agents and weight setters must be disjoint");
    }

    /// @notice The deployer kept nothing: the only weight authorities are the
    ///         weight setter (router roles) and the timelock (its ADMIN_ROLE).
    function test_deployerHoldsNoWeightAuthority() public view {
        assertFalse(_setsWeights(admin), "the deployer must keep no weight authority");
        assertEq(router.getRoleMemberCount(WEIGHT_SETTER_ROLE), 1, "one weight setter");
        assertEq(router.getRoleMember(WEIGHT_SETTER_ROLE, 0), address(gov));
        assertEq(gov.getRoleMemberCount(ADMIN_ROLE), 1, "one weight-setter admin");
        assertEq(gov.getRoleMember(ADMIN_ROLE, 0), timelock);
    }

    // ─── Negative path: the invariant is a security-model change ─────────────

    /// @notice A committee agent who receives the weight setter's ADMIN_ROLE (a
    ///         security-model change needing an ADR against INV-4) is flagged by
    ///         the invariant. This asserts the predicate catches the overlap it
    ///         is supposed to prevent; it mutates only the test's own live
    ///         state, never the shipped topology.
    function test_invariantFlagsCommitteeAgentGivenWeightSetterAdmin() public {
        vm.prank(timelock);
        gov.grantRole(ADMIN_ROLE, committeeAthena);
        assertFalse(
            _separationHolds(),
            "granting a committee agent the weight setter's ADMIN_ROLE must break the invariant"
        );
        assertTrue(_overlap(ic.COMMITTEE_AGENT_ROLE(), committeeAthena));
    }

    /// @notice A committee agent who receives the router's WEIGHT_SETTER_ROLE is
    ///         flagged too (the role is self-administered: only a holder grants it).
    function test_invariantFlagsCommitteeAgentGivenWeightSetterRole() public {
        vm.prank(address(gov));
        router.grantRole(WEIGHT_SETTER_ROLE, committeeWoon);
        assertFalse(
            _separationHolds(),
            "granting a committee agent WEIGHT_SETTER_ROLE must break the invariant"
        );
    }

    /// @notice The timelock seat additionally granted COMMITTEE_AGENT_ROLE (a
    ///         security-model change) is flagged by the invariant.
    function test_invariantFlagsWeightSetterAdminGivenCommitteeRole() public {
        bytes32 committeeRole = ic.COMMITTEE_AGENT_ROLE();
        vm.prank(admin);
        ic.grantRole(committeeRole, timelock);
        assertFalse(
            _separationHolds(),
            "granting the weight setter's admin COMMITTEE_AGENT_ROLE must break the invariant"
        );
        assertTrue(_overlap(committeeRole, timelock));
    }
}
