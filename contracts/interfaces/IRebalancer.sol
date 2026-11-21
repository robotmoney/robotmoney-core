// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.2 (glide path), §5.3 (one step), §5.4 (who calls),
//            §5.6 (parameters), §5.7 (previewPlan), §7 RB-2, RB-4, RB-5, RB-7
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {
    AssetStepParams,
    IFundEvents,
    PlanPreviewRow,
    SkipReason,
    StepParams
} from "../FundTypes.sol";
import {IRobotMoneyFund} from "./IRobotMoneyFund.sol";

/// @title IRebalancer
/// @notice Step selection for the one vault. Holds no funds and never receives tokens: it reads the
///         fund, computes one `StepOrder` from chain state, and calls `fund.executeStep`. It holds
///         `REBALANCER_ROLE` on the fund. Roles here: ADMIN_ROLE (timelock: parameters),
///         KEEPER_ROLE (keeper bot: `step` and `stepDelisted`).
///
///         Implementation `initialize(address fund, address admin, address keeper,
///         StepParams params, address upgradeTimelock, GovernedUUPS.UpgradeMode mode)` is not part
///         of this interface. Per-asset params default to zero (`maxStepUsdc == 0` → never traded)
///         until ADMIN sets them.
interface IRebalancer is IFundEvents {
    // ─── Events ──────────────────────────────────────────────────────────────

    event StepParamsSet(StepParams params);
    event AssetStepParamsSet(uint256 indexed index, AssetStepParams params);
    /// @notice Asset `index` is left out of leg picking until `until` because `fund.executeStep`
    ///         reverted on a step that used it (§5.8 "A venue freezes": a frozen venue stalls only its
    ///         own asset for one effective cooldown while the rest of the plan keeps converging).
    event AssetBackoff(uint256 indexed index, uint64 until);
    /// @notice The depth cap on basket legs changed (`setStepDepthBps`, and once at initialize).
    event StepDepthBpsSet(uint16 bps);

    // ─── Errors ──────────────────────────────────────────────────────────────

    /// @notice Retired in Step 3f (`step()` is `KEEPER_ROLE`-only, E34); kept for ABI compatibility.
    error NotKeeperBeforeGrace(address caller, uint256 openAt);
    /// @notice `fund.executeStep` reverted with under 1/63 of the gas `step()` forwarded left. The
    ///         caller most likely sent too little gas, so the revert is re-thrown instead of being
    ///         recorded as `StepFailed` plus a backoff.
    error StepGasStarved();
    /// @notice An asset's non-zero `maxStepUsdc` is below the global `minStepUsdc`: every step sized by
    ///         that cap would skip `BelowMinStep`, and as the most-deviating asset it would stall the
    ///         whole plan (§5.3 step 4, §5.6).
    error MaxStepBelowMinStep(uint256 index, uint256 maxStepUsdc, uint256 minStepUsdc);

    // ─── Step (§5.3) ─────────────────────────────────────────────────────────

    /// @notice Run at most one step. Takes no input (RB-2): the caller chooses only WHEN.
    ///         Access (§5.4, E34): `KEEPER_ROLE` only (`AccessControlUnauthorizedAccount` otherwise).
    ///         Every other non-execution RETURNS (does not revert) and emits `RebalanceStepSkipped`.
    ///
    ///         Order (§5.3):
    ///         0. Plan not Open → skip `PlanNotOpen`.
    ///            If `now > plan.endTime + maxOverrun` → `fund.concludePlan(Expired)`, return
    ///            `(false, Concluded)` (no skip event; the fund's PlanStatusChanged records it).
    ///         1. Cooldown: `now < fund.lastStepAt() + effectiveStepInterval()` → skip `Cooldown`.
    ///         2. If `now ≥ endTime` and
    ///            `PlanMath.withinTolerance(values, idle, nav, endBps, toleranceBps)` →
    ///            `fund.concludePlan(Converged)`, return `(false, Concluded)`.
    ///         3. Market check: build the eligible mask = active ∧ maxStepUsdc > 0 ∧ not in delisting
    ///            sale (`!fund.isAssetInSale(i)`, E53) ∧ not a Lending asset with outstanding claims
    ///            (`fund.positionClaimTotal(i) == 0`, E54/RB-35) ∧ not backed off (`assetBackoffUntil(i) < now`,
    ///            inclusive end) ∧ `fund.marketCheck(i).ok` ∧ Basket `_stepCap >= minStepUsdc`.
    ///         4. Pick legs: `PlanMath.pickLegs` over `fund.portfolioValues()` and the plan's
    ///            start/end/startIdle at `now`. No over or no under → skip `MarketDeviation`
    ///            (detail = first ORA-4 failer) when an asset was masked by ORA-4, else
    ///            `DepthCap` when a Basket asset's cap was below `minStepUsdc`, else
    ///            `Cooldown` (detail = longest backoff left) when one was backed off, else
    ///            `NothingToTrade`.
    ///         5. Size: `notional = min(over, under, cap[sell], cap[buy])` (idle legs uncapped).
    ///            `notional < minStepUsdc` → skip `BelowMinStep`, except for the last dust after
    ///            `endTime` when `notional == min(over, under)` (SAFE-05).
    ///         6. Floors from stricter of TWAP and feed (`_buildOrder`); `maxCostUsdc = notional × maxStepCostBps / 10 000`.
    ///         7. `try fund.executeStep(order)`; on revert → both non-idle legs back off for one
    ///            effective cooldown (`AssetBackoff`) and skip `StepFailed` (detail = selector);
    ///            a gas-starved revert re-throws `StepGasStarved`.
    ///         8. Update `lastBasketStepAt` when either leg is a Basket asset (E42), and emit `RebalanceStep`.
    /// @return executed True when a step traded.
    /// @return reason   `SkipReason.None` when executed, `Concluded` when this call moved the
    ///                  plan to Converged or Expired, else why not.
    function step() external returns (bool executed, SkipReason reason);

    // ─── Previews (§5.7) ─────────────────────────────────────────────────────

    /// @notice Preview a plan for a proposed per-asset target vector at current TWAP. `assets`
    ///         names each active asset by its fund asset address (`PlanMath.assetId`: `token` for
    ///         Basket, `adapter` for Lending). `bps` is parallel. Per asset (index-aligned to the
    ///         fund's list): current weight, the target, turnover `|target − current| × NAV /
    ///         10 000`, and estimated cost `turnover × fund.poolFeeBps(i) / 10 000`. Reverts on a
    ///         refused vector with the fund's §4.1 errors (RB-9).
    /// @return rows           Per-asset rows.
    /// @return totalTurnover  One-sided turnover: Σ max(target − current, 0) × NAV / 10 000
    ///                        (the same definition the fund uses for `plan.turnoverUsdc`).
    /// @return totalEstCost   Σ rows[i].estCostUsdc.
    function previewPlan(address[] calldata assets, uint256[] calldata bps)
        external
        view
        returns (PlanPreviewRow[] memory rows, uint256 totalTurnover, uint256 totalEstCost);

    /// @notice What `step()` would do now, without doing it (no access check, no state change).
    ///         Returns the chosen legs and notional, or the skip reason. `Concluded` means the plan
    ///         is still Open and a `step()` call now would conclude it. For keepers and tests.
    function previewStep()
        external
        view
        returns (SkipReason reason, uint256 sellIndex, uint256 buyIndex, uint256 notionalUsdc);

    /// @notice Retired after Step 3f made `step()` `KEEPER_ROLE`-only (E34).
    ///         Always returns `type(uint256).max`.
    function permissionlessAt() external view returns (uint256);

    /// @notice Timestamp until which asset `index` is left out of leg picking after a failed step
    ///         (0 if never backed off). See `AssetBackoff`.
    function assetBackoffUntil(uint256 index) external view returns (uint64);

    /// @notice The cooldown `step()` enforces now: `max(stepInterval, fund.maxTwapWindow())`, so an
    ///         asset added later with a longer TWAP window still keeps RB-5.
    function effectiveStepInterval() external view returns (uint256);

    // ─── Parameters (§5.6), ADMIN_ROLE ───────────────────────────────────────

    /// @notice Set the global step parameters. Bounds (`StepParamOutOfBounds` /
    ///         `BoundAtOrBelowPoolFee`): `stepInterval ∈ [max(MIN_STEP_INTERVAL, fund.maxTwapWindow()), MAX_STEP_INTERVAL]`,
    ///         `maxOverrun ≤ MAX_OVERRUN`,
    ///         `maxStepCostBps ∈ (fee1 + fee2, MAX_STEP_COST_BPS]` (sum of the two largest active basket pool fees),
    ///         `toleranceBps ∈ [1, MAX_TOLERANCE_BPS]`, and `minStepUsdc ≤` every asset's non-zero
    ///         `maxStepUsdc` (`MaxStepBelowMinStep`).
    function setStepParams(StepParams calldata params) external;

    /// @notice Set one asset's step parameters. Bounds: Basket `maxStepSlippageBps >
    ///         fund.poolFeeBps(index)` (`BoundAtOrBelowPoolFee`) and every kind
    ///         `maxStepSlippageBps ≤ fund.maxSlippageBps()` (`StepParamOutOfBounds`); a non-zero
    ///         `maxStepUsdc ≥ minStepUsdc` (`MaxStepBelowMinStep`).
    function setAssetStepParams(uint256 index, AssetStepParams calldata params) external;

    function stepParams() external view returns (StepParams memory);
    function assetStepParams(uint256 index) external view returns (AssetStepParams memory);

    /// @notice Set the depth cap on basket legs: a basket leg's notional is at most `bps` of its pool's
    ///         time-weighted USDC depth over one settlement window, beside its `maxStepUsdc`. Bounds
    ///         `[1, MAX_STEP_DEPTH_BPS]` (`StepParamOutOfBounds`): the cap cannot be switched off.
    function setStepDepthBps(uint16 bps) external;

    /// @notice The depth cap on basket legs in bps (`DEFAULT_STEP_DEPTH_BPS` from initialize).
    function stepDepthBps() external view returns (uint16);

    /// @notice The notional cap a step applies to asset `index` now: its `maxStepUsdc`, and for a basket asset
    ///         also `stepDepthBps` of its pool's USDC depth over one settlement window. 0 when the depth cannot be
    ///         read (too little pool history). A basket asset whose cap is below `minStepUsdc` is masked from leg
    ///         picking; with no other pair left the step skips `DepthCap` (fail closed, no stall behind it).
    function assetStepCap(uint256 index) external view returns (uint256);

    /// @notice Timestamp of the most recent executed basket rebalance step (`step()` with a Basket leg;
    ///         0 if none yet). Lending-only steps and `stepDelisted()` do not update it (E42, RB-30).
    function lastBasketStepAt() external view returns (uint64);

    /// @notice Keeper-only capped liquidation step for a delisted (`inSale`) asset toward USDC (E53).
    ///         Reverts `InvalidAssetIndex` if `index` is out of range; returns `false` if not active/`inSale`,
    ///         on backoff or step cooldown, when `_stepCap` is 0, or if `fund.executeDelistStep` reverts or
    ///         returns `false`.
    /// @return executed True when a step executed.
    function stepDelisted(uint256 index) external returns (bool executed);

    /// @notice The fund this rebalancer drives. Set once at initialize, no setter.
    function fund() external view returns (IRobotMoneyFund);
}
