// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.1 (from receipt to plan), §5.6 (plan parameters),
//            §6 (RouterGovernance → RebalanceGovernance), §4.1 (per-asset vector),
//            §7 RB-1, RB-8, RB-9
// Ported from: contracts/RouterGovernance.sol (applyReceipt checks, release role, GovernedUUPS proxy)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
// FROZEN BASELINE (one-vault scaffold, 2026-11-11): a copy of the step 3c synchronous fund and its tests. Never edit.
// It is the sim's synchronous arm and the target of the baseline attack tests. The live tree is contracts/test/prototype/src.
pragma solidity ^0.8.24;

import {AdminFloorAccessControl} from "../../../../lib/AdminFloorAccessControl.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {GovernedUUPS} from "../../../../lib/GovernedUUPS.sol";
import {
    IConsensusRecommendationReceipt
} from "../../../../interfaces/IConsensusRecommendationReceipt.sol";
import {
    PlanParams,
    Roles,
    IFundEvents,
    MIN_PLAN_DURATION,
    MAX_PLAN_DURATION,
    MAX_COST_BUDGET_BPS
} from "./FundTypes.sol";
import {IRobotMoneyFund} from "./interfaces/IRobotMoneyFund.sol";
import {IRebalanceGovernance} from "./interfaces/IRebalanceGovernance.sol";

/// @title RebalanceGovernance
/// @notice The fund's target setter (§5.1, §6). It holds the fund's `GOVERNANCE_ROLE` (the only gate
///         on `setTargetAndOpenPlan`) and moves the fund's target in two ways:
///         - `applyReceipt` releases a recorded Investment Committee consensus receipt and opens a
///           plan to the receipt's per-asset target vector in the same call. `TARGET_SETTER_ROLE` only.
///         - `setTarget` opens a plan with no receipt (bootstrap, drift correction; the old
///           `setDefaultWeights`). `ADMIN_ROLE` only.
///
///         RB-1: both roles are held by the `TimelockController`, whose only proposer is the Safe.
///         `TARGET_SETTER_ROLE` is self-administered, so no `ADMIN_ROLE` holder can grant it. A
///         target or a plan therefore only comes from a timelock-executed call into this contract.
///
///         RB-8 / INV-4: this contract calls the receipt register (`releaseReceipt`, views). The
///         register never calls this contract, the fund or the rebalancer. This contract holds only
///         the register's narrow `RECEIPT_RELEASER_ROLE`, never its `ADMIN_ROLE`.
///
///         Payload-digest binding is unchanged from `RouterGovernance`: the call names the digest
///         the vector was derived from (the payload's `assets` field, schema 1.1) and reverts unless
///         it equals the stored digest. `ReceiptApplied` records the digest, the vector and the
///         plan id together so anyone can re-derive the vector from the public payload and compare.
///         The bucket audit check (§4.1) is off-chain. No contract stores or reads a sleeve (RB-9).
///
///         Asset ids: a vector names each asset by its fund asset address (`PlanMath.assetId`):
///         `token` for a Basket asset, `adapter` for a Lending asset.
///
///         Released is not applied: a receipt released outside `applyReceipt` carries no
///         target and `applyReceipt` refuses it forever (`ReceiptAlreadyReleased`). A refused
///         vector reverts the whole call, so it releases nothing. The fund runs the §4.1 checks
///         (RB-9): an inactive or unknown asset (`TargetAssetNotActive`), a duplicate
///         (`TargetAssetDuplicate`), a missing active asset (`TargetAssetMissing`), a bad sum
///         (`TargetSumInvalid`), a lending target above its cap (`TargetExceedsCap`).
///
///         Runs behind its own ERC-1967 proxy (`GovernedUUPS`): `initialize` replaces the
///         constructor, the implementation is locked, and only `upgradeTimelock()` can upgrade or
///         freeze it. `fund` and `receipts` are set once at initialization and have no setter.
contract RebalanceGovernance is
    AdminFloorAccessControl,
    ReentrancyGuardUpgradeable,
    GovernedUUPS,
    IRebalanceGovernance
{
    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Gates `setTarget` and `setDefaultPlanParams`. Held by the `TimelockController`.
    bytes32 public constant ADMIN_ROLE = Roles.ADMIN_ROLE;

    /// @notice The only role that can call `applyReceipt` (the `RouterGovernance`
    ///         `WEIGHT_SETTER_ROLE` equivalent). Held by the `TimelockController`.
    ///         Self-administered.
    bytes32 public constant TARGET_SETTER_ROLE = Roles.TARGET_SETTER_ROLE;

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @inheritdoc IRebalanceGovernance
    IRobotMoneyFund public fund;

    /// @inheritdoc IRebalanceGovernance
    IConsensusRecommendationReceipt public receipts;

    /// @notice The `recordedAt` of the last receipt `applyReceipt` applied (0 until the first).
    ///         `applyReceipt` refuses any receipt not recorded strictly later, so two ready apply
    ///         operations executed out of order cannot make the older receipt's target live.
    uint64 public lastAppliedRecordedAt;

    /// @dev Plan parameters `applyReceipt` opens plans with (§5.6). Exposed by `defaultPlanParams()`.
    PlanParams private _defaultPlanParams;

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @notice Atomic proxy initialization (the ERC1967Proxy constructor calls it).
    /// @param fund_              The fund whose `setTargetAndOpenPlan` this contract calls.
    /// @param receipts_          ConsensusRecommendationReceipt register.
    /// @param admin_             Receives `ADMIN_ROLE` and `TARGET_SETTER_ROLE` (deployer, then the
    ///                           timelock stage hands both to the `TimelockController`).
    /// @param defaultPlanParams_ Plan parameters for `applyReceipt`, bounded as §5.6.
    /// @param upgradeTimelock_   The only upgrade and freeze authority.
    /// @param upgradeMode_       The release mode. `Undeclared` reverts.
    function initialize(
        address fund_,
        address receipts_,
        address admin_,
        PlanParams calldata defaultPlanParams_,
        address upgradeTimelock_,
        UpgradeMode upgradeMode_
    ) external initializer {
        __AccessControlEnumerable_init();
        __ReentrancyGuard_init();
        __GovernedUUPS_init(upgradeTimelock_, upgradeMode_);
        if (fund_ == address(0) || receipts_ == address(0) || admin_ == address(0)) {
            revert IFundEvents.ZeroAddress();
        }
        fund = IRobotMoneyFund(fund_);
        receipts = IConsensusRecommendationReceipt(receipts_);
        _setDefaultPlanParams(defaultPlanParams_);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _grantRole(ADMIN_ROLE, admin_);
        _setRoleAdmin(TARGET_SETTER_ROLE, TARGET_SETTER_ROLE);
        _grantRole(TARGET_SETTER_ROLE, admin_);
    }

    // ─── Target setter: apply a consensus receipt (§5.1 steps 2-3) ───────────

    /// @inheritdoc IRebalanceGovernance
    /// @dev §5.1 steps 2-3, RB-1, RB-9. Check order is `RouterGovernance.applyReceipt` unchanged.
    ///      The fund checks the vector inside `setTargetAndOpenPlan`. The release and the plan open
    ///      happen in one call; any revert, a refused vector included, undoes both.
    // slither-disable-start reentrancy-events
    // `applyReceipt` is `nonReentrant` and both external calls go to contracts fixed at
    // initialization; the event follows them so it records what landed.
    function applyReceipt(
        bytes32 receiptId,
        bytes32 payloadDigest,
        address[] calldata assets,
        uint256[] calldata bps
    ) external onlyRole(TARGET_SETTER_ROLE) nonReentrant returns (uint256 planId) {
        _checkAndRelease(receiptId, payloadDigest);
        planId = fund.setTargetAndOpenPlan(assets, bps, _defaultPlanParams, receiptId);

        emit ReceiptApplied(receiptId, payloadDigest, assets, bps, planId);
    }

    /// @dev `applyReceipt`'s receipt checks, in `RouterGovernance.applyReceipt` order, then the release (own
    ///      frame for stack depth). The digest binding is unchanged.
    function _checkAndRelease(bytes32 receiptId, bytes32 payloadDigest) private {
        if (!receipts.isRecorded(receiptId)) revert ReceiptNotRecorded(receiptId);
        IConsensusRecommendationReceipt.Receipt memory r = receipts.getReceiptById(receiptId);
        if (r.released) revert ReceiptAlreadyReleased(receiptId);
        if (r.payloadDigest != payloadDigest) {
            revert PayloadDigestMismatch(receiptId, r.payloadDigest, payloadDigest);
        }
        uint64 last = lastAppliedRecordedAt;
        if (r.recordedAt <= last) revert ReceiptNotNewerThanApplied(receiptId, r.recordedAt, last);

        lastAppliedRecordedAt = r.recordedAt;
        receipts.releaseReceipt(receiptId);
    }

    // slither-disable-end reentrancy-events

    // ─── Admin: receipt-less target and plan defaults (§6) ───────────────────

    /// @inheritdoc IRebalanceGovernance
    /// @dev §6 (the old `setDefaultWeights`), RB-1. Opens a plan with `receiptId == 0`. Does not
    ///      touch `lastAppliedRecordedAt`, so a later receipt still applies.
    function setTarget(
        address[] calldata assets,
        uint256[] calldata bps,
        PlanParams calldata params
    ) external onlyRole(ADMIN_ROLE) nonReentrant returns (uint256 planId) {
        _checkPlanParams(params);
        planId = fund.setTargetAndOpenPlan(assets, bps, params, bytes32(0));
        emit TargetSet(assets, bps, params, planId);
    }

    /// @inheritdoc IRebalanceGovernance
    /// @dev §5.6 `duration` and `costBudgetBps` bounds.
    function setDefaultPlanParams(PlanParams calldata params) external onlyRole(ADMIN_ROLE) {
        _setDefaultPlanParams(params);
    }

    // ─── Read surface ────────────────────────────────────────────────────────

    /// @inheritdoc IRebalanceGovernance
    function defaultPlanParams() external view returns (PlanParams memory) {
        return _defaultPlanParams;
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _setDefaultPlanParams(PlanParams calldata params) internal {
        _checkPlanParams(params);
        _defaultPlanParams = params;
        emit DefaultPlanParamsSet(params);
    }

    /// @dev §5.6: duration in [MIN_PLAN_DURATION, MAX_PLAN_DURATION], costBudgetBps in
    ///      [1, MAX_COST_BUDGET_BPS]. The fund re-checks the same bounds in `setTargetAndOpenPlan`.
    function _checkPlanParams(PlanParams calldata params) internal pure {
        if (
            params.duration < MIN_PLAN_DURATION || params.duration > MAX_PLAN_DURATION
                || params.costBudgetBps == 0 || params.costBudgetBps > MAX_COST_BUDGET_BPS
        ) revert IFundEvents.PlanParamOutOfBounds();
    }
}
