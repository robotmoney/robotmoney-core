// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.1 (asset target = sleeveBps × intraBps / 10 000),
//            §4.3 (deficit-first deposits), §5.1 (start snapshot), §5.2 (glide path), §5.3 step 3-4 (leg pick),
//            §5.5 (toleranceBps convergence), §7 RB-7 (never past pathTarget)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    AssetConfig,
    IFundEvents,
    Plan,
    NUM_SLEEVES,
    SLEEVE_AGENT,
    BPS,
    IDLE_INDEX
} from "./FundTypes.sol";

/// @title PlanMath
/// @notice The single home of the glide-path and weight math. Both `RobotMoneyFund` (start snapshot,
///         turnover, deficit-first deposits, the RB-7 guard in `executeStep`) and `Rebalancer` (leg
///         picking, sizing, convergence) call it, so the two can never disagree on what
///         `pathTarget(now)` is.
///
///         Units. Weights are basis points of fund NAV (10 000 = 100%). Values are USDC base units
///         (6 decimals) at TWAP. "Idle" is the fund's own USDC balance; its target is always 0 and
///         its path glides from the plan's `startIdleBps` to 0.
///
///         Rounding. Path targets round toward the plan's START weight, so the path never runs
///         ahead of the linear schedule and the rebalancer never moves past `pathTarget(now)`
///         (RB-7). Weights of actual holdings round down.
///
///         All functions are `internal pure`: inlined into each caller, no linking.
library PlanMath {
    /// @notice Result of `pickLegs`.
    /// @param sellIndex Most-overweight candidate, or IDLE_INDEX; meaningless when `over == 0`.
    /// @param over      Its excess over path in USDC (0 means: nothing to sell).
    /// @param buyIndex  Most-underweight candidate, or IDLE_INDEX; meaningless when `under == 0`.
    /// @param under     Its shortfall under path in USDC (0 means: nothing to buy).
    struct Legs {
        uint256 sellIndex;
        uint256 over;
        uint256 buyIndex;
        uint256 under;
    }

    // ─── Sleeve vectors (§4.1, §5.1) ─────────────────────────────────────────

    /// @notice Revert unless `sleeveBps` is a valid end target: sums to 10 000 and the agent sleeve
    ///         is 0 (ADR-0017).
    function validateSleeveBps(uint16[4] memory sleeveBps) internal pure {
        if (sleeveBps[SLEEVE_AGENT] != 0) revert IFundEvents.AgentSleeveNotZero(sleeveBps[SLEEVE_AGENT]);
        uint256 sum;
        for (uint256 s; s < NUM_SLEEVES; ++s) {
            sum += sleeveBps[s];
        }
        if (sum != BPS) revert IFundEvents.SleeveSumInvalid(sum);
    }

    /// @notice Turn a receipt-shaped `(sleeves, bps)` pair into the canonical sleeve vector, then
    ///         validate it (§5.1 step 2). `sleeves[k]` is a sleeve id (SLEEVE_*); each id may appear
    ///         at most once; an omitted sleeve is 0.
    /// @dev Reverts `InvalidParam` on a length mismatch, more than NUM_SLEEVES entries, an id
    ///      >= NUM_SLEEVES, a duplicate id, or a bps value > 10 000.
    function canonicalSleeveBps(uint8[] memory sleeves, uint256[] memory bps)
        internal
        pure
        returns (uint16[4] memory out)
    {
        uint256 n = sleeves.length;
        if (n != bps.length || n > NUM_SLEEVES) revert IFundEvents.InvalidParam();
        bool[4] memory seen;
        for (uint256 k; k < n; ++k) {
            uint8 s = sleeves[k];
            if (s >= NUM_SLEEVES || seen[s] || bps[k] > BPS) revert IFundEvents.InvalidParam();
            seen[s] = true;
            out[s] = uint16(bps[k]);
        }
        validateSleeveBps(out);
    }

    /// @notice Asset-level end targets: `sleeveBps[sleeve] × intraBps / 10 000` per active asset
    ///         (§4.1). The floor-rounding remainder of each sleeve goes to that sleeve's LAST active
    ///         asset, so each sleeve's asset targets sum to exactly `sleeveBps[sleeve]` and the
    ///         whole vector sums to exactly 10 000 for a valid sleeve vector.
    /// @dev Reverts `SleeveHasNoAssets` when a sleeve with a non-zero weight has no active asset,
    ///      and `IntraSleeveSumInvalid` when a sleeve's active `intraBps` do not sum to 10 000 (a
    ///      sleeve with zero weight is not checked). Inactive assets get 0.
    function assetTargets(uint16[4] memory sleeveBps, AssetConfig[] memory assets)
        internal
        pure
        returns (uint16[] memory targets)
    {
        uint256 n = assets.length;
        targets = new uint16[](n);
        for (uint8 s; s < NUM_SLEEVES; ++s) {
            uint256 sw = sleeveBps[s];
            if (sw == 0) continue;
            uint256 intraSum;
            uint256 given;
            uint256 last = IDLE_INDEX;
            for (uint256 i; i < n; ++i) {
                AssetConfig memory a = assets[i];
                if (!a.active || a.sleeve != s) continue;
                intraSum += a.intraBps;
                uint256 t = (sw * a.intraBps) / BPS;
                targets[i] = uint16(t);
                given += t;
                last = i;
            }
            if (last == IDLE_INDEX) revert IFundEvents.SleeveHasNoAssets(s);
            if (intraSum != BPS) revert IFundEvents.IntraSleeveSumInvalid(s, intraSum);
            targets[last] += uint16(sw - given);
        }
    }

    // ─── Weights ─────────────────────────────────────────────────────────────

    /// @notice `value` as bps of `nav`, rounded down. 0 when `nav` is 0.
    function weightBps(uint256 value, uint256 nav) internal pure returns (uint256) {
        if (nav == 0) return 0;
        return Math.mulDiv(value, BPS, nav);
    }

    /// @notice Actual weights of every asset and of idle, rounded down.
    function weightsBps(uint256[] memory values, uint256 idle, uint256 nav)
        internal
        pure
        returns (uint256[] memory bps, uint256 idleBps)
    {
        uint256 n = values.length;
        bps = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            bps[i] = weightBps(values[i], nav);
        }
        idleBps = weightBps(idle, nav);
    }

    /// @notice The plan's start point (§5.1 step 3): actual TWAP weights, floor-rounded, with idle
    ///         absorbing the rounding so `Σ start + startIdle == 10 000`. When `nav` is 0 there is
    ///         nothing to glide: start equals `endBps` and `startIdle` is 0, so the first deposits
    ///         allocate straight to the target (§9 step 2) and the rebalancer has nothing to do.
    function snapshotStart(uint256[] memory values, uint256 nav, uint16[] memory endBps)
        internal
        pure
        returns (uint16[] memory startBps, uint16 startIdleBps)
    {
        uint256 n = values.length;
        startBps = new uint16[](n);
        if (nav == 0) {
            for (uint256 i; i < n; ++i) {
                startBps[i] = endBps[i];
            }
            return (startBps, 0);
        }
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            uint256 w = weightBps(values[i], nav);
            startBps[i] = uint16(w);
            sum += w;
        }
        // Σ values <= nav (idle is the rest), so sum <= 10 000.
        startIdleBps = uint16(BPS - sum);
    }

    /// @notice One-sided planned turnover in USDC: `nav × Σ max(end_i − start_i, 0) / 10 000`.
    ///         Idle is excluded (its end is 0, so it never adds buy-side turnover).
    function turnoverUsdc(uint16[] memory startBps, uint16[] memory endBps, uint256 nav)
        internal
        pure
        returns (uint256)
    {
        uint256 up;
        for (uint256 i; i < startBps.length; ++i) {
            if (endBps[i] > startBps[i]) up += endBps[i] - startBps[i];
        }
        return Math.mulDiv(nav, up, BPS);
    }

    // ─── Glide path (§5.2) ───────────────────────────────────────────────────

    /// @notice `(elapsed, duration)` with `elapsed = clamp(t − startTime, 0, duration)`.
    ///         `f(t) = elapsed / duration`. A zero-length window returns (1, 1) (fully elapsed).
    function progress(uint64 startTime, uint64 endTime, uint256 t)
        internal
        pure
        returns (uint256 elapsed, uint256 duration)
    {
        if (endTime <= startTime) return (1, 1);
        duration = endTime - startTime;
        if (t <= startTime) return (0, duration);
        elapsed = t - startTime;
        if (elapsed > duration) elapsed = duration;
    }

    /// @notice `start + (end − start) × elapsed / duration`, in bps, rounded toward `start`.
    function pathBps(uint256 startBps, uint256 endBps, uint256 elapsed, uint256 duration)
        internal
        pure
        returns (uint256)
    {
        if (endBps >= startBps) return startBps + ((endBps - startBps) * elapsed) / duration;
        return startBps - ((startBps - endBps) * elapsed) / duration;
    }

    /// @notice `pathTarget(t)` of plan `p` for every asset and for idle (§5.2), in bps.
    function pathTargetsBps(Plan memory p, uint256 t)
        internal
        pure
        returns (uint256[] memory bps, uint256 idleBps)
    {
        (uint256 e, uint256 d) = progress(p.startTime, p.endTime, t);
        uint256 n = p.startBps.length;
        bps = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            bps[i] = pathBps(p.startBps[i], p.endBps[i], e, d);
        }
        idleBps = pathBps(p.startIdleBps, 0, e, d);
    }

    /// @notice USDC path target of asset `index` (or idle for IDLE_INDEX) under plan `p` at `t`,
    ///         for a fund valued at `nav`. Uses `pathValue` (no bps truncation).
    function pathTargetValue(Plan memory p, uint256 index, uint256 t, uint256 nav)
        internal
        pure
        returns (uint256)
    {
        (uint256 e, uint256 d) = progress(p.startTime, p.endTime, t);
        if (index == IDLE_INDEX) return pathValue(p.startIdleBps, 0, e, d, nav);
        return pathValue(p.startBps[index], p.endBps[index], e, d, nav);
    }

    /// @notice A path target as a USDC value, computed without the intermediate bps truncation:
    ///         `nav × (start × d + (end − start) × e) / (d × 10 000)`, rounded toward `start`'s value.
    function pathValue(uint256 startBps, uint256 endBps, uint256 elapsed, uint256 duration, uint256 nav)
        internal
        pure
        returns (uint256)
    {
        uint256 scale = duration * BPS;
        if (endBps >= startBps) {
            return Math.mulDiv(nav, startBps * duration + (endBps - startBps) * elapsed, scale);
        }
        // Rounding toward start: round the subtracted movement down, i.e. the result up.
        return Math.mulDiv(nav, startBps * duration - (startBps - endBps) * elapsed, scale, Math.Rounding.Ceil);
    }

    /// @notice `(over, under)` of a holding against its target value. At most one is non-zero.
    function deviation(uint256 value, uint256 targetValue) internal pure returns (uint256 over, uint256 under) {
        if (value > targetValue) return (value - targetValue, 0);
        return (0, targetValue - value);
    }

    // ─── Leg picking (§5.3 step 3, RB-7) ─────────────────────────────────────

    /// @notice Pick the most-overweight and most-underweight holdings against `pathTarget(now)`.
    ///         Idle USDC is a candidate on both sides (target: its own glide path to 0). Asset `i`
    ///         is a candidate only when `eligible[i]` (the caller masks out inactive assets, assets
    ///         failing ORA-4, assets with `maxStepUsdc == 0`, frozen venues).
    /// @param values   TWAP value per asset (length n).
    /// @param idle     Idle USDC.
    /// @param nav      `idle + Σ values` (the caller passes the same NAV it valued with).
    /// @param p        The plan (`fund.plan()`); uses startBps, endBps, startIdleBps, start/endTime.
    /// @param t        Evaluation time (normally `block.timestamp`).
    /// @param eligible Per-asset candidate mask (length n).
    /// @return legs See `Legs`.
    /// @dev Because Σ path == 10 000 (to rounding) and Σ actual == 10 000, total over == total
    ///      under, so when every holding is eligible an over always has a matching under.
    ///      `sellIndex != buyIndex` whenever both `over` and `under` are non-zero.
    ///      Sizing rule for the caller: `notional = min(over, under, maxStepUsdc[sell], maxStepUsdc[buy])`
    ///      (idle legs have no cap). That keeps both legs on their side of the path (RB-7).
    function pickLegs(
        uint256[] memory values,
        uint256 idle,
        uint256 nav,
        Plan memory p,
        uint256 t,
        bool[] memory eligible
    ) internal pure returns (Legs memory legs) {
        legs.sellIndex = IDLE_INDEX;
        legs.buyIndex = IDLE_INDEX;
        // Idle first; assets replace it only when strictly further from path.
        (legs.over, legs.under) = deviation(idle, pathTargetValue(p, IDLE_INDEX, t, nav));
        for (uint256 i; i < values.length; ++i) {
            if (eligible[i]) _consider(legs, i, values[i], pathTargetValue(p, i, t, nav));
        }
    }

    /// @dev `pickLegs` inner step: replace the best sell / buy candidate when asset `i` is strictly
    ///      further over / under its target value.
    function _consider(Legs memory legs, uint256 i, uint256 value, uint256 targetValue) private pure {
        (uint256 o, uint256 u) = deviation(value, targetValue);
        if (o > legs.over) {
            legs.over = o;
            legs.sellIndex = i;
        }
        if (u > legs.under) {
            legs.under = u;
            legs.buyIndex = i;
        }
    }

    // ─── Convergence (§5.5) ──────────────────────────────────────────────────

    /// @notice True when every asset and idle sit within `toleranceBps` of NAV of their END
    ///         target: `|value_i − end_i × nav / 10 000| ≤ toleranceBps × nav / 10 000`, and
    ///         `idle ≤ toleranceBps × nav / 10 000`. Callers also require `now ≥ endTime` before
    ///         marking a plan Converged. A zero NAV is converged.
    function withinTolerance(
        uint256[] memory values,
        uint256 idle,
        uint256 nav,
        uint16[] memory endBps,
        uint256 toleranceBps
    ) internal pure returns (bool) {
        if (nav == 0) return true;
        uint256 band = Math.mulDiv(nav, toleranceBps, BPS);
        if (idle > band) return false;
        for (uint256 i; i < values.length; ++i) {
            (uint256 o, uint256 u) = deviation(values[i], Math.mulDiv(nav, endBps[i], BPS));
            if (o > band || u > band) return false;
        }
        return true;
    }

    // ─── Deficit-first deposits (§4.3) ───────────────────────────────────────

    /// @notice Split a deposit of `amount` USDC across assets, deficit-first (§4.3, D7), against the
    ///         CURRENT plan target `curBps` (`pathTarget(now)` while a plan is live, else the end target),
    ///         taken at the post-deposit NAV `navAfter = navBefore + amount`.
    ///         Idle USDC is a holding like any other: while a plan is live its target is its own glide
    ///         path `idlePath = 10 000 − Σ curBps` (§5.2), exactly as the rebalancer sees it.
    ///         - `deficit_i = max(curBps_i × navAfter / 10 000 − value_i, 0)` per asset, and
    ///           `deficit_idle = max(idlePath × navAfter / 10 000 − idleBefore, 0)` with
    ///           `idleBefore = navBefore − Σ values`.
    ///         - If `Σ deficit ≥ amount`: each holding gets `amount × deficit / Σ deficit` (idle's share
    ///           simply stays idle). The rounding remainder goes to the largest asset shortfall when idle
    ///           has none, else it stays idle.
    ///         - Else every deficit is filled and the rest is split by `curBps`; idle's path share stays
    ///           idle. With no live plan `Σ curBps = 10 000`, so the rounding remainder goes to the asset
    ///           with the largest `curBps`.
    ///         So a deposit during a plan never pushes an asset past `pathTarget(now)` while idle sits
    ///         under its own path; the rebalancer would only sell that back (a swap round trip every
    ///         holder pays, against §4.3 "free rebalancing" and §5.7 "reduced by deficit-first deposits").
    ///         The caller (the fund) clips Lending allocations at `capBps` headroom and leaves any clipped
    ///         or venue-refused USDC idle.
    function deficitSplit(
        uint256[] memory values,
        uint256 navBefore,
        uint256 amount,
        uint256[] memory curBps
    ) internal pure returns (uint256[] memory alloc) {
        uint256 n = values.length;
        alloc = new uint256[](n);
        if (amount == 0 || n == 0) return alloc;
        DeficitAcc memory acc = _assetDeficits(values, navBefore + amount, curBps, alloc);
        uint256 idleDef = _idleDeficit(navBefore, navBefore + amount, acc.sumVal, acc.sumBps);
        uint256 totalDef = acc.totalDef + idleDef;
        if (totalDef >= amount) {
            uint256 given;
            for (uint256 i; i < n; ++i) {
                if (alloc[i] == 0) continue;
                alloc[i] = Math.mulDiv(amount, alloc[i], totalDef);
                given += alloc[i];
            }
            if (idleDef == 0) alloc[acc.maxDefIdx] += amount - given;
            return alloc;
        }
        uint256 rest = amount - totalDef;
        uint256 restGiven;
        uint256 maxIdx;
        for (uint256 i; i < n; ++i) {
            uint256 share = Math.mulDiv(rest, curBps[i], BPS);
            alloc[i] += share;
            restGiven += share;
            if (curBps[i] > curBps[maxIdx]) maxIdx = i;
        }
        if (acc.sumBps == BPS) alloc[maxIdx] += rest - restGiven;
    }

    /// @dev `deficitSplit` accumulator (stack depth).
    struct DeficitAcc {
        uint256 totalDef;
        uint256 maxDefIdx;
        uint256 maxDef;
        uint256 sumBps;
        uint256 sumVal;
    }

    /// @dev Write each asset's deficit at `navAfter` into `alloc`; return the sums.
    function _assetDeficits(
        uint256[] memory values,
        uint256 navAfter,
        uint256[] memory curBps,
        uint256[] memory alloc
    ) private pure returns (DeficitAcc memory acc) {
        for (uint256 i; i < values.length; ++i) {
            acc.sumBps += curBps[i];
            acc.sumVal += values[i];
            uint256 tv = Math.mulDiv(navAfter, curBps[i], BPS);
            if (tv <= values[i]) continue;
            uint256 dfc = tv - values[i];
            alloc[i] = dfc;
            acc.totalDef += dfc;
            if (dfc > acc.maxDef) {
                acc.maxDef = dfc;
                acc.maxDefIdx = i;
            }
        }
    }

    /// @dev Idle's shortfall under its path at `navAfter`: `idlePath = 10 000 − Σ curBps` when that is
    ///      positive (a live plan), else 0. `idleBefore = navBefore − Σ values`.
    function _idleDeficit(uint256 navBefore, uint256 navAfter, uint256 sumVal, uint256 sumBps)
        private
        pure
        returns (uint256)
    {
        if (sumBps >= BPS) return 0;
        uint256 idleBefore = navBefore > sumVal ? navBefore - sumVal : 0;
        uint256 tv = Math.mulDiv(navAfter, BPS - sumBps, BPS);
        return tv > idleBefore ? tv - idleBefore : 0;
    }
}
