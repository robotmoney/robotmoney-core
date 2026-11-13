// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.1 (from receipt to plan), §4.1 (per-asset vector), §6 (RouterGovernance →
//            RebalanceGovernance), §7 RB-1, RB-8, RB-9
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
// FROZEN BASELINE (one-vault scaffold, 2026-11-11): a copy of the step 3c synchronous fund and its tests. Never edit.
// It is the sim's synchronous arm and the target of the baseline attack tests. The live tree is contracts/test/prototype/src.
pragma solidity ^0.8.24;

import {PlanParams} from "../FundTypes.sol";
import {IRobotMoneyFund} from "./IRobotMoneyFund.sol";
import {
    IConsensusRecommendationReceipt
} from "../../../../../interfaces/IConsensusRecommendationReceipt.sol";

/// @title IRebalanceGovernance
/// @notice Port of `RouterGovernance`: turns a recorded consensus receipt into a fund target and a
///         rebalance plan. Holds `GOVERNANCE_ROLE` on the fund and only the receipt register's
///         `RECEIPT_RELEASER_ROLE` (never its `ADMIN_ROLE`). The receipt register never calls this
///         contract or the fund (RB-8, INV-4).
///
///         Roles: TARGET_SETTER_ROLE (self-administered, the timelock) gates `applyReceipt`;
///         ADMIN_ROLE (the timelock) gates `setTarget` and `setDefaultPlanParams`.
///
///         Implementation `initialize(address fund, address receipts, address admin,
///         PlanParams defaultPlanParams, address upgradeTimelock, GovernedUUPS.UpgradeMode mode)`
///         is not part of this interface. It grants ADMIN_ROLE and TARGET_SETTER_ROLE to `admin`
///         with ADMIN_ROLE administered by ADMIN_ROLE and TARGET_SETTER_ROLE by itself.
interface IRebalanceGovernance {
    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice A receipt was released and its per-asset vector opened as plan `planId`.
    event ReceiptApplied(
        bytes32 indexed receiptId,
        bytes32 payloadDigest,
        address[] assets,
        uint256[] bps,
        uint256 indexed planId
    );

    /// @notice A receipt-less per-asset vector was set and opened as plan `planId` (`setTarget`).
    event TargetSet(address[] assets, uint256[] bps, PlanParams params, uint256 indexed planId);

    event DefaultPlanParamsSet(PlanParams params);

    // ─── Errors (same shapes as RouterGovernance) ────────────────────────────

    error ReceiptNotRecorded(bytes32 receiptId);
    error ReceiptAlreadyReleased(bytes32 receiptId);
    error PayloadDigestMismatch(bytes32 receiptId, bytes32 stored, bytes32 given);
    error ReceiptNotNewerThanApplied(bytes32 receiptId, uint64 recordedAt, uint64 lastApplied);

    // ─── Write surface ───────────────────────────────────────────────────────

    /// @notice Release `receiptId` and open a plan to its per-asset vector, in one call (§5.1 step 2-3).
    ///         TARGET_SETTER_ROLE only (the timelock: RB-1). `nonReentrant`.
    ///         Checks in order (RouterGovernance.applyReceipt, unchanged):
    ///         recorded (`ReceiptNotRecorded`), not released (`ReceiptAlreadyReleased`), stored digest
    ///         == `payloadDigest` (`PayloadDigestMismatch`), `recordedAt > lastAppliedRecordedAt`
    ///         (`ReceiptNotNewerThanApplied`). Effects: `lastAppliedRecordedAt = recordedAt`,
    ///         `receipts.releaseReceipt(receiptId)`, then
    ///         `fund.setTargetAndOpenPlan(assets, bps, defaultPlanParams, receiptId)`, which runs
    ///         the §4.1 vector checks (RB-9). Any revert, a refused vector included, undoes the
    ///         release. Emits `ReceiptApplied`.
    /// @param assets  Asset ids, each active asset exactly once, any order. An id is the fund
    ///                asset address (`PlanMath.assetId`): `token` for Basket, `adapter` for Lending.
    /// @param bps     Parallel target weights in bps of NAV, summing to 10 000.
    /// @return planId The opened plan.
    function applyReceipt(
        bytes32 receiptId,
        bytes32 payloadDigest,
        address[] calldata assets,
        uint256[] calldata bps
    ) external returns (uint256 planId);

    /// @notice Open a plan with no receipt (§6: bootstrap and drift correction; the old
    ///         `setDefaultWeights`). ADMIN_ROLE only. Same vector checks as `applyReceipt` (RB-9).
    ///         Does not touch `lastAppliedRecordedAt`. Emits `TargetSet`.
    function setTarget(
        address[] calldata assets,
        uint256[] calldata bps,
        PlanParams calldata params
    ) external returns (uint256 planId);

    /// @notice Set the plan parameters `applyReceipt` uses. ADMIN_ROLE only. Bounds as
    ///         `setTargetAndOpenPlan` (`PlanParamOutOfBounds`). Emits `DefaultPlanParamsSet`.
    function setDefaultPlanParams(PlanParams calldata params) external;

    // ─── Read surface ────────────────────────────────────────────────────────

    function fund() external view returns (IRobotMoneyFund);
    function receipts() external view returns (IConsensusRecommendationReceipt);
    function lastAppliedRecordedAt() external view returns (uint64);
    function defaultPlanParams() external view returns (PlanParams memory);
}
