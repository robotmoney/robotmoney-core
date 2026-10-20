// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.8, §4.9 — Receipt Submitter Authority
// Implements: issue 1888 — the migration fixture: the deployed v0.5.0 receipt shape
pragma solidity ^0.8.24;

import {AdminFloorAccessControl} from "../../lib/AdminFloorAccessControl.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {GovernedUUPS} from "../../lib/GovernedUUPS.sol";

/// @dev Answers `hasRole` true for everyone: the stand-in for the deleted committee registry.
contract LegacyCommitteeAlwaysAllows {
    function hasRole(bytes32, address) external pure returns (bool) {
        return true;
    }
}

/// @title LegacyConsensusRecommendationReceipt
/// @notice A faithful copy of the v0.5.0 receipt's state and write surface, used ONLY to build a
///         populated proxy that the migration test upgrades to the current receipt. Its storage
///         layout is identical to `ConsensusRecommendationReceipt`: `gateway`, `icPolicy`, the
///         receipt log and the index map, in that order, behind the same bases.
contract LegacyConsensusRecommendationReceipt is
    AdminFloorAccessControl,
    ReentrancyGuardUpgradeable,
    GovernedUUPS
{
    struct Receipt {
        bytes32 receiptId;
        bytes32 payloadDigest;
        string payloadUri;
        address submitter;
        uint64 recordedAt;
        uint64 releasedAt;
        bool released;
    }

    error CallerNotGateway();
    error ReceiptAlreadyRecorded();
    error ReceiptNotFound();

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant COMMITTEE_AGENT_ROLE = keccak256("COMMITTEE_AGENT_ROLE");

    address public gateway;
    address public icPolicy;
    Receipt[] private _receipts;
    mapping(bytes32 => uint256) private _indexPlusOne;

    function initialize(
        address admin_,
        address gateway_,
        address icPolicy_,
        address upgradeTimelock_,
        UpgradeMode upgradeMode_
    ) external initializer {
        __AccessControlEnumerable_init();
        __ReentrancyGuard_init();
        __GovernedUUPS_init(upgradeTimelock_, upgradeMode_);
        gateway = gateway_;
        icPolicy = icPolicy_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
    }

    function _revokeRole(bytes32 role, address account) internal virtual override returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE && hasRole(role, account) && getRoleMemberCount(role) == 1) {
            revert LastAdminFloor();
        }
        return super._revokeRole(role, account);
    }

    function recordReceipt(
        address submitter,
        bytes32 receiptId,
        bytes32 payloadDigest,
        string calldata payloadUri
    ) external nonReentrant returns (uint256 index) {
        if (msg.sender != gateway) revert CallerNotGateway();
        if (_indexPlusOne[receiptId] != 0) revert ReceiptAlreadyRecorded();
        index = _receipts.length;
        _receipts.push(
            Receipt({
                receiptId: receiptId,
                payloadDigest: payloadDigest,
                payloadUri: payloadUri,
                submitter: submitter,
                recordedAt: uint64(block.timestamp),
                releasedAt: 0,
                released: false
            })
        );
        _indexPlusOne[receiptId] = index + 1;
    }

    function releaseReceipt(bytes32 receiptId) external onlyRole(ADMIN_ROLE) nonReentrant {
        uint256 slot = _indexPlusOne[receiptId];
        if (slot == 0) revert ReceiptNotFound();
        Receipt storage r = _receipts[slot - 1];
        r.released = true;
        r.releasedAt = uint64(block.timestamp);
    }

    function receiptCount() external view returns (uint256) {
        return _receipts.length;
    }

    function getReceiptById(bytes32 receiptId) external view returns (Receipt memory) {
        uint256 slot = _indexPlusOne[receiptId];
        if (slot == 0) revert ReceiptNotFound();
        return _receipts[slot - 1];
    }
}
