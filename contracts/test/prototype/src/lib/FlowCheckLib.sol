// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.3 checks 1 to 7 (before any trade), §5.9.2 step 5
//            (eligibility from bound prices), §5.9.5 (defaults); docs/technical/one-vault-timed-flows-eng-plan.md E6,
//            E7, E10, E12, E16, E19, E21
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TwapTickMath} from "../../../../lib/TwapTickMath.sol";
import {AssetConfig, AssetKind, BPS, FeedStatus, IDLE_INDEX, PRICE_SCALE} from "../FundTypes.sol";
import {
    AssetPrice,
    FlowParams,
    IFlowEvents,
    Quote,
    SettleCheck,
    SettleContext,
    PRICE_KIND_BASKET,
    PRICE_KIND_LENDING,
    PRICE_KIND_NONE,
    LEG_PRICE_TWAP_ONLY,
    LEG_PRICE_FEED_ONLY
} from "../FlowTypes.sol";
import {IRobotMoneyFundFull} from "../interfaces/IRobotMoneyFund.sol";
import {ILendingRateAdapter} from "../interfaces/IFlowAdapters.sol";
import {FlowEpochs, FlowState} from "./FlowStorage.sol";

/// @dev The fund's exclusion ledger, as check 6 reads it (review Q-F3).
interface IExclusionLedgerView {
    function exclusionCount() external view returns (uint256);
    function exclusions(uint256 id)
        external
        view
        returns (uint256, address, uint48, uint40, bool, uint256, uint256, uint256, uint256);
}
import {FeedLib} from "./FeedLib.sol";
import {TwapSlicesLib} from "./TwapSlicesLib.sol";

/// @title FlowCheckLib
/// @notice The FlowQueue's view logic, linked (`public`) to keep the queue under G1: the pre-trade checks of proposal
///         §5.9.3 (1 to 7), the two bound prices of E12 with the rounding allowances that make RB-14 hold by
///         construction, and the quotes of E21. Nothing here writes state.
///
///         Prices are `usdc × PRICE_SCALE / shares` (FundTypes). Every number rounds to the side that is worse for the
///         flow user and never worse for the holders.
///
///         Bound prices (E12). For a deposit of `s` new shares the fund buys, per asset, `ceil(held × s / supply)`
///         (lending plus `LENDING_ROUNDING_UNITS`), paying for basket legs at most `buyPerToken` per whole token.
///         So the worst USDC cost of `s` shares is at most `s × Vdep / supply + Fdep`, where `Vdep` values every
///         holding at the purchase limit and `Fdep` is the fixed rounding overhead of one call (one unit per leg, the
///         two lending units, one base unit of each basket token). The deposit bound adds that overhead spread over
///         the fewest shares a fill can make (`sMin`: shares worth `minRequestUsdc` at twice the raw price):
///         `depositBound = ceil(Vdep × PS / supply) + ceil((Fdep + 2) × PS / sMin)`. The redemption bound mirrors it
///         with the sale limits, the two lending units withheld and the exit fee. `FlowSettleLib` verifies the
///         realized price of every side against the bound after its trade (check 11) and reverts that side if not.
library FlowCheckLib {
    /// @dev Gas given to a lending venue's `ratePerUnit` read (review Q-F1). The real adapters read a few slots of
    ///      their venue (Aave's normalized income, a Morpho vault's share price, Comet's indexes).
    uint256 internal constant LEND_RATE_GAS = 300_000;

    using Math for uint256;

    /// @dev Extra USDC units of slack in each bound's rounding term beyond the counted overhead.
    uint256 private constant BOUND_SLACK_UNITS = 2;

    /// @dev Intermediate per-call values of `_market`.
    struct Feeds {
        uint256 usdc8;
        uint256 usdcUnit;
        address usdc;
        // Appended by `levers` (2026-11-12): `FlowLevers.legPriceMode`, read once per `market` call.
        uint8 legPriceMode;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Checks 1 to 7
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Run checks 1 to 7 for a settlement called by `caller` now. Returns the first failing check with the
    ///         asset index (IDLE_INDEX when not asset-specific) and a detail (the feed status, the slices in band,
    ///         the deviation in bps, ...). `c` is complete only when `check == Ok`.
    ///
    ///         Keeper first, per epoch (step 3 finish plan §3.1 item 1, E10): a caller without KEEPER_ROLE may settle
    ///         an epoch only once that epoch's own window end plus `keeperGrace` has passed, and its walk stops at the
    ///         newest epoch that qualifies (`c.lastEpoch`). The scaffold counted the grace from the oldest open epoch
    ///         only, so one never-fillable request let anyone settle every newer epoch at its window end.
    /// @param isKeeper Whether `caller` holds KEEPER_ROLE on the queue.
    function preTrade(FlowState storage s, address caller, bool isKeeper)
        public
        view
        returns (SettleCheck check, uint256 index, uint256 detail, SettleContext memory c)
    {
        caller;
        FlowParams memory p = s.params;
        // ── Check 1: time and state ──
        if (block.timestamp < p.settleWindow) return (SettleCheck.Window, IDLE_INDEX, 0, c);
        uint64 oldest;
        (c.firstEpoch, c.lastEpoch, oldest) = pendingRange(s, block.timestamp - p.settleWindow);
        if (oldest == type(uint64).max) return (SettleCheck.Window, IDLE_INDEX, 0, c);
        if (!isKeeper) {
            uint256 openAt = FlowEpochs.endOf(s, oldest) + p.settleWindow + p.keeperGrace;
            if (block.timestamp < openAt) return (SettleCheck.Caller, IDLE_INDEX, openAt, c);
            // The oldest open epoch qualifies, so the newest that qualifies is at or above it.
            (bool any, uint64 lastPublic) =
                FlowEpochs.newestEndedBy(s, block.timestamp - p.settleWindow - p.keeperGrace, c.firstEpoch);
            c.lastEpoch = any && lastPublic > oldest ? lastPublic : oldest;
        }
        if (s.paused) return (SettleCheck.Paused, IDLE_INDEX, 0, c);
        // ── Checks 2 to 7 ──
        SettleContext memory m;
        (check, index, detail, m) = market(s);
        if (check != SettleCheck.Ok) return (check, index, detail, c);
        m.firstEpoch = c.firstEpoch;
        m.lastEpoch = c.lastEpoch;
        m.excludedMask = excludedMask(s);
        // ── Check 6: share price against the last settlement ──
        if (s.lastSharePrice != 0) {
            uint256 last = breakerReference(s, m);
            uint256 moved = m.sharePrice > last ? m.sharePrice - last : last - m.sharePrice;
            uint256 moveBps = last == 0 ? type(uint256).max : moved.mulDiv(BPS, last, Math.Rounding.Ceil);
            uint256 epochsPassed = FlowEpochs.current(s) - s.lastSettleEpoch;
            if (epochsPassed == 0) epochsPassed = 1;
            if (moveBps > uint256(p.maxSharePriceMoveBps) * epochsPassed) {
                return (SettleCheck.SharePrice, IDLE_INDEX, moveBps, m);
            }
        }
        // ── Check 1 (state part): deposits are processed only while the fund takes deposits ──
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        m.depositsOpen = m.excludedMask == 0 && !fund.depositsPaused() && !fund.isShutdown();
        return (SettleCheck.Ok, IDLE_INDEX, 0, m);
    }

    /// @notice Check 6's reference for the snapshot `m`: NAV per share at the feeds at the last settlement, re-based
    ///         for each lending venue excluded or restored since (step 3 finish plan §3.1 item 9, D-AT-4).
    ///
    ///         An excluded venue reads 0 in `heldBalances`, so the exclusion itself drops NAV per share at the feeds
    ///         by the venue's share, and the scaffold's breaker then held every settlement, redemptions included, for
    ///         up to `ceil(share / maxSharePriceMoveBps)` epochs, against E13 ("redemptions settle alone"). Here a
    ///         venue excluded since the last settlement leaves the reference with the per-share value it had then; a
    ///         venue restored since enters it with its per-share value now. This has the effect of resetting the
    ///         reference at the exclusion or the restore for that venue's part only, so the breaker still measures
    ///         every market move since the last settlement, and none of the governed step. Assumed default of this
    ///         run (plan §4); the owner may change it.
    ///         A venue whose exclusion record opened AND closed since the last settlement (a revoke then a re-allow,
    ///         or a revoke then a removal) shows the same mask bit at both ends; the ledger's record count shows it.
    ///         Such a venue is re-based both ways: its per-share part at the last settlement leaves the reference
    ///         and its per-share value now enters it (review Q-F3).
    function breakerReference(FlowState storage s, SettleContext memory m) public view returns (uint256 ref) {
        ref = s.lastSharePrice;
        uint256 changed = s.lastExcludedMask ^ m.excludedMask;
        changed |= _cycledVenues(s, m);
        for (uint256 i; changed != 0 && i < m.prices.length; ++i) {
            if (changed & (1 << i) == 0) continue;
            changed &= ~(1 << i);
            if (m.prices[i].kind != PRICE_KIND_LENDING) continue;
            // Its part at the last settlement leaves (0 when it was excluded then: an excluded venue reads 0);
            // unless excluded now, its part now enters.
            uint256 v = s.lastLendPerShare[i];
            ref = ref > v ? ref - v : 0;
            if (m.excludedMask & (1 << i) == 0) ref += m.held[i].mulDiv(PRICE_SCALE, m.supply);
        }
    }

    /// @dev Bit `i` set for each lending venue that had an exclusion record open since the last settlement and has
    ///      the same mask bit now as then (its record cycled: opened and closed between two settlements).
    function _cycledVenues(FlowState storage s, SettleContext memory m) private view returns (uint256 mask) {
        address ledger = IRobotMoneyFundFull(s.fund).exclusionLedger();
        uint256 count = IExclusionLedgerView(ledger).exclusionCount();
        for (uint256 id = s.lastExclusionCount + 1; id <= count; ++id) {
            (uint256 i,,,,,,,,) = IExclusionLedgerView(ledger).exclusions(id);
            if (i >= 256 || i >= m.prices.length) continue;
            uint256 bit = 1 << i;
            if ((s.lastExcludedMask & bit) == (m.excludedMask & bit)) mask |= bit;
        }
    }

    /// @notice Bit `i` set when asset `i` has an open exclusion record now (E13).
    function excludedMask(FlowState storage s) public view returns (uint256 mask) {
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        uint256 n = fund.assetCount();
        for (uint256 i; i < n && i < 256; ++i) {
            if (fund.openExclusionOf(i) != 0) mask |= 1 << i;
        }
    }

    /// @notice Checks 2 to 5 and 7 (feeds, sequencer, USDC peg, TWAP quorum, TWAP against feed, lending rate,
    ///         snapshot), then the bound prices. No time, caller or pause check: the quotes use this alone.
    ///         Check 5 compares with the rates stored at the last settlement.
    function market(FlowState storage s)
        public
        view
        returns (SettleCheck check, uint256 index, uint256 detail, SettleContext memory c)
    {
        FlowParams memory p = s.params;
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        AssetConfig[] memory cfg = fund.assetConfigs();
        Feeds memory f;
        f.usdc = s.usdc;
        f.usdcUnit = 10 ** IERC20Metadata(f.usdc).decimals();
        f.legPriceMode = s.levers.legPriceMode;

        // ── Check 2: sequencer, every basket feed, the USDC peg ──
        {
            (bool up, FeedStatus st) = FeedLib.sequencerUp(s.sequencerFeed, p.sequencerGrace);
            if (!up) return (SettleCheck.Sequencer, IDLE_INDEX, uint256(st), c);
        }
        uint256[] memory feed8 = new uint256[](cfg.length);
        for (uint256 i; i < cfg.length; ++i) {
            if (!cfg[i].active || cfg[i].kind != AssetKind.Basket) continue;
            (FeedStatus st, uint256 px) = FeedLib.read(cfg[i].feed, cfg[i].maxFeedAge);
            if (st != FeedStatus.Ok) return (SettleCheck.Feed, i, uint256(st), c);
            feed8[i] = px;
        }
        {
            (bool pegOk, FeedStatus st, uint256 u8) = FeedLib.usdcPeg(s.usdcFeed, s.usdcFeedMaxAge, p.usdcPegBandBps);
            if (!pegOk) return (SettleCheck.UsdcPeg, IDLE_INDEX, st == FeedStatus.OffPeg ? u8 : uint256(st), c);
            f.usdc8 = u8;
        }

        // ── Check 3: slice-median TWAP and its quorum ──
        int24[] memory ticks = new int24[](cfg.length);
        for (uint256 i; i < cfg.length; ++i) {
            if (!cfg[i].active || cfg[i].kind != AssetKind.Basket) continue;
            (bool ok, int24 med, uint8 inBand) =
                TwapSlicesLib.median(cfg[i].pool, p.settleWindow, p.slices, p.dispersionBps);
            if (!ok || inBand < p.quorum) return (SettleCheck.TwapQuorum, i, inBand, c);
            ticks[i] = med;
        }

        // ── Check 4: each TWAP within refBandBps of its feed; per-swap limits from the stricter price ──
        c.prices = new AssetPrice[](cfg.length);
        for (uint256 i; i < cfg.length; ++i) {
            if (!cfg[i].active) continue;
            if (cfg[i].kind == AssetKind.Lending) {
                c.prices[i].kind = PRICE_KIND_LENDING;
                continue;
            }
            (bool ok, uint256 devBps, AssetPrice memory ap) = _basketPrice(cfg[i], ticks[i], feed8[i], f, p);
            if (!ok) return (SettleCheck.TwapVsFeed, i, devBps, c);
            c.prices[i] = ap;
        }

        // ── Check 5: each lending venue's own rate grew at most maxLendRateGrowthBps per day ──
        {
            (bool ok, uint256 i, uint256 growthBps, uint256[] memory rates) = _lendRates(s, cfg, p);
            if (!ok) return (SettleCheck.LendRate, i, growthBps, c);
            c.lendRates = rates;
        }

        // ── Check 7: snapshot (held amounts, idle, supply) and NAV at the feeds (used by check 6 and the caps) ──
        c.supply = fund.totalSupply();
        if (c.supply == 0) return (SettleCheck.SharePrice, IDLE_INDEX, 0, c);
        (c.idle, c.held) = fund.heldBalances();
        if (c.held.length != cfg.length) return (SettleCheck.SharePrice, IDLE_INDEX, c.held.length, c);
        c.navFeed = c.idle;
        for (uint256 i; i < cfg.length; ++i) {
            if (c.prices[i].kind == PRICE_KIND_LENDING) c.navFeed += c.held[i];
            else if (c.prices[i].kind == PRICE_KIND_BASKET) {
                c.navFeed += c.held[i].mulDiv(c.prices[i].feedPerToken, c.prices[i].unit);
            }
        }
        c.sharePrice = c.navFeed.mulDiv(PRICE_SCALE, c.supply);
        (c.tvlCap,, c.exitFeeBps,) = fund.config();
        (c.depositBound, c.redeemBound) = bounds(c, p.minRequestUsdc);
        return (SettleCheck.Ok, IDLE_INDEX, 0, c);
    }

    /// @dev Per-swap limits of one basket asset, and check 4. Prices are USDC units per whole token. `f.legPriceMode`
    ///      is the `FlowLevers.legPriceMode` lever (step 3 finish plan §3.2): 0, the design, starts a purchase from the
    ///      lower of TWAP and feed and a sale from the higher; 1 from the TWAP only; 2 from the feed only.
    function _basketPrice(AssetConfig memory a, int24 tick, uint256 px8, Feeds memory f, FlowParams memory p)
        private
        view
        returns (bool ok, uint256 devBps, AssetPrice memory ap)
    {
        ap.kind = PRICE_KIND_BASKET;
        ap.unit = 10 ** IERC20Metadata(a.token).decimals();
        uint256 feedDown = px8.mulDiv(f.usdcUnit, f.usdc8);
        uint256 feedUp = px8.mulDiv(f.usdcUnit, f.usdc8, Math.Rounding.Ceil);
        uint256 twapDown = TwapTickMath.priceFromTick(tick, a.token, f.usdc, ap.unit);
        uint256 twapUp = twapDown + 1;
        if (feedDown == 0) return (false, type(uint256).max, ap);
        uint256 diff = twapDown > feedDown ? twapDown - feedDown : feedDown - twapDown;
        devBps = diff.mulDiv(BPS, feedDown, Math.Rounding.Ceil);
        if (devBps > p.refBandBps) return (false, devBps, ap);
        ap.feedPerToken = feedDown;
        uint256 low = feedUp < twapUp ? feedUp : twapUp;
        uint256 high = feedDown > twapDown ? feedDown : twapDown;
        if (f.legPriceMode == LEG_PRICE_TWAP_ONLY) (low, high) = (twapUp, twapDown);
        else if (f.legPriceMode == LEG_PRICE_FEED_ONLY) (low, high) = (feedUp, feedDown);
        ap.buyPerToken = low.mulDiv(BPS + p.legBandBps, BPS, Math.Rounding.Ceil);
        ap.sellPerToken = high.mulDiv(BPS - p.legBandBps, BPS);
        ok = true;
    }

    /// @dev Check 5. Growth per day `(rate − last) / last` against `maxLendRateGrowthBps × elapsed / 1 day`. A first
    ///      settlement (no stored rate) passes and records the rate. A falling rate passes (its loss is shared pro
    ///      rata, RB-21). A venue whose rate cannot be read fails (fail closed). Returns the rates it read and
    ///      accepted; the settlement records them when its own read after the trades fails (step 3 finish plan §3.1
    ///      item 5: the scaffold then silently kept the old reference).
    function _lendRates(FlowState storage s, AssetConfig[] memory cfg, FlowParams memory p)
        private
        view
        returns (bool ok, uint256 index, uint256 growthBps, uint256[] memory rates)
    {
        uint256 elapsed = block.timestamp - s.lastSettleAt;
        rates = new uint256[](cfg.length);
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        for (uint256 i; i < cfg.length; ++i) {
            if (!cfg[i].active || cfg[i].kind != AssetKind.Lending) continue;
            // An excluded venue counts as 0 and trades nothing (E13): its rate is not read, so a revoked adapter
            // whose rate fails or jumps cannot hold every settlement, redemptions included (review Q-F1).
            if (fund.openExclusionOf(i) != 0) continue;
            (bool rOk, uint256 rate) = lendRate(cfg[i].adapter);
            if (!rOk) return (false, i, type(uint256).max, rates);
            rates[i] = rate;
            uint256 last = s.lastLendRate[i];
            if (last == 0 || rate <= last) continue;
            uint256 growth = rate - last;
            // growth / last ≤ maxBps / BPS × elapsed / 1 day, cross-multiplied, exact.
            if (growth * BPS * 1 days > last * uint256(p.maxLendRateGrowthBps) * elapsed) {
                return (false, i, growth.mulDiv(BPS, last, Math.Rounding.Ceil), rates);
            }
        }
        return (true, 0, 0, rates);
    }

    /// @notice The venue rate of a lending adapter (`ILendingRateAdapter.ratePerUnit`). `ok` false when the call
    ///         reverts, returns short data or returns 0.
    function lendRate(address adapter) public view returns (bool ok, uint256 rate) {
        if (adapter.code.length == 0) return (false, 0);
        // Gas-capped: a venue's rate read is a view of a few storage reads; a hostile adapter cannot burn the call.
        (bool success, bytes memory ret) =
            adapter.staticcall{gas: LEND_RATE_GAS}(abi.encodeWithSelector(ILendingRateAdapter.ratePerUnit.selector));
        if (!success || ret.length < 32) return (false, 0);
        rate = abi.decode(ret, (uint256));
        ok = rate != 0;
    }

    /// @notice Whether deposits may be processed (check 1): the fund does not pause deposits, is not shut down, and
    ///         excludes no asset (E13). `preTrade` computes the same from its exclusion mask.
    function depositsOpen(FlowState storage s) public view returns (bool) {
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        if (fund.depositsPaused() || fund.isShutdown()) return false;
        return excludedMask(s) == 0;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Bound prices (E12) and the per-request rounding allowances (RB-14)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice The two bound prices for the snapshot `c` (see the library note). 0 means that side cannot be bounded
    ///         for a fill of `minRequestUsdc` (an empty or tiny fund) and does not trade.
    /// @return depositBound The most a depositor pays per share, PRICE_SCALE, rounded UP.
    /// @return redeemBound  The least a redeemer receives per share after the exit fee, PRICE_SCALE, rounded DOWN.
    function bounds(SettleContext memory c, uint256 minRequestUsdc)
        public
        pure
        returns (uint256 depositBound, uint256 redeemBound)
    {
        uint256 vDep = c.idle;
        uint256 vRed = c.idle;
        uint256 fDep = 1;
        uint256 fRed = 2; // one unit for the idle floor, one for the exit fee rounding
        for (uint256 i; i < c.prices.length; ++i) {
            AssetPrice memory ap = c.prices[i];
            if (ap.kind == PRICE_KIND_LENDING) {
                vDep += c.held[i];
                vRed += c.held[i];
                fDep += 3;
                fRed += 3;
            } else if (ap.kind == PRICE_KIND_BASKET) {
                vDep += c.held[i].mulDiv(ap.buyPerToken, ap.unit, Math.Rounding.Ceil);
                vRed += c.held[i].mulDiv(ap.sellPerToken, ap.unit);
                fDep += ap.buyPerToken.ceilDiv(ap.unit) + 1;
                fRed += ap.sellPerToken.ceilDiv(ap.unit) + 1;
            }
        }
        if (vDep != 0) {
            uint256 sMin = minRequestUsdc.mulDiv(c.supply, 2 * vDep);
            if (sMin != 0) {
                depositBound = vDep.mulDiv(PRICE_SCALE, c.supply, Math.Rounding.Ceil)
                    + (fDep + BOUND_SLACK_UNITS).mulDiv(PRICE_SCALE, sMin, Math.Rounding.Ceil);
            }
        }
        if (vRed != 0) {
            uint256 xMin = minRequestUsdc.mulDiv(c.supply, vRed);
            if (xMin != 0) {
                uint256 raw = vRed.mulDiv((BPS - c.exitFeeBps) * PRICE_SCALE, c.supply * BPS);
                uint256 cut = (fRed + BOUND_SLACK_UNITS).mulDiv(PRICE_SCALE, xMin, Math.Rounding.Ceil);
                redeemBound = raw > cut ? raw - cut : 0;
            }
        }
    }

    /// @notice How far above the deposit bound a request of `usdc` must set its limit so that its own fill, after
    ///         the per-request split (shares DOWN, refund DOWN), is still inside its limit (RB-14).
    ///         `type(uint256).max` when `usdc` is too small to bound at all.
    ///         Derivation: `y = floor(usdc × PS / bound)`; the fill gets at least `y − 2` shares' worth of slack, so
    ///         its price is at most `bound + (bound + PS) / (y − 2)`.
    function depositAllowance(uint256 bound, uint256 usdc) public pure returns (uint256) {
        if (bound == 0) return type(uint256).max;
        uint256 y = usdc.mulDiv(PRICE_SCALE, bound);
        if (y <= 2) return type(uint256).max;
        return (bound + PRICE_SCALE).ceilDiv(y - 2);
    }

    /// @notice How far below the redemption bound a request of `shares` must set its limit so that its own fill,
    ///         paid `floor(usdcOut × shares / X)`, is still inside its limit (RB-14): `ceil(PS / shares)`.
    function redeemAllowance(uint256 shares) public pure returns (uint256) {
        if (shares == 0) return type(uint256).max;
        return PRICE_SCALE.ceilDiv(shares);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Epochs
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice When epoch `epoch`'s settlement window ends: its end plus `settleWindow` (`FlowEpochs`, item 3).
    function settleableAt(FlowState storage s, uint64 epoch) internal view returns (uint256) {
        return FlowEpochs.endOf(s, epoch) + s.params.settleWindow;
    }

    /// @notice The epochs `settle` may walk: from the oldest one that can hold an unexpired request
    ///         (`current − maxRoll`, or the stored `oldestEpoch` if later) to the newest that ended at or before
    ///         `endedBy` (`now − settleWindow`: its window has ended), and the oldest of them that still has an open
    ///         request (`type(uint64).max` if none: check 1 "Window").
    function pendingRange(FlowState storage s, uint256 endedBy)
        public
        view
        returns (uint64 first, uint64 last, uint64 oldest)
    {
        oldest = type(uint64).max;
        uint64 cur = FlowEpochs.current(s);
        uint16 maxRoll = s.params.maxRoll;
        first = cur > maxRoll ? cur - maxRoll : 0;
        if (s.oldestEpoch > first) first = s.oldestEpoch;
        bool any;
        (any, last) = FlowEpochs.newestEndedBy(s, endedBy, first);
        if (!any) return (first, first, oldest);
        for (uint64 e = first; e <= last; ++e) {
            if (s.epochOpen[e] != 0) return (first, last, e);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Quotes (E21)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice The worst case for a deposit request of `usdc` made now: the deposit bound a settlement in this block
    ///         would use, plus this size's rounding allowance. Reverts `SettleBlocked` when checks 2 to 5 fail now
    ///         (no settlement could bound it either).
    function quoteDeposit(FlowState storage s, uint256 usdc) public view returns (Quote memory q) {
        (SettleCheck check, uint256 index, uint256 detail, SettleContext memory c) = market(s);
        if (check != SettleCheck.Ok) revert IFlowEvents.SettleBlocked(check, index, detail);
        uint256 allowance = depositAllowance(c.depositBound, usdc);
        if (allowance == type(uint256).max) revert IFlowEvents.SettleBlocked(SettleCheck.DepositLeg, IDLE_INDEX, usdc);
        q.boundPrice = c.depositBound + allowance;
        q.worstAmount = usdc.mulDiv(PRICE_SCALE, q.boundPrice);
        q.feeBps = 0;
        (q.earliestSettle, q.holdEnds) = _times(s, true);
    }

    /// @notice The worst case for a redemption request of `shares` made now: the redemption bound less this size's
    ///         rounding allowance, after the exit fee.
    function quoteRedeem(FlowState storage s, uint256 shares) public view returns (Quote memory q) {
        (SettleCheck check, uint256 index, uint256 detail, SettleContext memory c) = market(s);
        if (check != SettleCheck.Ok) revert IFlowEvents.SettleBlocked(check, index, detail);
        uint256 allowance = redeemAllowance(shares);
        if (c.redeemBound <= allowance) revert IFlowEvents.SettleBlocked(SettleCheck.RedeemLeg, IDLE_INDEX, shares);
        q.boundPrice = c.redeemBound - allowance;
        q.worstAmount = shares.mulDiv(q.boundPrice, PRICE_SCALE);
        q.feeBps = c.exitFeeBps;
        (q.earliestSettle, q.holdEnds) = _times(s, false);
    }

    function _times(FlowState storage s, bool isDeposit) private view returns (uint64 earliest, uint64 holdEnds) {
        earliest = uint64(settleableAt(s, FlowEpochs.current(s)));
        holdEnds = isDeposit ? earliest + s.params.minHold : earliest;
    }
}
