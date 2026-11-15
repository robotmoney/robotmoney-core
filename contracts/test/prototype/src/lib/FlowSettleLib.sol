// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.3, §5.11.4, §5.10 (StepInWindow, E24, E27, E28,
//            E33, E34, E35, E36, E41, E42, E53);
//            docs/technical/one-vault-timed-flows-eng-plan.md E24-E42
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    AssetConfig,
    AssetKind,
    BPS,
    IDLE_INDEX,
    LENDING_ROUNDING_UNITS,
    PRICE_SCALE
} from "../FundTypes.sol";
import {
    AssetPrice,
    Claim,
    Fill,
    FlowParams,
    IFlowEvents,
    Request,
    RequestKind,
    Settlement,
    SettleCheck,
    SettleContext,
    MAX_ROLL,
    PRICE_KIND_BASKET,
    PRICE_KIND_LENDING
} from "../FlowTypes.sol";
import {IRebalancer} from "../interfaces/IRebalancer.sol";
import {IRobotMoneyFundFull} from "../interfaces/IRobotMoneyFund.sol";
import {FlowEpochs, FlowState, RoundState, WalkCursor} from "./FlowStorage.sol";
import {FlowCheckLib, IExclusionLedgerView} from "./FlowCheckLib.sol";
import {FlowMatchLib} from "./FlowMatchLib.sol";
import {FundValuationLib} from "./FundValuationLib.sol";

interface IFlowQueueSides {
    function settleRedeemSide(uint256 settlementId, Fill[] calldata fills, SettleContext calldata c)
        external;
    function settleDepositSide(
        uint256 settlementId,
        Fill[] calldata fills,
        SettleContext calldata c
    ) external;
}

/// @title FlowSettleLib
/// @notice Keeper-only round settlement (E34, E35): StepInWindow gate + notice cleanup + enrollment +
///         round-stop venue test + O(1) Whole Match `M` + FIFO net-side execution (`sellForFlowGross` / `mintInKind`).
library FlowSettleLib {
    using Math for uint256;
    using SafeERC20 for IERC20;

    uint256 internal constant MAX_LOOK_PER_CALL = 256;
    uint256 internal constant SIDE_GAS_BASE = 2_000_000;
    uint256 internal constant SIDE_GAS_PER_ASSET = 600_000;
    uint256 internal constant SIDE_GAS_PER_FILL = 450_000;
    uint256 internal constant SIDE_CALL_MARGIN = 10_000;
    uint256 internal constant MAX_REASON_BYTES = 1_024;
    uint256 private constant BOUND_SLACK_UNITS = 2;

    enum Outcome {
        Pass,
        Fill,
        Partial,
        Hold
    }

    struct Walk {
        uint64 cur;
        uint256 period;
        uint256 budget;
        uint256 minRequestUsdc;
        uint256 depRoom;
        uint256 redRoom;
        uint256 depTotal;
        uint256 redValue;
        uint256 nDep;
        uint256 nRed;
        Fill[] dep;
        Fill[] red;
        SidePos depPos;
        SidePos redPos;
        uint256 settlementId;
        bool callRoomLow;
    }

    struct SidePos {
        bool walked;
        bool ended;
        bool hasStop;
        uint64 stopE;
        uint256 stopI;
        bool hasHold;
        uint64 holdE;
        uint256 holdI;
        uint64 endE;
        uint256 endI;
    }

    /// @notice Run one keeper settlement call inside round `c.roundEpoch`.
    function settle(FlowState storage s, uint256 maxRequests, uint256 maxUsdc, bool isKeeper)
        public
        returns (uint256 settlementId)
    {
        (SettleCheck check, uint256 index, uint256 detail, SettleContext memory c) =
            FlowCheckLib.preTrade(s, msg.sender, isKeeper);
        if (check != SettleCheck.Ok) revert IFlowEvents.SettleBlocked(check, index, detail);
        if (maxRequests == 0) return 0;

        uint64 cur = FlowEpochs.current(s);
        uint256 matchSettlementId = _prepareRoundIfNeeded(s, c, cur);

        Walk memory w;
        w.cur = cur;
        w.settlementId = matchSettlementId != 0 ? matchSettlementId : s.settlementCount + 1;
        w.budget = maxRequests < MAX_LOOK_PER_CALL ? maxRequests : MAX_LOOK_PER_CALL;
        w.dep = new Fill[](w.budget);
        w.red = new Fill[](w.budget);
        _rooms(s, c, w, maxUsdc);

        if (c.navFeed != 0 && w.redRoom != 0 && s.redPoolShares != 0) {
            w.redPos = _walkSide(s, c, w, RequestKind.Redeem);
        }
        if (c.depositsOpen && w.depRoom != 0 && s.depPoolUsdc != 0) {
            w.depPos = _walkSide(s, c, w, RequestKind.Deposit);
        }

        bool redOk = w.nRed != 0 && _runSide(c, w, RequestKind.Redeem);
        bool depOk = w.nDep != 0 && _runSide(c, w, RequestKind.Deposit);
        _moveCursor(s, RequestKind.Redeem, w.redPos, w.nRed == 0 || redOk);
        _moveCursor(s, RequestKind.Deposit, w.depPos, w.nDep == 0 || depOk);
        _rememberOldest(s, c.lastEpoch);
        settlementId = _finishSettle(s, c, w, matchSettlementId, redOk, depOk);
    }

    function _finishSettle(
        FlowState storage s,
        SettleContext memory c,
        Walk memory w,
        uint256 matchSettlementId,
        bool redOk,
        bool depOk
    ) private returns (uint256 settlementId) {
        (bool moreRed, bool moreDep) = FlowMatchLib.hasUnfilledInPool(s, c.depositsOpen, w.cur);
        if (!moreRed && !moreDep) {
            s.rounds[c.roundEpoch].done = true;
            FlowMatchLib.finalizeEndedNotices(s);
        }

        if (w.callRoomLow && w.nRed == 0 && w.nDep == 0 && matchSettlementId == 0) {
            emit IFlowEvents.SettleCallRoomBelowMinimum(w.depRoom, w.redRoom);
        }
        if (!redOk && !depOk && matchSettlementId == 0) return 0;

        settlementId = w.settlementId;
        if (s.settlementCount < settlementId) s.settlementCount = settlementId;
        Settlement storage st = s.settlements[settlementId];
        st.time = uint64(block.timestamp);
        st.settler = msg.sender;
        if (st.holdEndsAt == 0 && (st.matchedShares != 0 || st.sharesMinted != 0)) {
            st.holdEndsAt = uint64(block.timestamp) + s.params.minHold;
        }
        s.lastSettleAt = uint64(block.timestamp);
        s.lastSettleEpoch = w.cur;
        s.lastSharePrice = c.sharePrice;
        _recordReferences(s, c);

        if (s.levers.basketCallBps != 0 && (depOk || redOk)) {
            if (s.leverTradeBlock != block.number) {
                s.leverTradeBlock = uint64(block.number);
                s.leverBlockDep = 0;
                s.leverBlockRed = 0;
            }
            if (depOk) s.leverBlockDep += uint128(w.depTotal);
            if (redOk) s.leverBlockRed += uint128(w.redValue);
        }

        emit IFlowEvents.Settled(
            settlementId,
            msg.sender,
            st.matchSharePrice != 0 ? st.matchSharePrice : c.matchSharePrice,
            st.matchedShares,
            st.matchedUsdc,
            st.usdcIn,
            st.sharesMinted,
            st.sharesBurned,
            st.usdcOut
        );
    }

    /// @dev On the first `settle` call of `c.roundEpoch`: enforce `StepInWindow` (E42), clean up ended
    ///      redemption notices, evict expired deposits, enroll locked requests, test lending venues (E36),
    ///      and book the whole match `M` O(1) (E24, E35).
    function _prepareRoundIfNeeded(FlowState storage s, SettleContext memory c, uint64 cur)
        private
        returns (uint256 matchSettlementId)
    {
        RoundState storage rs = s.rounds[c.roundEpoch];
        if (rs.opened) {
            c.depositsOpen = rs.depositsOpen;
            return 0;
        }

        address reb = IRobotMoneyFundFull(s.fund).rebalancer();
        if (reb != address(0)) {
            uint64 lastBasket = IRebalancer(reb).lastBasketStepAt();
            if (lastBasket != 0 && block.timestamp - lastBasket < s.params.settleWindow) {
                revert IFlowEvents.StepInWindow(lastBasket, s.params.settleWindow);
            }
        }

        FlowMatchLib.finalizeEndedNotices(s);
        FlowMatchLib.evictExpiredDepBuckets(s, cur);
        FlowMatchLib.enrollEpochs(s, c.roundEpoch, cur);

        rs.opened = true;
        if (!c.depositsOpen) {
            rs.depositsOpen = false;
            emit IFlowEvents.DepositStoppedForRound(c.roundEpoch, 1);
        } else if (!c.lendRateOk) {
            rs.depositsOpen = false;
            s.lastDepositStopEpoch = c.roundEpoch;
            s.openStopCancelUntilEpoch = cur;
            emit IFlowEvents.DepositStoppedForRound(c.roundEpoch, 2);
        } else {
            (bool liqOk,) = FlowCheckLib.checkVenuesLiquidity(s, c, s.redPoolShares);
            if (!liqOk) {
                rs.depositsOpen = false;
                s.lastDepositStopEpoch = c.roundEpoch;
                s.openStopCancelUntilEpoch = cur;
                emit IFlowEvents.DepositStoppedForRound(c.roundEpoch, 3);
            } else {
                rs.depositsOpen = true;
            }
        }
        c.depositsOpen = rs.depositsOpen;

        if (rs.depositsOpen) {
            (,,, address feeRecipient) = IRobotMoneyFundFull(s.fund).config();
            matchSettlementId = FlowMatchLib.bookMatch(s, c, c.roundEpoch, feeRecipient);
        }
    }

    function _rooms(FlowState storage s, SettleContext memory c, Walk memory w, uint256 maxUsdc)
        private
        view
    {
        FlowParams memory p = s.params;
        w.period = w.cur;
        w.minRequestUsdc = p.minRequestUsdc;
        uint256 cap = c.navFeed.mulDiv(p.maxEpochFlowBps, BPS);
        if (cap < p.epochFlowFloorUsdc) cap = p.epochFlowFloorUsdc;
        uint256 du = s.depositUsed[w.period];
        uint256 ru = s.redeemUsed[w.period];
        w.depRoom = cap > du ? cap - du : 0;
        w.redRoom = cap > ru ? cap - ru : 0;
        uint256 tvlRoom = c.tvlCap > c.navFeed ? c.tvlCap - c.navFeed : 0;
        if (tvlRoom < w.depRoom) w.depRoom = tvlRoom;
        if (maxUsdc < w.depRoom) w.depRoom = maxUsdc;
        if (maxUsdc < w.redRoom) w.redRoom = maxUsdc;
        uint16 callBps = s.levers.basketCallBps;
        if (callBps != 0) _basketCallRoom(s, c, w, callBps, p.settleWindow);
    }

    function _basketCallRoom(
        FlowState storage s,
        SettleContext memory c,
        Walk memory w,
        uint256 callBps,
        uint32 window
    ) private view {
        uint256 depCap = type(uint256).max;
        uint256 redCap = type(uint256).max;
        AssetConfig[] memory cfg = IRobotMoneyFundFull(s.fund).assetConfigs();
        for (uint256 i; i < c.prices.length; ++i) {
            AssetPrice memory ap = c.prices[i];
            if (ap.kind != PRICE_KIND_BASKET || ap.inSale || c.held[i] == 0) continue;
            uint256 value = c.held[i].mulDiv(ap.feedPerToken, ap.unit, Math.Rounding.Ceil);
            (bool ok, uint256 depth) = FundValuationLib.poolUsdcDepth(cfg[i].pool, s.usdc, window);
            uint256 room =
                ok && value != 0 ? depth.mulDiv(callBps, BPS).mulDiv(c.navFeed, value) : 0;
            if (room < depCap) depCap = room;
            if (room < redCap) redCap = room;
        }
        if (depCap < w.minRequestUsdc || redCap < w.minRequestUsdc) w.callRoomLow = true;
        if (s.leverTradeBlock == block.number) {
            uint256 du = s.leverBlockDep;
            uint256 ru = s.leverBlockRed;
            depCap = depCap > du ? depCap - du : 0;
            redCap = redCap > ru ? redCap - ru : 0;
        }
        if (depCap < w.depRoom) w.depRoom = depCap;
        if (redCap < w.redRoom) w.redRoom = redCap;
    }

    function _walkStart(FlowState storage s, uint64 lastEpoch, uint8 k)
        private
        view
        returns (uint256 idx, uint256 i)
    {
        WalkCursor memory at = s.cursors[0][k];
        idx = s.oldestEpoch;
        if (at.epoch == 0 || at.epoch > lastEpoch) return (idx, 0);
        uint256 len = s.activeEpochs.length;
        while (idx < len && s.activeEpochs[idx] < at.epoch) ++idx;
        if (idx >= len || s.activeEpochs[idx] != at.epoch) return (s.oldestEpoch, 0);
        return (idx, at.index);
    }

    function _walkSide(FlowState storage s, SettleContext memory c, Walk memory w, RequestKind kind)
        private
        returns (SidePos memory pos)
    {
        uint8 k = uint8(kind);
        (uint256 idx, uint256 i) = _walkStart(s, c.lastEpoch, k);
        pos.walked = true;
        uint64 e;
        while (true) {
            if (idx >= s.activeEpochs.length || (e = s.activeEpochs[idx]) > c.lastEpoch) {
                pos.ended = true;
                break;
            }
            if (i >= s.sideIds[k][e].length || s.sideOpen[k][e] == 0) {
                ++idx;
                i = 0;
                continue;
            }
            if (w.budget == 0 || _roomLeft(w, kind) == 0) break;
            --w.budget;
            Outcome o = _consider(s, c, w, kind, s.sideIds[k][e][i]);
            if (o != Outcome.Pass) {
                if (!pos.hasStop) {
                    pos.hasStop = true;
                    pos.stopE = e;
                    pos.stopI = i;
                }
                if (o != Outcome.Fill && !pos.hasHold) {
                    pos.hasHold = true;
                    pos.holdE = e;
                    pos.holdI = i;
                }
            }
            ++i;
        }
        pos.endE = e;
        pos.endI = i;
    }

    function _roomLeft(Walk memory w, RequestKind kind) private pure returns (uint256) {
        return kind == RequestKind.Deposit ? w.depRoom - w.depTotal : w.redRoom - w.redValue;
    }

    function _moveCursor(
        FlowState storage s,
        RequestKind kind,
        SidePos memory pos,
        bool sideOk
    ) private {
        if (!pos.walked) return;
        WalkCursor storage at = s.cursors[0][uint8(kind)];
        if (pos.ended) {
            at.epoch = 0;
            at.index = 0;
        } else if (!sideOk && pos.hasStop) {
            at.epoch = pos.stopE;
            at.index = uint192(pos.stopI);
        } else if (pos.hasHold) {
            at.epoch = pos.holdE;
            at.index = uint192(pos.holdI);
        } else {
            at.epoch = pos.endE;
            at.index = uint192(pos.endI);
        }
    }

    function _rememberOldest(FlowState storage s, uint64 lastEpoch) private {
        uint256 len = s.activeEpochs.length;
        uint256 idx = s.oldestEpoch;
        while (idx < len) {
            uint64 e = s.activeEpochs[idx];
            if (e > lastEpoch || s.epochOpen[e] != 0) break;
            ++idx;
        }
        if (s.oldestEpoch != idx) s.oldestEpoch = uint64(idx);
    }

    function _consider(
        FlowState storage s,
        SettleContext memory c,
        Walk memory w,
        RequestKind kind,
        uint256 id
    ) private view returns (Outcome) {
        Request storage r = s.requests[id];
        if (r.closed || !r.enrolled || r.era < s.windDownEra) return Outcome.Pass;
        if (kind == RequestKind.Deposit && w.cur > r.expiryEpoch) return Outcome.Pass;
        uint256 rem = FlowMatchLib.currentRequestRemaining(s, id);
        if (rem == 0) return Outcome.Pass;
        if (kind == RequestKind.Deposit) return _considerDeposit(w, id, rem);
        return _considerRedeem(c, w, id, rem);
    }

    function _considerDeposit(Walk memory w, uint256 id, uint256 remaining)
        private
        pure
        returns (Outcome)
    {
        if (remaining < w.minRequestUsdc) return Outcome.Pass;
        uint256 amt = _partial(remaining, w.depRoom - w.depTotal, w.minRequestUsdc);
        if (amt == 0) return Outcome.Hold;
        w.dep[w.nDep++] = Fill({requestId: id, amount: amt, capValue: amt});
        w.depTotal += amt;
        return amt < remaining ? Outcome.Partial : Outcome.Fill;
    }

    function _considerRedeem(SettleContext memory c, Walk memory w, uint256 id, uint256 remaining)
        private
        pure
        returns (Outcome)
    {
        uint256 room = w.redRoom - w.redValue;
        uint256 amt = _partial(
            remaining,
            room.mulDiv(c.supply, c.navFeed),
            w.minRequestUsdc.mulDiv(c.supply, c.navFeed, Math.Rounding.Ceil)
        );
        if (amt == 0) return Outcome.Hold;
        uint256 value = amt.mulDiv(c.navFeed, c.supply, Math.Rounding.Ceil);
        if (value > room) return Outcome.Hold;
        w.red[w.nRed++] = Fill({requestId: id, amount: amt, capValue: value});
        w.redValue += value;
        return amt < remaining ? Outcome.Partial : Outcome.Fill;
    }

    function _partial(uint256 remaining, uint256 room, uint256 minFill)
        private
        pure
        returns (uint256)
    {
        if (remaining <= room) return remaining;
        if (remaining < 2 * minFill) return 0;
        uint256 amt = room < remaining - minFill ? room : remaining - minFill;
        return amt >= minFill ? amt : 0;
    }

    function sideGas(uint256 assets, uint256 fills) internal pure returns (uint256) {
        return SIDE_GAS_BASE + assets * SIDE_GAS_PER_ASSET + fills * SIDE_GAS_PER_FILL;
    }

    function _runSide(SettleContext memory c, Walk memory w, RequestKind kind)
        private
        returns (bool ok)
    {
        bool red = kind == RequestKind.Redeem;
        Fill[] memory fills = red ? w.red : w.dep;
        uint256 n = red ? w.nRed : w.nDep;
        _shrink(fills, n);
        bytes memory data = red
            ? abi.encodeCall(IFlowQueueSides.settleRedeemSide, (w.settlementId, fills, c))
            : abi.encodeCall(IFlowQueueSides.settleDepositSide, (w.settlementId, fills, c));
        uint256 budget = sideGas(c.prices.length, n);
        if (gasleft() < budget + budget / 63 + SIDE_CALL_MARGIN) {
            revert IFlowEvents.SettleSideOutOfGas(kind);
        }
        bytes memory reason;
        assembly ("memory-safe") {
            ok := call(budget, address(), 0, add(data, 32), mload(data), 0, 0)
            let size := returndatasize()
            if gt(size, MAX_REASON_BYTES) { size := MAX_REASON_BYTES }
            reason := mload(0x40)
            mstore(reason, size)
            returndatacopy(add(reason, 32), 0, size)
            mstore(0x40, add(add(reason, 32), and(add(size, 31), not(31))))
        }
        if (!ok) emit IFlowEvents.SideFailed(w.settlementId, kind, reason);
    }

    function _recordReferences(FlowState storage s, SettleContext memory c) private {
        s.lastExcludedMask = c.excludedMask;
        s.lastSaleMask = c.saleMask;
        s.lastExclusionCount =
            IExclusionLedgerView(IRobotMoneyFundFull(s.fund).exclusionLedger()).exclusionCount();
        AssetConfig[] memory cfg = IRobotMoneyFundFull(s.fund).assetConfigs();
        for (uint256 i; i < c.prices.length; ++i) {
            AssetPrice memory ap = c.prices[i];
            if (ap.kind == PRICE_KIND_LENDING) {
                uint256 lps = c.held[i].mulDiv(PRICE_SCALE, c.supply);
                s.lastLendPerShare[i] = lps;
                s.lastAssetPerShare[i] = lps;
                if (c.excludedMask & (1 << i) != 0) continue;
                bool ok;
                uint256 rate;
                if (i < cfg.length) (ok, rate) = FlowCheckLib.lendRate(cfg[i].adapter);
                s.lastLendRate[i] = ok ? rate : c.lendRates[i];
            } else if (ap.kind == PRICE_KIND_BASKET && ap.unit != 0) {
                s.lastAssetPerShare[i] = c.held[i].mulDiv(ap.feedPerToken, ap.unit)
                    .mulDiv(PRICE_SCALE, c.supply);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Parameters
    // ═════════════════════════════════════════════════════════════════════════

    function applyParams(FlowState storage s, FlowParams memory p) public {
        uint32 oldLen = s.params.epochLength;
        if (oldLen != 0 && oldLen != p.epochLength) _rebaseEpochs(s);
        s.params = p;
        s.oldestEpoch = 0;
        delete s.cursors;
    }

    function _rebaseEpochs(FlowState storage s) private {
        uint64 cur = FlowEpochs.current(s);
        uint256 len = s.activeEpochs.length;
        for (uint256 idx = s.oldestEpoch; idx < len; ++idx) {
            uint64 e = s.activeEpochs[idx];
            if (s.epochOpen[e] != 0 && s.epochEnd[e] == 0) {
                s.epochEnd[e] = uint64(FlowEpochs.endOf(s, e));
            }
        }
        uint256 endCur = FlowEpochs.endOf(s, cur);
        s.epochAnchorIndex = cur + 1;
        s.epochAnchorTime = uint64(endCur);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Step 8: Net Redemption Side (`sellForFlowGross`)
    // ═════════════════════════════════════════════════════════════════════════

    function redeemSide(
        FlowState storage s,
        uint256 settlementId,
        Fill[] memory fills,
        SettleContext memory c
    ) public {
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        uint256 nFills = fills.length;
        address[] memory owners = new address[](nFills);
        uint256[] memory ownerShares = new uint256[](nFills);
        uint16[] memory ownerFeeBps = new uint16[](nFills);
        uint256 x;
        for (uint256 k; k < nFills; ++k) {
            uint256 amt = fills[k].amount;
            Request storage r = s.requests[fills[k].requestId];
            owners[k] = r.owner;
            ownerShares[k] = amt;
            ownerFeeBps[k] = r.exitFeeBps;
            x += amt;
        }

        uint256[] memory minOut = new uint256[](c.prices.length);
        for (uint256 i; i < c.prices.length; ++i) {
            AssetPrice memory ap = c.prices[i];
            if (ap.kind == PRICE_KIND_BASKET && !ap.inSale) {
                minOut[i] = c.held[i].mulDiv(x, c.supply).mulDiv(ap.sellPerToken, ap.unit);
            }
        }

        uint256 grossOut;
        {
            uint256 usdcBefore = IERC20(s.usdc).balanceOf(address(this));
            uint256 sharesBefore = fund.balanceOf(address(this));
            grossOut = fund.sellForFlowBatch(x, minOut, owners, ownerShares, ownerFeeBps);
            _expect(IERC20(s.usdc).balanceOf(address(this)) - usdcBefore, grossOut);
            _expect(sharesBefore - fund.balanceOf(address(this)), x);
        }

        uint256 netOut = _recordRedeems(s, fund, settlementId, fills, x, grossOut);
        Settlement storage st = s.settlements[settlementId];
        st.sharesBurned = x;
        st.usdcOut = netOut;
    }

    function _recordRedeems(
        FlowState storage s,
        IRobotMoneyFundFull fund,
        uint256 settlementId,
        Fill[] memory fills,
        uint256 x,
        uint256 grossOut
    ) private returns (uint256 totalNet) {
        uint256 period = FlowEpochs.current(s);
        uint256 totalFee;
        for (uint256 k; k < fills.length; ++k) {
            (uint256 feeK, uint256 usdcK) =
                _recordRedeem(s, fund, settlementId, fills[k], x, grossOut, period);
            totalFee += feeK;
            totalNet += usdcK;
        }
        if (totalFee != 0) {
            (,,, address feeRecipient) = fund.config();
            IERC20(s.usdc).safeTransfer(feeRecipient, totalFee);
        }
        s.dustUsdc += grossOut - totalFee - totalNet;
    }

    function _recordRedeem(
        FlowState storage s,
        IRobotMoneyFundFull fund,
        uint256 settlementId,
        Fill memory f,
        uint256 x,
        uint256 grossOut,
        uint256 period
    ) private returns (uint256 feeK, uint256 usdcK) {
        Request storage r = s.requests[f.requestId];
        address owner = r.owner;
        fund.ledgerCheckpoint(owner);
        FlowMatchLib.syncOwnerRedeems(s, owner);
        FlowMatchLib.consumeRedeem(s, f.requestId, f.amount, true);

        uint256 grossK = grossOut.mulDiv(f.amount, x);
        feeK = grossK.mulDiv(r.exitFeeBps, BPS);
        usdcK = grossK - feeK;

        Claim memory cl =
            _claim(f.requestId, owner, RequestKind.Redeem, settlementId, uint64(block.timestamp));
        cl.shares = f.amount;
        cl.usdc = usdcK;
        uint256 claimId = _newClaim(s, cl);
        s.totalOwedUsdc += usdcK;
        s.redeemUsed[period] += f.capValue;
        emit IFlowEvents.RedeemFilled(f.requestId, claimId, settlementId, f.amount, usdcK);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Step 9: Net Deposit Side (`mintInKind`)
    // ═════════════════════════════════════════════════════════════════════════

    function depositSide(
        FlowState storage s,
        uint256 settlementId,
        Fill[] memory fills,
        SettleContext memory c
    ) public {
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        uint256 u;
        for (uint256 k; k < fills.length; ++k) {
            u += fills[k].amount;
        }
        uint256 sharesOut;
        uint256[] memory maxIn;
        {
            (uint256 idle, uint256[] memory held) = fund.heldBalances();
            uint256 supply = fund.totalSupply();
            uint256 vDep = idle;
            uint256 fDep = 1 + BOUND_SLACK_UNITS;
            for (uint256 i; i < c.prices.length; ++i) {
                AssetPrice memory ap = c.prices[i];
                if (ap.kind == PRICE_KIND_LENDING) {
                    vDep += held[i];
                    fDep += LENDING_ROUNDING_UNITS + 1;
                } else if (ap.kind == PRICE_KIND_BASKET) {
                    vDep += held[i].mulDiv(ap.buyPerToken, ap.unit, Math.Rounding.Ceil);
                    fDep += ap.buyPerToken.ceilDiv(ap.unit) + 1;
                }
            }
            if (u <= fDep || vDep == 0) {
                revert IFlowEvents.SettleBlocked(SettleCheck.DepositLeg, IDLE_INDEX, u);
            }
            sharesOut = (u - fDep).mulDiv(supply, vDep);
            if (sharesOut == 0) {
                revert IFlowEvents.SettleBlocked(SettleCheck.DepositLeg, IDLE_INDEX, u);
            }
            maxIn = new uint256[](c.prices.length);
            uint256 worst = idle.mulDiv(sharesOut, supply, Math.Rounding.Ceil);
            for (uint256 i; i < c.prices.length; ++i) {
                AssetPrice memory ap = c.prices[i];
                if (ap.kind == PRICE_KIND_LENDING) {
                    worst += held[i].mulDiv(sharesOut, supply, Math.Rounding.Ceil)
                    + LENDING_ROUNDING_UNITS;
                } else if (ap.kind == PRICE_KIND_BASKET) {
                    maxIn[i] = held[i]
                        .mulDiv(sharesOut, supply, Math.Rounding.Ceil)
                        .mulDiv(ap.buyPerToken, ap.unit, Math.Rounding.Ceil);
                    worst += maxIn[i];
                }
            }
            if (worst > u) {
                revert IFlowEvents.SettleBlocked(SettleCheck.DepositLeg, IDLE_INDEX, worst);
            }
        }

        uint256 spent;
        {
            uint256 usdcBefore = IERC20(s.usdc).balanceOf(address(this));
            uint256 sharesBefore = fund.balanceOf(address(this));
            IERC20(s.usdc).forceApprove(address(fund), u);
            spent = fund.mintInKind(sharesOut, u, maxIn);
            IERC20(s.usdc).forceApprove(address(fund), 0);
            _expect(usdcBefore - IERC20(s.usdc).balanceOf(address(this)), spent);
            _expect(fund.balanceOf(address(this)) - sharesBefore, sharesOut);
        }
        // Check 11 (`E33`): realized spend must stay within worst-case per-swap cost `u`.
        if (spent > u) {
            revert IFlowEvents.SettleBlocked(SettleCheck.RealizedPrice, IDLE_INDEX, spent);
        }
        uint64 maxHoldEnd = _recordDeposits(s, fund, settlementId, fills, u, spent, sharesOut);
        Settlement storage st = s.settlements[settlementId];
        st.usdcIn = spent;
        st.sharesMinted = sharesOut;
        if (maxHoldEnd > st.holdEndsAt) st.holdEndsAt = maxHoldEnd;
    }

    struct DepositBatch {
        uint256 settlementId;
        uint256 u;
        uint256 unused;
        uint256 sharesOut;
        uint256 period;
    }

    function _recordDeposits(
        FlowState storage s,
        IRobotMoneyFundFull fund,
        uint256 settlementId,
        Fill[] memory fills,
        uint256 u,
        uint256 spent,
        uint256 sharesOut
    ) private returns (uint64 maxHoldEnd) {
        DepositBatch memory b = DepositBatch({
            settlementId: settlementId,
            u: u,
            unused: u - spent,
            sharesOut: sharesOut,
            period: FlowEpochs.current(s)
        });
        uint256 sharesGiven;
        uint256 refunded;
        for (uint256 k; k < fills.length; ++k) {
            (uint256 sharesK, uint256 refundK, uint64 unlockK) =
                _recordDeposit(s, fund, b, fills[k]);
            sharesGiven += sharesK;
            refunded += refundK;
            if (unlockK > maxHoldEnd) maxHoldEnd = unlockK;
        }
        s.dustShares += sharesOut - sharesGiven;
        s.dustUsdc += b.unused - refunded;
    }

    function _recordDeposit(
        FlowState storage s,
        IRobotMoneyFundFull fund,
        DepositBatch memory b,
        Fill memory f
    ) private returns (uint256 sharesK, uint256 refundK, uint64 unlockAt) {
        Request storage r = s.requests[f.requestId];
        address owner = r.owner;
        // Checkpoint ledger & materialize any prior match BEFORE consuming net USDC (RB-22).
        fund.ledgerCheckpoint(owner);
        FlowMatchLib.syncOwnerDeposits(s, owner);
        FlowMatchLib.consumeDeposit(s, f.requestId, f.amount, true);

        sharesK = b.sharesOut.mulDiv(f.amount, b.u);
        refundK = b.unused.mulDiv(f.amount, b.u);
        uint256 costK = f.amount - refundK;
        unlockAt = uint64(block.timestamp) + r.minHold;

        s.ownerHeldShares[owner] += sharesK;
        s.totalHeldShares += sharesK;
        if (refundK != 0) {
            s.usdcCredit[owner] += refundK;
            s.totalCreditUsdc += refundK;
            emit IFlowEvents.CreditAdded(owner, refundK, 0);
        }
        Claim memory cl = _claim(f.requestId, owner, RequestKind.Deposit, b.settlementId, unlockAt);
        cl.shares = sharesK;
        cl.usdc = costK;
        uint256 claimId = _newClaim(s, cl);
        s.depositUsed[b.period] += costK;
        emit IFlowEvents.DepositFilled(
            f.requestId, claimId, b.settlementId, costK, sharesK, unlockAt
        );
    }

    function _newClaim(FlowState storage s, Claim memory c) private returns (uint256 claimId) {
        claimId = ++s.claimCount;
        s.claims[claimId] = c;
        s.claimsOf[c.owner].push(claimId);
        s.requestClaims[c.requestId].push(claimId);
    }

    function _claim(
        uint256 requestId,
        address owner,
        RequestKind kind,
        uint256 settlementId,
        uint64 unlockAt
    ) private pure returns (Claim memory c) {
        c.requestId = requestId;
        c.owner = owner;
        c.kind = kind;
        c.settlementId = uint64(settlementId);
        c.unlockAt = unlockAt;
    }

    function _shrink(Fill[] memory a, uint256 n) private pure {
        assembly {
            mstore(a, n)
        }
    }

    function _expect(uint256 actual, uint256 expected) private pure {
        if (actual != expected) revert IFlowEvents.FundResultMismatch(expected, actual);
    }
}
