// SPDX-License-Identifier: MIT
// Canonical: docs/technical/governance-decisions.md §3.4 — the receipt submitters and the weight setter are disjoint
// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §3.4
// Implements: issue #1248 acceptance criterion 3 and Test plan item 1, as
//             restated by issue #1698 — the RECEIPT_SUBMITTER_ROLE holder set and
//             the weight-authority holder set MUST be disjoint.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {ConsensusRecommendationReceipt} from "../ConsensusRecommendationReceipt.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

/// @title GovernanceSeparationInvariant
/// @notice Verifies the decision that the committee and the weight setter are
///         separate bodies: no address may hold both `RECEIPT_SUBMITTER_ROLE` on
///         the ConsensusRecommendationReceipt and any weight authority, meaning
///         `WEIGHT_SETTER_ROLE` or `ADMIN_ROLE` on `RouterGovernance`, or
///         `WEIGHT_SETTER_ROLE` on the `PortfolioRouter`.
///
///         The committee recommends (it records a receipt); the Safe, through
///         the timelock that holds the weight-setter role, applies it. There is
///         no voting. INV-4's signalling-only boundary (`docs/prd.md` §12) is a
///         control, not a label, precisely because the parties that recommend
///         and the parties that apply never overlap. Granting a committee agent
///         any weight authority is a security-model change needing a new ADR,
///         so this test fails loudly if that overlap ever appears.
contract GovernanceSeparationInvariant is Test {
    // ─── Actors ──────────────────────────────────────────────────────────────

    address internal admin = makeAddr("admin");

    // Committee body (ConsensusRecommendationReceipt.RECEIPT_SUBMITTER_ROLE).
    address internal committeeAthena = makeAddr("committee-athena");
    address internal committeeRobotMoney = makeAddr("committee-robotmoney");
    address internal committeeWoon = makeAddr("committee-woon");

    // Applying body: the timelock, the only governance WEIGHT_SETTER_ROLE holder.
    address internal timelock = makeAddr("timelock");

    address internal intruder = makeAddr("intruder");

    // ─── Contracts ───────────────────────────────────────────────────────────

    ConsensusRecommendationReceipt internal ic;
    PortfolioRouter internal router;
    RouterGovernance internal gov;

    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant WEIGHT_SETTER_ROLE = keccak256("WEIGHT_SETTER_ROLE");

    // ─── Setup ───────────────────────────────────────────────────────────────

    function setUp() public {
        // Recommending body: the receipt submitters. This invariant asserts role membership.
        ic = CoreProxies.consensusRecommendationReceipt(admin);
        bytes32 committeeRole = ic.RECEIPT_SUBMITTER_ROLE();
        vm.startPrank(admin);
        ic.grantRole(committeeRole, committeeAthena);
        ic.grantRole(committeeRole, committeeRobotMoney);
        ic.grantRole(committeeRole, committeeWoon);
        vm.stopPrank();

        // Applying body: RouterGovernance holds the router's weight role, and
        // the timelock holds governance ADMIN_ROLE and WEIGHT_SETTER_ROLE.
        TestERC20 usdc = new TestERC20();
        VaultRegistry registry = CoreProxies.vaultRegistry(admin);
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), admin);
        gov = CoreProxies.routerGovernance(address(router), makeAddr("receipts"), admin);
        vm.startPrank(admin);
        router.grantRole(ADMIN_ROLE, address(gov));
        router.grantRole(WEIGHT_SETTER_ROLE, address(gov));
        router.revokeRole(WEIGHT_SETTER_ROLE, admin);
        gov.grantRole(ADMIN_ROLE, timelock);
        gov.grantRole(WEIGHT_SETTER_ROLE, timelock);
        gov.revokeRole(WEIGHT_SETTER_ROLE, admin);
        vm.stopPrank();
    }

    // ─── The invariant ───────────────────────────────────────────────────────

    function _swept() internal view returns (address[6] memory) {
        return [committeeAthena, committeeRobotMoney, committeeWoon, timelock, admin, intruder];
    }

    /// @dev True iff no swept address holds both RECEIPT_SUBMITTER_ROLE and any
    ///      weight authority.
    function _separationHolds() internal view returns (bool) {
        address[6] memory swept = _swept();
        for (uint256 i = 0; i < swept.length; i++) {
            if (_overlap(swept[i])) return false;
        }
        return true;
    }

    function _hasWeightAuthority(address account) internal view returns (bool) {
        return gov.hasRole(WEIGHT_SETTER_ROLE, account) || gov.hasRole(ADMIN_ROLE, account)
            || router.hasRole(WEIGHT_SETTER_ROLE, account);
    }

    /// @dev True iff `account` has RECEIPT_SUBMITTER_ROLE AND weight authority.
    function _overlap(address account) internal view returns (bool) {
        return ic.hasRole(ic.RECEIPT_SUBMITTER_ROLE(), account) && _hasWeightAuthority(account);
    }

    // ─── AC3: committee and weight setter are disjoint ───────────────────────

    /// @notice The configured committee agents hold no weight authority.
    function test_committeeAgentsHaveNoWeightAuthority() public view {
        assertFalse(_hasWeightAuthority(committeeAthena), "athena must not hold weight authority");
        assertFalse(
            _hasWeightAuthority(committeeRobotMoney), "robotmoney must not hold weight authority"
        );
        assertFalse(_hasWeightAuthority(committeeWoon), "woon must not hold weight authority");
    }

    /// @notice The weight setter (the timelock) is not a committee agent, and
    ///         RouterGovernance is the router's only weight setter.
    function test_weightSetterIsNotACommitteeAgent() public view {
        assertTrue(gov.hasRole(WEIGHT_SETTER_ROLE, timelock), "timelock applies receipts");
        assertFalse(
            ic.hasRole(ic.RECEIPT_SUBMITTER_ROLE(), timelock), "timelock is a receipt submitter"
        );
        assertEq(router.getRoleMemberCount(WEIGHT_SETTER_ROLE), 1);
        assertEq(router.getRoleMember(WEIGHT_SETTER_ROLE, 0), address(gov));
    }

    /// @notice The committee holders are recognised by the receipt contract.
    function test_committeeHoldersAreRecognisedByPolicy() public view {
        bytes32 committeeRole = ic.RECEIPT_SUBMITTER_ROLE();
        assertTrue(ic.hasRole(committeeRole, committeeAthena), "athena must be a receipt submitter");
        assertTrue(
            ic.hasRole(committeeRole, committeeRobotMoney), "robotmoney must be a receipt submitter"
        );
        assertTrue(ic.hasRole(committeeRole, committeeWoon), "woon must be a receipt submitter");
    }

    /// @notice The full configured topology satisfies the separation invariant.
    function test_separationInvariantHolds() public view {
        assertTrue(_separationHolds(), "committee agents and the weight setter must be disjoint");
    }

    // ─── Negative path: the invariant is a security-model change ─────────────

    /// @notice A receipt submitter granted governance ADMIN_ROLE is flagged.
    function test_invariantFlagsCommitteeAgentWithWeightAuthority() public {
        vm.prank(timelock);
        gov.grantRole(ADMIN_ROLE, committeeAthena);
        assertFalse(
            _separationHolds(),
            "granting a committee agent weight authority must break the invariant"
        );
        assertTrue(_overlap(committeeAthena));
    }

    /// @notice The weight setter additionally granted RECEIPT_SUBMITTER_ROLE is flagged.
    function test_invariantFlagsWeightSetterGivenCommitteeRole() public {
        bytes32 committeeRole = ic.RECEIPT_SUBMITTER_ROLE();
        vm.prank(admin);
        ic.grantRole(committeeRole, timelock);
        assertFalse(
            _separationHolds(),
            "granting the weight setter RECEIPT_SUBMITTER_ROLE must break the invariant"
        );
        assertTrue(_overlap(timelock));
    }
}
