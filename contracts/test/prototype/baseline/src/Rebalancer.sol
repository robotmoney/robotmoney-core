// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.2 (glide path), §5.3 (one step), §5.4 (who calls),
//            §5.5 (plan states), §5.6 (governed parameters), §5.7 (previewPlan), §5.8 (threats),
//            §7 RB-2, RB-4, RB-5, RB-7
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
// FROZEN BASELINE (one-vault scaffold, 2026-11-11): a copy of the step 3c synchronous fund and its tests. Never edit.
// It is the sim's synchronous arm and the target of the baseline attack tests. The live tree is contracts/test/prototype/src.
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {AdminFloorAccessControl} from "../../../../lib/AdminFloorAccessControl.sol";
import {GovernedUUPS} from "../../../../lib/GovernedUUPS.sol";
import {
    AssetConfig,
    AssetKind,
    AssetStepParams,
    Plan,
    PlanPreviewRow,
    PlanStatus,
    Roles,
    SkipReason,
    StepOrder,
    StepParams,
    StepResult,
    BPS,
    IDLE_INDEX,
    MIN_STEP_INTERVAL,
    MAX_STEP_INTERVAL,
    MAX_STEP_COST_BPS,
    MAX_TOLERANCE_BPS,
    MAX_KEEPER_GRACE,
    MAX_OVERRUN
} from "./FundTypes.sol";
import {PlanMath} from "./PlanMath.sol";
import {IRobotMoneyFund} from "./interfaces/IRobotMoneyFund.sol";
import {IRebalancer} from "./interfaces/IRebalancer.sol";

/// @title Rebalancer
/// @notice Step selection for the one vault (§5). It holds no funds, grants no token approvals and
///         never receives tokens by design: it reads the fund, derives one `StepOrder` purely from
///         chain state, and calls `fund.executeStep`, which does all custody, swaps, NAV
///         measurement, the RB-7 guard, the per-step cost cap and the budget halt (RB-3, RB-4).
///
///         Authority:
///         - `step()`: KEEPER_ROLE always; anyone once `keeperGrace` has passed with no step on an
///           Open plan (§5.4). The caller chooses only WHEN (RB-2).
///         - Parameters (§5.6): ADMIN_ROLE (the timelock).
///         On the fund this contract holds REBALANCER_ROLE (`executeStep`, `concludePlan`).
///
///         Runtime hardening beyond the pinned interface (prototype choices, see NatSpec below):
///         - The cooldown is `max(stepInterval, fund.maxTwapWindow())`, so an asset added later
///           with a longer TWAP window can never make the cooldown shorter than a window (§5.3.1).
///         - Each leg's slippage floor is clamped to `fund.maxSlippageBps()` at run time, so a
///           later lowering of the fund ceiling is honoured without re-setting every asset.
///         - Per-asset backoff: when `executeStep` reverts, both non-idle legs are excluded from
///           leg picking for one cooldown, so a frozen venue stalls only its own asset while the
///           rest of the plan keeps converging (§5.8 "A venue freezes").
///         - Gas starvation: `executeStep` is only called with at least `STEP_GAS_FLOOR` gas left
///           (else `StepGasStarved`), and a revert that left this frame with under 1/63 of the gas it
///           forwarded is re-thrown, so a permissionless caller cannot force a fake `StepFailed` and a
///           backoff by sending too little gas.
///
///         Runs behind its own ERC-1967 proxy (`GovernedUUPS`). `fund` is set once at initialize.
contract Rebalancer is
    AdminFloorAccessControl,
    ReentrancyGuardUpgradeable,
    GovernedUUPS,
    IRebalancer
{
    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Sets step parameters and administers KEEPER_ROLE. Held by the timelock.
    bytes32 public constant ADMIN_ROLE = Roles.ADMIN_ROLE;
    /// @notice May call `step()` before `keeperGrace` has passed (§5.4).
    bytes32 public constant KEEPER_ROLE = Roles.KEEPER_ROLE;

    /// @notice Gas that must remain when `step()` calls `fund.executeStep` (RB-2, §5.8 row 5). A measured
    ///         worst-case step (two swaps, three TWAP NAV passes over six assets, nested 63/64 forwarding)
    ///         stays well under it, so with this much gas no frame inside the step can run out. A caller
    ///         that sends less gets `StepGasStarved`: nothing is recorded and no asset backs off. Without
    ///         the floor, an out-of-gas inside a nested frame (library, adapter, router, pool) hands every
    ///         parent its retained 1/64 back, slips past the `gasBefore / 63` check, and a permissionless
    ///         caller could book a fake `StepFailed` and choose which assets get masked.
    uint256 public constant STEP_GAS_FLOOR = 4_000_000;

    // ─── Storage ─────────────────────────────────────────────────────────────

    IRobotMoneyFund private _fund;
    StepParams private _stepParams;
    mapping(uint256 index => AssetStepParams) private _assetStepParams;
    /// @dev Asset index → timestamp until which the asset is excluded from leg picking after a
    ///      failed `executeStep` (§5.8 venue freeze).
    mapping(uint256 index => uint64) private _backoffUntil;

    // ─── Internal decision record ────────────────────────────────────────────

    /// @dev What `step()` would do now. `conclude` is None, Converged or Expired.
    struct Decision {
        SkipReason reason;
        PlanStatus conclude;
        uint256 sellIndex;
        uint256 buyIndex;
        uint256 notional;
        uint256 detail;
    }

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @notice Atomic proxy initialization.
    /// @param fund_    The fund this rebalancer drives. Set once, no setter.
    /// @param admin    Receives ADMIN_ROLE (deployer first, then the timelock).
    /// @param keeper   Receives KEEPER_ROLE. address(0) grants none (grace path only).
    /// @param params   Initial global step parameters, bounded as in `setStepParams` (§5.6).
    /// @param upgradeTimelock_ The only upgrade and freeze authority.
    /// @param upgradeMode_ Release mode; `Undeclared` reverts.
    function initialize(
        address fund_,
        address admin,
        address keeper,
        StepParams calldata params,
        address upgradeTimelock_,
        UpgradeMode upgradeMode_
    ) external initializer {
        __AccessControlEnumerable_init();
        __ReentrancyGuard_init();
        __GovernedUUPS_init(upgradeTimelock_, upgradeMode_);
        if (fund_ == address(0) || admin == address(0)) revert ZeroAddress();
        _fund = IRobotMoneyFund(fund_);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(KEEPER_ROLE, ADMIN_ROLE);
        _grantRole(ADMIN_ROLE, admin);
        if (keeper != address(0)) _grantRole(KEEPER_ROLE, keeper);
        _setStepParams(params);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Step (§5.3, §5.4)
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IRebalancer
    /// @dev Implements §5.3 steps 1 to 9 in order, plus the §5.5 Converged and Expired transitions.
    ///      Takes no input (RB-2). Skips return and emit `RebalanceStepSkipped`; only the access
    ///      check (`NotKeeperBeforeGrace`) and gas starvation (`StepGasStarved`) revert.
    ///      A concluded plan (Converged or Expired) returns `(false, Concluded)` with the fund's
    ///      `PlanStatusChanged` as its only event.
    function step() external nonReentrant returns (bool executed, SkipReason reason) {
        IRobotMoneyFund f = _fund;
        Plan memory p = f.plan();

        // §5.4: keeper first, anyone after grace while the plan is Open.
        if (!hasRole(KEEPER_ROLE, msg.sender)) {
            uint256 openAt = _permissionlessAt(f, p);
            if (block.timestamp < openAt) revert NotKeeperBeforeGrace(msg.sender, openAt);
        }

        Decision memory d = _decide(f, p);

        if (d.conclude != PlanStatus.None) {
            f.concludePlan(d.conclude);
            return (false, SkipReason.Concluded);
        }
        if (d.reason != SkipReason.None) {
            emit RebalanceStepSkipped(p.id, d.reason, d.sellIndex, d.buyIndex, d.detail);
            return (false, d.reason);
        }
        return _execute(f, p, d);
    }

    /// @dev §5.3 steps 5 to 9: build the TWAP floors, call the fund, report.
    function _execute(IRobotMoneyFund f, Plan memory p, Decision memory d)
        internal
        returns (bool executed, SkipReason reason)
    {
        StepOrder memory order = _buildOrder(f, d);
        uint256 gasBefore = gasleft();
        if (gasBefore < STEP_GAS_FLOOR) revert StepGasStarved();
        try f.executeStep(order) returns (StepResult memory r) {
            (uint256 sellPath, uint256 buyPath) = _legPathBps(p, d.sellIndex, d.buyIndex);
            emit RebalanceStep(
                p.id,
                d.sellIndex,
                d.buyIndex,
                d.notional,
                r.amountIn,
                r.amountOut,
                r.cost,
                sellPath,
                buyPath
            );
            return (true, SkipReason.None);
        } catch (bytes memory err) {
            // Second line of defence behind STEP_GAS_FLOOR: under 1/63 of the forwarded gas left means the
            // callee ran out of gas in its own frame. Re-throw, so no fake skip or backoff is recorded.
            if (gasleft() <= gasBefore / 63) revert StepGasStarved();
            uint256 selector;
            if (err.length >= 4) selector = uint256(uint32(bytes4(err)));
            _backoff(f, d.sellIndex);
            _backoff(f, d.buyIndex);
            emit RebalanceStepSkipped(
                p.id, SkipReason.StepFailed, d.sellIndex, d.buyIndex, selector
            );
            return (false, SkipReason.StepFailed);
        }
    }

    /// @dev Exclude a non-idle leg from leg picking for one effective cooldown (§5.8).
    function _backoff(IRobotMoneyFund f, uint256 index) internal {
        if (index == IDLE_INDEX) return;
        uint64 until = uint64(block.timestamp + _effectiveInterval(f));
        _backoffUntil[index] = until;
        emit AssetBackoff(index, until);
    }

    /// @dev §5.3 step 5: every floor comes from the TWAP, never from spot.
    ///      Basket sell: TWAP USDC value of the tokens the fund will sell, × (1 − slip).
    ///      Lending sell: notional × (1 − slip). Idle sell: 0.
    ///      Basket buy: TWAP token amount for `notional`, × (1 − slip). Lending or idle buy: 0.
    ///      Cost cap (§5.3 step 7, RB-4): notional × maxStepCostBps / 10 000.
    function _buildOrder(IRobotMoneyFund f, Decision memory d)
        internal
        view
        returns (StepOrder memory o)
    {
        o.sellIndex = d.sellIndex;
        o.buyIndex = d.buyIndex;
        o.notionalUsdc = d.notional;
        uint256 ceiling = f.maxSlippageBps();
        if (d.sellIndex != IDLE_INDEX) {
            uint256 keep = BPS - _slip(d.sellIndex, ceiling);
            if (f.assetConfig(d.sellIndex).kind == AssetKind.Basket) {
                uint256 quote =
                    f.assetUsdcValue(d.sellIndex, f.assetTokenValue(d.sellIndex, d.notional));
                o.minSellUsdcOut = Math.mulDiv(quote, keep, BPS);
            } else {
                o.minSellUsdcOut = Math.mulDiv(d.notional, keep, BPS);
            }
        }
        if (d.buyIndex != IDLE_INDEX && f.assetConfig(d.buyIndex).kind == AssetKind.Basket) {
            uint256 keep = BPS - _slip(d.buyIndex, ceiling);
            o.minBuyOut = Math.mulDiv(f.assetTokenValue(d.buyIndex, d.notional), keep, BPS);
        }
        o.maxCostUsdc = Math.mulDiv(d.notional, _stepParams.maxStepCostBps, BPS);
    }

    /// @dev The asset's step slippage, clamped to the fund's current ceiling.
    function _slip(uint256 index, uint256 ceiling) internal view returns (uint256) {
        uint256 s = _assetStepParams[index].maxStepSlippageBps;
        return s > ceiling ? ceiling : s;
    }

    /// @dev The legs' path targets at `now` in bps (idle's path for an IDLE_INDEX leg), §5.3 step 9.
    function _legPathBps(Plan memory p, uint256 sellIndex, uint256 buyIndex)
        internal
        view
        returns (uint256 sellPath, uint256 buyPath)
    {
        (uint256 e, uint256 dur) = PlanMath.progress(p.startTime, p.endTime, block.timestamp);
        sellPath = sellIndex == IDLE_INDEX
            ? PlanMath.pathBps(p.startIdleBps, 0, e, dur)
            : PlanMath.pathBps(p.startBps[sellIndex], p.endBps[sellIndex], e, dur);
        buyPath = buyIndex == IDLE_INDEX
            ? PlanMath.pathBps(p.startIdleBps, 0, e, dur)
            : PlanMath.pathBps(p.startBps[buyIndex], p.endBps[buyIndex], e, dur);
    }

    // ─── Decision (shared by step and previewStep) ───────────────────────────

    /// @dev §5.3 steps 0 to 4 and the §5.5 conclusions, as a pure read of chain state.
    function _decide(IRobotMoneyFund f, Plan memory p) internal view returns (Decision memory d) {
        d.sellIndex = IDLE_INDEX;
        d.buyIndex = IDLE_INDEX;
        StepParams memory sp = _stepParams;

        // 0. Only an Open plan trades. Past endTime + maxOverrun it expires (§5.5).
        if (p.status != PlanStatus.Open) {
            d.reason = SkipReason.PlanNotOpen;
            return d;
        }
        if (block.timestamp > uint256(p.endTime) + sp.maxOverrun) {
            d.reason = SkipReason.Concluded;
            d.conclude = PlanStatus.Expired;
            return d;
        }

        // 1. Cooldown (RB-5): at least one full TWAP window since the last executed step.
        uint256 readyAt = uint256(f.lastStepAt()) + _effectiveInterval(f);
        if (block.timestamp < readyAt) {
            d.reason = SkipReason.Cooldown;
            d.detail = readyAt - block.timestamp;
            return d;
        }

        (uint256 nav, uint256 idle, uint256[] memory values) = f.portfolioValues();

        // §5.5: after the path ends, stop once every holding sits inside toleranceBps of its end.
        if (
            block.timestamp >= p.endTime
                && PlanMath.withinTolerance(values, idle, nav, p.endBps, sp.toleranceBps)
        ) {
            d.reason = SkipReason.Concluded;
            d.conclude = PlanStatus.Converged;
            return d;
        }

        // 2. Eligible mask: active, tradeable (maxStepUsdc > 0), not backed off, passes ORA-4.
        //    An ORA-4 failure is masked out, so it is never a leg (RB-5).
        (bool[] memory eligible, uint256 oraFail, uint256 backoffLeft) = _eligible(f, values.length);

        // 3. Legs: most over vs most under pathTarget(now), at TWAP (RB-7 sizing below).
        PlanMath.Legs memory legs =
            PlanMath.pickLegs(values, idle, nav, p, block.timestamp, eligible);
        if (legs.over == 0 || legs.under == 0) {
            if (oraFail != IDLE_INDEX) {
                d.reason = SkipReason.MarketDeviation;
                d.detail = oraFail;
            } else if (backoffLeft != 0) {
                d.reason = SkipReason.Cooldown;
                d.detail = backoffLeft;
            } else {
                d.reason = SkipReason.NothingToTrade;
            }
            return d;
        }
        d.sellIndex = legs.sellIndex;
        d.buyIndex = legs.buyIndex;

        // 4. Size: min(over, under, maxStepUsdc of each non-idle leg). Never past path (RB-7).
        uint256 notional = Math.min(legs.over, legs.under);
        if (legs.sellIndex != IDLE_INDEX) {
            notional = Math.min(notional, _assetStepParams[legs.sellIndex].maxStepUsdc);
        }
        if (legs.buyIndex != IDLE_INDEX) {
            notional = Math.min(notional, _assetStepParams[legs.buyIndex].maxStepUsdc);
        }
        d.notional = notional;
        if (notional < sp.minStepUsdc) {
            d.reason = SkipReason.BelowMinStep;
            d.detail = notional;
        }
    }

    /// @dev §5.3 step 2. Returns the candidate mask, the first asset that failed ORA-4 (IDLE_INDEX
    ///      if none) and the longest remaining backoff among masked assets (0 if none).
    function _eligible(IRobotMoneyFund f, uint256 n)
        internal
        view
        returns (bool[] memory eligible, uint256 oraFail, uint256 backoffLeft)
    {
        eligible = new bool[](n);
        oraFail = IDLE_INDEX;
        AssetConfig[] memory cfgs = f.assetConfigs();
        for (uint256 i; i < n; ++i) {
            if (!cfgs[i].active || _assetStepParams[i].maxStepUsdc == 0) continue;
            // Inclusive end: a keeper stepping on the cooldown cadence lands exactly on `until`, and must
            // see the frozen asset still masked there, or it retries it forever and starves the others (§5.8).
            uint256 until = _backoffUntil[i];
            if (until >= block.timestamp) {
                uint256 left = until + 1 - block.timestamp;
                if (left > backoffLeft) backoffLeft = left;
                continue;
            }
            (bool ok,) = f.marketCheck(i);
            if (!ok) {
                if (oraFail == IDLE_INDEX) oraFail = i;
                continue;
            }
            eligible[i] = true;
        }
    }

    /// @dev `max(stepInterval, fund.maxTwapWindow())` (§5.3 step 1, §5.6).
    function _effectiveInterval(IRobotMoneyFund f) internal view returns (uint256) {
        return Math.max(_stepParams.stepInterval, f.maxTwapWindow());
    }

    /// @dev §5.4: `max(lastStepAt, startTime) + keeperGrace` while Open, else never.
    function _permissionlessAt(IRobotMoneyFund f, Plan memory p) internal view returns (uint256) {
        if (p.status != PlanStatus.Open) return type(uint256).max;
        uint256 base = Math.max(f.lastStepAt(), p.startTime);
        return base + _stepParams.keeperGrace;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Previews (§5.7)
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IRebalancer
    /// @dev Per asset at current TWAP: `turnover = |target − current| × NAV / 10 000` and
    ///      `estCost = turnover × fund.poolFeeBps(i) / 10 000` (0 for Lending). PROTOTYPE ESTIMATE:
    ///      pool fee only. It ignores price impact and the slippage allowance, so it is a lower
    ///      bound; the realized cost is bounded above by `maxStepCostBps` per step and by
    ///      `costBudgetBps` per plan. Reverts on a refused vector with the same `PlanMath.assetTargets`
    ///      errors the fund would raise at plan open (§4.1, RB-9), including `TargetExceedsCap`.
    function previewPlan(address[] calldata assets, uint256[] calldata bps)
        external
        view
        returns (PlanPreviewRow[] memory rows, uint256 totalTurnover, uint256 totalEstCost)
    {
        IRobotMoneyFund f = _fund;
        AssetConfig[] memory cfgs = f.assetConfigs();
        uint16[] memory targets = PlanMath.assetTargets(assets, bps, cfgs);
        (uint256 nav,, uint256[] memory values) = f.portfolioValues();
        uint256 n = cfgs.length;
        rows = new PlanPreviewRow[](n);
        for (uint256 i; i < n; ++i) {
            PlanPreviewRow memory r = rows[i];
            r.currentBps = PlanMath.weightBps(values[i], nav);
            r.targetBps = targets[i];
            uint256 diff = r.targetBps > r.currentBps
                ? r.targetBps - r.currentBps
                : r.currentBps - r.targetBps;
            r.turnoverUsdc = Math.mulDiv(nav, diff, BPS);
            r.estCostUsdc = Math.mulDiv(r.turnoverUsdc, f.poolFeeBps(i), BPS);
            if (r.targetBps > r.currentBps) totalTurnover += r.turnoverUsdc;
            totalEstCost += r.estCostUsdc;
        }
    }

    /// @inheritdoc IRebalancer
    /// @dev Same decision as `step()` at this block, without access check or state change. A plan
    ///      that `step()` would conclude (Converged or Expired) reports `Concluded` while
    ///      `fund.planStatus()` is still Open: a keeper should call `step()` in that case.
    function previewStep()
        external
        view
        returns (SkipReason reason, uint256 sellIndex, uint256 buyIndex, uint256 notionalUsdc)
    {
        IRobotMoneyFund f = _fund;
        Decision memory d = _decide(f, f.plan());
        return (d.reason, d.sellIndex, d.buyIndex, d.notional);
    }

    /// @inheritdoc IRebalancer
    /// @dev `type(uint256).max` when the plan is not Open (§5.4).
    function permissionlessAt() external view returns (uint256) {
        IRobotMoneyFund f = _fund;
        return _permissionlessAt(f, f.plan());
    }

    /// @inheritdoc IRebalancer
    function assetBackoffUntil(uint256 index) external view returns (uint64) {
        return _backoffUntil[index];
    }

    /// @inheritdoc IRebalancer
    function effectiveStepInterval() external view returns (uint256) {
        return _effectiveInterval(_fund);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Parameters (§5.6), ADMIN_ROLE
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IRebalancer
    function setStepParams(StepParams calldata params) external onlyRole(ADMIN_ROLE) {
        _setStepParams(params);
    }

    /// @dev §5.6 bounds. `stepInterval ≥ max(MIN_STEP_INTERVAL, fund.maxTwapWindow())`;
    ///      `keeperGrace ∈ [stepInterval, MAX_KEEPER_GRACE]`; `maxOverrun ≤ MAX_OVERRUN`;
    ///      `maxStepCostBps ∈ (fee1 + fee2, MAX_STEP_COST_BPS]` where fee1, fee2 are the two largest
    ///      active basket pool fees: leg picking pairs the most-over with the most-under asset, so a
    ///      basket-to-basket step pays both fees, and a cap at or below their sum would make every such
    ///      step fail and back off until the plan expires (`BoundAtOrBelowPoolFee`, index = the asset
    ///      with the largest fee, fee = the sum); `toleranceBps ∈ [1, MAX_TOLERANCE_BPS]`;
    ///      `minStepUsdc ≤` every asset's non-zero `maxStepUsdc` (`MaxStepBelowMinStep`).
    function _setStepParams(StepParams calldata params) internal {
        IRobotMoneyFund f = _fund;
        uint256 minInterval = Math.max(MIN_STEP_INTERVAL, f.maxTwapWindow());
        if (
            params.stepInterval < minInterval || params.stepInterval > MAX_STEP_INTERVAL
                || params.keeperGrace < params.stepInterval || params.keeperGrace > MAX_KEEPER_GRACE
                || params.maxOverrun > MAX_OVERRUN || params.maxStepCostBps > MAX_STEP_COST_BPS
                || params.toleranceBps == 0 || params.toleranceBps > MAX_TOLERANCE_BPS
        ) revert StepParamOutOfBounds();
        (uint256 feeIndex, uint256 maxFee) = _maxPoolFee(f);
        if (params.maxStepCostBps <= maxFee) {
            revert BoundAtOrBelowPoolFee(feeIndex, params.maxStepCostBps, maxFee);
        }
        uint256 n = f.assetCount();
        for (uint256 i; i < n; ++i) {
            uint256 cap = _assetStepParams[i].maxStepUsdc;
            if (cap != 0 && cap < params.minStepUsdc) {
                revert MaxStepBelowMinStep(i, cap, params.minStepUsdc);
            }
        }
        _stepParams = params;
        emit StepParamsSet(params);
    }

    /// @dev Sum of the two largest active basket pool fees in bps (the cost floor of a basket-to-basket
    ///      step), and the index of the largest (IDLE_INDEX, 0 when there is no basket asset).
    function _maxPoolFee(IRobotMoneyFund f) internal view returns (uint256 index, uint256 feeSum) {
        index = IDLE_INDEX;
        uint256 first;
        uint256 second;
        AssetConfig[] memory cfgs = f.assetConfigs();
        for (uint256 i; i < cfgs.length; ++i) {
            if (!cfgs[i].active || cfgs[i].kind != AssetKind.Basket) continue;
            uint256 fee = f.poolFeeBps(i);
            if (index == IDLE_INDEX || fee > first) {
                second = first;
                first = fee;
                index = i;
            } else if (fee > second) {
                second = fee;
            }
        }
        feeSum = first + second;
    }

    /// @inheritdoc IRebalancer
    /// @dev §5.6 last paragraph. With `maxStepUsdc == 0` (asset not traded) no bound is checked,
    ///      so disabling an asset is never blocked. Otherwise: every kind
    ///      `maxStepSlippageBps ≤ fund.maxSlippageBps()` (`StepParamOutOfBounds`); Basket
    ///      `maxStepSlippageBps > fund.poolFeeBps(index)`, and a non-zero
    ///      `fund.navDeviationGuardBps()` must also exceed that fee (`BoundAtOrBelowPoolFee`);
    ///      `maxStepUsdc ≥ minStepUsdc` (`MaxStepBelowMinStep`: a cap below the dust floor would make
    ///      every step on this asset skip `BelowMinStep` and, as the most-deviating asset, stall the plan).
    function setAssetStepParams(uint256 index, AssetStepParams calldata params)
        external
        onlyRole(ADMIN_ROLE)
    {
        IRobotMoneyFund f = _fund;
        if (index >= f.assetCount()) revert InvalidAssetIndex(index);
        if (params.maxStepUsdc != 0) {
            uint256 minStep = _stepParams.minStepUsdc;
            if (params.maxStepUsdc < minStep) {
                revert MaxStepBelowMinStep(index, params.maxStepUsdc, minStep);
            }
            if (params.maxStepSlippageBps > f.maxSlippageBps()) revert StepParamOutOfBounds();
            if (f.assetConfig(index).kind == AssetKind.Basket) {
                uint256 fee = f.poolFeeBps(index);
                if (params.maxStepSlippageBps <= fee) {
                    revert BoundAtOrBelowPoolFee(index, params.maxStepSlippageBps, fee);
                }
                uint256 guard = f.navDeviationGuardBps();
                if (guard != 0 && guard <= fee) revert BoundAtOrBelowPoolFee(index, guard, fee);
            }
        }
        _assetStepParams[index] = params;
        emit AssetStepParamsSet(index, params);
    }

    /// @inheritdoc IRebalancer
    function stepParams() external view returns (StepParams memory) {
        return _stepParams;
    }

    /// @inheritdoc IRebalancer
    function assetStepParams(uint256 index) external view returns (AssetStepParams memory) {
        return _assetStepParams[index];
    }

    /// @inheritdoc IRebalancer
    function fund() external view returns (IRobotMoneyFund) {
        return _fund;
    }
}
