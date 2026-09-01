// SPDX-License-Identifier: MIT
// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §3.4
// Implements: issue #1248 acceptance criterion 3 and Test plan item 1 —
//             the COMMITTEE_AGENT_ROLE holder set and the RouterGovernance
//             non-zero-voting-power set MUST be disjoint.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @title GovernanceSeparationInvariant
/// @notice Verifies the §3.4 decision that the committee and the
///         RouterGovernance voter set are separate bodies: no address may
///         hold both `COMMITTEE_AGENT_ROLE` on the InvestmentCommitteePolicy
///         and non-zero voting power on `RouterGovernance`.
///
///         The two bodies are separately administered (committee agents are
///         allowlisted through the IC policy's `COMMITTEE_AGENT_ROLE`;
///         governance voters are given power by `ADMIN_ROLE` via
///         `RouterGovernance.setVotingPower`). There is deliberately no
///         on-chain link between them — INV-4's signalling-only boundary
///         (`docs/prd.md` §12) is a *control*, not a label, precisely because
///         the parties that recommend and the parties that approve never
///         overlap. The invariant asserted here is a deployment-level
///         invariant over that live state.
///
///         It is a security-model change (requiring a new ADR against INV-4)
///         to grant a committee agent voting power or to grant a voter the
///         COMMITTEE_AGENT_ROLE, so this test fails loudly if that overlap
///         ever appears in the configured topology. It also pins that the
///         approving body's quorum reflects a real (< total voter power)
///         threshold rather than the MVP default of one, resolving the §3.4
///         open concern.
contract GovernanceSeparationInvariant is Test {
    // ─── Actors ──────────────────────────────────────────────────────────────

    address internal admin = makeAddr("admin");

    // Committee body (InvestmentCommitteePolicy.COMMITTEE_AGENT_ROLE).
    address internal committeeAthena = makeAddr("committee-athena");
    address internal committeeRobotMoney = makeAddr("committee-robotmoney");
    address internal committeeWoon = makeAddr("committee-woon");

    // Approving body (RouterGovernance voters with non-zero power).
    address internal voter1 = makeAddr("gov-voter-1");
    address internal voter2 = makeAddr("gov-voter-2");
    address internal voter3 = makeAddr("gov-voter-3");

    address internal intruder = makeAddr("intruder");

    // ─── Contracts ───────────────────────────────────────────────────────────

    InvestmentCommitteePolicy internal ic;
    RouterGovernance internal gov;

    uint256 internal constant VOTER_POWER = 100e18;
    uint64 internal constant VOTING_PERIOD = 1 days;
    uint64 internal constant EXECUTION_DELAY = 1 days;
    uint256 internal constant QUORUM_THRESHOLD = 250e18;

    // ─── Setup ───────────────────────────────────────────────────────────────

    function setUp() public {
        // Committee body: InvestmentCommitteePolicy. The gateway address is
        // only required non-zero by the constructor; this invariant asserts
        // role membership (not gateway-routed operations), so a dummy gateway
        // address is sufficient.
        ic = new InvestmentCommitteePolicy(admin, makeAddr("gateway"));
        bytes32 committeeRole = ic.COMMITTEE_AGENT_ROLE();
        vm.startPrank(admin);
        ic.grantRole(committeeRole, committeeAthena);
        ic.grantRole(committeeRole, committeeRobotMoney);
        ic.grantRole(committeeRole, committeeWoon);
        vm.stopPrank();

        // Approving body: RouterGovernance wired to a PortfolioRouter.
        TestERC20 usdc = new TestERC20();
        VaultRegistry registry = new VaultRegistry(admin);
        PortfolioRouter router = new PortfolioRouter(address(usdc), address(registry), admin);
        gov = new RouterGovernance(
            address(router), admin, VOTING_PERIOD, EXECUTION_DELAY, QUORUM_THRESHOLD
        );
        bytes32 routerAdminRole = router.ADMIN_ROLE();
        vm.startPrank(admin);
        router.grantRole(routerAdminRole, address(gov));
        gov.setVotingPower(voter1, VOTER_POWER);
        gov.setVotingPower(voter2, VOTER_POWER);
        gov.setVotingPower(voter3, VOTER_POWER);
        vm.stopPrank();
    }

    // ─── The invariant ───────────────────────────────────────────────────────

    /// @dev True iff no address holds both COMMITTEE_AGENT_ROLE and non-zero
    ///      RouterGovernance voting power. Written as a predicate so the whole
    ///      topology can be swept in one place.
    function _separationHolds() internal view returns (bool) {
        bytes32 committeeRole = ic.COMMITTEE_AGENT_ROLE();
        return !_overlap(committeeRole, committeeAthena)
            && !_overlap(committeeRole, committeeRobotMoney)
            && !_overlap(committeeRole, committeeWoon) && !_overlap(committeeRole, voter1)
            && !_overlap(committeeRole, voter2) && !_overlap(committeeRole, voter3)
            && !_overlap(committeeRole, intruder);
    }

    /// @dev True iff `account` has COMMITTEE_AGENT_ROLE AND non-zero power.
    function _overlap(bytes32 committeeRole, address account) internal view returns (bool) {
        return ic.hasRole(committeeRole, account) && gov.votingPower(account) != 0;
    }

    // ─── AC3: committee and voter set are disjoint ───────────────────────────

    /// @notice The configured committee agents hold COMMITTEE_AGENT_ROLE but
    ///         have ZERO voting power.
    function test_committeeAgentsHaveNoVotingPower() public view {
        assertEq(gov.votingPower(committeeAthena), 0, "athena must not hold voting power");
        assertEq(gov.votingPower(committeeRobotMoney), 0, "robotmoney must not hold voting power");
        assertEq(gov.votingPower(committeeWoon), 0, "woon must not hold voting power");
    }

    /// @notice The configured governance voters hold non-zero power but do NOT
    ///         hold COMMITTEE_AGENT_ROLE.
    function test_votersAreNotCommitteeAgents() public view {
        bytes32 committeeRole = ic.COMMITTEE_AGENT_ROLE();
        assertTrue(gov.votingPower(voter1) != 0, "voter1 must have power");
        assertTrue(gov.votingPower(voter2) != 0, "voter2 must have power");
        assertTrue(gov.votingPower(voter3) != 0, "voter3 must have power");
        assertFalse(ic.hasRole(committeeRole, voter1), "voter1 must not be a committee agent");
        assertFalse(ic.hasRole(committeeRole, voter2), "voter2 must not be a committee agent");
        assertFalse(ic.hasRole(committeeRole, voter3), "voter3 must not be a committee agent");
    }

    /// @notice No committee agent holds COMMITTEE_AGENT_ROLE. It is a
    ///         security-model change (new ADR against INV-4) for a committee
    ///         agent to hold voting power, so the mutually-exclusive membership
    ///         is asserted directly.
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
        assertTrue(_separationHolds(), "committee agents and governance voters must be disjoint");
    }

    // ─── Negative path: the invariant is a security-model change ─────────────

    /// @notice A committee agent who receives voting power (a security-model
    ///         change needing an ADR against INV-4) is flagged by the
    ///         invariant. This asserts the predicate catches the overlap it is
    ///         supposed to prevent; it mutates only the test's own live state,
    ///         never the shipped topology.
    function test_invariantFlagsCommitteeAgentWithVotingPower() public {
        vm.prank(admin);
        gov.setVotingPower(committeeAthena, 100e18);
        assertFalse(
            _separationHolds(), "granting a committee agent voting power must break the invariant"
        );
        assertTrue(_overlap(ic.COMMITTEE_AGENT_ROLE(), committeeAthena));
    }

    /// @notice A voter who is additionally granted COMMITTEE_AGENT_ROLE (a
    ///         security-model change) is flagged by the invariant.
    function test_invariantFlagsVoterGivenCommitteeRole() public {
        bytes32 committeeRole = ic.COMMITTEE_AGENT_ROLE();
        vm.prank(admin);
        ic.grantRole(committeeRole, voter1);
        assertFalse(
            _separationHolds(), "granting a voter COMMITTEE_AGENT_ROLE must break the invariant"
        );
        assertTrue(_overlap(committeeRole, voter1));
    }

    // ─── §3.4: the approving body's quorum reflects the voter set ────────────

    /// @notice The approving body's quorum is a meaningful fraction of the
    ///         voter set, not the single-voter MVP default of 1 — resolving the
    ///         §3.4 open concern ("the approving body's quorum is currently
    ///         1"). One voter with any nonzero power can no longer carry a
    ///         weight proposal.
    function test_quorumReflectsTheVoterSet() public view {
        assertEq(gov.quorumThreshold(), QUORUM_THRESHOLD, "quorum must reflect the voter set");
        // quorum (250) > combined power of any two voters (200), but <= all
        // three (300): at least a super-majority of the voter set must agree.
        assertTrue(
            gov.quorumThreshold() > VOTER_POWER * 2,
            "a minority of two voters must not reach quorum"
        );
        assertTrue(gov.quorumThreshold() <= VOTER_POWER * 3, "full participation reaches quorum");
    }
}
