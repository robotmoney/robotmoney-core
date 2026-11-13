// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md §4.4 (sim: timed flows: "The sim's user flows become
//            requests with limits. Its keeper also settles."; "The sim's feed for each asset follows its fair-price
//            walk, with the feed's own deviation threshold and heartbeat"), §4.1 (A2, A6, A9, A10 in the sim);
//            docs/technical/one-vault-rebalancer-proposal.md §5.9.2 (epoch), §5.9.3 (checks 1 to 12), §5.9.5
//            (defaults), §13 G9; one-vault-step3-finish-plan.md §3.4
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {TwapTickMath} from "../../../lib/TwapTickMath.sol";
import {PrototypeHarness} from "../PrototypeHarness.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {TwapSlicesLib} from "../src/lib/TwapSlicesLib.sol";
import {BPS, PRICE_SCALE, PlanParams, PlanStatus} from "../src/FundTypes.sol";
import {FlowParams, IFlowEvents, Quote, Request, SettleCheck} from "../src/FlowTypes.sol";
import {ILendingRateAdapter} from "../src/interfaces/IFlowAdapters.sol";
import {SimMarket} from "./SimMarket.sol";

/// @title TimedSimBase
/// @notice The timed world the timed-flow sim and the timed sim attacks run in: the live five-asset fund and its
///         FlowQueue (PrototypeHarness), the step 3 market for wETH and cbBTC (`SimMarket`), Chainlink feeds that follow
///         the market's fair-price walk, and a keeper that settles every epoch at the end of its window.
///
///         Feed model (eng plan §4.4). Each basket feed is a `MockAggregator` at the real feed address (the harness
///         places them). Its answer is the reference walk's price, never the pool's. A new round is written when the
///         walk moves the price more than the feed's deviation threshold from the last answer (checked right after
///         each walk step, which is the only time the reference moves), and when `heartbeat` seconds passed since the
///         last round (stamped at the heartbeat time, with the price of that moment). Thresholds and heartbeats are
///         the Chainlink directory values for Base that `docs/technical/research/vault-share-pricing-models.md`
///         records (2026-11-11): ETH / USD 0.15 % and 20 min, cbBTC / USD 0.3 % and 20 min. The harness sets cbBTC's
///         `maxFeedAge` from a 24 h heartbeat; the 20 min heartbeat here only writes rounds more often, so the feed is
///         never staler than either reading allows (recorded in notes/sim.md). USDC / USD is held at 1.00000000 with a
///         24 h heartbeat, and the sequencer is up: the sim models neither a depeg nor an outage (A17 covers them).
///
///         Keeper model (§5.9.2 step 4, D3). The keeper calls `settle(256, max)` at each window end, `k ×
///         epochLength + settleWindow`, when `checkSettle()` says something is settleable. A call that reverts, or in
///         which a side fails, is retried at the start of every later 30-minute slot until one succeeds. The keeper
///         settles before it steps the rebalance in the same block. It never sends a call the sim does not record:
///         every attempt is kept with its outcome and the state around it (`attempts`).
///
///         Records. Every attempt (`AttemptRec`), every settlement that traded (`SettleRec`) and every request the
///         sim made (`ReqRec`) is kept for the JSON. Costs are against the feed (NAV per share at the feeds before the
///         settlement, the value the queue's own checks use) and against the reference walk, before the exit fee.
abstract contract TimedSimBase is PrototypeHarness, SimMarket {
    using Math for uint256;

    // ─── Feed model (see the contract note) ─────────────────────────────────────────────────────────────

    uint256 internal constant FEED_DEV_BPS_ETH = 15;
    uint256 internal constant FEED_DEV_BPS_CBBTC = 30;
    uint256 internal constant FEED_HEARTBEAT_SEC = 1_200;
    uint256 internal constant USDC_FEED_HEARTBEAT_SEC = 86_400;

    // ─── Attempt kinds and outcomes ─────────────────────────────────────────────────────────────────────

    /// @dev A window-end call for an epoch that holds new requests (the "first call after the window" of G9).
    uint8 internal constant ATT_FIRST = 1;
    /// @dev A window-end call that only continues older requests (a cap or a block left them pending).
    uint8 internal constant ATT_CONTINUE = 2;
    /// @dev A retry at a slot start after a call that reverted or in which a side failed.
    uint8 internal constant ATT_RETRY = 3;

    /// @dev Both sides that had fills traded.
    uint16 internal constant OUT_OK = 0;
    /// @dev No revert and no side failed, but nothing traded (every request skipped by its limit or left by a cap).
    uint16 internal constant OUT_NOOP = 2;
    uint16 internal constant OUT_DEP_FAILED = 10;
    uint16 internal constant OUT_RED_FAILED = 11;
    uint16 internal constant OUT_BOTH_FAILED = 12;
    /// @dev 100 + SettleCheck: `settle` reverted `SettleBlocked(check, index, detail)`.
    uint16 internal constant OUT_BLOCKED_BASE = 100;
    uint16 internal constant OUT_OUT_OF_GAS = 300;
    uint16 internal constant OUT_OTHER_REVERT = 400;

    /// @dev One keeper attempt. Basket arrays are [wETH, cbBTC]. `index`/`detail`: of the revert (SettleBlocked's
    ///      asset and detail; the selector of any other revert), or of the failed side (its reason's selector in
    ///      `detail`). The `*Bps` fields describe the market just before the call (the normal range of §5.9.5).
    struct AttemptRec {
        uint64 at;
        uint8 kind;
        uint16 outcome;
        uint256 index;
        uint256 detail;
        uint256 settlementId;
        uint256 fills;
        uint256 limitSkips;
        int256[2] twapVsFeedBps;
        uint256[2] slicesInBand;
        uint256[2] sliceDevBps;
        int256[2] spotVsFeedBps;
        int256[2] spotMoveBps;
        uint256 sharePriceMoveBps;
        uint256 lendGrowthCentiBpsPerDay;
    }

    /// @dev One settlement that traded. Fair values are NAV per share before the settlement × shares.
    struct SettleRec {
        uint64 at;
        uint256 settlementId;
        uint256 depUsdc;
        uint256 depFairFeed;
        uint256 depFairRef;
        uint256 redGross;
        uint256 redFairFeed;
        uint256 redFairRef;
        uint256 navFeed;
    }

    /// @dev One request the sim made. Deposit: `amount` is USDC escrowed, `filled` USDC spent, `basis` the USDC
    ///      spent; cost = spent − fair value of the shares. Redemption: `amount` shares escrowed, `filled` shares
    ///      burned, `basis` the fair value of the burned shares; cost = fair value − USDC before the exit fee.
    struct ReqRec {
        uint256 id;
        bool isDeposit;
        bool quoteFailed;
        uint64 at;
        uint64 epoch;
        uint256 amount;
        uint256 valueUsdc;
        uint256 limit;
        uint256 filled;
        uint256 basis;
        int256 costFeed;
        int256 costRef;
        uint64 firstFillAt;
        uint64 doneAt;
        uint64 unlockAt;
        uint256 fills;
        uint256 limitSkips;
    }

    // ─── State ──────────────────────────────────────────────────────────────────────────────────────────

    address[2] internal feedAddr;
    uint256[2] internal basketIdx;
    int256[2] internal feedPx8;
    uint256[2] internal feedAt;
    uint256 internal usdcFeedAt;
    uint256[2] internal feedRoundsDeviation;
    uint256[2] internal feedRoundsHeartbeat;

    /// @dev The last window end (k of `k × epochLength + settleWindow`) the keeper handled.
    uint256 internal lastSchedK;
    bool internal retryDue;

    AttemptRec[] internal attempts;
    SettleRec[] internal settles;
    ReqRec[] internal reqs;
    /// @dev requestId => index + 1 in `reqs` (0: not a sim request, e.g. genesis).
    mapping(uint256 => uint256) internal reqIndex;

    /// @dev NAV per share at the feeds and the venue rates at the last settlement that traded (normal range).
    uint256 internal lastSettlePx;
    uint256 internal lastSettleAt;
    uint256[3] internal lastLendRate;
    /// @dev Bound prices of the last quotes that answered, for a client whose quote reverts now.
    uint256 internal lastDepBound;
    uint256 internal lastRedBound;
    /// @dev Fills of the last attempt (read by `_onSettlePost`).
    uint256 internal lastAttemptDepFills;
    uint256 internal lastAttemptRedFills;

    // ─── Hooks ──────────────────────────────────────────────────────────────────────────────────────────

    function _mkFundUsdc(address to, uint256 amount) internal override {
        fundUsdc(to, amount);
    }

    /// @dev The sims skip the per-slot fixture coverage check unless PROTO_FIXTURE_CHECK=1, as RebalanceSim does.
    function _fixtureCheckByDefault() internal pure virtual override returns (bool) {
        return false;
    }

    /// @dev Called right before each keeper `settle` attempt and right after it (plan accounting in the sim; the
    ///      attacker's last push before the keeper's call and its unwind after it in the sim attacks). Same block.
    function _onSettlePre() internal virtual {}

    function _onSettlePost(uint16 outcome) internal virtual {}

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Feeds
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Put every feed on the reference walk now (a fresh round), USDC at 1, the sequencer up.
    function _feedInit() internal {
        require(cometListed, "timed sim: needs the five-asset fixture (Compound listed)");
        feedAddr = [FEED_ETH, FEED_CBBTC];
        basketIdx = [IDX_WETH, IDX_CBBTC];
        uint256 now_ = vm.getBlockTimestamp();
        for (uint256 b; b < MK_N; ++b) {
            _pushFeed(b, _refPrice8(b), now_);
        }
        feedPrice8[FEED_USDC] = 1e8;
        MockAggregator(FEED_USDC).setRound(8, 1e8, now_, now_);
        usdcFeedAt = now_;
        MockAggregator(FEED_SEQUENCER).setRound(0, 0, sequencerUpSince, now_);
    }

    /// @notice USD price (8 decimals) of one whole basket token at the reference walk.
    function _refPrice8(uint256 b) internal view returns (int256) {
        uint256 unit = 10 ** IERC20Metadata(mkTokens[b]).decimals();
        return int256(TwapTickMath.priceFromTick(_mkRefTick(b), mkTokens[b], MK_USDC, unit) * 100);
    }

    function _pushFeed(uint256 b, int256 px8, uint256 at) internal {
        MockAggregator(feedAddr[b]).setRound(8, px8, at, at);
        feedPx8[b] = px8;
        feedAt[b] = at;
        feedPrice8[feedAddr[b]] = px8;
    }

    /// @notice Heartbeat rounds due by now (each at its heartbeat time, at the reference of that moment), the USDC
    ///         feed's daily round, and the sequencer's status. Call after every warp, before the reference moves.
    function _feedTick() internal {
        uint256 now_ = vm.getBlockTimestamp();
        for (uint256 b; b < MK_N; ++b) {
            if (now_ < feedAt[b] + FEED_HEARTBEAT_SEC) continue;
            uint256 k = (now_ - feedAt[b]) / FEED_HEARTBEAT_SEC;
            _pushFeed(b, _refPrice8(b), feedAt[b] + k * FEED_HEARTBEAT_SEC);
            ++feedRoundsHeartbeat[b];
        }
        if (now_ >= usdcFeedAt + USDC_FEED_HEARTBEAT_SEC) {
            usdcFeedAt += (now_ - usdcFeedAt) / USDC_FEED_HEARTBEAT_SEC * USDC_FEED_HEARTBEAT_SEC;
            MockAggregator(FEED_USDC).setRound(8, 1e8, usdcFeedAt, usdcFeedAt);
        }
        MockAggregator(FEED_SEQUENCER).setRound(0, 0, sequencerUpSince, now_);
    }

    /// @notice Deviation rounds: right after a walk step, each feed whose answer is more than its threshold from the
    ///         new reference price writes a round now.
    function _feedDeviation() internal {
        uint256 now_ = vm.getBlockTimestamp();
        for (uint256 b; b < MK_N; ++b) {
            int256 px = _refPrice8(b);
            int256 last = feedPx8[b];
            uint256 diff = uint256(px > last ? px - last : last - px);
            uint256 dev = b == 0 ? FEED_DEV_BPS_ETH : FEED_DEV_BPS_CBBTC;
            if (diff * BPS > dev * uint256(last)) {
                _pushFeed(b, px, now_);
                ++feedRoundsDeviation[b];
            }
        }
    }

    /// @notice Feed price of one whole basket token in USDC units, as the queue reads it (USD feed / USDC feed).
    function _feedPerToken(uint256 b) internal view returns (uint256) {
        return uint256(feedPx8[b]).mulDiv(1e6, 1e8);
    }

    function _refPerToken(uint256 b) internal view returns (uint256) {
        return _mkUsdcFor(b, 10 ** IERC20Metadata(mkTokens[b]).decimals(), _mkRefSqrt(b));
    }

    /// @notice NAV at the feeds and at the reference walk from the fund's held amounts (heldBalances).
    function _navFeedRef() internal view returns (uint256 navFeed, uint256 navRef, uint256 supply) {
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        navFeed = idle;
        navRef = idle;
        uint256 n = held.length;
        for (uint256 i; i < n; ++i) {
            if (i == IDX_WETH || i == IDX_CBBTC) {
                uint256 b = i - IDX_WETH;
                uint256 unit = 10 ** IERC20Metadata(mkTokens[b]).decimals();
                navFeed += held[i].mulDiv(_feedPerToken(b), unit);
                navRef += held[i].mulDiv(_refPerToken(b), unit);
            } else {
                navFeed += held[i];
                navRef += held[i];
            }
        }
        supply = fund.totalSupply();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Keeper: the settle schedule
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Start the keeper's schedule now: the next window end after now is the first it handles.
    function _schedInit() internal {
        FlowParams memory p = queue.flowParams();
        uint256 now_ = vm.getBlockTimestamp();
        lastSchedK = now_ < p.settleWindow ? 0 : (now_ - p.settleWindow) / p.epochLength;
    }

    /// @notice Advance time to `t`, stopping at every window end on the way for the keeper's scheduled call.
    function _until(uint256 t) internal {
        FlowParams memory p = queue.flowParams();
        while (true) {
            uint256 k = lastSchedK + 1;
            uint256 due = k * p.epochLength + p.settleWindow;
            if (due > t) break;
            if (due > vm.getBlockTimestamp()) {
                _mkAt(due);
                _feedTick();
            }
            lastSchedK = k;
            _scheduledSettle(k);
        }
        if (t > vm.getBlockTimestamp()) _mkAt(t);
        _feedTick();
    }

    /// @notice The keeper's call at the end of window k (epoch k − 1 closed an hour ago), if anything is settleable.
    function _scheduledSettle(uint256 k) internal {
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        if (check == SettleCheck.Window) {
            retryDue = false;
            return;
        }
        bool fresh = queue.epochRequests(uint64(k - 1)).length != 0;
        uint16 out = _settleAttempt(fresh ? ATT_FIRST : ATT_CONTINUE);
        retryDue = !_settled(out);
    }

    /// @notice At a slot start: retry a call that failed, while something is settleable.
    function _retrySettle() internal {
        if (!retryDue) return;
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        if (check == SettleCheck.Window) {
            retryDue = false;
            return;
        }
        retryDue = !_settled(_settleAttempt(ATT_RETRY));
    }

    /// @notice No revert and no failed side.
    function _settled(uint16 out) internal pure returns (bool) {
        return out == OUT_OK || out == OUT_NOOP;
    }

    /// @notice One keeper `settle` call, recorded with the market around it.
    function _settleAttempt(uint8 kind) internal returns (uint16 outcome) {
        AttemptRec memory a;
        a.at = uint64(vm.getBlockTimestamp());
        a.kind = kind;
        _observeSettle(a);
        Basis memory v;
        (v.navFeed, v.navRef, v.supply) = _navFeedRef();
        v.feeBps = _exitFeeBps();
        uint160[2] memory sp0 = [_mkSpotSqrt(0), _mkSpotSqrt(1)];
        lastAttemptDepFills = 0;
        lastAttemptRedFills = 0;
        _onSettlePre();
        vm.recordLogs();
        vm.prank(keeper);
        try queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max) returns (uint256 sid) {
            VmSafe.Log[] memory logs = vm.getRecordedLogs();
            a.settlementId = sid;
            outcome = _bookSettle(sid, logs, v, a);
        } catch (bytes memory err) {
            vm.getRecordedLogs();
            outcome = _blockedOutcome(err, a);
        }
        for (uint256 b; b < MK_N; ++b) {
            a.spotMoveBps[b] = _sqrtMoveBps(b, sp0[b], _mkSpotSqrt(b));
        }
        a.outcome = outcome;
        attempts.push(a);
        _onSettlePost(outcome);
    }

    /// @dev Signed move of the token's USDC price from sqrt price `s0` to `s1`, in bps.
    function _sqrtMoveBps(uint256 b, uint160 s0, uint160 s1) internal view returns (int256) {
        uint256 unit = 10 ** IERC20Metadata(mkTokens[b]).decimals();
        return _mkBps(_mkUsdcFor(b, unit, s1), _mkUsdcFor(b, unit, s0));
    }

    /// @dev The quantities the §5.9.5 values bound, read before the call: TWAP (slice median) against the feed, the
    ///      slices in the dispersion band and the widest slice, the spot against the feed, the share-price move
    ///      since the last settlement per epoch passed, and the fastest venue-rate growth per day since then.
    function _observeSettle(AttemptRec memory a) internal view {
        FlowParams memory p = queue.flowParams();
        for (uint256 b; b < MK_N; ++b) {
            (bool ok, int24[] memory means) =
                TwapSlicesLib.sliceMeans(mkPools[b], p.settleWindow, p.slices);
            uint256 unit = 10 ** IERC20Metadata(mkTokens[b]).decimals();
            uint256 feed = _feedPerToken(b);
            a.spotVsFeedBps[b] = _mkBps(_mkUsdcFor(b, unit, _mkSpotSqrt(b)), feed);
            if (!ok) continue;
            (int24 med, uint256 inBand, uint256 widest) = _sliceStats(means, p.dispersionBps);
            a.slicesInBand[b] = inBand;
            a.sliceDevBps[b] = widest;
            a.twapVsFeedBps[b] =
                _mkBps(TwapTickMath.priceFromTick(med, mkTokens[b], MK_USDC, unit), feed);
        }
        (uint256 navFeed,, uint256 supply) = _navFeedRef();
        if (lastSettlePx != 0 && supply != 0) {
            uint256 px = navFeed.mulDiv(PRICE_SCALE, supply);
            uint256 moved = px > lastSettlePx ? px - lastSettlePx : lastSettlePx - px;
            uint256 epochs = vm.getBlockTimestamp() / p.epochLength - lastSettleAt / p.epochLength;
            if (epochs == 0) epochs = 1;
            a.sharePriceMoveBps = moved.mulDiv(BPS, lastSettlePx, Math.Rounding.Ceil) / epochs;
        }
        if (lastSettleAt != 0 && vm.getBlockTimestamp() > lastSettleAt) {
            uint256 elapsed = vm.getBlockTimestamp() - lastSettleAt;
            uint256[3] memory rates = _lendRates();
            for (uint256 j; j < 3; ++j) {
                if (lastLendRate[j] == 0 || rates[j] <= lastLendRate[j]) continue;
                uint256 g = (rates[j] - lastLendRate[j])
                .mulDiv(BPS * 100 * 1 days, lastLendRate[j] * elapsed);
                if (g > a.lendGrowthCentiBpsPerDay) a.lendGrowthCentiBpsPerDay = g;
            }
        }
    }

    /// @dev Median (lower) of the slice means, the slices within `dispersionBps` of it (TwapSlicesLib's band) and the
    ///      widest slice's distance from it in ticks (one tick is about 1 bp of price).
    function _sliceStats(int24[] memory means, uint16 dispersionBps)
        internal
        pure
        returns (int24 med, uint256 inBand, uint256 widest)
    {
        uint256 n = means.length;
        int24[] memory s = new int24[](n);
        for (uint256 j; j < n; ++j) {
            s[j] = means[j];
        }
        for (uint256 i = 1; i < n; ++i) {
            int24 x = s[i];
            uint256 j = i;
            while (j > 0 && s[j - 1] > x) {
                s[j] = s[j - 1];
                --j;
            }
            s[j] = x;
        }
        med = s[(n - 1) / 2];
        int256 band = int256(uint256(TwapSlicesLib.bandTicks(dispersionBps)));
        for (uint256 j; j < n; ++j) {
            int256 d = int256(means[j]) - int256(med);
            if (d < 0) d = -d;
            if (d <= band) ++inBand;
            if (uint256(d) > widest) widest = uint256(d);
        }
    }

    function _lendRates() internal view returns (uint256[3] memory r) {
        address[3] memory ad =
            [address(aaveAdapter), address(moonwellAdapter), address(cometAdapter)];
        for (uint256 j; j < 3; ++j) {
            try ILendingRateAdapter(ad[j]).ratePerUnit() returns (uint256 x) {
                r[j] = x;
            } catch {}
        }
    }

    /// @dev NAV per share before a settlement, at the feeds and at the reference, and the exit fee.
    struct Basis {
        uint256 navFeed;
        uint256 navRef;
        uint256 supply;
        uint256 feeBps;
    }

    /// @dev Book a call that returned: its fills (against the feed and the reference), its skips, its failed sides.
    function _bookSettle(uint256 sid, VmSafe.Log[] memory logs, Basis memory v, AttemptRec memory a)
        internal
        returns (uint16 outcome)
    {
        bool depFailed;
        bool redFailed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(queue)) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == IFlowEvents.DepositFilled.selector) {
                _bookDepositFill(logs[i], v);
                ++a.fills;
                ++lastAttemptDepFills;
            } else if (t0 == IFlowEvents.RedeemFilled.selector) {
                _bookRedeemFill(logs[i], v);
                ++a.fills;
                ++lastAttemptRedFills;
            } else if (t0 == IFlowEvents.RequestSkipped.selector) {
                ++a.limitSkips;
                uint256 k = reqIndex[uint256(logs[i].topics[1])];
                if (k != 0) ++reqs[k - 1].limitSkips;
            } else if (t0 == IFlowEvents.SideFailed.selector) {
                (uint8 kind, bytes memory reason) = abi.decode(logs[i].data, (uint8, bytes));
                if (kind == 0) depFailed = true;
                else redFailed = true;
                (bytes4 sel, uint256 w0,,) = _words(reason);
                a.detail = uint256(uint32(sel));
                a.index = w0;
            } else if (t0 == IFlowEvents.Settled.selector) {
                _bookSettlement(sid, logs[i].data, v);
            }
        }
        _markDone();
        if (depFailed && redFailed) return OUT_BOTH_FAILED;
        if (depFailed) return OUT_DEP_FAILED;
        if (redFailed) return OUT_RED_FAILED;
        return sid == 0 ? OUT_NOOP : OUT_OK;
    }

    /// @dev `DepositFilled(requestId, claimId, settlementId; usdc, shares, unlockAt)`: cost = USDC spent − the
    ///      shares' value at NAV per share before the settlement.
    function _bookDepositFill(VmSafe.Log memory log, Basis memory v) internal {
        uint256 k = reqIndex[uint256(log.topics[1])];
        if (k == 0) return;
        (uint256 usdc, uint256 shares, uint64 unlockAt) =
            abi.decode(log.data, (uint256, uint256, uint64));
        ReqRec storage r = reqs[k - 1];
        r.filled += usdc;
        r.basis += usdc;
        r.costFeed += int256(usdc) - int256(shares.mulDiv(v.navFeed, v.supply));
        r.costRef += int256(usdc) - int256(shares.mulDiv(v.navRef, v.supply));
        r.unlockAt = unlockAt;
        if (r.firstFillAt == 0) r.firstFillAt = uint64(vm.getBlockTimestamp());
        ++r.fills;
    }

    /// @dev `RedeemFilled(requestId, claimId, settlementId; shares, usdc)`, `usdc` net of the exit fee: cost = the
    ///      shares' value − the USDC before the fee (`usdc / (1 − fee)`).
    function _bookRedeemFill(VmSafe.Log memory log, Basis memory v) internal {
        uint256 k = reqIndex[uint256(log.topics[1])];
        if (k == 0) return;
        (uint256 shares, uint256 usdc) = abi.decode(log.data, (uint256, uint256));
        ReqRec storage r = reqs[k - 1];
        uint256 fairFeed = shares.mulDiv(v.navFeed, v.supply);
        uint256 gross = usdc.mulDiv(BPS, BPS - v.feeBps);
        r.filled += shares;
        r.basis += fairFeed;
        r.costFeed += int256(fairFeed) - int256(gross);
        r.costRef += int256(shares.mulDiv(v.navRef, v.supply)) - int256(gross);
        if (r.firstFillAt == 0) r.firstFillAt = uint64(vm.getBlockTimestamp());
        ++r.fills;
    }

    function _bookSettlement(uint256 sid, bytes memory data, Basis memory v) internal {
        (,, uint256 usdcIn, uint256 minted, uint256 burned, uint256 usdcOut) =
            abi.decode(data, (uint256, uint256, uint256, uint256, uint256, uint256));
        SettleRec memory s;
        s.at = uint64(vm.getBlockTimestamp());
        s.settlementId = sid;
        s.depUsdc = usdcIn;
        s.depFairFeed = minted.mulDiv(v.navFeed, v.supply);
        s.depFairRef = minted.mulDiv(v.navRef, v.supply);
        s.redGross = usdcOut.mulDiv(BPS, BPS - v.feeBps);
        s.redFairFeed = burned.mulDiv(v.navFeed, v.supply);
        s.redFairRef = burned.mulDiv(v.navRef, v.supply);
        s.navFeed = v.navFeed;
        settles.push(s);
        (uint256 nf,, uint256 sup) = _navFeedRef();
        lastSettlePx = sup == 0 ? 0 : nf.mulDiv(PRICE_SCALE, sup);
        lastSettleAt = vm.getBlockTimestamp();
        lastLendRate = _lendRates();
    }

    /// @dev Mark every open sim request the queue now reports closed.
    function _markDone() internal {
        uint256 n = reqs.length;
        for (uint256 i; i < n; ++i) {
            ReqRec storage r = reqs[i];
            if (r.doneAt != 0 || r.fills == 0) continue;
            if (queue.getRequest(r.id).closed) r.doneAt = uint64(vm.getBlockTimestamp());
        }
    }

    /// @dev A reverted `settle`: SettleBlocked names its check; anything else is recorded by selector.
    function _blockedOutcome(bytes memory err, AttemptRec memory a) internal pure returns (uint16) {
        (bytes4 sel, uint256 w0, uint256 w1, uint256 w2) = _words(err);
        if (sel == IFlowEvents.SettleBlocked.selector) {
            a.index = w1;
            a.detail = w2;
            return OUT_BLOCKED_BASE + uint16(w0);
        }
        a.detail = uint256(uint32(sel));
        a.index = w0;
        if (sel == IFlowEvents.SettleSideOutOfGas.selector) return OUT_OUT_OF_GAS;
        return OUT_OTHER_REVERT;
    }

    /// @dev The selector and the first three words of revert data (zero where absent).
    function _words(bytes memory err)
        internal
        pure
        returns (bytes4 sel, uint256 w0, uint256 w1, uint256 w2)
    {
        if (err.length >= 4) sel = bytes4(err);
        if (err.length >= 36) {
            assembly {
                w0 := mload(add(err, 36))
            }
        }
        if (err.length >= 68) {
            assembly {
                w1 := mload(add(err, 68))
            }
        }
        if (err.length >= 100) {
            assembly {
                w2 := mload(add(err, 100))
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Requests with limits (§5.9.2 steps 1 and 2: a client sets the limit from the quote)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Fund `who` with `usdc` and request a deposit with the limit `quote × (1 + slackBps)`. A quote that
    ///         reverts now (checks 2 to 5 fail) leaves the client with the last quote that answered (or the TWAP NAV
    ///         per share plus twice `legBandBps` when none did). Returns false when the request reverts.
    function _reqDeposit(address who, uint256 usdc, uint256 slackBps)
        internal
        returns (bool ok, uint256 id, bytes memory err)
    {
        fundUsdc(who, usdc);
        uint256 bound;
        bool quoteFailed;
        try queue.quoteDeposit(usdc) returns (Quote memory q) {
            bound = q.boundPrice;
            lastDepBound = bound;
        } catch {
            quoteFailed = true;
            bound = lastDepBound != 0
                ? lastDepBound
                : _twapPx().mulDiv(BPS + 2 * queue.flowParams().legBandBps, BPS);
        }
        uint256 limit = bound.mulDiv(BPS + slackBps, BPS);
        vm.startPrank(who);
        IERC20(USDC).approve(address(queue), usdc);
        try queue.requestDeposit(usdc, limit, who) returns (uint256 rid) {
            (ok, id) = (true, rid);
        } catch (bytes memory e) {
            err = e;
        }
        vm.stopPrank();
        if (ok) _recordReq(id, true, quoteFailed, usdc, usdc, limit);
    }

    /// @notice `who` requests a redemption of `shares` with the limit `quote × (1 − slackBps)` (same fallback).
    function _reqRedeem(address who, uint256 shares, uint256 slackBps)
        internal
        returns (bool ok, uint256 id, bytes memory err)
    {
        uint256 bound;
        bool quoteFailed;
        try queue.quoteRedeem(shares) returns (Quote memory q) {
            bound = q.boundPrice;
            lastRedBound = bound;
        } catch {
            quoteFailed = true;
            bound = lastRedBound != 0
                ? lastRedBound
                : _twapPx().mulDiv(BPS - 2 * queue.flowParams().legBandBps - _exitFeeBps(), BPS);
        }
        uint256 limit = bound.mulDiv(BPS - slackBps, BPS);
        vm.startPrank(who);
        IERC20(address(fund)).approve(address(queue), shares);
        try queue.requestRedeem(shares, limit, who) returns (uint256 rid) {
            (ok, id) = (true, rid);
        } catch (bytes memory e) {
            err = e;
        }
        vm.stopPrank();
        if (ok) {
            _recordReq(id, false, quoteFailed, shares, shares.mulDiv(_twapPx(), PRICE_SCALE), limit);
        }
    }

    function _recordReq(
        uint256 id,
        bool isDeposit,
        bool quoteFailed,
        uint256 amount,
        uint256 value,
        uint256 limit
    ) internal {
        ReqRec memory r;
        r.id = id;
        r.isDeposit = isDeposit;
        r.quoteFailed = quoteFailed;
        r.at = uint64(vm.getBlockTimestamp());
        r.epoch = queue.getRequest(id).epoch;
        r.amount = amount;
        r.valueUsdc = value;
        r.limit = limit;
        reqs.push(r);
        reqIndex[id] = reqs.length;
    }

    /// @notice NAV per share at the TWAP (`portfolioValues`, which reads no feed), PRICE_SCALE units.
    function _twapPx() internal view returns (uint256) {
        (uint256 nav,,) = fund.portfolioValues();
        uint256 supply = fund.totalSupply();
        return supply == 0 ? 0 : nav.mulDiv(PRICE_SCALE, supply);
    }

    function _exitFeeBps() internal view returns (uint256 fee) {
        (,, fee,) = fund.config();
    }

    /// @dev PROTO_SIM_FLOW_<FIELD> overrides, set through the timelock (the queue's only admin path). Shared by the
    ///      timed-flow sim and the timed sim attacks, so a lever is measured in both the same way.
    function _applyFlowOverrides() internal returns (bool changed) {
        FlowParams memory p = queue.flowParams();
        FlowParams memory q = queue.flowParams();
        q.epochLength = uint32(_envU("EPOCH_LENGTH", q.epochLength));
        q.settleWindow = uint32(_envU("SETTLE_WINDOW", q.settleWindow));
        q.minHold = uint32(_envU("MIN_HOLD", q.minHold));
        q.keeperGrace = uint32(_envU("KEEPER_GRACE", q.keeperGrace));
        q.maxEpochFlowBps = uint16(_envU("MAX_EPOCH_FLOW_BPS", q.maxEpochFlowBps));
        q.epochFlowFloorUsdc = uint128(_envU("EPOCH_FLOW_FLOOR_USDC", q.epochFlowFloorUsdc));
        q.maxSharePriceMoveBps = uint16(_envU("MAX_SHARE_PRICE_MOVE_BPS", q.maxSharePriceMoveBps));
        q.maxRoll = uint16(_envU("MAX_ROLL", q.maxRoll));
        q.minRequestUsdc = uint128(_envU("MIN_REQUEST_USDC", q.minRequestUsdc));
        q.slices = uint8(_envU("SLICES", q.slices));
        q.quorum = uint8(_envU("QUORUM", q.quorum));
        q.dispersionBps = uint16(_envU("DISPERSION_BPS", q.dispersionBps));
        q.refBandBps = uint16(_envU("REF_BAND_BPS", q.refBandBps));
        q.legBandBps = uint16(_envU("LEG_BAND_BPS", q.legBandBps));
        q.maxLendRateGrowthBps = uint16(_envU("MAX_LEND_RATE_GROWTH_BPS", q.maxLendRateGrowthBps));
        changed = keccak256(abi.encode(p)) != keccak256(abi.encode(q));
        if (changed) timelockExecute(address(queue), abi.encodeCall(queue.setFlowParams, (q)));
    }

    function _envU(string memory field, uint256 cur) internal view returns (uint256) {
        return vm.envOr(string.concat("PROTO_SIM_FLOW_", field), cur);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Setup helpers (no market yet: the pools stand still, the feeds sit on the reference)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Spread idle USDC over `v` with a 1-day plan through the timelock, stepping as the keeper every
    ///         interval with fresh feeds (the harness's `investFund` without the stale-feed warps).
    function _investQuiet(uint16[5] memory v) internal {
        setTargetViaTimelock(v, PlanParams(1 days, COST_BUDGET_BPS));
        uint256 interval = rebalancer.effectiveStepInterval();
        for (uint256 i; i < 120 && fund.planStatus() == PlanStatus.Open; ++i) {
            // `verify` 2026-11-12: refill the meter each step. The timed sim runs its genesis in a self-call
            // (`simGenesis`), and on the recorder's fork a call out of the test contract gets at most the pin block's
            // gas limit (40M, scaffold verify-T1); a whole 1-day plan does not fit. Metering only: in replay the
            // frame has far more gas than any step needs either way, so no state or result changes.
            vm.resetGasMetering();
            vm.warp(vm.getBlockTimestamp() + interval);
            vm.roll(vm.getBlockNumber() + interval / 2);
            _stampQuiet();
            keeperStep();
            coverageCheckpoint();
        }
        require(
            fund.planStatus() != PlanStatus.Open, "sim genesis: the investing plan did not conclude"
        );
    }

    /// @notice Deposit `total` USDC through the queue for `holders`, one request of at most `chunk` per cap period
    ///         (each request fills whole in its own period, so none waits past `maxRoll`), then deliver every share
    ///         after the hold. The keeper settles each at its window end with fresh feeds.
    function _depositQuiet(address[] memory holders, uint256 total, uint256 chunk) internal {
        uint256 left = total;
        for (uint256 k; left != 0; ++k) {
            vm.resetGasMetering(); // one settled chunk per refill (see `_investQuiet`)
            uint256 amt = left < chunk ? left : chunk;
            left -= amt;
            address h = holders[k % holders.length];
            uint256 id = openDepositRequest(h, amt, type(uint256).max);
            uint256 at = queue.settleableAt(queue.getRequest(id).epoch);
            vm.roll(vm.getBlockNumber() + (at - vm.getBlockTimestamp()) / 2);
            vm.warp(at);
            _stampQuiet();
            vm.prank(keeper);
            queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
            require(
                queue.getRequest(id).closed,
                "sim genesis: a deposit chunk did not fill in its period"
            );
            coverageCheckpoint();
        }
        for (uint256 i; i < holders.length; ++i) {
            vm.resetGasMetering();
            deliverAfterHold(holders[i]);
            coverageCheckpoint();
        }
    }

    /// @notice Stamp every feed now at its current answer (no market runs yet, so the reference stands still).
    function _stampQuiet() internal {
        uint256 now_ = vm.getBlockTimestamp();
        for (uint256 b; b < MK_N; ++b) {
            _pushFeed(b, feedPx8[b], now_);
        }
        MockAggregator(FEED_USDC).setRound(8, 1e8, now_, now_);
        usdcFeedAt = now_;
        MockAggregator(FEED_SEQUENCER).setRound(0, 0, sequencerUpSince, now_);
    }
}
