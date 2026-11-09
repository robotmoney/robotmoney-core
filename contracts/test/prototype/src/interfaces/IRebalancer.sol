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
///         KEEPER_ROLE (keeper bot: `step` before grace).
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

    // ─── Errors ──────────────────────────────────────────────────────────────

    /// @notice Caller lacks KEEPER_ROLE and `keeperGrace` has not passed (§5.4).
    error NotKeeperBeforeGrace(address caller, uint256 openAt);
    /// @notice `fund.executeStep` reverted with under 1/63 of the gas `step()` forwarded left. The
    ///         caller most likely sent too little gas, so the revert is re-thrown instead of being
    ///         recorded as `StepFailed` plus a backoff (a permissionless caller cannot fake a venue
    ///         failure by starving gas).
    error StepGasStarved();
    /// @notice An asset's non-zero `maxStepUsdc` is below the global `minStepUsdc`: every step sized by
    ///         that cap would skip `BelowMinStep`, and as the most-deviating asset it would stall the
    ///         whole plan (§5.3 step 4, §5.6).
    error MaxStepBelowMinStep(uint256 index, uint256 maxStepUsdc, uint256 minStepUsdc);

    // ─── Step (§5.3) ─────────────────────────────────────────────────────────

    /// @notice Run at most one step. Takes no input (RB-2): the caller chooses only WHEN.
    ///         Access (§5.4): KEEPER_ROLE always; anyone once
    ///         `now ≥ max(fund.lastStepAt(), plan.startTime) + keeperGrace` while the plan is Open;
    ///         otherwise reverts `NotKeeperBeforeGrace`. Every other non-execution RETURNS
    ///         (does not revert) and emits `RebalanceStepSkipped`.
    ///
    ///         Order (§5.3):
    ///         0. Plan not Open → skip `PlanNotOpen`.
    ///            If `now > plan.endTime + maxOverrun` → `fund.concludePlan(Expired)`, return
    ///            `(false, Concluded)` (no skip event; the fund's PlanStatusChanged records it).
    ///         1. Cooldown: `now < fund.lastStepAt() + effectiveStepInterval()` → skip `Cooldown`.
    ///         2. If `now ≥ endTime` and
    ///            `PlanMath.withinTolerance(values, idle, nav, endBps, toleranceBps)` →
    ///            `fund.concludePlan(Converged)`, return `(false, Concluded)`.
    ///         3. Market check: build the eligible mask = active ∧ maxStepUsdc > 0 ∧ not backed
    ///            off (`assetBackoffUntil(i) < now`, inclusive end) ∧ `fund.marketCheck(i).ok`. An asset failing
    ///            ORA-4 (or an excluded Lending asset) is masked out (RB-5: it is never traded).
    ///         4. Pick legs: `PlanMath.pickLegs` over `fund.portfolioValues()` and the plan's
    ///            start/end/startIdle at `now`. No over or no under → skip `MarketDeviation`
    ///            (detail = first ORA-4 failer) when an asset was masked by ORA-4, else
    ///            `Cooldown` (detail = longest backoff left) when one was backed off, else
    ///            `NothingToTrade`.
    ///         5. Size: `notional = min(over, under, maxStepUsdc[sell], maxStepUsdc[buy])` (idle
    ///            legs uncapped). `notional < minStepUsdc` → skip `BelowMinStep`.
    ///         6. Floors from TWAP, never spot (each slippage clamped to `fund.maxSlippageBps()`):
    ///            Basket sell: `minSellUsdcOut = assetUsdcValue(sell, assetTokenValue(sell, notional))
    ///                          × (1 − maxStepSlippageBps[sell])`;
    ///            Lending sell: `notional × (1 − maxStepSlippageBps[sell])`; idle sell: 0.
    ///            Basket buy: `minBuyOut = assetTokenValue(buy, notional) × (1 − maxStepSlippageBps[buy])`;
    ///            otherwise 0.
    ///            `maxCostUsdc = notional × maxStepCostBps / 10 000`.
    ///         7. `try fund.executeStep(order)`; on revert → both non-idle legs back off for one
    ///            effective cooldown (`AssetBackoff`) and skip `StepFailed` (detail = selector);
    ///            a gas-starved revert re-throws `StepGasStarved`.
    ///            Cost cap and budget halt are enforced inside `executeStep` (RB-4).
    ///         8. Emit `RebalanceStep` with the legs' path targets at `now`.
    /// @return executed True when a step traded.
    /// @return reason   `SkipReason.None` when executed, `Concluded` when this call moved the
    ///                  plan to Converged or Expired, else why not.
    function step() external returns (bool executed, SkipReason reason);

    // ─── Previews (§5.7) ─────────────────────────────────────────────────────

    /// @notice Preview a plan for a proposed sleeve vector at current TWAP. Per asset (index-
    ///         aligned): current weight, the asset-level target (`PlanMath.assetTargets`),
    ///         turnover `|target − current| × NAV / 10 000`, and estimated cost
    ///         `turnover × fund.poolFeeBps(i) / 10 000`. Reverts on an invalid vector.
    /// @return rows           Per-asset rows.
    /// @return totalTurnover  One-sided turnover: Σ max(target − current, 0) × NAV / 10 000
    ///                        (the same definition the fund uses for `plan.turnoverUsdc`).
    /// @return totalEstCost   Σ rows[i].estCostUsdc.
    function previewPlan(uint16[4] calldata sleeveBps)
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

    /// @notice Earliest timestamp at which `step()` is open to anyone (§5.4).
    ///         `type(uint256).max` while the plan is not Open.
    function permissionlessAt() external view returns (uint256);

    /// @notice Timestamp until which asset `index` is left out of leg picking after a failed step
    ///         (0 if never backed off). See `AssetBackoff`.
    function assetBackoffUntil(uint256 index) external view returns (uint64);

    /// @notice The cooldown `step()` enforces now: `max(stepInterval, fund.maxTwapWindow())`, so an
    ///         asset added later with a longer TWAP window still keeps RB-5.
    function effectiveStepInterval() external view returns (uint256);

    // ─── Parameters (§5.6), ADMIN_ROLE ───────────────────────────────────────

    /// @notice Set the global step parameters. Bounds (`StepParamOutOfBounds` /
    ///         `BoundAtOrBelowPoolFee`): see `StepParams` NatSpec. In particular
    ///         `stepInterval ≥ max(MIN_STEP_INTERVAL, fund.maxTwapWindow())` and
    ///         `maxStepCostBps >` the sum of the two largest active basket pool fees (a basket-to-basket
    ///         step pays both), and `minStepUsdc ≤` every asset's non-zero `maxStepUsdc`
    ///         (`MaxStepBelowMinStep`).
    function setStepParams(StepParams calldata params) external;

    /// @notice Set one asset's step parameters. Bounds: Basket `maxStepSlippageBps >
    ///         fund.poolFeeBps(index)` (`BoundAtOrBelowPoolFee`) and every kind
    ///         `maxStepSlippageBps ≤ fund.maxSlippageBps()` (`StepParamOutOfBounds`); a non-zero
    ///         `maxStepUsdc ≥ minStepUsdc` (`MaxStepBelowMinStep`).
    function setAssetStepParams(uint256 index, AssetStepParams calldata params) external;

    function stepParams() external view returns (StepParams memory);
    function assetStepParams(uint256 index) external view returns (AssetStepParams memory);

    /// @notice The fund this rebalancer drives. Set once at initialize, no setter.
    function fund() external view returns (IRobotMoneyFund);
}
