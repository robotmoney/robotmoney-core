// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.2 (NAV), §4.3 (ORA-4 on deposit),
//            §5.3 step 2 (market check), §5.6 last paragraph (bounds above the pool fee), §6.1 (size),
//            §5.9.3 check 2 and §5.9.6 (NAV views revert on an unhealthy feed); §7 RB-21 (position units);
//            docs/technical/one-vault-timed-flows-eng-plan.md E9, E19
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStrategyAdapter} from "../../../../interfaces/IStrategyAdapter.sol";
import {IBasketSwapAdapter} from "../../../../interfaces/IBasketSwapAdapter.sol";
import {IObservablePool} from "../../../../interfaces/IObservablePool.sol";
import {TwapTickMath} from "../../../../lib/TwapTickMath.sol";
import {RobotMoneyVaultOps} from "../../../../lib/RobotMoneyVaultOps.sol";
import {TickMath} from "../../../../lib/TickMath.sol";
import {
    AssetConfig,
    AssetKind,
    FeedStatus,
    IFundEvents,
    Plan,
    PlanStatus,
    Venue,
    BPS,
    IDLE_INDEX,
    DEFAULT_SETTLE_WINDOW
} from "../FundTypes.sol";
import {FlowParams} from "../FlowTypes.sol";
import {PlanMath} from "../PlanMath.sol";
import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {IFlowQueue} from "../interfaces/IFlowQueue.sol";
import {FundState} from "./FundStorage.sol";
import {FeedLib} from "./FeedLib.sol";

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
        return s.codeHashAllowed[a.adapter.codehash]
            && RobotMoneyVaultOps.exclusions().openExclusionOf[i] == 0;
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

    /// @notice What the holders own of asset `i`: Basket the fund's token balance less `deferredTotal[i]` (owed to
    ///         past in-kind exits, §4.4), floored at 0. Lending (step 3d, E9, RB-21): the holders' units of the
    ///         position, `positionValue × (positionUnits − positionClaimTotal) / positionUnits`, rounded DOWN; the
    ///         whole `positionValue` while the position has no units yet (no claim can exist then). Every NAV read
    ///         and every pro-rata leg uses this, never the raw balance, so position claims are never counted.
    function heldBalance(FundState storage s, uint256 i) internal view returns (uint256 bal) {
        AssetConfig storage a = s.assets[i];
        if (a.kind == AssetKind.Lending) return holdersPart(s, i, positionValue(s, i));
        bal = IERC20(a.token).balanceOf(address(this));
        uint256 owed = s.deferredTotal[i];
        bal = bal > owed ? bal - owed : 0;
    }

    /// @notice Lending position `i` as the venue reports it: `adapter.totalAssets()` less `deferredTotal[i]` (fixed
    ///         USDC owed to step 3c deferrals, if any), floored at 0. Holders' units and claim units are shares of
    ///         this amount (E9). Reverts if the venue's read reverts.
    function positionValue(FundState storage s, uint256 i) internal view returns (uint256 p) {
        p = IStrategyAdapter(s.assets[i].adapter).totalAssets();
        uint256 owed = s.deferredTotal[i];
        p = p > owed ? p - owed : 0;
    }

    /// @notice The holders' part of lending position `i` worth `p`: `p × (units − claim units) / units`, DOWN.
    function holdersPart(FundState storage s, uint256 i, uint256 p)
        internal
        view
        returns (uint256)
    {
        uint256 units = s.positionUnits[i];
        if (units == 0) return p;
        return p.mulDiv(units - s.positionClaimTotal[i], units);
    }

    // ─── Held amounts and the proportion check (step 3d: proposal §5.9.3 checks 7 and 10, RB-13) ───────────

    /// @notice Check 7 snapshot: idle USDC, and per asset index `heldBalance` of every COUNTED asset (inactive
    ///         assets and Lending assets under an open ADP-2 exclusion read 0: no flow trades them). Amounts, not
    ///         values: no price is read.
    function heldAmounts(FundState storage s)
        internal
        view
        returns (uint256 idle, uint256[] memory held)
    {
        idle = IERC20(s.usdc).balanceOf(address(this));
        uint256 n = s.assets.length;
        held = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            if (isCounted(s, i)) held[i] = heldBalance(s, i);
        }
    }

    /// @notice `IRobotMoneyFund.heldBalances`: `heldAmounts` as a linked view.
    function heldBalances(FundState storage s)
        public
        view
        returns (uint256 idle, uint256[] memory held)
    {
        return heldAmounts(s);
    }

    /// @notice Check 10 (RB-13), run by the fund itself after every flow that mints or burns: for idle USDC and
    ///         every asset counted in the snapshot, `after × supplyBefore ≥ before × supplyAfter`, on held amounts
    ///         read now. Exact, in full 512-bit precision (`Math.mulDiv` cannot help: both sides are products), so
    ///         no rounding is ever forgiven. The two lending units are applied to the amounts a flow moves, never
    ///         here. Reverts `ProportionViolated(index, before, after, supplyBefore, supplyAfter)`, `index =
    ///         IDLE_INDEX` for idle USDC.
    /// @dev An asset counted at the snapshot is re-read even if a hostile call un-counted it in between; an asset
    ///      that was not counted (held 0) passes trivially. `before × supplyAfter` and `after × supplyBefore` are
    ///      each < 2^256 for any real fund: amounts < 2^128 (USDC 6 dp, tokens 18 dp, under 3.4e20 whole tokens)
    ///      and supply < 2^128 (3.4e38 share units = 3.4e14 USDC at the seed scale); checked arithmetic reverts
    ///      otherwise, which fails closed.
    function requireProportion(
        FundState storage s,
        uint256 idleBefore,
        uint256[] memory heldBefore,
        uint256 supplyBefore,
        uint256 supplyAfter
    ) internal view {
        uint256 idleAfter = IERC20(s.usdc).balanceOf(address(this));
        if (idleAfter * supplyBefore < idleBefore * supplyAfter) {
            revert IRobotMoneyFund.ProportionViolated(
                IDLE_INDEX, idleBefore, idleAfter, supplyBefore, supplyAfter
            );
        }
        uint256 n = heldBefore.length;
        for (uint256 i; i < n; ++i) {
            uint256 b = heldBefore[i];
            if (b == 0) continue;
            uint256 a = heldBalance(s, i);
            if (a * supplyBefore < b * supplyAfter) {
                revert IRobotMoneyFund.ProportionViolated(i, b, a, supplyBefore, supplyAfter);
            }
        }
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

    // ─── E19: NAV views that refuse an unhealthy feed, and the last good NAV ─────────────────────────────

    /// @notice `totalAssets()` (E19, proposal §5.9.6): `nav`, but only while every feed is healthy, else
    ///         `FeedUnhealthy(index, status)`. "Healthy" is exactly settlement check 2 (§5.9.3): every ACTIVE basket
    ///         asset's feed reads Ok within its `maxFeedAge` (index = the asset); and, once a FlowQueue is bound, the
    ///         sequencer feed is up for `sequencerGrace` and the USDC / USD feed is fresh and inside
    ///         `usdcPegBandBps`, read from the queue's `feeds()` and `flowParams()` (index = `IDLE_INDEX`). The
    ///         value itself is still the TWAP NAV of §4.2: the feeds gate the view, they do not price it.
    /// @dev The internal `nav` (executeStep, plan open) does not read the feeds: the rebalance step's feed checks
    ///      are step 3e (proposal §5.10), out of scope here.
    function navChecked(FundState storage s) public view returns (uint256) {
        requireFeedsHealthy(s);
        return nav(s);
    }

    /// @notice Revert `FeedUnhealthy` unless check 2's feeds are healthy (see `navChecked`).
    function requireFeedsHealthy(FundState storage s) internal view {
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            AssetConfig storage a = s.assets[i];
            if (!a.active || a.kind != AssetKind.Basket) continue;
            (FeedStatus st,) = FeedLib.read(a.feed, a.maxFeedAge);
            if (st != FeedStatus.Ok) revert IRobotMoneyFund.FeedUnhealthy(i, st);
        }
        address q = s.flowQueue;
        if (q == address(0)) return;
        FlowParams memory p = IFlowQueue(q).flowParams();
        (address usdcFeed, uint32 usdcMaxAge, address seqFeed) = IFlowQueue(q).feeds();
        (bool up, FeedStatus seq) = FeedLib.sequencerUp(seqFeed, p.sequencerGrace);
        if (!up) revert IRobotMoneyFund.FeedUnhealthy(IDLE_INDEX, seq);
        (bool pegged, FeedStatus peg,) = FeedLib.usdcPeg(usdcFeed, usdcMaxAge, p.usdcPegBandBps);
        if (!pegged) revert IRobotMoneyFund.FeedUnhealthy(IDLE_INDEX, peg);
    }

    /// @notice `lastGoodNav()` (E19). Never reverts. While the feeds are healthy and the NAV reads, the last good
    ///         NAV is the NAV now: `(totalAssets(), block.timestamp)`. Otherwise the value the fund stored the last
    ///         time it recorded one (`recordNav`: at `seed`, each `mintInKind`, each `sellForFlow` and each
    ///         `executeStep`), with that time; `(0, 0)` if it never did.
    /// @dev Reads `totalAssets()` through an external self-call so any revert inside it (a feed, a TWAP read, a
    ///      venue) is caught. A caller that forwards too little gas for the read gets the stored value.
    function lastGoodNav(FundState storage s) public view returns (uint256, uint64) {
        try IERC4626(address(this)).totalAssets() returns (uint256 v) {
            return (v, uint64(block.timestamp));
        } catch {
            return (s.lastGoodNav, s.lastGoodNavAt);
        }
    }

    /// @notice Store `totalAssets()` and the time as the last good NAV when it reads (feeds healthy, every venue
    ///         and TWAP read succeeds). Never reverts and changes nothing else, so a bad feed can never stop the
    ///         flow or step that calls it.
    function recordNav(FundState storage s) public {
        try IERC4626(address(this)).totalAssets() returns (uint256 v) {
            s.lastGoodNav = v;
            s.lastGoodNavAt = uint64(block.timestamp);
        } catch {}
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
    function usdcValue(FundState storage s, uint256 i, uint256 amount)
        public
        view
        returns (uint256)
    {
        AssetConfig storage a = s.assets[i];
        if (a.kind == AssetKind.Lending || amount == 0) return amount;
        return
            IBasketSwapAdapter(a.adapter).twapPrice(a.pool, a.token, s.usdc, amount, a.twapWindow);
    }

    /// @notice Amount of asset `i` worth `usdcAmount` at TWAP. Lending: identity.
    function tokenValue(FundState storage s, uint256 i, uint256 usdcAmount)
        public
        view
        returns (uint256)
    {
        AssetConfig storage a = s.assets[i];
        if (a.kind == AssetKind.Lending || usdcAmount == 0) return usdcAmount;
        return
            IBasketSwapAdapter(a.adapter)
                .twapPrice(a.pool, s.usdc, a.token, usdcAmount, a.twapWindow);
    }

    // ─── ORA-4 (§4.3, §5.3 step 2) ───────────────────────────────────────────

    /// @notice ORA-4 for asset `i`. Never reverts. `ok` for a counted Lending asset and whenever the guard is
    ///         0. An excluded Lending asset reads NOT ok (so the Rebalancer's eligibility mask drops it: it
    ///         cannot take or return USDC). A Basket asset whose TWAP, spot or probe read fails reads not ok
    ///         with `deviationBps == type(uint256).max`. Otherwise `ok` iff |spot − TWAP| / TWAP ≤ guard
    ///         (`TwapTickMath.deviationBps` arithmetic, with every external read wrapped in try/catch).
    function marketCheck(FundState storage s, uint256 i)
        public
        view
        returns (bool ok, uint256 deviationBps)
    {
        if (i >= s.assets.length) return (false, 0);
        AssetConfig storage a = s.assets[i];
        if (a.kind == AssetKind.Lending) return (isCounted(s, i) || !a.active, 0);
        uint256 guard = s.navDeviationGuardBps;
        if (guard == 0) return (true, 0);
        (bool read, uint256 dev) = _deviation(s.usdc, a);
        if (!read) return (false, type(uint256).max);
        return (dev <= guard, dev);
    }

    /// @notice Revert `NavMarketDeviationExceeded` when asset `i` fails ORA-4.
    function requireMarket(FundState storage s, uint256 i) internal view {
        (bool ok, uint256 dev) = marketCheck(s, i);
        if (!ok) {
            revert IRobotMoneyFund.NavMarketDeviationExceeded(
                s.assets[i].token, dev, s.navDeviationGuardBps
            );
        }
    }

    /// @dev |spot − TWAP| / TWAP in bps on a 1 USDC probe of the token; `read` false when any read reverts.
    function _deviation(address usdc, AssetConfig storage a)
        private
        view
        returns (bool read, uint256 dev)
    {
        uint256 probe;
        try IBasketSwapAdapter(a.adapter)
            .twapPrice(a.pool, usdc, a.token, ORA4_PROBE_USDC, a.twapWindow) returns (
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
        try IObservablePool(pool).observe(secondsAgos) returns (
            int56[] memory cums, uint160[] memory
        ) {
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
    function maxPoolFeeBps(FundState storage s)
        public
        view
        returns (uint256 maxBps, uint256 index)
    {
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
    //  Asset admission rule 3: the pool-share rule (§4.5, E15, RB-17). Called by `FundAdminLib.openPlan`.
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice §4.5 rule 3, checked when a target is set: for every active basket asset with a non-zero end target,
    ///         `ceil(tvlCap × target / 10 000)` must be at most `floor(poolShareBps × depth / 10 000)`, where `depth`
    ///         is the pool's USDC depth over one settlement window (`poolUsdcDepth`). Else
    ///         `PoolShareExceeded(index, targetUsdc, limitUsdc)`.
    function requirePoolShare(FundState storage s, uint16[] memory endBps) public view {
        uint256 cap = s.tvlCap;
        uint256 share = s.poolShareBps;
        uint32 w = settleWindow(s);
        uint256 n = endBps.length;
        for (uint256 i; i < n; ++i) {
            AssetConfig storage a = s.assets[i];
            if (endBps[i] == 0 || !a.active || a.kind != AssetKind.Basket) continue;
            uint256 targetUsdc = cap.mulDiv(endBps[i], BPS, Math.Rounding.Ceil);
            (bool ok, uint256 depth) = poolUsdcDepth(a.pool, s.usdc, w);
            if (!ok) revert IRobotMoneyFund.PoolHistoryTooShort(i, w);
            uint256 limitUsdc = depth.mulDiv(share, BPS);
            if (targetUsdc > limitUsdc) {
                revert IRobotMoneyFund.PoolShareExceeded(i, targetUsdc, limitUsdc);
            }
        }
    }

    /// @dev Slices `poolUsdcDepth` splits its window into, and how many of the thinnest it drops (review R-F2).
    uint256 internal constant DEPTH_SLICES = 12;
    uint256 internal constant DEPTH_DROP = 2;

    /// @notice The USDC a pool holds in its active range over the last `window` seconds, read from its
    ///         time-weighted liquidity, never from a token balance (§4.5 rule 3). One `observe` call returns
    ///         `DEPTH_SLICES + 1` points; each slice's in-range liquidity is its harmonic mean
    ///         `L_j = dt_j × 2^128 / Δ secondsPerLiquidityCumulativeX128`. The depth uses the third-thinnest slice
    ///         (the `DEPTH_DROP` thinnest are dropped), priced at the window's arithmetic-mean tick: `depth` is the
    ///         USDC side of the virtual reserves of that `L` (`L × sqrtP / 2^96` when USDC is token1,
    ///         `L × 2^96 / sqrtP` when token0), rounded DOWN.
    ///         Why not one harmonic mean over the whole window (the step 3 reading): a pool pushed out of its
    ///         liquidity for a few seconds adds `dt × 2^128 / max(1, L)` for those seconds and drives one harmonic
    ///         mean, so every cap read from it, to about 0 for a whole window (review R-F2). Dropping the two
    ///         thinnest slices means thinning must be held through a full slice (`window / 12`, five minutes at the
    ///         default) and the slices on both sides of it. Inflating needs liquidity held through ten of the twelve
    ///         slices; liquidity added and removed inside one transaction adds no seconds and does not count.
    /// @return ok    False when `observe` reverts (too little history) or the window is under `DEPTH_SLICES` seconds.
    /// @return depth USDC units.
    function poolUsdcDepth(address pool, address usdc, uint32 window)
        public
        view
        returns (bool ok, uint256 depth)
    {
        if (window < DEPTH_SLICES) return (false, 0);
        uint32[] memory ago = new uint32[](DEPTH_SLICES + 1);
        uint32 len = window / uint32(DEPTH_SLICES);
        for (uint256 j; j < DEPTH_SLICES; ++j) {
            ago[j] = window - uint32(j) * len;
        }
        // ago[DEPTH_SLICES] = 0 (now): the last slice also takes the remainder of `window / DEPTH_SLICES`.
        int56[] memory tc;
        uint160[] memory spl;
        try IObservablePool(pool).observe(ago) returns (int56[] memory t, uint160[] memory l) {
            (tc, spl) = (t, l);
        } catch {
            return (false, 0);
        }
        if (tc.length != DEPTH_SLICES + 1 || spl.length != DEPTH_SLICES + 1) return (false, 0);
        uint256 liq = _thinSliceLiquidity(ago, spl);
        int56 dTick = tc[DEPTH_SLICES] - tc[0];
        int56 w = int56(uint56(window));
        int56 meanTick = dTick / w;
        if (dTick < 0 && dTick % w != 0) meanTick--;
        uint256 sqrtP = TickMath.getSqrtRatioAtTick(int24(meanTick));
        depth = IObservablePool(pool).token1() == usdc
            ? liq.mulDiv(sqrtP, 1 << 96)
            : liq.mulDiv(1 << 96, sqrtP);
        ok = true;
    }

    /// @dev Each slice's harmonic in-range liquidity, sorted ascending; returns the one at rank `DEPTH_DROP`. A
    ///      slice whose cumulative did not move (no seconds) counts as 0 liquidity, the conservative reading.
    function _thinSliceLiquidity(uint32[] memory ago, uint160[] memory spl)
        private
        pure
        returns (uint256)
    {
        uint256[] memory l = new uint256[](DEPTH_SLICES);
        for (uint256 j; j < DEPTH_SLICES; ++j) {
            uint256 dSpl = uint256(spl[j + 1] - spl[j]);
            uint256 dt = uint256(ago[j] - ago[j + 1]);
            l[j] = dSpl == 0 ? 0 : (dt << 128) / dSpl;
        }
        // Insertion sort: 12 elements.
        for (uint256 i = 1; i < DEPTH_SLICES; ++i) {
            uint256 v = l[i];
            uint256 k = i;
            while (k != 0 && l[k - 1] > v) {
                l[k] = l[k - 1];
                --k;
            }
            l[k] = v;
        }
        return l[DEPTH_DROP];
    }

    /// @notice The settlement window the admission rules read: the bound FlowQueue's `settleWindow`, or
    ///         `DEFAULT_SETTLE_WINDOW` before a queue is bound.
    function settleWindow(FundState storage s) internal view returns (uint32) {
        address q = s.flowQueue;
        if (q == address(0)) return DEFAULT_SETTLE_WINDOW;
        return IFlowQueue(q).flowParams().settleWindow;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Glide-path views (§5.2, §4.3)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice `pathTarget(t)` of the current plan per asset and idle (`PlanMath.pathTargetsBps`); zeros (one
    ///         per asset) before the first plan.
    function pathTarget(FundState storage s, uint256 t)
        public
        view
        returns (uint256[] memory bps, uint256 idleBps)
    {
        if (s.plan.id == 0) return (new uint256[](s.assets.length), 0);
        Plan memory p = s.plan;
        return PlanMath.pathTargetsBps(p, t);
    }

    /// @notice Actual TWAP weights per asset and idle, rounded down.
    function currentWeightsBps(FundState storage s)
        public
        view
        returns (uint256[] memory bps, uint256 idleBps)
    {
        (uint256 total, uint256 idle, uint256[] memory values) = portfolio(s);
        return PlanMath.weightsBps(values, idle, total);
    }
}
