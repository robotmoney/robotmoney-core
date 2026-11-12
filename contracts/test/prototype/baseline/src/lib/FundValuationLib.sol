// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.2 (NAV), §4.3 (ORA-4 on deposit),
//            §5.3 step 2 (market check), §5.6 last paragraph (bounds above the pool fee), §6.1 (size)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
// FROZEN BASELINE (one-vault scaffold, 2026-11-11): a copy of the step 3c synchronous fund and its tests. Never edit.
// It is the sim's synchronous arm and the target of the baseline attack tests. The live tree is contracts/test/prototype/src.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStrategyAdapter} from "../../../../../interfaces/IStrategyAdapter.sol";
import {IBasketSwapAdapter} from "../../../../../interfaces/IBasketSwapAdapter.sol";
import {IObservablePool} from "../../../../../interfaces/IObservablePool.sol";
import {TwapTickMath} from "../../../../../lib/TwapTickMath.sol";
import {RobotMoneyVaultOps} from "../../../../../lib/RobotMoneyVaultOps.sol";
import {AssetConfig, AssetKind, IFundEvents, Plan, PlanStatus, Venue, BPS} from "../FundTypes.sol";
import {PlanMath} from "../PlanMath.sol";
import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {FundState} from "./FundStorage.sol";

/// @title FundValuationLib
/// @notice NAV, TWAP pricing and the ORA-4 market check of `RobotMoneyFund` (§4.2), as an externally linked
///         library: it runs by DELEGATECALL as the fund, so `address(this)` is the fund.
///
///         NAV = idle USDC + Σ counted Lending `adapter.totalAssets()` + Σ active Basket balance × TWAP.
///         This is the union of `RobotMoneyVault.totalAssets` (with ADP-2 exclusion) and
///         `BasketVault.totalAssets` (TWAP through the asset's `IBasketSwapAdapter.twapPrice`, never spot).
library FundValuationLib {
    using Math for uint256;

    /// @dev USDC probe for the ORA-4 check: 1 USDC priced into the token (BasketViews.checkNavDeviation).
    uint256 internal constant ORA4_PROBE_USDC = 1e6;

    // ─── Counting (§4.2, ADP-2) ─────────────────────────────────────────────

    /// @notice Asset `i` counts in NAV and may trade: active, and for Lending also an allowed adapter code
    ///         hash and no open exclusion record (`RobotMoneyVaultOps.isCounted`, simplified: the adapter's
    ///         `VAULT`/`USDC` binding is checked once at `addAsset` and pinned by the code hash, since both
    ///         are immutables baked into the runtime code the hash covers).
    function isCounted(FundState storage s, uint256 i) internal view returns (bool) {
        AssetConfig storage a = s.assets[i];
        if (!a.active) return false;
        if (a.kind == AssetKind.Basket) return true;
        return s.codeHashAllowed[a.adapter.codehash] && RobotMoneyVaultOps.exclusions().openExclusionOf[i] == 0;
    }

    /// @notice True while an active Lending asset is excluded (ADP-2). Deposits close meanwhile, as on
    ///         `RobotMoneyVault` (core 1788): a deposit would mint against a NAV the excluded value left.
    function anyExcluded(FundState storage s) internal view returns (bool) {
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            AssetConfig storage a = s.assets[i];
            if (a.active && a.kind == AssetKind.Lending && !isCounted(s, i)) return true;
        }
        return false;
    }

    // ─── NAV (§4.2) ──────────────────────────────────────────────────────────

    /// @notice What the holders own of asset `i`: Basket the fund's token balance, Lending the adapter's
    ///         `totalAssets()`, each less `deferredTotal[i]` (owed to past in-kind exits, §4.4), floored at 0.
    ///         Every NAV read and every pro-rata leg uses this, never the raw balance.
    function heldBalance(FundState storage s, uint256 i) internal view returns (uint256 bal) {
        AssetConfig storage a = s.assets[i];
        bal = a.kind == AssetKind.Lending
            ? IStrategyAdapter(a.adapter).totalAssets()
            : IERC20(a.token).balanceOf(address(this));
        uint256 owed = s.deferredTotal[i];
        bal = bal > owed ? bal - owed : 0;
    }

    /// @notice USDC value of asset `i` at TWAP (Lending: `heldBalance`, 1:1). 0 when not counted.
    function assetValue(FundState storage s, uint256 i) public view returns (uint256) {
        if (!isCounted(s, i)) return 0;
        AssetConfig storage a = s.assets[i];
        uint256 bal = heldBalance(s, i);
        if (a.kind == AssetKind.Lending || bal == 0) return bal;
        return IBasketSwapAdapter(a.adapter).twapPrice(a.pool, a.token, s.usdc, bal, a.twapWindow);
    }

    /// @notice `totalAssets()`: idle plus every counted asset's value.
    function nav(FundState storage s) public view returns (uint256 sum) {
        sum = IERC20(s.usdc).balanceOf(address(this));
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            sum += assetValue(s, i);
        }
    }

    /// @notice One-call valuation: `nav == idle + Σ values == totalAssets()`.
    function portfolio(FundState storage s)
        public
        view
        returns (uint256 total, uint256 idle, uint256[] memory values)
    {
        idle = IERC20(s.usdc).balanceOf(address(this));
        total = idle;
        uint256 n = s.assets.length;
        values = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 v = assetValue(s, i);
            values[i] = v;
            total += v;
        }
    }

    /// @notice USDC value of `amount` of asset `i` at TWAP. Lending: identity.
    function usdcValue(FundState storage s, uint256 i, uint256 amount) public view returns (uint256) {
        AssetConfig storage a = s.assets[i];
        if (a.kind == AssetKind.Lending || amount == 0) return amount;
        return IBasketSwapAdapter(a.adapter).twapPrice(a.pool, a.token, s.usdc, amount, a.twapWindow);
    }

    /// @notice Amount of asset `i` worth `usdcAmount` at TWAP. Lending: identity.
    function tokenValue(FundState storage s, uint256 i, uint256 usdcAmount) public view returns (uint256) {
        AssetConfig storage a = s.assets[i];
        if (a.kind == AssetKind.Lending || usdcAmount == 0) return usdcAmount;
        return IBasketSwapAdapter(a.adapter).twapPrice(a.pool, s.usdc, a.token, usdcAmount, a.twapWindow);
    }

    // ─── ORA-4 (§4.3, §5.3 step 2) ───────────────────────────────────────────

    /// @notice ORA-4 for asset `i`. Never reverts. `ok` for a counted Lending asset and whenever the guard is
    ///         0. An excluded Lending asset reads NOT ok (so the Rebalancer's eligibility mask drops it: it
    ///         cannot take or return USDC). A Basket asset whose TWAP, spot or probe read fails reads not ok
    ///         with `deviationBps == type(uint256).max`. Otherwise `ok` iff |spot − TWAP| / TWAP ≤ guard
    ///         (`TwapTickMath.deviationBps` arithmetic, with every external read wrapped in try/catch).
    function marketCheck(FundState storage s, uint256 i) public view returns (bool ok, uint256 deviationBps) {
        if (i >= s.assets.length) return (false, 0);
        AssetConfig storage a = s.assets[i];
        if (a.kind == AssetKind.Lending) return (isCounted(s, i) || !a.active, 0);
        uint256 guard = s.navDeviationGuardBps;
        if (guard == 0) return (true, 0);
        (bool read, uint256 dev) = _deviation(s.usdc, a);
        if (!read) return (false, type(uint256).max);
        return (dev <= guard, dev);
    }

    /// @notice Revert `NavMarketDeviationExceeded` unless every active Basket asset passes ORA-4, and
    ///         `DepositsClosedDuringExclusion` while a Lending asset is excluded (ADP-2, core 1788). The deposit gate
    ///         (§4.3), one linked call.
    function requireDepositable(FundState storage s) public view {
        if (anyExcluded(s)) revert IRobotMoneyFund.DepositsClosedDuringExclusion();
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            AssetConfig storage a = s.assets[i];
            if (a.active && a.kind == AssetKind.Basket) requireMarket(s, i);
        }
    }

    /// @notice Revert `NavMarketDeviationExceeded` when asset `i` fails ORA-4.
    function requireMarket(FundState storage s, uint256 i) internal view {
        (bool ok, uint256 dev) = marketCheck(s, i);
        if (!ok) {
            revert IRobotMoneyFund.NavMarketDeviationExceeded(s.assets[i].token, dev, s.navDeviationGuardBps);
        }
    }

    /// @dev |spot − TWAP| / TWAP in bps on a 1 USDC probe of the token; `read` false when any read reverts.
    function _deviation(address usdc, AssetConfig storage a) private view returns (bool read, uint256 dev) {
        uint256 probe;
        try IBasketSwapAdapter(a.adapter).twapPrice(a.pool, usdc, a.token, ORA4_PROBE_USDC, a.twapWindow) returns (
            uint256 q
        ) {
            probe = q;
        } catch {
            return (false, 0);
        }
        if (probe == 0) return (true, 0);
        (bool okMean, int24 mean) = _tryMeanTick(a.pool, a.twapWindow);
        if (!okMean) return (false, 0);
        int24 spot;
        try IObservablePool(a.pool).slot0() returns (uint160, int24 t, uint16, uint16) {
            spot = t;
        } catch {
            return (false, 0);
        }
        uint256 twapVal = TwapTickMath.priceFromTick(mean, a.token, usdc, probe);
        if (twapVal == 0) return (true, 0);
        uint256 spotVal = TwapTickMath.priceFromTick(spot, a.token, usdc, probe);
        uint256 diff = twapVal > spotVal ? twapVal - spotVal : spotVal - twapVal;
        return (true, diff.mulDiv(BPS, twapVal));
    }

    /// @dev `TwapTickMath.meanTick` with the `observe` read wrapped in try/catch (Uniswap OracleLibrary rounding).
    function _tryMeanTick(address pool, uint32 window) private view returns (bool ok, int24 tick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        try IObservablePool(pool).observe(secondsAgos) returns (int56[] memory cums, uint160[] memory) {
            int56 delta = cums[1] - cums[0];
            int56 w = int56(uint56(window));
            tick = int24(delta / w);
            if (delta < 0 && (delta % w != 0)) tick--;
            ok = true;
        } catch {}
    }

    // ─── Bounds (§5.6 last paragraph) ────────────────────────────────────────

    /// @notice Asset `i`'s pool fee in bps rounded up; 0 for Lending. For an Aerodrome asset `poolFee` is the
    ///         tick spacing the adapter takes, so the fee is read from the pool's `fee()` (pips) when it
    ///         answers, else `poolFee` is used.
    function poolFeeBps(FundState storage s, uint256 i) public view returns (uint256) {
        AssetConfig storage a = s.assets[i];
        if (a.kind == AssetKind.Lending) return 0;
        uint256 pips = a.poolFee;
        if (a.venue == Venue.Aerodrome) {
            (bool ok, bytes memory data) = a.pool.staticcall(abi.encodeWithSignature("fee()"));
            if (ok && data.length == 32) pips = abi.decode(data, (uint256));
        }
        return (pips + 99) / 100;
    }

    /// @notice Largest `poolFeeBps` over active Basket assets and its index (0, 0 when none).
    function maxPoolFeeBps(FundState storage s) public view returns (uint256 maxBps, uint256 index) {
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            if (!s.assets[i].active) continue;
            uint256 f = poolFeeBps(s, i);
            if (f > maxBps) (maxBps, index) = (f, i);
        }
    }

    /// @notice Revert `BoundAtOrBelowPoolFee` unless `bps` is strictly above every active Basket pool fee
    ///         (§5.6 last paragraph: a floor or band at or below the pool fee fails every trade).
    function requireAboveFees(FundState storage s, uint256 bps) public view {
        (uint256 feeBps, uint256 idx) = maxPoolFeeBps(s);
        if (bps <= feeBps) revert IFundEvents.BoundAtOrBelowPoolFee(idx, bps, feeBps);
    }

    /// @notice Longest `twapWindow` over active Basket assets (0 when none).
    function maxTwapWindow(FundState storage s) public view returns (uint32 w) {
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            AssetConfig storage a = s.assets[i];
            if (a.active && a.kind == AssetKind.Basket && a.twapWindow > w) w = a.twapWindow;
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Glide-path views (§5.2, §4.3)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice `pathTarget(t)` of the current plan per asset and idle (`PlanMath.pathTargetsBps`); zeros (one
    ///         per asset) before the first plan.
    function pathTarget(FundState storage s, uint256 t) public view returns (uint256[] memory bps, uint256 idleBps) {
        if (s.plan.id == 0) return (new uint256[](s.assets.length), 0);
        Plan memory p = s.plan;
        return PlanMath.pathTargetsBps(p, t);
    }

    /// @notice The target deposits route against (§4.3): `pathTarget(now)` while the plan is live (Open,
    ///         Halted, Paused), else the persistent `targetBps`.
    function currentTargetBps(FundState storage s) public view returns (uint256[] memory bps) {
        PlanStatus st = s.plan.status;
        if (st == PlanStatus.Open || st == PlanStatus.Halted || st == PlanStatus.Paused) {
            (bps,) = pathTarget(s, block.timestamp);
            return bps;
        }
        uint16[] storage t = s.targetBps;
        bps = new uint256[](t.length);
        for (uint256 i; i < t.length; ++i) {
            bps[i] = t[i];
        }
    }

    /// @notice Actual TWAP weights per asset and idle, rounded down.
    function currentWeightsBps(FundState storage s) public view returns (uint256[] memory bps, uint256 idleBps) {
        (uint256 total, uint256 idle, uint256[] memory values) = portfolio(s);
        return PlanMath.weightsBps(values, idle, total);
    }
}
