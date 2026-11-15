// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.3 (checks 1 to 7), §5.11.3-§5.11.4 (forward pricing,
//            keeper-only settle, venue liquidity test, Check 5 deposit stop, E53 inSale exclusion);
//            docs/technical/one-vault-timed-flows-eng-plan.md E6, E7, E11, E13, E16, E25, E31, E34, E36, E42, E44, E53
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AssetConfig, AssetKind, BPS, IDLE_INDEX, PRICE_SCALE} from "../FundTypes.sol";
import {
    AssetPrice,
    FlowParams,
    IFlowEvents,
    Quote,
    SettleCheck,
    SettleContext,
    LEG_PRICE_FEED_ONLY,
    LEG_PRICE_TWAP_ONLY,
    PRICE_KIND_BASKET,
    PRICE_KIND_LENDING
} from "../FlowTypes.sol";
import {ILendingRateAdapter} from "../interfaces/IFlowAdapters.sol";
import {IRobotMoneyFundFull} from "../interfaces/IRobotMoneyFund.sol";
import {FeedLib, FeedStatus} from "./FeedLib.sol";
import {TwapSlicesLib} from "./TwapSlicesLib.sol";
import {TwapTickMath} from "../../../../lib/TwapTickMath.sol";
import {FlowEpochs, FlowState, RoundState} from "./FlowStorage.sol";
import {FlowMatchLib} from "./FlowMatchLib.sol";

/// @dev Minimal interface of FundExclusionLedger read by Check 6 (cycled exclusions, review Q-F3).
interface IExclusionLedgerView {
    function exclusionCount() external view returns (uint256);
    function exclusions(uint256 id)
        external
        view
        returns (
            uint256 adapterIndex,
            address adapter,
            uint48 openedBlock,
            uint40 openedAt,
            bool finalized,
            uint256 snapshotSupply,
            uint256 adapterValue,
            uint256 recoveredUsdc,
            uint256 claimedUsdc
        );
}

/// @title FlowCheckLib
/// @notice Pre-trade oracle, TWAP, venue liquidity, and breaker checks (Steps 1–7) plus forward-priced terms
///         quotes (`quoteDeposit` / `quoteRedeem`). Linked (`public`) to keep `FlowQueue` under G1.
library FlowCheckLib {
    uint256 internal constant LEND_RATE_GAS = 300_000;

    using Math for uint256;

    struct Feeds {
        uint256 usdc8;
        uint256 usdcUnit;
        address usdc;
        uint8 legPriceMode;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Checks 1 to 7
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Run checks 1 to 7 for a settlement called by `caller` now (`isKeeper == KEEPER_ROLE`).
    function preTrade(
        FlowState storage s,
        address,
        /*caller*/
        bool isKeeper
    )
        public
        view
        returns (SettleCheck check, uint256 index, uint256 detail, SettleContext memory c)
    {
        FlowParams memory p = s.params;
        (bool winOk, uint64 cur, uint64 roundEpoch) = _timeWindowOpen(s, p);
        if (!winOk) return (SettleCheck.Window, IDLE_INDEX, 0, c);
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        if (
            s.paused || (s.queuePausedUntil != 0 && block.timestamp < s.queuePausedUntil)
                || fund.isShutdown()
        ) {
            return (SettleCheck.Paused, IDLE_INDEX, 0, c);
        }
        if (!_hasRoundWork(s, roundEpoch, cur)) return (SettleCheck.Window, IDLE_INDEX, 0, c);
        if (!isKeeper) return (SettleCheck.Caller, IDLE_INDEX, 0, c);

        SettleContext memory m;
        (check, index, detail, m) = market(s);
        if (check != SettleCheck.Ok) return (check, index, detail, c);
        m.roundEpoch = roundEpoch;
        m.firstEpoch = roundEpoch;
        m.lastEpoch = roundEpoch;
        m.excludedMask = excludedMask(s);

        if (s.lastSharePrice != 0) {
            (bool priceOk, uint256 moveBps) = _sharePriceBreakerOk(s, m, cur, p);
            if (!priceOk) return (SettleCheck.SharePrice, IDLE_INDEX, moveBps, m);
        }

        RoundState storage rs = s.rounds[roundEpoch];
        m.depositsOpen = rs.opened
            ? rs.depositsOpen
            : (m.excludedMask == 0 && m.saleMask == 0 && !fund.depositsPaused()
                    && !fund.isShutdown());
        return (SettleCheck.Ok, IDLE_INDEX, 0, m);
    }

    function _timeWindowOpen(FlowState storage s, FlowParams memory p)
        private
        view
        returns (bool ok, uint64 cur, uint64 roundEpoch)
    {
        if (block.timestamp < p.settleWindow) return (false, 0, 0);
        cur = FlowEpochs.current(s);
        if (
            p.settleWindow < p.epochLength && cur > 0
                && block.timestamp < FlowEpochs.endOf(s, cur - 1) + p.settleWindow
        ) {
            return (false, cur, 0);
        }
        bool any;
        (any, roundEpoch) = FlowEpochs.newestEndedBy(s, block.timestamp - p.settleWindow, 0);
        if (!any) return (false, cur, 0);
        return (true, cur, roundEpoch);
    }

    function _hasRoundWork(FlowState storage s, uint64 roundEpoch, uint64 cur)
        private
        view
        returns (bool)
    {
        RoundState storage rs = s.rounds[roundEpoch];
        if (rs.opened) {
            if (rs.done) return false;
            (bool hasRed, bool hasDep) = FlowMatchLib.hasUnfilledInPool(s, rs.depositsOpen, cur);
            return hasRed || hasDep;
        }
        return FlowMatchLib.hasPendingForRound(s, roundEpoch, cur);
    }

    function _sharePriceBreakerOk(
        FlowState storage s,
        SettleContext memory m,
        uint64 cur,
        FlowParams memory p
    ) private view returns (bool ok, uint256 moveBps) {
        (uint256 curPx, uint256 lastRef) = _breakerValues(s, m);
        uint256 moved = curPx > lastRef ? curPx - lastRef : lastRef - curPx;
        moveBps = lastRef == 0 ? type(uint256).max : moved.mulDiv(BPS, lastRef, Math.Rounding.Ceil);
        uint256 epochsPassed = cur - s.lastSettleEpoch;
        if (epochsPassed == 0) epochsPassed = 1;
        ok = moveBps <= uint256(p.maxSharePriceMoveBps) * epochsPassed;
    }

    function _breakerValues(FlowState storage s, SettleContext memory m)
        private
        view
        returns (uint256 curPx, uint256 ref)
    {
        curPx = m.sharePrice;
        ref = s.lastSharePrice;
        uint256 cycled = _cycledVenues(s, m);
        uint256 len = m.prices.length;

        // Rebase excluded Lending venues (D-AT-4)
        for (uint256 i; i < len && i < 256; ++i) {
            uint256 bit = 1 << i;
            if (m.prices[i].kind != PRICE_KIND_LENDING) {
                if ((s.lastExcludedMask & bit) == 0 && (m.excludedMask & bit) == 0) continue;
            }
            if ((s.lastExcludedMask & bit) == (m.excludedMask & bit) && (cycled & bit) == 0) {
                continue;
            }
            uint256 v = s.lastLendPerShare[i];
            ref = ref > v ? ref - v : 0;
            if (m.excludedMask & bit == 0) ref += m.held[i].mulDiv(PRICE_SCALE, m.supply);
        }

        // Exclude `inSale` assets from Check 6 (E53) on both sides
        for (uint256 i; i < len && i < 256; ++i) {
            uint256 bit = 1 << i;
            if ((m.saleMask & bit) == 0) continue;
            if (m.prices[i].kind == PRICE_KIND_BASKET && m.prices[i].unit != 0) {
                uint256 curValPerShare = m.held[i]
                    .mulDiv(m.prices[i].feedPerToken, m.prices[i].unit)
                    .mulDiv(PRICE_SCALE, m.supply);
                curPx = curPx > curValPerShare ? curPx - curValPerShare : 0;
            }
            if ((s.lastSaleMask & bit) == 0) {
                uint256 lastVal = s.lastAssetPerShare[i];
                ref = ref > lastVal ? ref - lastVal : 0;
            }
        }
    }

    function _cycledVenues(FlowState storage s, SettleContext memory m)
        private
        view
        returns (uint256 mask)
    {
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

    /// @notice Checks 2–4, 5 (non-reverting capture into `lendRateOk`), and 7 (snapshot, `navFeed`, `navTwap`, `S`).
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

        // ── Check 2: sequencer, active non-inSale basket feeds, USDC peg ──
        {
            (bool up, FeedStatus st) = FeedLib.sequencerUp(s.sequencerFeed, p.sequencerGrace);
            if (!up) return (SettleCheck.Sequencer, IDLE_INDEX, uint256(st), c);
        }

        uint256[] memory feed8 = new uint256[](cfg.length);
        bool[] memory inSaleFlags = new bool[](cfg.length);
        for (uint256 i; i < cfg.length; ++i) {
            if (!cfg[i].active) continue;
            bool inSale = fund.isAssetInSale(i);
            inSaleFlags[i] = inSale;
            if (inSale && i < 256) c.saleMask |= 1 << i;
            if (cfg[i].kind != AssetKind.Basket) continue;
            (FeedStatus st, uint256 px) = FeedLib.read(cfg[i].feed, cfg[i].maxFeedAge);
            if (!inSale && st != FeedStatus.Ok) return (SettleCheck.Feed, i, uint256(st), c);
            if (st == FeedStatus.Ok) feed8[i] = px;
        }
        {
            (bool pegOk, FeedStatus st, uint256 u8) =
                FeedLib.usdcPeg(s.usdcFeed, s.usdcFeedMaxAge, p.usdcPegBandBps);
            if (!pegOk) {
                return
                    (SettleCheck.UsdcPeg, IDLE_INDEX, st == FeedStatus.OffPeg ? u8 : uint256(st), c);
            }
            f.usdc8 = u8;
        }

        // ── Check 3: slice-median TWAP and quorum (skipping inSale) ──
        int24[] memory ticks = new int24[](cfg.length);
        for (uint256 i; i < cfg.length; ++i) {
            if (!cfg[i].active || cfg[i].kind != AssetKind.Basket || inSaleFlags[i]) continue;
            (bool ok, int24 med, uint8 inBand) =
                TwapSlicesLib.median(cfg[i].pool, p.settleWindow, p.slices, p.dispersionBps);
            if (!ok || inBand < p.quorum) return (SettleCheck.TwapQuorum, i, inBand, c);
            ticks[i] = med;
        }

        // ── Check 4: TWAP within refBandBps of feed & per-swap bounds (skipping inSale TWAP check) ──
        c.prices = new AssetPrice[](cfg.length);
        for (uint256 i; i < cfg.length; ++i) {
            if (!cfg[i].active) continue;
            if (cfg[i].kind == AssetKind.Lending) {
                c.prices[i].kind = PRICE_KIND_LENDING;
                c.prices[i].inSale = inSaleFlags[i];
                continue;
            }
            if (inSaleFlags[i]) {
                AssetPrice memory apSale;
                apSale.kind = PRICE_KIND_BASKET;
                apSale.inSale = true;
                apSale.unit = 10 ** IERC20Metadata(cfg[i].token).decimals();
                if (feed8[i] != 0) {
                    apSale.feedPerToken = feed8[i].mulDiv(f.usdcUnit, f.usdc8);
                } else {
                    apSale.feedPerToken = fund.saleFallbackPrice(i);
                }
                if (apSale.feedPerToken == 0) {
                    return (SettleCheck.Feed, i, uint256(FeedStatus.NoFeed), c);
                }
                c.prices[i] = apSale;
                continue;
            }
            (bool ok, uint256 devBps, AssetPrice memory ap) =
                _basketPrice(cfg[i], ticks[i], feed8[i], f, p);
            if (!ok) return (SettleCheck.TwapVsFeed, i, devBps, c);
            c.prices[i] = ap;
        }

        // ── Check 5: lending rate check (folded into round deposit stop, E36 / SAFE-09) ──
        (c.lendRateOk, c.lendRateFailIdx, c.lendRateFailDetail, c.lendRates) = _lendRates(s, cfg, p);

        // ── Check 7: snapshot, navFeed, navTwap (`S`) ──
        c.supply = fund.totalSupply();
        if (c.supply == 0) return (SettleCheck.SharePrice, IDLE_INDEX, 0, c);
        (c.idle, c.held) = fund.heldBalances();
        if (c.held.length != cfg.length) {
            return (SettleCheck.SharePrice, IDLE_INDEX, c.held.length, c);
        }
        c.navFeed = c.idle;
        c.navTwap = c.idle;
        for (uint256 i; i < cfg.length; ++i) {
            if (c.prices[i].kind == PRICE_KIND_LENDING) {
                c.navFeed += c.held[i];
                c.navTwap += c.held[i];
            } else if (c.prices[i].kind == PRICE_KIND_BASKET) {
                c.navFeed += c.held[i].mulDiv(c.prices[i].feedPerToken, c.prices[i].unit);
                if (!c.prices[i].inSale) {
                    c.navTwap += c.held[i].mulDiv(c.prices[i].twapPerToken, c.prices[i].unit);
                }
            }
        }
        c.sharePrice = c.navFeed.mulDiv(PRICE_SCALE, c.supply);
        c.matchSharePrice = c.navTwap.mulDiv(PRICE_SCALE, c.supply);
        (c.tvlCap,, c.exitFeeBps,) = fund.config();
        return (SettleCheck.Ok, IDLE_INDEX, 0, c);
    }

    function _basketPrice(
        AssetConfig memory a,
        int24 tick,
        uint256 px8,
        Feeds memory f,
        FlowParams memory p
    ) private view returns (bool ok, uint256 devBps, AssetPrice memory ap) {
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
        ap.twapPerToken = twapDown;
        uint256 low = feedUp < twapUp ? feedUp : twapUp;
        uint256 high = feedDown > twapDown ? feedDown : twapDown;
        if (f.legPriceMode == LEG_PRICE_TWAP_ONLY) (low, high) = (twapUp, twapDown);
        else if (f.legPriceMode == LEG_PRICE_FEED_ONLY) (low, high) = (feedUp, feedDown);
        ap.buyPerToken = low.mulDiv(BPS + p.legBandBps, BPS, Math.Rounding.Ceil);
        ap.sellPerToken = high.mulDiv(BPS - p.legBandBps, BPS);
        ok = true;
    }

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
            if (fund.openExclusionOf(i) != 0) continue;
            (bool rOk, uint256 rate) = lendRate(cfg[i].adapter);
            if (!rOk) return (false, i, type(uint256).max, rates);
            rates[i] = rate;
            uint256 last = s.lastLendRate[i];
            if (last == 0 || rate <= last) continue;
            uint256 growth = rate - last;
            if (growth * BPS * 1 days > last * uint256(p.maxLendRateGrowthBps) * elapsed) {
                return (false, i, growth.mulDiv(BPS, last, Math.Rounding.Ceil), rates);
            }
        }
        return (true, 0, 0, rates);
    }

    function lendRate(address adapter) public view returns (bool ok, uint256 rate) {
        if (adapter.code.length == 0) return (false, 0);
        (bool success, bytes memory ret) = adapter.staticcall{gas: LEND_RATE_GAS}(
            abi.encodeWithSelector(ILendingRateAdapter.ratePerUnit.selector)
        );
        if (!success || ret.length < 32) return (false, 0);
        rate = abi.decode(ret, (uint256));
        ok = rate != 0;
    }

    /// @notice Available underlying liquidity from a lending adapter (`E36`, `E44`, gas-capped staticcall).
    function venueLiquidity(address adapter) public view returns (bool ok, uint256 avail) {
        if (adapter.code.length == 0) return (false, 0);
        (bool success, bytes memory ret) = adapter.staticcall{gas: LEND_RATE_GAS}(
            abi.encodeWithSelector(ILendingRateAdapter.availableLiquidity.selector)
        );
        if (!success || ret.length < 32) return (false, 0);
        avail = abi.decode(ret, (uint256));
        ok = true;
    }

    /// @notice Test whether every non-excluded Lending venue can pay its pro-rata slice of `redPoolShares` (`E36`, `E44`).
    function checkVenuesLiquidity(
        FlowState storage s,
        SettleContext memory c,
        uint256 redPoolShares
    ) public view returns (bool ok, uint256 failIndex) {
        if (redPoolShares == 0) return (true, 0);
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        AssetConfig[] memory cfg = fund.assetConfigs();
        for (uint256 i; i < cfg.length; ++i) {
            if (!cfg[i].active || cfg[i].kind != AssetKind.Lending) continue;
            if (fund.openExclusionOf(i) != 0) continue;
            uint256 need = c.held[i].mulDiv(redPoolShares, c.supply, Math.Rounding.Ceil);
            if (need == 0) continue;
            (bool rOk, uint256 avail) = venueLiquidity(cfg[i].adapter);
            if (!rOk) return (false, i);
            (uint256 totalU, uint256 claimU) = fund.positionUnits(i);
            if (totalU != 0) {
                uint256 fundU = totalU > claimU ? totalU - claimU : 0;
                avail = avail.mulDiv(fundU, totalU);
            }
            if (avail < need) return (false, i);
        }
        return (true, 0);
    }

    /// @notice Whether state deposit stops are inactive right now.
    function depositsOpen(FlowState storage s) public view returns (bool) {
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        if (fund.depositsPaused() || fund.isShutdown() || fund.hasAssetInSale()) return false;
        return excludedMask(s) == 0;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Forward-Priced Terms Views (E31, FLOW-08)
    // ═════════════════════════════════════════════════════════════════════════

    function settleableAt(FlowState storage s, uint64 epoch) internal view returns (uint256) {
        return FlowEpochs.endOf(s, epoch) + s.params.settleWindow;
    }

    function quoteDeposit(FlowState storage s, uint256) public view returns (Quote memory q) {
        q = _terms(s, true);
    }

    function quoteRedeem(FlowState storage s, uint256) public view returns (Quote memory q) {
        q = _terms(s, false);
    }

    function _terms(FlowState storage s, bool isDeposit) private view returns (Quote memory q) {
        FlowParams memory p = s.params;
        uint64 cur = FlowEpochs.current(s);
        uint256 epEnd = FlowEpochs.endOf(s, cur);
        q.cancelCutoff = uint64(epEnd > p.cancelBuffer ? epEnd - p.cancelBuffer : 0);
        q.earliestSettle = uint64(epEnd + p.settleWindow);
        q.holdEnds = isDeposit ? q.earliestSettle + p.minHold : q.earliestSettle;
        if (!isDeposit) {
            (,, q.feeBps,) = IRobotMoneyFundFull(s.fund).config();
        }
        q.refBandBps = p.refBandBps;
        q.legBandBps = p.legBandBps;
    }
}
