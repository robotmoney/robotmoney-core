// SPDX-License-Identifier: MIT
// Canonical: docs/code-reviews/20261121-214700-agy/01-governance-and-access-control.md (AGY-02)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProposerFloorTimelock} from "../ProposerFloorTimelock.sol";

/// @notice The executor floor of `ProposerFloorTimelock` (safety review 0.9.0, AGY-02): under the fund system's
///         Safe-only execution (D4-10) the Safe is the only executor, and dropping it would leave nothing executable.
contract ProposerFloorTimelockExecutorFloorTest is Test {
    address internal member = makeAddr("proposerExecutor");
    ProposerFloorTimelock internal timelock;

    function setUp() public {
        address[] memory one = new address[](1);
        one[0] = member;
        timelock = new ProposerFloorTimelock(60, one, one, address(0));
    }

    function test_lastExecutorCannotRenounce() public {
        bytes32 role = timelock.EXECUTOR_ROLE();
        assertEq(timelock.executorCount(), 1, "one account is the only executor");
        vm.prank(member);
        vm.expectRevert(ProposerFloorTimelock.LastExecutorFloor.selector);
        timelock.renounceRole(role, member);
    }

    function test_lastExecutorCannotBeRevoked() public {
        bytes32 role = timelock.EXECUTOR_ROLE();
        vm.prank(address(timelock));
        vm.expectRevert(ProposerFloorTimelock.LastExecutorFloor.selector);
        timelock.revokeRole(role, member);
    }

    function test_aSecondExecutorLetsTheFirstGo() public {
        bytes32 role = timelock.EXECUTOR_ROLE();
        address next = makeAddr("nextExecutor");
        vm.startPrank(address(timelock));
        timelock.grantRole(role, next);
        timelock.revokeRole(role, member);
        vm.stopPrank();
        assertEq(timelock.executorCount(), 1, "one executor left");
        assertTrue(timelock.hasRole(role, next), "the new executor holds the role");
    }

    function test_openExecutorCountsAsOneHolder() public {
        address[] memory proposers = new address[](1);
        proposers[0] = member;
        address[] memory open = new address[](1);
        open[0] = address(0);
        ProposerFloorTimelock t = new ProposerFloorTimelock(60, proposers, open, address(0));
        assertEq(t.executorCount(), 1, "address(0) counts");
        bytes32 role = t.EXECUTOR_ROLE();
        vm.prank(address(t));
        vm.expectRevert(ProposerFloorTimelock.LastExecutorFloor.selector);
        t.revokeRole(role, address(0));
    }

    function test_bornWithNoExecutorReverts() public {
        address[] memory proposers = new address[](1);
        proposers[0] = member;
        vm.expectRevert(ProposerFloorTimelock.NoExecutor.selector);
        new ProposerFloorTimelock(60, proposers, new address[](0), address(0));
    }
}
