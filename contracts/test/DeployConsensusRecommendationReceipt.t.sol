// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.8, §4.9 — Receipt Submitter Authority, Consensus Receipt
// Implements: issue #1247 acceptance criteria 2 and 10, task 4.10; issue 1888 (receipt deploys alone)
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {
    DeployConsensusRecommendationReceipt
} from "../script/DeployConsensusRecommendationReceipt.s.sol";
import {IConsensusRecommendationReceipt} from "../interfaces/IConsensusRecommendationReceipt.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";

/// @title DeployConsensusRecommendationReceiptTest
/// @notice The receipt contract deploys ALONE (no gateway, no committee registry), and
///         `ADMIN_ROLE` on it lands on the `TimelockController` and nowhere else. The
///         as-deployed wiring records directly through a Safe-granted submitter.
contract DeployConsensusRecommendationReceiptTest is SafeGovernance {
    address submitter = address(0xB1);
    address stranger = address(0xDEAD);
    /// A real SafeL2 1.4.1 proxy: the only proposer and canceller on the timelock.
    address safe;

    TimelockController timelock;
    DeployConsensusRecommendationReceipt script;
    DeployConsensusRecommendationReceipt.Deployed d;

    function setUp() public {
        _installSafeSet();
        safe = _newDefaultSafe();
        timelock = _newGovTimelock(safe, 1 hours);

        script = new DeployConsensusRecommendationReceipt();
        d = script.runInProcessWith(address(timelock));
    }

    /// @dev The receipt deploys alone: its retired gateway and IC slots stay empty.
    function testReceiptDeploysAloneWithRetiredSlotsEmpty() public view {
        assertTrue(address(d.receipts) != address(0), "receipt contract deployed");
        assertEq(
            address(uint160(uint256(vm.load(address(d.receipts), bytes32(0))))),
            address(0),
            "retired writer slot empty"
        );
        assertEq(d.receipts.icPolicy(), address(0), "no IC policy binding");
    }

    /// @dev INV-3: `ADMIN_ROLE` on the receipt contract is held by the TimelockController
    ///      and by nobody else.
    function testReceiptAdminRoleIsTimelockOnly() public view {
        bytes32 role = d.receipts.ADMIN_ROLE();
        assertTrue(d.receipts.hasRole(role, address(timelock)), "timelock holds ADMIN_ROLE");
        assertEq(d.receipts.getRoleMemberCount(role), 1, "the timelock alone holds ADMIN_ROLE");
        assertFalse(d.receipts.hasRole(role, address(script)), "deployer must not hold it");
        assertTrue(
            d.receipts.hasRole(d.receipts.DEFAULT_ADMIN_ROLE(), address(timelock)),
            "timelock holds DEFAULT_ADMIN_ROLE"
        );
        assertEq(
            d.receipts.getRoleMemberCount(d.receipts.RECEIPT_SUBMITTER_ROLE()),
            0,
            "no submitter at deploy"
        );
        assertEq(
            d.receipts.getRoleMemberCount(d.receipts.RECEIPT_RELEASER_ROLE()),
            0,
            "no releaser at deploy"
        );
    }

    /// @dev The as-deployed wiring anchors: the Safe, through the timelock, grants the submitter
    ///      role, the submitter records directly, and the timelock cannot release (no release
    ///      role) while a stranger cannot record.
    function testDeployedWiringAnchorsDirectly() public {
        bytes32 submitterRole = d.receipts.RECEIPT_SUBMITTER_ROLE();
        bytes memory grant = abi.encodeCall(d.receipts.grantRole, (submitterRole, submitter));
        _govSchedule(safe, timelock, address(d.receipts), grant, bytes32(0), 1 hours);
        _expectExecuteRefused(safe, timelock, address(d.receipts), grant, bytes32(0));
        vm.warp(block.timestamp + 1 hours);
        _govExecute(safe, timelock, address(d.receipts), grant, bytes32(0));
        assertTrue(d.receipts.hasRole(submitterRole, submitter));

        bytes32 id = keccak256("ceremony-receipt");
        bytes32 digest = keccak256("ceremony-digest");
        vm.prank(stranger);
        vm.expectRevert(IConsensusRecommendationReceipt.SubmitterNotAllowlisted.selector);
        d.receipts.recordReceipt(id, digest, "https://robotmoney.net/api/swarm/receipts/s1");

        vm.prank(submitter);
        d.receipts.recordReceipt(id, digest, "https://robotmoney.net/api/swarm/receipts/s1");
        assertEq(d.receipts.getReceiptById(id).payloadDigest, digest);
        assertEq(d.receipts.getReceiptById(id).submitter, submitter);

        vm.prank(address(timelock));
        vm.expectRevert();
        d.receipts.releaseReceipt(id);
    }
}
