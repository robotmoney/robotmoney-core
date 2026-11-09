// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.1 (from receipt to plan), §6 (RouterGovernance →
//            RebalanceGovernance), §7 RB-1, RB-8
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {PlanParams} from "../FundTypes.sol";
import {IRobotMoneyFund} from "./IRobotMoneyFund.sol";
import {IConsensusRecommendationReceipt} from "../../../../interfaces/IConsensusRecommendationReceipt.sol";

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

    /// @notice A receipt was released and its sleeve vector opened as plan `planId`.
    event ReceiptApplied(
        bytes32 indexed receiptId, bytes32 payloadDigest, uint16[4] sleeveBps, uint256 indexed planId
    );

    /// @notice A receipt-less target was set and opened as plan `planId` (`setTarget`).
    event TargetSet(uint16[4] sleeveBps, PlanParams params, uint256 indexed planId);

    event DefaultPlanParamsSet(PlanParams params);

    // ─── Errors (same shapes as RouterGovernance) ────────────────────────────

    error ReceiptNotRecorded(bytes32 receiptId);
    error ReceiptAlreadyReleased(bytes32 receiptId);
    error PayloadDigestMismatch(bytes32 receiptId, bytes32 stored, bytes32 given);
    error ReceiptNotNewerThanApplied(bytes32 receiptId, uint64 recordedAt, uint64 lastApplied);

    // ─── Write surface ───────────────────────────────────────────────────────

    /// @notice Release `receiptId` and open a plan to its sleeve vector, in one call (§5.1 step 2-3).
    ///         TARGET_SETTER_ROLE only (the timelock: RB-1). `nonReentrant`.
    ///         Checks in order (RouterGovernance.applyReceipt, unchanged):
    ///         recorded (`ReceiptNotRecorded`), not released (`ReceiptAlreadyReleased`), stored digest
    ///         == `payloadDigest` (`PayloadDigestMismatch`), `recordedAt > lastAppliedRecordedAt`
    ///         (`ReceiptNotNewerThanApplied`). Then `PlanMath.canonicalSleeveBps(sleeves, bps)`
    ///         (sum 10 000, agent sleeve 0). Effects: `lastAppliedRecordedAt = recordedAt`,
    ///         `receipts.releaseReceipt(receiptId)`, then
    ///         `fund.setTargetAndOpenPlan(sleeveBps, defaultPlanParams, receiptId)`. Any revert
    ///         undoes the release. Emits `ReceiptApplied`.
    /// @param sleeves Sleeve ids (SLEEVE_*: 0 agent_tokens, 1 conservative_defi_yield,
    ///                2 protocol_tokens, 3 real_world_assets), each at most once.
    /// @param bps     Parallel weights in bps.
    /// @return planId The opened plan.
    function applyReceipt(
        bytes32 receiptId,
        bytes32 payloadDigest,
        uint8[] calldata sleeves,
        uint256[] calldata bps
    ) external returns (uint256 planId);

    /// @notice Open a plan with no receipt (§6: bootstrap and drift correction; the old
    ///         `setDefaultWeights`). ADMIN_ROLE only. Same sleeve validation as `applyReceipt`.
    ///         Does not touch `lastAppliedRecordedAt`. Emits `TargetSet`.
    function setTarget(uint8[] calldata sleeves, uint256[] calldata bps, PlanParams calldata params)
        external
        returns (uint256 planId);

    /// @notice Set the plan parameters `applyReceipt` uses. ADMIN_ROLE only. Bounds as
    ///         `setTargetAndOpenPlan` (`PlanParamOutOfBounds`). Emits `DefaultPlanParamsSet`.
    function setDefaultPlanParams(PlanParams calldata params) external;

    // ─── Read surface ────────────────────────────────────────────────────────

    function fund() external view returns (IRobotMoneyFund);
    function receipts() external view returns (IConsensusRecommendationReceipt);
    function lastAppliedRecordedAt() external view returns (uint64);
    function defaultPlanParams() external view returns (PlanParams memory);
}
