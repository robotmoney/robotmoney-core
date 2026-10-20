// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md
// Canonical: docs/architecture.md §4.8, §4.9 — Receipt Submitter Authority
// Implements: issue 1888 — a populated v0.5.0 receipt proxy upgrades to the submitter-role receipt
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {
    IConsensusRecommendationReceipt
} from "../gateway/interfaces/IConsensusRecommendationReceipt.sol";
import {GovernedUUPS, GovernedUpgrade} from "../lib/GovernedUUPS.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";
import {
    LegacyConsensusRecommendationReceipt,
    LegacyCommitteeAlwaysAllows
} from "./helpers/LegacyConsensusRecommendationReceipt.sol";

/// @title ConsensusReceiptMigrationTest
/// @notice The deployed receipt (v0.5.0) gates `recordReceipt` on the gateway, reads the committee
///         registry, and lets RouterGovernance release as the receipt `ADMIN_ROLE` holder. The
///         timelock upgrades the populated proxy with `upgradeToAndCall(newImpl,
///         migrateToSubmitterRoles(governance))`. After it: the role admins are wired, governance
///         holds only the release role, the timelock holds the receipt `ADMIN_ROLE` alone, the
///         retired slots and every historical receipt are unchanged, and record and release work.
contract ConsensusReceiptMigrationTest is SafeGovernance {
    uint256 internal constant DELAY = 1 hours;
    bytes32 internal constant INITIALIZABLE_SLOT =
        0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;

    address internal safe;
    TimelockController internal timelock;
    address internal gatewayStandIn = makeAddr("gateway");
    address internal committeeStandIn;
    address internal governance = makeAddr("router-governance");
    address internal submitter = makeAddr("safe-submitter");
    address internal stranger = makeAddr("stranger");

    LegacyConsensusRecommendationReceipt internal legacy;
    ConsensusRecommendationReceipt internal receipts;
    address internal newImpl;
    uint256 internal salt;

    function setUp() public {
        _installSafeSet();
        safe = _newDefaultSafe();
        timelock = _newGovTimelock(safe, DELAY);
        CoreProxies.useUpgradeConfig(address(timelock), GovernedUUPS.UpgradeMode.Upgradeable);

        committeeStandIn = address(new LegacyCommitteeAlwaysAllows());
        address legacyImpl = address(new LegacyConsensusRecommendationReceipt());
        legacy = LegacyConsensusRecommendationReceipt(
            CoreProxies.proxy(
                legacyImpl,
                abi.encodeCall(
                    LegacyConsensusRecommendationReceipt.initialize,
                    (
                        address(timelock),
                        gatewayStandIn,
                        committeeStandIn,
                        address(timelock),
                        GovernedUUPS.UpgradeMode.Upgradeable
                    )
                )
            )
        );
        // v0.5.0 deploy: governance holds the receipt ADMIN_ROLE (granted by the timelock).
        _govRun(
            safe,
            timelock,
            address(legacy),
            abi.encodeCall(legacy.grantRole, (legacy.ADMIN_ROLE(), governance)),
            _salt(),
            DELAY
        );

        // Populate: two receipts through the gateway, one released.
        vm.startPrank(gatewayStandIn);
        legacy.recordReceipt(submitter, keccak256("r1"), keccak256("d1"), "https://x.invalid/r1");
        vm.warp(block.timestamp + 5);
        legacy.recordReceipt(submitter, keccak256("r2"), keccak256("d2"), "https://x.invalid/r2");
        vm.stopPrank();
        vm.prank(governance);
        legacy.releaseReceipt(keccak256("r1"));

        newImpl = address(new ConsensusRecommendationReceipt());
    }

    function _salt() internal returns (bytes32) {
        return keccak256(abi.encode("receipt-migration", ++salt));
    }

    function _migrationCall() internal view returns (bytes memory) {
        return abi.encodeCall(
            GovernedUUPS.upgradeToAndCall,
            (
                newImpl,
                abi.encodeCall(ConsensusRecommendationReceipt.migrateToSubmitterRoles, (governance))
            )
        );
    }

    function _migrate() internal {
        _govRun(safe, timelock, address(legacy), _migrationCall(), _salt(), DELAY);
        receipts = ConsensusRecommendationReceipt(address(legacy));
    }

    function _initializedVersion() internal view returns (uint64) {
        return uint64(uint256(vm.load(address(legacy), INITIALIZABLE_SLOT)));
    }

    // ─── The authorized upgrade ──────────────────────────────────────────────

    function test_migration_wiresRoleAdminsAndMovesGovernanceToTheReleaseRole() public {
        // Before: governance is an ADMIN_ROLE holder and the roles do not exist yet.
        assertTrue(legacy.hasRole(legacy.ADMIN_ROLE(), governance));
        _migrate();

        assertEq(CoreProxies.implementationOf(address(receipts)), newImpl, "implementation");
        assertEq(_initializedVersion(), 2, "reinitializer(2) ran");
        assertEq(receipts.getRoleAdmin(receipts.RECEIPT_SUBMITTER_ROLE()), receipts.ADMIN_ROLE());
        assertEq(receipts.getRoleAdmin(receipts.RECEIPT_RELEASER_ROLE()), receipts.ADMIN_ROLE());
        assertTrue(receipts.hasRole(receipts.RECEIPT_RELEASER_ROLE(), governance), "release role");
        assertFalse(receipts.hasRole(receipts.ADMIN_ROLE(), governance), "ADMIN_ROLE removed");
        assertEq(receipts.getRoleMemberCount(receipts.ADMIN_ROLE()), 1, "one ADMIN_ROLE holder");
        assertTrue(receipts.hasRole(receipts.ADMIN_ROLE(), address(timelock)), "the timelock");
        assertEq(receipts.getRoleMemberCount(receipts.RECEIPT_SUBMITTER_ROLE()), 0);
        assertEq(GovernedUUPS(address(receipts)).upgradeTimelock(), address(timelock));
    }

    function test_migration_keepsSlotsAndHistoricalReceiptsUnchanged() public {
        _migrate();
        assertEq(receipts.gateway(), gatewayStandIn, "retired gateway slot value");
        assertEq(receipts.icPolicy(), committeeStandIn, "retired IC slot value");
        assertEq(receipts.receiptCount(), 2);

        IConsensusRecommendationReceipt.Receipt memory r1 = receipts.getReceiptById(keccak256("r1"));
        assertEq(r1.payloadDigest, keccak256("d1"));
        assertEq(r1.payloadUri, "https://x.invalid/r1");
        assertEq(r1.submitter, submitter);
        assertTrue(r1.released, "released stays released");
        IConsensusRecommendationReceipt.Receipt memory r2 = receipts.getReceiptById(keccak256("r2"));
        assertEq(r2.payloadDigest, keccak256("d2"));
        assertEq(r2.submitter, submitter);
        assertFalse(r2.released, "unreleased stays unreleased");
        assertEq(receipts.getReceipt(1).receiptId, keccak256("r2"), "append order");
    }

    function test_migration_postUpgradeRecordAndReleaseWork() public {
        _migrate();

        // The gateway can no longer record: the route is gone.
        vm.prank(gatewayStandIn);
        vm.expectRevert(IConsensusRecommendationReceipt.SubmitterNotAllowlisted.selector);
        receipts.recordReceipt(keccak256("r3"), keccak256("d3"), "https://x.invalid/r3");

        // The Safe, through the timelock, grants the submitter, which records directly.
        _govRun(
            safe,
            timelock,
            address(receipts),
            abi.encodeCall(receipts.grantRole, (receipts.RECEIPT_SUBMITTER_ROLE(), submitter)),
            _salt(),
            DELAY
        );
        vm.prank(submitter);
        receipts.recordReceipt(keccak256("r3"), keccak256("d3"), "https://x.invalid/r3");
        assertEq(receipts.getReceiptById(keccak256("r3")).submitter, submitter);

        // Governance releases with the narrow role. The timelock cannot.
        vm.prank(address(timelock));
        vm.expectRevert();
        receipts.releaseReceipt(keccak256("r2"));
        vm.prank(governance);
        receipts.releaseReceipt(keccak256("r2"));
        assertTrue(receipts.isReleased(keccak256("r2")));
        // Governance cannot administer submitters.
        bytes32 submitterRole = receipts.RECEIPT_SUBMITTER_ROLE();
        vm.prank(governance);
        vm.expectRevert();
        receipts.grantRole(submitterRole, stranger);
    }

    // ─── Rejected paths ──────────────────────────────────────────────────────

    function test_migration_repeatIsRejected() public {
        _migrate();
        // A second reinitializer(2) call, from the timelock itself, reverts.
        vm.prank(address(timelock));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        receipts.migrateToSubmitterRoles(governance);
        // And as the data of another upgrade.
        bytes memory again = _migrationCall();
        bytes32 s = _salt();
        _govSchedule(safe, timelock, address(receipts), again, s, DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        timelock.execute(address(receipts), 0, again, bytes32(0), s);
        assertEq(_initializedVersion(), 2, "version stays 2");
    }

    function test_migration_unauthorizedUpgradeAndUnauthorizedMigrationAreRejected() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(GovernedUpgrade.NotUpgradeTimelock.selector, stranger)
        );
        GovernedUUPS(address(legacy)).upgradeToAndCall(newImpl, "");
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(GovernedUpgrade.NotUpgradeTimelock.selector, governance)
        );
        GovernedUUPS(address(legacy)).upgradeToAndCall(newImpl, "");

        // An upgrade without the migration call leaves the migration open to the timelock ONLY.
        _govRun(
            safe,
            timelock,
            address(legacy),
            abi.encodeCall(GovernedUUPS.upgradeToAndCall, (newImpl, "")),
            _salt(),
            DELAY
        );
        receipts = ConsensusRecommendationReceipt(address(legacy));
        vm.prank(stranger);
        vm.expectRevert(IConsensusRecommendationReceipt.MigrationCallerNotTimelock.selector);
        receipts.migrateToSubmitterRoles(stranger);
        vm.prank(governance);
        vm.expectRevert(IConsensusRecommendationReceipt.MigrationCallerNotTimelock.selector);
        receipts.migrateToSubmitterRoles(governance);
        assertEq(_initializedVersion(), 1, "an unauthorized call did not consume the version");
    }

    function test_migration_zeroReleaserIsRejected() public {
        bytes memory bad = abi.encodeCall(
            GovernedUUPS.upgradeToAndCall,
            (
                newImpl,
                abi.encodeCall(ConsensusRecommendationReceipt.migrateToSubmitterRoles, (address(0)))
            )
        );
        bytes32 s = _salt();
        _govSchedule(safe, timelock, address(legacy), bad, s, DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        timelock.execute(address(legacy), 0, bad, bytes32(0), s);
        assertEq(CoreProxies.implementationOf(address(legacy)) != newImpl, true, "no upgrade");
    }

    function test_migration_frozenProxyCannotUpgradeOrMigrate() public {
        address impl = CoreProxies.implementationOf(address(legacy));
        _govRun(
            safe,
            timelock,
            address(legacy),
            abi.encodeCall(GovernedUUPS.freezeUpgrades, (impl, impl.codehash)),
            _salt(),
            DELAY
        );
        bytes memory call_ = _migrationCall();
        bytes32 s = _salt();
        _govSchedule(safe, timelock, address(legacy), call_, s, DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(GovernedUpgrade.UpgradesAreFrozen.selector);
        timelock.execute(address(legacy), 0, call_, bytes32(0), s);
        assertEq(CoreProxies.implementationOf(address(legacy)), impl, "implementation unchanged");
    }
}
