// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.2 steps 4, 5 and 7 (settle, eligibility, roll),
//            §5.9.3 (the twelve steps), RB-12 to RB-16, RB-20, RB-22; docs/technical/one-vault-timed-flows-eng-plan.md
//            E5, E7, E8, E10, E12, E13, E18, E20; coordinator rulings 1 to 4 (2026-11-11); step 3 finish plan §3.1
//            items 2 to 5 and 9 (the review of the step 3d scaffold, fixed by `fix-queue` 2026-11-12)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AssetConfig, AssetKind, BPS, IDLE_INDEX, LENDING_ROUNDING_UNITS, PRICE_SCALE} from "../FundTypes.sol";
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
    PRICE_KIND_BASKET,
    PRICE_KIND_LENDING,
    MAX_ROLL
} from "../FlowTypes.sol";
import {IRobotMoneyFundFull} from "../interfaces/IRobotMoneyFund.sol";
import {FlowEpochs, FlowState, WalkCursor} from "./FlowStorage.sol";
import {FlowCheckLib, IExclusionLedgerView} from "./FlowCheckLib.sol";
import {FundValuationLib} from "./FundValuationLib.sol";

/// @notice The queue's per-side self-call entry points (`FlowQueue.settleRedeemSide` / `settleDepositSide`). Each
///         side runs in its own call frame so that a failure anywhere in it, including checks 8 to 11 after the
///         fund traded, reverts that side completely and leaves the other side's result standing (coordinator
///         ruling 1, RB-15). Only the queue itself can call them (`OnlySelf`).
interface IFlowQueueSides {
    function settleRedeemSide(uint256 settlementId, Fill[] calldata fills, SettleContext calldata c) external;
    function settleDepositSide(uint256 settlementId, Fill[] calldata fills, SettleContext calldata c) external;
}

/// @title FlowSettleLib
/// @notice `settle` of the FlowQueue, linked (`public`) to keep the queue under G1.
///
///         Order (proposal §5.9.3): checks 1 to 7 (`FlowCheckLib.preTrade`, a failure reverts `SettleBlocked`);
///         the walk over pending requests, deciding each request's fill from its own limit against the chain's bound
///         price (E12, RB-14) and from the caps (E20); then the redemption side and the deposit side, each one call
///         into the fund through a queue self-call with its own fixed gas budget; then the cursors and the record.
///         A side that fails changes no state (RB-15) and its requests stay pending.
///
///         The walk (step 3 finish plan §3.1 item 2, RB-20, ruling 3). Each side walks its own requests, oldest first
///         (epoch, then position in it), from its cursor, at most `maxRequests` looks for the whole call (closed and
///         skipped requests count), redemptions first. The cursor moves past a request only when the request is
///         closed or expired, or the call had room for its side and the request's own limit refused it at its whole
///         remaining size (its most favourable size, so no caller input can make a limit refuse). A request the call
///         could not fill (no room left, or its limit admits the bound only at a larger fill than the room allows),
///         and every fill of a side that then failed, keep the cursor at or before them. A side the call cannot fill
///         at all (closed, unbounded, `maxUsdc` 0, a spent cap) is not walked: it moves no cursor and uses no budget.
///         A walk that reaches the end of the range ends the pass; the next call starts a new pass at the oldest
///         epoch. The keeper's calls keep their own cursor, which no other caller moves: a keeper pass starts at the
///         oldest epoch and continues only through the keeper's own calls (ruling 3: a flood of refused requests is
///         passed over by consecutive calls, not re-walked by each).
///
///         Rounding: the fund rounds purchases UP and the mint DOWN; here each fill's shares are rounded DOWN and
///         its USDC paid or refunded DOWN. What rounding leaves over stays on the queue's books (`dustUsdc`,
///         `dustShares`), never with a flow user.
library FlowSettleLib {
    using Math for uint256;
    using SafeERC20 for IERC20;

    /// @dev The most requests one call looks at, whatever `maxRequests` says: bounds memory and gas. It can only make
    ///      a call do less; the next call continues at the cursor (RB-20).
    uint256 internal constant MAX_LOOK_PER_CALL = 256;

    /// @dev Each side's call gets exactly `sideGas(assets, fills)` (item 4): a fixed function of the fund's asset count
    ///      and the side's fills. No caller input sets it. Measured on the five-asset harness fund in replay, every
    ///      fill a fresh owner (cold storage): a deposit side used 2.30M gas for 1 fill and 11.16M for 32 (about
    ///      0.29M per fill); a redemption side 1.89M for 1 fill and 8.87M for 32 (about 0.23M per fill). The budget
    ///      is 5.45M for one fill and 0.45M more per fill: 2.4x and 2.9x the one-fill sides, 1.57x the per-fill cost
    ///      (fix-queue notes). A venue that needs more fails its side, the same for every caller.
    uint256 internal constant SIDE_GAS_BASE = 2_000_000;
    uint256 internal constant SIDE_GAS_PER_ASSET = 600_000;
    uint256 internal constant SIDE_GAS_PER_FILL = 450_000;
    /// @dev Gas between the budget check and the call opcode, with room to spare.
    uint256 internal constant SIDE_CALL_MARGIN = 10_000;
    /// @dev The most revert data of a failed side copied into `SideFailed`: a venue's huge revert data costs the
    ///      settle nothing more than this.
    uint256 internal constant MAX_REASON_BYTES = 1_024;

    /// @dev What the walk did with one request: passed (closed, expired, or refused by its own limit), filled in
    ///      full, filled in part, or held (it waits for room).
    enum Outcome {
        Pass,
        Fill,
        Partial,
        Hold
    }

    /// @dev Where one side's walk went. `stop`: the first request it filled or held; `hold`: the first it held or
    ///      filled in part; `end`: where it stopped; `ended`: it reached the end of the range.
    struct SidePos {
        bool walked;
        bool ended;
        bool hasStop;
        bool hasHold;
        uint64 stopE;
        uint256 stopI;
        uint64 holdE;
        uint256 holdI;
        uint64 endE;
        uint256 endI;
    }

    /// @dev The walk's state: the caps' room, each side's fills (`dep[0:nDep]`, `red[0:nRed]`), the budget left.
    struct Walk {
        uint256 period;
        uint256 depRoom;
        uint256 redRoom;
        uint256 depTotal;
        uint256 redValue;
        uint256 nDep;
        uint256 nRed;
        uint256 settlementId;
        uint64 cur;
        uint16 maxRoll;
        uint256 minRequestUsdc;
        uint256 budget;
        uint8 cls;
        bool callRoomLow;
        Fill[] dep;
        Fill[] red;
        SidePos depPos;
        SidePos redPos;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  settle
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice The body of `FlowQueue.settle`. See the library note.
    /// @return settlementId The recorded settlement, or 0 when no side traded.
    function settle(FlowState storage s, uint256 maxRequests, uint256 maxUsdc, bool isKeeper)
        public
        returns (uint256 settlementId)
    {
        (SettleCheck check, uint256 index, uint256 detail, SettleContext memory c) =
            FlowCheckLib.preTrade(s, msg.sender, isKeeper);
        if (check != SettleCheck.Ok) revert IFlowEvents.SettleBlocked(check, index, detail);

        Walk memory w;
        w.settlementId = s.settlementCount + 1;
        w.cls = isKeeper ? 0 : 1;
        w.budget = maxRequests < MAX_LOOK_PER_CALL ? maxRequests : MAX_LOOK_PER_CALL;
        w.dep = new Fill[](w.budget);
        w.red = new Fill[](w.budget);
        _rooms(s, c, w, maxUsdc);
        if (c.redeemBound != 0 && c.navFeed != 0 && w.redRoom != 0) w.redPos = _walkSide(s, c, w, RequestKind.Redeem);
        if (c.depositsOpen && c.depositBound != 0 && w.depRoom != 0) {
            w.depPos = _walkSide(s, c, w, RequestKind.Deposit);
        }

        bool redOk = w.nRed != 0 && _runSide(c, w, RequestKind.Redeem);
        bool depOk = w.nDep != 0 && _runSide(c, w, RequestKind.Deposit);
        _moveCursor(s, w.cls, RequestKind.Redeem, w.redPos, w.nRed == 0 || redOk);
        _moveCursor(s, w.cls, RequestKind.Deposit, w.depPos, w.nDep == 0 || depOk);
        _rememberOldest(s, c);
        // A per-call basket cap below the minimum fill holds every request; say so (review Q-F5).
        if (w.callRoomLow && w.nRed == 0 && w.nDep == 0) emit IFlowEvents.SettleCallRoomBelowMinimum(w.depRoom, w.redRoom);
        if (!redOk && !depOk) return 0;

        // ── Step 12: record ──
        settlementId = w.settlementId;
        s.settlementCount = settlementId;
        Settlement storage st = s.settlements[settlementId];
        st.time = uint64(block.timestamp);
        st.settler = msg.sender;
        s.lastSettleAt = uint64(block.timestamp);
        s.lastSettleEpoch = w.cur;
        s.lastSharePrice = c.sharePrice;
        _recordReferences(s, c);
        if (s.levers.basketCallBps != 0) {
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
            st.depositBoundPrice,
            st.redeemBoundPrice,
            st.usdcIn,
            st.sharesMinted,
            st.sharesBurned,
            st.usdcOut
        );
    }

    /// @dev Each side's room in this call (E20, ruling 2): the period's cap less what the period already used (a
    ///      cap counts per epoch of clock time, so a backlog of epochs cannot stack caps), the TVL cap for
    ///      deposits, and `maxUsdc` for each side.
    function _rooms(FlowState storage s, SettleContext memory c, Walk memory w, uint256 maxUsdc) private view {
        FlowParams memory p = s.params;
        w.cur = FlowEpochs.current(s);
        w.period = w.cur;
        w.maxRoll = p.maxRoll;
        w.minRequestUsdc = p.minRequestUsdc;
        uint256 cap = c.navFeed.mulDiv(p.maxEpochFlowBps, BPS);
        if (cap < p.epochFlowFloorUsdc) cap = p.epochFlowFloorUsdc;
        uint256 du = s.depositUsed[w.period];
        uint256 ru = s.redeemUsed[w.period];
        w.depRoom = cap > du ? cap - du : 0;
        w.redRoom = cap > ru ? cap - ru : 0;
        // The TVL cap: a deposit must leave NAV (at the feeds) at or under it.
        uint256 tvlRoom = c.tvlCap > c.navFeed ? c.tvlCap - c.navFeed : 0;
        if (tvlRoom < w.depRoom) w.depRoom = tvlRoom;
        if (maxUsdc < w.depRoom) w.depRoom = maxUsdc;
        if (maxUsdc < w.redRoom) w.redRoom = maxUsdc;
        uint16 callBps = s.levers.basketCallBps;
        if (callBps != 0) _basketCallRoom(s, c, w, callBps, p.settleWindow);
    }

    /// @dev The `FlowLevers.basketCallBps` lever (step 3 finish plan §3.2; off at 0, the default). A side's flow of
    ///      value `v` buys or sells about `v × value_i / navFeed` of basket asset `i` (pro rata, E3, E4), so each side's
    ///      room is cut to `min_i(cap_i × navFeed / value_i)`, where `cap_i` is `callBps` of the pool's time-weighted
    ///      USDC depth over `window` and `value_i` the holding at its feed. A pool whose depth cannot be read gives
    ///      no room (fail closed). The cap is a budget per block and side: a call in a block that already traded
    ///      under the lever gets the cap less what that side already traded in the block, so the parts of a large
    ///      flow land in different blocks, and a small call cannot take the whole block's room (review Q-F2).
    ///      A side whose cap is below its minimum fill is flagged (`w.callRoomLow`), so the halt is visible.
    function _basketCallRoom(FlowState storage s, SettleContext memory c, Walk memory w, uint256 callBps, uint32 window)
        private
        view
    {
        uint256 depCap = type(uint256).max;
        uint256 redCap = type(uint256).max;
        AssetConfig[] memory cfg = IRobotMoneyFundFull(s.fund).assetConfigs();
        for (uint256 i; i < c.prices.length; ++i) {
            AssetPrice memory ap = c.prices[i];
            if (ap.kind != PRICE_KIND_BASKET || c.held[i] == 0) continue;
            uint256 value = c.held[i].mulDiv(ap.feedPerToken, ap.unit, Math.Rounding.Ceil);
            (bool ok, uint256 depth) = FundValuationLib.poolUsdcDepth(cfg[i].pool, s.usdc, window);
            uint256 room = ok && value != 0 ? depth.mulDiv(callBps, BPS).mulDiv(c.navFeed, value) : 0;
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

    /// @dev Walk side `kind`'s requests from this caller class's cursor (see the library note). Epochs with no open
    ///      request of the side are passed over without counting. Stops at the end of the range, when the budget is
    ///      spent, or when the side has no room left (nothing behind could fill).
    function _walkSide(FlowState storage s, SettleContext memory c, Walk memory w, RequestKind kind)
        private
        returns (SidePos memory pos)
    {
        uint8 k = uint8(kind);
        WalkCursor memory at = s.cursors[w.cls][k];
        uint64 e = at.epoch;
        uint256 i = at.index;
        if (e < c.firstEpoch || e > c.lastEpoch) {
            e = c.firstEpoch;
            i = 0;
        }
        pos.walked = true;
        while (true) {
            if (i >= s.sideIds[k][e].length || s.sideOpen[k][e] == 0) {
                if (e >= c.lastEpoch) {
                    pos.ended = true;
                    break;
                }
                ++e;
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

    /// @dev After the sides: the cursor of this caller class on side `kind`. A pass that reached the end starts again
    ///      at the oldest epoch. Otherwise the cursor stays on the first fill of a side that failed, else on the first
    ///      request held or filled in part, else where the walk stopped. A side not walked keeps its cursor.
    function _moveCursor(FlowState storage s, uint8 cls, RequestKind kind, SidePos memory pos, bool sideOk) private {
        if (!pos.walked) return;
        WalkCursor storage at = s.cursors[cls][uint8(kind)];
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

    /// @dev Remember the oldest epoch in this call's range that still has an open request, so later ranges start
    ///      there. Unchanged when none is open (the hint never passes an open, unexpired request).
    function _rememberOldest(FlowState storage s, SettleContext memory c) private {
        for (uint64 e = c.firstEpoch; e <= c.lastEpoch; ++e) {
            if (s.epochOpen[e] != 0) {
                if (s.oldestEpoch != e) s.oldestEpoch = e;
                return;
            }
        }
    }

    /// @dev Decide one request (see `Outcome`).
    function _consider(FlowState storage s, SettleContext memory c, Walk memory w, RequestKind kind, uint256 id)
        private
        returns (Outcome)
    {
        Request storage r = s.requests[id];
        if (r.closed || r.remaining == 0) return Outcome.Pass;
        if (w.cur > uint256(r.epoch) + w.maxRoll) return Outcome.Pass; // expired (E18): only withdrawExpired or cancel
        if (kind == RequestKind.Deposit) return _considerDeposit(c, w, id, r.remaining, r.limit);
        return _considerRedeem(c, w, id, r.remaining, r.limit);
    }

    function _considerDeposit(SettleContext memory c, Walk memory w, uint256 id, uint256 remaining, uint256 limit)
        private
        returns (Outcome)
    {
        // Refused at its whole remaining size, the size with the smallest rounding allowance: refused at any size.
        uint256 allowance = FlowCheckLib.depositAllowance(c.depositBound, remaining);
        if (allowance == type(uint256).max || limit < c.depositBound + allowance) {
            emit IFlowEvents.RequestSkipped(id, w.settlementId, c.depositBound, limit);
            return Outcome.Pass;
        }
        uint256 amt = _partial(remaining, w.depRoom - w.depTotal, w.minRequestUsdc);
        if (amt == 0) return Outcome.Hold; // the cap, the TVL cap or `maxUsdc` leaves it pending (ruling 2)
        if (amt < remaining) {
            allowance = FlowCheckLib.depositAllowance(c.depositBound, amt);
            if (allowance == type(uint256).max || limit < c.depositBound + allowance) return Outcome.Hold;
        }
        w.dep[w.nDep++] = Fill({requestId: id, amount: amt, capValue: amt});
        w.depTotal += amt;
        return amt < remaining ? Outcome.Partial : Outcome.Fill;
    }

    /// @dev Redemptions count against the cap at their value at the feeds (rounded UP).
    function _considerRedeem(SettleContext memory c, Walk memory w, uint256 id, uint256 remaining, uint256 limit)
        private
        returns (Outcome)
    {
        // Written so a user limit near 2^256 cannot overflow and revert the whole call.
        uint256 allowance = FlowCheckLib.redeemAllowance(remaining);
        if (allowance >= c.redeemBound || limit > c.redeemBound - allowance) {
            emit IFlowEvents.RequestSkipped(id, w.settlementId, c.redeemBound, limit);
            return Outcome.Pass;
        }
        uint256 room = w.redRoom - w.redValue;
        uint256 amt = _partial(
            remaining,
            room.mulDiv(c.supply, c.navFeed),
            w.minRequestUsdc.mulDiv(c.supply, c.navFeed, Math.Rounding.Ceil)
        );
        if (amt == 0) return Outcome.Hold;
        uint256 value = amt.mulDiv(c.navFeed, c.supply, Math.Rounding.Ceil);
        if (value > room) return Outcome.Hold;
        if (amt < remaining) {
            allowance = FlowCheckLib.redeemAllowance(amt);
            if (allowance >= c.redeemBound || limit > c.redeemBound - allowance) return Outcome.Hold;
        }
        w.red[w.nRed++] = Fill({requestId: id, amount: amt, capValue: value});
        w.redValue += value;
        return amt < remaining ? Outcome.Partial : Outcome.Fill;
    }

    /// @dev The fill of a request with `remaining` against `room`: all of it if it fits; else a part of at least
    ///      `minFill` that leaves at least `minFill` behind (so no dust remainder is ever created, and every partial
    ///      fill is large enough for the bound's rounding term); else 0 (it waits).
    function _partial(uint256 remaining, uint256 room, uint256 minFill) private pure returns (uint256) {
        if (remaining <= room) return remaining;
        if (remaining < 2 * minFill) return 0;
        uint256 amt = room < remaining - minFill ? room : remaining - minFill;
        return amt >= minFill ? amt : 0;
    }

    /// @notice The gas one side's call gets: a fixed function of the fund's asset count and the side's fills.
    function sideGas(uint256 assets, uint256 fills) internal pure returns (uint256) {
        return SIDE_GAS_BASE + assets * SIDE_GAS_PER_ASSET + fills * SIDE_GAS_PER_FILL;
    }

    /// @dev Run side `kind` in its own self-call with exactly `sideGas` (step 3 finish plan §3.1 item 4).
    ///
    ///      Why a fixed budget. The scaffold forwarded all its gas and, when a side failed leaving `settle` less than
    ///      a third of the gas it had at the call, reverted the whole `settle` (`SettleSideOutOfGas`, verify's fix of
    ///      mechanism-tests 1): a caller must not choose a side by starving it. But a venue that burns all the gas
    ///      it is given then always tripped that guard and blocked both sides, against ruling 1. Now the side gets
    ///      a fixed budget, no more: a venue that burns it fails that side alone, and the other side settles. The
    ///      caller's gas can only decide whether the budget is there: `settle` reverts whole with
    ///      `SettleSideOutOfGas` unless it can hand the side its whole budget (`budget × 64/63` plus the call's
    ///      overhead must be left), so starving a side is impossible. The revert data copied back is capped at
    ///      `MAX_REASON_BYTES`, so a venue's huge revert data cannot burn `settle`'s own gas either.
    function _runSide(SettleContext memory c, Walk memory w, RequestKind kind) private returns (bool ok) {
        bool red = kind == RequestKind.Redeem;
        Fill[] memory fills = red ? w.red : w.dep;
        uint256 n = red ? w.nRed : w.nDep;
        _shrink(fills, n);
        bytes memory data = red
            ? abi.encodeCall(IFlowQueueSides.settleRedeemSide, (w.settlementId, fills, c))
            : abi.encodeCall(IFlowQueueSides.settleDepositSide, (w.settlementId, fills, c));
        uint256 budget = sideGas(c.prices.length, n);
        if (gasleft() < budget + budget / 63 + SIDE_CALL_MARGIN) revert IFlowEvents.SettleSideOutOfGas(kind);
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

    /// @dev Step 12, the references of checks 5 and 6.
    ///      Check 5 (item 5): each lending venue's rate read after this settlement's trades, as the scaffold did, so a
    ///      second settlement in the same block compares like with like (with no time elapsed check 5 allows no
    ///      growth, and the fund's own supply can move a venue's rate by a rounding unit). When that read fails, the
    ///      rate check 5 read and accepted before the trades (fail closed: the scaffold skipped the venue and kept a
    ///      stale or zero reference, after which any jump passed check 5).
    ///      Check 6 (item 9): the exclusion mask and each lending venue's held amount per share.
    function _recordReferences(FlowState storage s, SettleContext memory c) private {
        s.lastExcludedMask = c.excludedMask;
        s.lastExclusionCount = IExclusionLedgerView(IRobotMoneyFundFull(s.fund).exclusionLedger()).exclusionCount();
        AssetConfig[] memory cfg = IRobotMoneyFundFull(s.fund).assetConfigs();
        for (uint256 i; i < c.prices.length; ++i) {
            if (c.prices[i].kind != PRICE_KIND_LENDING) continue;
            bool ok;
            uint256 rate;
            // An excluded venue's rate is neither read nor moved (review Q-F1): its reference stays the one from
            // before the exclusion, and a restored venue is compared with it (growth over the elapsed time).
            if (c.excludedMask & (1 << i) != 0) {
                s.lastLendPerShare[i] = c.held[i].mulDiv(PRICE_SCALE, c.supply);
                continue;
            }
            if (i < cfg.length) (ok, rate) = FlowCheckLib.lendRate(cfg[i].adapter);
            s.lastLendRate[i] = ok ? rate : c.lendRates[i];
            s.lastLendPerShare[i] = c.held[i].mulDiv(PRICE_SCALE, c.supply);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Parameters (step 3 finish plan §3.1 item 3)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Store new flow parameters (the queue checked their bounds). A new `epochLength` first re-anchors the
    ///         epochs (`FlowEpochs`). Any change resets the walk: the oldest-epoch hint and every cursor, so no
    ///         request is left behind a stale position (a larger `maxRoll` makes older requests live again).
    function applyParams(FlowState storage s, FlowParams memory p) public {
        uint32 oldLen = s.params.epochLength;
        if (oldLen != 0 && oldLen != p.epochLength) _rebaseEpochs(s);
        s.params = p;
        s.oldestEpoch = 0;
        delete s.cursors;
    }

    /// @dev Under the old parameters: store the end of every epoch that can still hold a live request, then anchor the
    ///      epochs after the one in progress, so the new length applies from the end of the epoch in progress. An
    ///      epoch more than `MAX_ROLL` behind holds only requests expired under every allowed `maxRoll`.
    function _rebaseEpochs(FlowState storage s) private {
        uint64 cur = FlowEpochs.current(s);
        uint64 from = cur > MAX_ROLL ? cur - MAX_ROLL : 0;
        for (uint64 e = from; e <= cur; ++e) {
            if (s.epochOpen[e] != 0 && s.epochEnd[e] == 0) s.epochEnd[e] = uint64(FlowEpochs.endOf(s, e));
        }
        uint256 endCur = FlowEpochs.endOf(s, cur);
        s.epochAnchorIndex = cur + 1;
        s.epochAnchorTime = uint64(endCur);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Step 8: the redemption side
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice One call into the fund for every redemption fill (E4): `sellForFlow` with a minimum per sale (check 8),
    ///         then check 11 for the batch and for each fill against its own limit, then the claims (step 12).
    ///         Runs inside the queue's self-call; any revert here undoes the whole side.
    function redeemSide(FlowState storage s, uint256 settlementId, Fill[] memory fills, SettleContext memory c)
        public
    {
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        uint256 x;
        for (uint256 k; k < fills.length; ++k) {
            x += fills[k].amount;
        }
        // Per-sale limits from the snapshot (the fund's state has not changed since checks 1 to 7).
        uint256[] memory minOut = new uint256[](c.prices.length);
        uint256 grossMin = c.idle.mulDiv(x, c.supply);
        for (uint256 i; i < c.prices.length; ++i) {
            AssetPrice memory ap = c.prices[i];
            if (ap.kind == PRICE_KIND_LENDING) {
                uint256 q = c.held[i].mulDiv(x, c.supply);
                grossMin += q > LENDING_ROUNDING_UNITS ? q - LENDING_ROUNDING_UNITS : 0;
            } else if (ap.kind == PRICE_KIND_BASKET) {
                minOut[i] = c.held[i].mulDiv(x, c.supply).mulDiv(ap.sellPerToken, ap.unit);
                grossMin += minOut[i];
            }
        }
        uint256 netMin = grossMin - grossMin.mulDiv(c.exitFeeBps, BPS, Math.Rounding.Ceil);
        // The batch must be large enough that the per-sale limits alone guarantee the bound (else it waits).
        if (netMin * PRICE_SCALE < c.redeemBound * x) {
            revert IFlowEvents.SettleBlocked(SettleCheck.RedeemLeg, IDLE_INDEX, netMin);
        }

        uint256 out;
        {
            uint256 usdcBefore = IERC20(s.usdc).balanceOf(address(this));
            uint256 sharesBefore = fund.balanceOf(address(this));
            out = fund.sellForFlow(x, minOut);
            _expect(IERC20(s.usdc).balanceOf(address(this)) - usdcBefore, out);
            _expect(sharesBefore - fund.balanceOf(address(this)), x);
        }
        // ── Check 11, the batch ──
        if (out * PRICE_SCALE < c.redeemBound * x) {
            revert IFlowEvents.SettleBlocked(SettleCheck.RealizedPrice, IDLE_INDEX, out);
        }
        _recordRedeems(s, settlementId, fills, x, out);
        Settlement storage st = s.settlements[settlementId];
        st.redeemBoundPrice = c.redeemBound;
        st.sharesBurned = x;
        st.usdcOut = out;
    }

    /// @dev Step 12 for the redemption fills: USDC per fill DOWN, each fill checked against its own limit.
    function _recordRedeems(FlowState storage s, uint256 settlementId, Fill[] memory fills, uint256 x, uint256 out)
        private
    {
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        uint256 period = FlowEpochs.current(s);
        uint256 paid;
        for (uint256 k; k < fills.length; ++k) {
            Fill memory f = fills[k];
            Request storage r = s.requests[f.requestId];
            uint256 usdcK = out.mulDiv(f.amount, x);
            // ── Check 11 / RB-14, this fill against its own limit ──
            // `usdcK / amount < limit / PS`, in a form a user limit near 2^256 cannot overflow.
            if (usdcK.mulDiv(PRICE_SCALE, f.amount) < r.limit) {
                revert IFlowEvents.SettleBlocked(SettleCheck.RealizedPrice, f.requestId, usdcK);
            }
            // E13 / RB-22: checkpoint before the owner's queued shares change.
            fund.ledgerCheckpoint(r.owner);
            s.queuedShares[r.owner] -= f.amount;
            s.totalEscrowShares -= f.amount;
            r.remaining -= f.amount;
            if (r.remaining == 0) _close(s, r);
            Claim memory cl = _claim(f.requestId, r.owner, RequestKind.Redeem, settlementId, uint64(block.timestamp));
            cl.shares = f.amount;
            cl.usdc = usdcK;
            uint256 claimId = _newClaim(s, cl);
            s.totalOwedUsdc += usdcK;
            s.redeemUsed[period] += f.capValue;
            paid += usdcK;
            emit IFlowEvents.RedeemFilled(f.requestId, claimId, settlementId, f.amount, usdcK);
        }
        s.dustUsdc += out - paid;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Step 9: the deposit side
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice One call into the fund for every deposit fill (E3): `mintInKind` of `floor(U × PS / bound)` shares with
    ///         a maximum per purchase (check 9), then check 11 for the batch and for each fill, then the claims with
    ///         their unlock time (E8) and the refund of unused USDC as credit (E22). The purchase is sized from the
    ///         fund's holdings AFTER the redemption side, read fresh here.
    function depositSide(FlowState storage s, uint256 settlementId, Fill[] memory fills, SettleContext memory c)
        public
    {
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        uint256 u;
        for (uint256 k; k < fills.length; ++k) {
            u += fills[k].amount;
        }
        uint256 sharesOut = u.mulDiv(PRICE_SCALE, c.depositBound);
        uint256[] memory maxIn;
        {
            (uint256 idle, uint256[] memory held) = fund.heldBalances();
            uint256 supply = fund.totalSupply();
            maxIn = new uint256[](c.prices.length);
            uint256 worst = idle.mulDiv(sharesOut, supply, Math.Rounding.Ceil);
            for (uint256 i; i < c.prices.length; ++i) {
                AssetPrice memory ap = c.prices[i];
                if (ap.kind == PRICE_KIND_LENDING) {
                    worst += held[i].mulDiv(sharesOut, supply, Math.Rounding.Ceil) + LENDING_ROUNDING_UNITS;
                } else if (ap.kind == PRICE_KIND_BASKET) {
                    maxIn[i] = held[i].mulDiv(sharesOut, supply, Math.Rounding.Ceil).mulDiv(
                        ap.buyPerToken, ap.unit, Math.Rounding.Ceil
                    );
                    worst += maxIn[i];
                }
            }
            if (sharesOut == 0 || worst > u || worst * PRICE_SCALE > c.depositBound * sharesOut) {
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
        // ── Check 11, the batch ──
        if (spent > u || spent * PRICE_SCALE > c.depositBound * sharesOut) {
            revert IFlowEvents.SettleBlocked(SettleCheck.RealizedPrice, IDLE_INDEX, spent);
        }
        _recordDeposits(s, settlementId, fills, u, spent, sharesOut);
        Settlement storage st = s.settlements[settlementId];
        st.depositBoundPrice = c.depositBound;
        st.usdcIn = spent;
        st.sharesMinted = sharesOut;
        st.holdEndsAt = uint64(block.timestamp) + s.params.minHold;
    }

    /// @dev The batch numbers every deposit fill is split from.
    struct DepositBatch {
        uint256 settlementId;
        uint256 u;
        uint256 unused;
        uint256 sharesOut;
        uint64 unlockAt;
        uint256 period;
    }

    /// @dev Step 12 for the deposit fills: shares DOWN, refund DOWN, each fill checked against its own limit.
    function _recordDeposits(
        FlowState storage s,
        uint256 settlementId,
        Fill[] memory fills,
        uint256 u,
        uint256 spent,
        uint256 sharesOut
    ) private {
        DepositBatch memory b = DepositBatch({
            settlementId: settlementId,
            u: u,
            unused: u - spent,
            sharesOut: sharesOut,
            unlockAt: uint64(block.timestamp) + s.params.minHold,
            period: FlowEpochs.current(s)
        });
        uint256 sharesGiven;
        uint256 refunded;
        for (uint256 k; k < fills.length; ++k) {
            (uint256 sharesK, uint256 refundK) = _recordDeposit(s, b, fills[k]);
            sharesGiven += sharesK;
            refunded += refundK;
        }
        s.dustShares += sharesOut - sharesGiven;
        s.dustUsdc += b.unused - refunded;
    }

    function _recordDeposit(FlowState storage s, DepositBatch memory b, Fill memory f)
        private
        returns (uint256 sharesK, uint256 refundK)
    {
        Request storage r = s.requests[f.requestId];
        sharesK = b.sharesOut.mulDiv(f.amount, b.u);
        refundK = b.unused.mulDiv(f.amount, b.u);
        uint256 costK = f.amount - refundK;
        // ── Check 11 / RB-14, this fill against its own limit ──
        // `costK / sharesK > limit / PS`, in a form a user limit near 2^256 cannot overflow.
        if (sharesK == 0 || costK.mulDiv(PRICE_SCALE, sharesK, Math.Rounding.Ceil) > r.limit) {
            revert IFlowEvents.SettleBlocked(SettleCheck.RealizedPrice, f.requestId, costK);
        }
        address owner = r.owner;
        IRobotMoneyFundFull(s.fund).ledgerCheckpoint(owner);
        s.queuedShares[owner] += sharesK;
        s.totalHeldShares += sharesK;
        s.totalPendingUsdc -= f.amount;
        r.remaining -= f.amount;
        if (r.remaining == 0) _close(s, r);
        if (refundK != 0) {
            s.usdcCredit[owner] += refundK;
            s.totalCreditUsdc += refundK;
            emit IFlowEvents.CreditAdded(owner, refundK, 0);
        }
        Claim memory cl = _claim(f.requestId, owner, RequestKind.Deposit, b.settlementId, b.unlockAt);
        cl.shares = sharesK;
        cl.usdc = costK;
        uint256 claimId = _newClaim(s, cl);
        s.depositUsed[b.period] += f.capValue;
        emit IFlowEvents.DepositFilled(f.requestId, claimId, b.settlementId, costK, sharesK, b.unlockAt);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Store claim `c` (fresh: nothing claimed) for its owner and request.
    function _newClaim(FlowState storage s, Claim memory c) private returns (uint256 claimId) {
        claimId = ++s.claimCount;
        s.claims[claimId] = c;
        s.claimsOf[c.owner].push(claimId);
        s.requestClaims[c.requestId].push(claimId);
    }

    function _claim(uint256 requestId, address owner, RequestKind kind, uint256 settlementId, uint64 unlockAt)
        private
        pure
        returns (Claim memory c)
    {
        c.requestId = requestId;
        c.owner = owner;
        c.kind = kind;
        c.settlementId = uint64(settlementId);
        c.unlockAt = unlockAt;
    }

    function _close(FlowState storage s, Request storage r) private {
        r.closed = true;
        s.epochOpen[r.epoch] -= 1;
        s.sideOpen[uint8(r.kind)][r.epoch] -= 1;
    }

    /// @dev Cut a memory array to its first `n` entries (n ≤ its length).
    function _shrink(Fill[] memory a, uint256 n) private pure {
        assembly {
            mstore(a, n)
        }
    }

    function _expect(uint256 actual, uint256 expected) private pure {
        if (actual != expected) revert IFlowEvents.FundResultMismatch(expected, actual);
    }
}
