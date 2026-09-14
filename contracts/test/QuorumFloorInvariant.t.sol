// SPDX-License-Identifier: MIT
// Canonical: project-fusion.md §5 D16 — MIN_QUORUM_THRESHOLD = 2 in the
//            contract AND a watchdog page on quorumThreshold() <= 1.
// Canonical: docs/technical/router-governance-handoff-runbook.md §1.1
// Implements: fusion round-2 task T22 — raise the quorum floor out of the
//             deploy script and into the contract, so a hollow single-voter
//             quorum cannot be restored by an ADMIN_ROLE holder after the
//             AC-GOV-03 evidence was collected.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @title QuorumFloorInvariant
/// @notice The quorum floor is a property of the CONTRACT, not of the deploy
///         script. `DeployRouterGovernance` already refuses
///         `QUORUM_THRESHOLD <= 1` on both entrypoints, but that guard only
///         covers the deployment instant: `setQuorumThreshold(1)` afterwards
///         succeeded for any `ADMIN_ROLE` holder, and so did a constructor
///         call that bypassed the script entirely (every fixture, every fork
///         test, and any hand-rolled `forge create`). AC-GOV-03's "quorum 2 of
///         total voting power 2" was therefore reversible with one
///         transaction and no on-chain refusal.
///
///         These tests pin the floor at both doors — constructor and setter —
///         because those are the only two ways `quorumThreshold` is ever
///         written.
contract QuorumFloorInvariantTest is Test {
    RouterGovernance internal gov;
    PortfolioRouter internal router;

    address internal admin = makeAddr("gov-admin");
    address internal outsider = makeAddr("outsider");

    uint64 internal constant VOTING_PERIOD = 1 days;
    uint64 internal constant EXECUTION_DELAY = 1 days;
    uint256 internal constant QUORUM_THRESHOLD = 2;

    function setUp() public {
        TestERC20 usdc = new TestERC20();
        VaultRegistry registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);
        gov = new RouterGovernance(
            address(router), admin, VOTING_PERIOD, EXECUTION_DELAY, QUORUM_THRESHOLD
        );
    }

    // ─── The floor constant ──────────────────────────────────────────────────

    /// @notice D16: the floor is 2, not the MVP placeholder 1.
    function test_minQuorumThresholdIsTwo() public view {
        assertEq(gov.MIN_QUORUM_THRESHOLD(), 2, "MIN_QUORUM_THRESHOLD must be 2 (D16)");
    }

    // ─── Door 1: the constructor ─────────────────────────────────────────────

    /// @notice A constructor call with quorum 1 must revert. This is the door
    ///         every test fixture and every `forge create` uses, and the one
    ///         the deploy-script guard does not cover.
    function test_constructorRefusesQuorumOne() public {
        vm.expectRevert(RouterGovernance.QuorumBelowMinimum.selector);
        new RouterGovernance(address(router), admin, VOTING_PERIOD, EXECUTION_DELAY, 1);
    }

    function test_constructorRefusesQuorumZero() public {
        vm.expectRevert(RouterGovernance.QuorumBelowMinimum.selector);
        new RouterGovernance(address(router), admin, VOTING_PERIOD, EXECUTION_DELAY, 0);
    }

    /// @notice The floor itself is still deployable — the refusal is a floor,
    ///         not a ban on the boundary value.
    function test_constructorAcceptsExactlyTheFloor() public {
        RouterGovernance fresh = new RouterGovernance(
            address(router), admin, VOTING_PERIOD, EXECUTION_DELAY, gov.MIN_QUORUM_THRESHOLD()
        );
        assertEq(fresh.quorumThreshold(), 2);
    }

    // ─── Door 2: the setter ──────────────────────────────────────────────────

    /// @notice THE regression this task exists for: an ADMIN_ROLE holder could
    ///         walk a live deployment back down to a hollow quorum of 1 after
    ///         the acceptance evidence was collected.
    function test_setQuorumThresholdRefusesOne() public {
        vm.prank(admin);
        vm.expectRevert(RouterGovernance.QuorumBelowMinimum.selector);
        gov.setQuorumThreshold(1);

        assertEq(gov.quorumThreshold(), QUORUM_THRESHOLD, "quorum must be unchanged after refusal");
    }

    function test_setQuorumThresholdRefusesZero() public {
        vm.prank(admin);
        vm.expectRevert(RouterGovernance.QuorumBelowMinimum.selector);
        gov.setQuorumThreshold(0);
    }

    function test_setQuorumThresholdAcceptsTheFloorAndAbove() public {
        vm.startPrank(admin);
        gov.setQuorumThreshold(2);
        assertEq(gov.quorumThreshold(), 2);
        gov.setQuorumThreshold(9);
        assertEq(gov.quorumThreshold(), 9);
        vm.stopPrank();
    }

    /// @notice The floor does not replace the access-control check.
    function test_setQuorumThresholdStillRequiresAdminRole() public {
        vm.prank(outsider);
        vm.expectRevert();
        gov.setQuorumThreshold(5);
    }

    /// @notice Whatever path wrote it, a live deployment always reads back a
    ///         quorum above the placeholder. This is the assertion the
    ///         watchdog mirrors off chain (D16, second half).
    function test_liveQuorumIsAlwaysAboveThePlaceholder() public view {
        assertGt(gov.quorumThreshold(), 1, "live quorumThreshold() <= 1 is a pageable condition");
    }
}
