// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.10 (the same layers on the rebalance, step 3e), §5.9.3
//            checks 2 and 4, §5.9.5 (refBandBps, sequencerGrace, usdcPegBandBps, maxFeedAge), §7 RB-5 and RB-19;
//            step-3 finish plan §3.5
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IBasketSwapAdapter} from "../../../../interfaces/IBasketSwapAdapter.sol";
import {
    AssetConfig,
    AssetKind,
    FeedStatus,
    StepFeedCheck,
    StepPrices,
    BPS,
    IDLE_INDEX
} from "../FundTypes.sol";
import {FlowParams} from "../FlowTypes.sol";
import {IFlowQueue} from "../interfaces/IFlowQueue.sol";
import {FeedLib} from "./FeedLib.sol";

/// @title StepFeedLib
/// @notice The feed checks of one rebalance step (step 3e, proposal §5.10): checks 2 and 4 of §5.9.3, run on every
///         step. The fund runs it inside `executeStep` (so no caller can skip it, RB-19) and the Rebalancer runs the
///         same code first, so a step that would fail is skipped with a reason (`SkipReason.FeedCheck`) instead of
///         being tried. `check` is `public`: one linked copy serves both callers (it keeps the Rebalancer and
///         `FundStepLib` small, §6.1), and both read the same state in the same transaction, so they agree.
///
///         The parameters are the settlement's own (proposal §5.10 "the same layers"): the sequencer feed, the USDC
///         feed and their ages from the bound FlowQueue's `feeds()`; `sequencerGrace`, `usdcPegBandBps` and
///         `refBandBps` from its `flowParams()`; each basket feed and its `maxFeedAge` from the fund's asset config.
///
///         Check 4 compares each basket asset's feed with the TWAP the step itself uses: the asset's `twapWindow`
///         TWAP through its swap adapter, the one the fund values NAV with and the Rebalancer sizes and floors with.
///         (The settlement compares the slice-median TWAP of check 3; §5.10 asks a step for checks 2 and 4 only.)
library StepFeedLib {
    using Math for uint256;

    /// @notice Run checks 2 and 4 for a step now. Order as the settlement's `market`: the sequencer, every active
    ///         basket feed, the USDC peg, then each active basket TWAP against its feed. Never reverts: a reverting or
    ///         missing feed, a reverting TWAP read and a missing queue are each a failed check (fail closed).
    /// @param cfg   The fund's asset list (`assetConfigs()`).
    /// @param usdc  The fund's USDC.
    /// @param queue The fund's bound FlowQueue (`flowQueue()`), or address(0).
    /// @return c      `Ok`, or the first check that failed.
    /// @return index  The asset that failed (IDLE_INDEX when the failure is not an asset's).
    /// @return detail The feed status, the USDC price, or the deviation in bps (see `StepFeedCheck`).
    /// @return px     Per asset index: the feed and TWAP prices and the token unit (complete only when `Ok`).
    function check(AssetConfig[] memory cfg, address usdc, address queue)
        public
        view
        returns (StepFeedCheck c, uint256 index, uint256 detail, StepPrices memory px)
    {
        uint256 n = cfg.length;
        px.feed = new uint256[](n);
        px.twap = new uint256[](n);
        px.unit = new uint256[](n);
        if (queue == address(0)) return (StepFeedCheck.NoQueue, IDLE_INDEX, 0, px);
        FlowParams memory p = IFlowQueue(queue).flowParams();
        uint256 usdc8;
        // ── Check 2: the sequencer, every active basket feed (8-decimal prices into `px.feed`), the USDC peg ──
        (c, index, detail, usdc8) = _check2(cfg, queue, p, px.feed);
        if (c != StepFeedCheck.Ok) return (c, index, detail, px);
        // ── Check 4: each active basket TWAP within refBandBps of its feed ──
        uint256 usdcUnit = 10 ** IERC20Metadata(usdc).decimals();
        for (uint256 i; i < n; ++i) {
            if (!_isBasket(cfg[i])) continue;
            (c, detail) = _check4(cfg[i], usdc, usdcUnit, usdc8, p.refBandBps, px, i);
            if (c != StepFeedCheck.Ok) return (c, i, detail, px);
        }
        return (StepFeedCheck.Ok, IDLE_INDEX, 0, px);
    }

    /// @dev Check 2. Writes each active basket feed's 8-decimal USD price into `px8` and returns the USDC / USD
    ///      price (8 decimals).
    function _check2(
        AssetConfig[] memory cfg,
        address queue,
        FlowParams memory p,
        uint256[] memory px8
    ) private view returns (StepFeedCheck, uint256, uint256, uint256 usdc8) {
        (address usdcFeed, uint32 usdcMaxAge, address seqFeed) = IFlowQueue(queue).feeds();
        {
            (bool up, FeedStatus st) = FeedLib.sequencerUp(seqFeed, p.sequencerGrace);
            if (!up) return (StepFeedCheck.Sequencer, IDLE_INDEX, uint256(st), 0);
        }
        for (uint256 i; i < cfg.length; ++i) {
            if (!_isBasket(cfg[i])) continue;
            (FeedStatus st, uint256 v) = FeedLib.read(cfg[i].feed, cfg[i].maxFeedAge);
            if (st != FeedStatus.Ok) return (StepFeedCheck.Feed, i, uint256(st), 0);
            px8[i] = v;
        }
        (bool pegOk, FeedStatus pst, uint256 u8) =
            FeedLib.usdcPeg(usdcFeed, usdcMaxAge, p.usdcPegBandBps);
        if (!pegOk) {
            return
                (StepFeedCheck.UsdcPeg, IDLE_INDEX, pst == FeedStatus.OffPeg ? u8 : uint256(pst), 0);
        }
        return (StepFeedCheck.Ok, IDLE_INDEX, 0, u8);
    }

    /// @dev Check 4 for basket asset `i` (`a`). On entry `px.feed[i]` holds its 8-decimal USD price; on success it
    ///      holds the feed price in USDC per whole token, and `px.twap[i]`, `px.unit[i]` are set.
    function _check4(
        AssetConfig memory a,
        address usdc,
        uint256 usdcUnit,
        uint256 usdc8,
        uint16 refBandBps,
        StepPrices memory px,
        uint256 i
    ) private view returns (StepFeedCheck, uint256) {
        uint256 unit = 10 ** IERC20Metadata(a.token).decimals();
        uint256 feedPx = px.feed[i].mulDiv(usdcUnit, usdc8);
        px.feed[i] = 0;
        if (feedPx == 0) return (StepFeedCheck.Feed, uint256(FeedStatus.NonPositive));
        (bool ok, uint256 twapPx) = _twap(a, usdc, unit);
        if (!ok || twapPx == 0) return (StepFeedCheck.TwapRead, 0);
        uint256 dev = (twapPx > feedPx ? twapPx - feedPx : feedPx - twapPx)
        .mulDiv(BPS, feedPx, Math.Rounding.Ceil);
        if (dev > refBandBps) return (StepFeedCheck.TwapVsFeed, dev);
        px.feed[i] = feedPx;
        px.twap[i] = twapPx;
        px.unit[i] = unit;
        return (StepFeedCheck.Ok, 0);
    }

    /// @notice USDC value of `amount` of asset `i` at the feed (`px.feed`, rounded DOWN). A lending asset and idle
    ///         USDC count one to one (`IDLE_INDEX` is idle).
    function feedValue(StepPrices memory px, uint256 i, uint256 amount)
        internal
        pure
        returns (uint256)
    {
        if (i == IDLE_INDEX || px.unit[i] == 0) return amount;
        return amount.mulDiv(px.feed[i], px.unit[i]);
    }

    function _isBasket(AssetConfig memory a) private pure returns (bool) {
        return a.active && a.kind == AssetKind.Basket;
    }

    /// @dev The asset's TWAP over its `twapWindow`: USDC for one whole token through its swap adapter. `ok` false when
    ///      the read reverts.
    function _twap(AssetConfig memory a, address usdc, uint256 unit)
        private
        view
        returns (bool ok, uint256 v)
    {
        try IBasketSwapAdapter(a.adapter)
            .twapPrice(a.pool, a.token, usdc, unit, a.twapWindow) returns (
            uint256 q
        ) {
            return (true, q);
        } catch {
            return (false, 0);
        }
    }
}
