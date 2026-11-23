// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.11.3-§5.11.5 (Step 3f match booking & running indexes);
//            docs/technical/one-vault-timed-flows-eng-plan.md E24, E27, E28, E35, E38, E40, E41, E52
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BPS, PRICE_SCALE} from "../FundTypes.sol";
import {
    Claim,
    ENROLL_BUDGET,
    ENROLL_PROCEED_MAX,
    ENROLL_GAS_MAX,
    ENROLL_VISIT_MAX,
    IFlowEvents,
    MAX_OWNER_OPEN_REQUESTS,
    NOTICE_BUDGET,
    Request,
    RequestKind,
    Settlement,
    SettleContext
} from "../FlowTypes.sol";
import {IRobotMoneyFundFull} from "../interfaces/IRobotMoneyFund.sol";
import {FeeTransfer} from "./FeeTransfer.sol";
import {
    DepBucket,
    DepMatchRecord,
    FlowEpochs,
    FlowState,
    OwnerDepCohort,
    OwnerRedState,
    RedCycleState,
    RoundState
} from "./FlowStorage.sol";

/// @title FlowMatchLib
/// @notice Linked library holding Step 3f's O(1) whole-match booking, running match indexes, lazy per-owner
///         claim materialization, post-`maxRoll` redemption notice returns, wind-down release, and
///         index-historical share views for `FundExclusionLedger` (E24, E35, E38, E40, E52).
library FlowMatchLib {
    using Math for uint256;
    using SafeERC20 for IERC20;

    /// @dev Precision scale for factor ratios (1e30 leaves > 1e12 headroom up to 1e30 shares without rounding collapse).
    uint256 internal constant MATCH_SCALE = 1e30;
    /// @dev Precision scale for cumulative matched USDC per unit normalized redemption basis.
    uint256 internal constant ACC_SCALE = 1e36;

    // ═════════════════════════════════════════════════════════════════════════
    //  Initialization & request registration
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Ensure the Step 3f match cycle counters are initialized (`>= 1`).
    /// @dev The wind-down era is NOT touched here: it starts at 0 and only `onShutdown` raises it. A queue upgraded in
    ///      place from v0.8 never ran `initialize`, and its requests (old ones, and the first new one, which records its
    ///      era before `registerCreated` calls this) carry era 0. Raising the era here orphaned them from every round.
    function ensureInitialized(FlowState storage s) public {
        if (s.depCycle == 0) {
            s.depCycle = 1;
            s.depCycleFactor[1] = MATCH_SCALE;
        }
        if (s.redCycle == 0) {
            s.redCycle = 1;
            s.redCycles[1].unmatchedFactor = MATCH_SCALE;
        }
    }

    function registerCreated(
        FlowState storage s,
        uint256 requestId,
        address owner,
        RequestKind kind,
        uint64 epoch,
        uint256 amount
    ) public {
        ensureInitialized(s);
        if (!s.epochSeen[epoch]) {
            s.epochSeen[epoch] = true;
            s.activeEpochs.push(epoch);
        }
        // Per-owner cap on open requests (safety review 0.9.0, MISSED-01). The list can still hold requests that closed
        // since the owner's last sync, so a full list is synced (ledger checkpoint first, RB-22) before it refuses.
        bool dep = kind == RequestKind.Deposit;
        uint256[] storage open = dep ? s.ownerActiveDepReqs[owner] : s.ownerActiveRedReqs[owner];
        if (open.length >= MAX_OWNER_OPEN_REQUESTS) {
            IRobotMoneyFundFull(s.fund).ledgerCheckpoint(owner);
            if (dep) syncOwnerDeposits(s, owner);
            else syncOwnerRedeems(s, owner);
            if (open.length >= MAX_OWNER_OPEN_REQUESTS) {
                revert IFlowEvents.TooManyOpenRequests(owner);
            }
        }
        open.push(requestId);
        if (kind == RequestKind.Redeem) s.ownerUnenrolledRedShares[owner] += amount;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Pending discovery, epoch enrollment & expiry eviction
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice True when round `roundEpoch` has any enrolled live work or unenrolled live requests in `e <= roundEpoch`.
    function hasPendingForRound(FlowState storage s, uint64 roundEpoch, uint64 cur)
        public
        view
        returns (bool)
    {
        if (s.redPoolShares != 0) return true;
        if (s.depPoolUsdc != 0 && _liveDepBucket(s, cur)) return true;
        uint256 idx = s.enrollCursor;
        // Positions before `enrollPos` in the cursor's epoch are enrolled (the pool checks above) or dead.
        uint256 pos = s.enrollPos;
        uint256 len = s.activeEpochs.length;
        uint256 looks;
        while (idx < len) {
            uint64 e = s.activeEpochs[idx];
            if (e > roundEpoch) break;
            if (s.sideOpen[uint8(RequestKind.Redeem)][e] != 0) return true;
            if (s.sideOpen[uint8(RequestKind.Deposit)][e] != 0) {
                uint256[] storage ids = s.sideIds[uint8(RequestKind.Deposit)][e];
                for (uint256 j = pos; j < ids.length; ++j) {
                    // Cancelled and expired ids stay listed, so this scan is bounded: past the bound the answer is
                    // "work", and the bounded enrollment walk moves the cursor over them (safety review 0.9.0,
                    // MISSED-01: one owner's create-and-cancel loop must not make every settlement scan them all).
                    if (++looks > ENROLL_VISIT_MAX) return true;
                    Request storage r = s.requests[ids[j]];
                    if (!r.closed && r.era == s.windDownEra && cur <= r.expiryEpoch) {
                        return true;
                    }
                }
            }
            pos = 0;
            ++idx;
        }
        return false;
    }

    /// @notice True when there are still locked unfilled requests after `bookMatch` on either or net side.
    function hasUnfilledInPool(FlowState storage s, bool depositsOpen, uint64 cur)
        public
        view
        returns (bool hasRed, bool hasDep)
    {
        hasRed = s.redPoolShares != 0;
        hasDep = depositsOpen && s.depPoolUsdc != 0 && _liveDepBucket(s, cur);
    }

    /// @dev A deposit bucket that has not expired and still holds basis. A bucket emptied by cancels or full
    ///      consumption stays listed until it expires; it is not work (safety review 0.9.0, AGY-12).
    function _liveDepBucket(FlowState storage s, uint64 cur) private view returns (bool) {
        for (uint256 i; i < s.activeDepBuckets.length; ++i) {
            uint64 e = s.activeDepBuckets[i];
            if (e >= cur && s.depBuckets[s.depCycle][e].totalNormBasis != 0) return true;
        }
        return false;
    }

    /// @dev The hold a match books: the longest hold enrolled in any bucket that still has basis in the live cycle
    ///      (safety review 0.9.0, AGY-10). A bucket leaves within `maxRoll` epochs, so a long hold from before a
    ///      `minHold` cut stops counting when its bucket does. A bucket with basis and no mark was enrolled before
    ///      this mark existed (or holds zero-hold deposits): the all-time maximum then stands in, as before.
    function _matchHold(FlowState storage s) private view returns (uint32 hold) {
        uint256 cyc = s.depCycle;
        bool any;
        for (uint256 i; i < s.activeDepBuckets.length; ++i) {
            uint64 e = s.activeDepBuckets[i];
            if (s.depBuckets[cyc][e].totalNormBasis == 0) continue;
            uint32 h = s.depBucketMaxMinHold[cyc][e];
            if (h == 0) return s.maxDepositMinHold;
            if (h > hold) hold = h;
            any = true;
        }
        if (!any) hold = s.maxDepositMinHold;
    }

    /// @notice Evict any expired deposit bucket (`expiryEpoch < cur`) before booking a round's match.
    function evictExpiredDepBuckets(FlowState storage s, uint64 cur) public {
        ensureInitialized(s);
        uint256 i;
        while (i < s.activeDepBuckets.length) {
            uint64 expEp = s.activeDepBuckets[i];
            if (expEp >= cur) {
                ++i;
                continue;
            }
            uint256 cyc = s.depCycle;
            uint256 F = s.depCycleFactor[cyc];
            DepBucket storage b = s.depBuckets[cyc][expEp];
            uint256 oldPool = s.depPoolUsdc;
            uint256 bNew = s.depTotalNormBasis - b.totalNormBasis;
            uint256 newPool = bNew.mulDiv(F, MATCH_SCALE);
            uint256 evictedUsdc = b.totalNormBasis.mulDiv(F, MATCH_SCALE);
            uint256 dust = oldPool - (newPool + evictedUsdc);
            if (dust != 0) {
                s.totalPendingUsdc -= dust;
                s.dustUsdc += dust;
            }
            s.depTotalNormBasis = bNew;
            s.depPoolUsdc = newPool;
            b.evicted = true;
            b.finalUnmatchedFactor = F;
            b.endMatchId = s.depMatches.length;
            b.evictedUnmatchedUsdc = evictedUsdc;
            b.activeListed = false;

            uint256 lastIdx = s.activeDepBuckets.length - 1;
            if (i != lastIdx) s.activeDepBuckets[i] = s.activeDepBuckets[lastIdx];
            s.activeDepBuckets.pop();
        }
    }

    /// @notice Enroll closed epochs `<= maxEpoch`, at most `ENROLL_BUDGET` enrollments and `ENROLL_VISIT_MAX` visits
    ///         per call (safety review 0.9.0, MISSED-01). Resumes at `(enrollCursor, enrollPos)`. Returns true once
    ///         every epoch in range is enrolled and this call enrolled at most `ENROLL_PROCEED_MAX` requests.
    ///         Checkpoints owners on the exclusion ledger first (RB-22).
    function enrollEpochs(FlowState storage s, uint64 maxEpoch, uint64 cur)
        public
        returns (bool done)
    {
        ensureInitialized(s);
        uint256 idx = s.enrollCursor;
        uint256 pos = s.enrollPos;
        uint256 len = s.activeEpochs.length;
        uint256 visits;
        uint256 enrolled;
        uint256 gasAtStart = gasleft();
        done = true;
        while (idx < len) {
            uint64 e = s.activeEpochs[idx];
            if (e > maxEpoch) break;
            while (true) {
                // The batch also ends on gas: an enrollment first syncs its owner, which costs one claim write per
                // unsynced match of each of the owner's open requests, so a count alone does not bound a call.
                if (
                    visits == ENROLL_VISIT_MAX || enrolled == ENROLL_BUDGET
                        || (enrolled != 0 && gasAtStart - gasleft() > ENROLL_GAS_MAX)
                ) {
                    done = false;
                    break;
                }
                (bool visited, bool did) = _enrollAt(s, e, pos, cur);
                if (!visited) break;
                ++visits;
                ++pos;
                if (did) ++enrolled;
            }
            if (!done) break;
            pos = 0;
            ++idx;
        }
        s.enrollCursor = idx;
        s.enrollPos = pos;
        // A heavy enrollment ends the call, so the booking and the side walk get a call of their own.
        if (enrolled > ENROLL_PROCEED_MAX) done = false;
    }

    /// @dev Position `pos` of epoch `e`: its deposit ids, then its redemption ids (which never expire, E40). Returns
    ///      `visited` false past the end of the epoch.
    function _enrollAt(FlowState storage s, uint64 e, uint256 pos, uint64 cur)
        private
        returns (bool visited, bool did)
    {
        uint256[] storage depIds = s.sideIds[uint8(RequestKind.Deposit)][e];
        uint256 nDep = depIds.length;
        if (pos < nDep) return (true, _enrollOne(s, depIds[pos], true, cur));
        uint256[] storage redIds = s.sideIds[uint8(RequestKind.Redeem)][e];
        if (pos - nDep < redIds.length) {
            return (true, _enrollOne(s, redIds[pos - nDep], false, cur));
        }
        return (false, false);
    }

    function _enrollOne(FlowState storage s, uint256 rId, bool isDep, uint64 cur)
        private
        returns (bool)
    {
        Request storage r = s.requests[rId];
        if (r.closed || r.enrolled || r.era < s.windDownEra || (isDep && cur > r.expiryEpoch)) {
            return false;
        }
        IRobotMoneyFundFull(s.fund).ledgerCheckpoint(r.owner);
        if (isDep) {
            syncOwnerDeposits(s, r.owner);
            _enrollDeposit(s, r);
        } else {
            syncOwnerRedeems(s, r.owner);
            // A shutdown starts a new cycle with the owner's basis of the old one still unmatched (a full match
            // would have zeroed it in the sync above). Release that wind-down escrow first, so the new enrollment
            // does not fold the old basis into the new cycle and count it twice once released (safety review 0.9.0,
            // MISSED-03).
            OwnerRedState storage ors = s.ownerRedStates[r.owner];
            if (ors.normBasis != 0 && ors.matchCycle < s.redCycle) releaseWindDown(s, r.owner);
            _enrollRedeem(s, r);
        }
        return true;
    }

    function _enrollDeposit(FlowState storage s, Request storage r) private {
        uint256 cyc = s.depCycle;
        if (r.minHold > s.depBucketMaxMinHold[cyc][r.expiryEpoch]) {
            s.depBucketMaxMinHold[cyc][r.expiryEpoch] = r.minHold;
        }
        uint256 F = s.depCycleFactor[cyc];
        uint256 rem = r.remaining;
        uint256 nb = F == MATCH_SCALE ? rem : rem.mulDiv(MATCH_SCALE, F);
        uint256 oldPool = s.depPoolUsdc;
        uint256 newB = s.depTotalNormBasis + nb;
        uint256 newPool = newB.mulDiv(F, MATCH_SCALE);
        uint256 added = newPool - oldPool;
        uint256 dust = rem - added;
        if (dust != 0) {
            s.totalPendingUsdc -= dust;
            s.dustUsdc += dust;
        }
        r.enrolled = true;
        r.matchCycle = cyc;
        r.normBasis = nb;
        r.remaining = F == MATCH_SCALE ? rem : nb.mulDiv(F, MATCH_SCALE);
        r.nextMatchId = s.depMatches.length;

        s.depTotalNormBasis = newB;
        s.depPoolUsdc = newPool;
        DepBucket storage b = s.depBuckets[cyc][r.expiryEpoch];
        if (!b.activeListed) {
            b.activeListed = true;
            s.activeDepBuckets.push(r.expiryEpoch);
        }
        b.totalNormBasis += nb;
        b.remainingNormBasis += nb;

        _mergeOwnerDepCohort(s, r.owner, r.expiryEpoch, cyc, nb);
    }

    function _mergeOwnerDepCohort(
        FlowState storage s,
        address owner,
        uint64 expiryEpoch,
        uint256 cyc,
        uint256 nb
    ) private {
        OwnerDepCohort[] storage cohorts = s.ownerDepCohorts[owner];
        uint256 matchLen = s.depMatches.length;
        for (uint256 k; k < cohorts.length; ++k) {
            if (cohorts[k].matchCycle == cyc && cohorts[k].expiryEpoch == expiryEpoch) {
                cohorts[k].normBasis += nb;
                cohorts[k].startMatchId = matchLen;
                return;
            }
        }
        cohorts.push(
            OwnerDepCohort({
                expiryEpoch: expiryEpoch, matchCycle: cyc, startMatchId: matchLen, normBasis: nb
            })
        );
    }

    function _enrollRedeem(FlowState storage s, Request storage r) private {
        uint256 cyc = s.redCycle;
        RedCycleState storage rc = s.redCycles[cyc];
        uint256 F = rc.unmatchedFactor;
        uint256 rem = r.remaining;
        uint256 nb = F == MATCH_SCALE ? rem : rem.mulDiv(MATCH_SCALE, F);
        uint256 oldPool = s.redPoolShares;
        uint256 newB = rc.totalNormBasis + nb;
        uint256 newPool = newB.mulDiv(F, MATCH_SCALE);
        uint256 added = newPool - oldPool;
        uint256 dust = rem - added;
        if (dust != 0) {
            s.totalEscrowShares -= dust;
            s.dustShares += dust;
        }
        s.ownerUnenrolledRedShares[r.owner] -= rem;
        r.enrolled = true;
        r.matchCycle = cyc;
        r.normBasis = nb;
        r.entryUnmatchedFactor = F;
        r.entryCumScaled = rc.cumNetPerBasisScaled[r.exitFeeBps];
        r.remaining = F == MATCH_SCALE ? rem : nb.mulDiv(F, MATCH_SCALE);

        if (!rc.tierActive[r.exitFeeBps]) {
            rc.tierActive[r.exitFeeBps] = true;
            rc.feeTiers.push(r.exitFeeBps);
        }
        rc.totalNormBasis = newB;
        rc.tierNormBasis[r.exitFeeBps] += nb;
        s.redPoolShares = newPool;

        OwnerRedState storage ors = s.ownerRedStates[r.owner];
        ors.matchCycle = cyc;
        ors.normBasis += nb;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Whole Match Booking (E24, D31, RB-36, E52)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Book the whole match `M` between locked deposits (`D`) and locked redemptions (`R`) at TWAP `S`.
    function bookMatch(
        FlowState storage s,
        SettleContext memory c,
        uint64 roundEpoch,
        address feeRecipient
    ) public returns (uint256 settlementId) {
        ensureInitialized(s);
        uint256 D = s.depPoolUsdc;
        uint256 R = s.redPoolShares;
        uint256 S = c.matchSharePrice;
        if (D == 0 || R == 0 || S == 0) return 0;
        // Plan 8.5: the match prices at the lagging TWAP, so it books only while TWAP NAV is close to feed NAV.
        {
            uint256 nf = c.navFeed;
            uint256 nt = c.navTwap;
            uint256 dev = (nt > nf ? nt - nf : nf - nt).mulDiv(BPS, nf, Math.Rounding.Ceil);
            if (dev > s.params.matchBandBps) {
                emit IFlowEvents.MatchSkipped(roundEpoch, dev);
                return 0;
            }
        }

        (uint256 M, uint256 matchedUsdc, uint256 matchDust) =
            _reserveMatchCap(s, c.navFeed, D, R, S);
        if (M == 0 || matchedUsdc == 0) return 0;

        settlementId = ++s.settlementCount;
        {
            Settlement storage st = s.settlements[settlementId];
            st.time = uint64(block.timestamp);
            st.settler = msg.sender;
            st.matchedShares = M;
            st.matchedUsdc = matchedUsdc;
            st.matchSharePrice = S;
            // The cycle's own longest hold (AGY-10). A cycle enrolled before the upgrade has none recorded: fall back
            // to the all-time mark, which is never shorter.
            st.holdEndsAt = uint64(block.timestamp) + _matchHold(s);
        }

        _advanceDepositMatchIndex(s, roundEpoch, uint64(settlementId), M, matchedUsdc, D, matchDust);
        uint256 totalFee =
            _advanceRedeemMatchIndex(s, uint64(settlementId), M, matchedUsdc, R, feeRecipient);

        RoundState storage rs = s.rounds[roundEpoch];
        rs.matchTime = uint64(block.timestamp);
        rs.settlementId = uint64(settlementId);
        emit IFlowEvents.Matched(roundEpoch, settlementId, M, matchedUsdc, totalFee, S);
    }

    function _reserveMatchCap(FlowState storage s, uint256 navFeed, uint256 D, uint256 R, uint256 S)
        private
        returns (uint256 M, uint256 matchedUsdc, uint256 matchDust)
    {
        uint256 curPeriod = FlowEpochs.current(s);
        uint256 cap = navFeed.mulDiv(s.params.maxEpochFlowBps, BPS);
        if (cap < s.params.epochFlowFloorUsdc) cap = s.params.epochFlowFloorUsdc;
        uint256 du = s.depositUsed[curPeriod];
        uint256 ru = s.redeemUsed[curPeriod];
        uint256 effD = D < (cap > du ? cap - du : 0) ? D : (cap > du ? cap - du : 0);
        uint256 maxDShares = effD.mulDiv(PRICE_SCALE, S);
        uint256 maxRShares = (cap > ru ? cap - ru : 0).mulDiv(PRICE_SCALE, S);
        if (R < maxRShares) maxRShares = R;
        M = maxRShares < maxDShares ? maxRShares : maxDShares;
        matchedUsdc = M.mulDiv(S, PRICE_SCALE);
        if (M == 0 || matchedUsdc == 0) return (0, 0, 0);
        if (M == maxDShares && effD == D) matchDust = D - matchedUsdc;
        s.depositUsed[curPeriod] = du + matchedUsdc;
        s.redeemUsed[curPeriod] = ru + matchedUsdc;
    }

    function _advanceDepositMatchIndex(
        FlowState storage s,
        uint64 roundEpoch,
        uint64 settlementId,
        uint256 M,
        uint256 matchedUsdc,
        uint256 D,
        uint256 matchDust
    ) private {
        uint256 cyc = s.depCycle;
        uint256 oldF = s.depCycleFactor[cyc];
        uint256 totalB = s.depTotalNormBasis;
        s.depMatches
            .push(
                DepMatchRecord({
                    roundEpoch: roundEpoch,
                    settlementId: settlementId,
                    matchTime: uint64(block.timestamp),
                    matchCycle: cyc,
                    matchedShares: M,
                    matchedUsdc: matchedUsdc,
                    totalNormBasis: totalB,
                    remainingNormBasis: totalB,
                    remainingShares: M
                })
            );
        s.totalPendingUsdc -= matchedUsdc;
        if (matchDust != 0) {
            s.totalPendingUsdc -= matchDust;
            s.dustUsdc += matchDust;
        }

        if (matchedUsdc + matchDust == D) {
            uint256 endLen = s.depMatches.length;
            for (uint256 i; i < s.activeDepBuckets.length; ++i) {
                DepBucket storage b = s.depBuckets[cyc][s.activeDepBuckets[i]];
                b.evicted = true;
                b.finalUnmatchedFactor = 0;
                b.endMatchId = endLen;
                b.evictedUnmatchedUsdc = 0;
                b.activeListed = false;
            }
            delete s.activeDepBuckets;
            s.depTotalNormBasis = 0;
            s.depPoolUsdc = 0;
            s.depCycleFactor[cyc] = 0;
            s.depCycle = cyc + 1;
            s.depCycleFactor[cyc + 1] = MATCH_SCALE;
        } else {
            uint256 newF = oldF.mulDiv(D - matchedUsdc, D);
            uint256 newD = totalB.mulDiv(newF, MATCH_SCALE);
            uint256 dust = (D - matchedUsdc) - newD;
            s.depCycleFactor[cyc] = newF;
            s.depPoolUsdc = newD;
            if (dust != 0) {
                s.totalPendingUsdc -= dust;
                s.dustUsdc += dust;
            }
        }
    }

    function _advanceRedeemMatchIndex(
        FlowState storage s,
        uint64 settlementId,
        uint256 M,
        uint256 matchedUsdc,
        uint256 R,
        address feeRecipient
    ) private returns (uint256 totalFee) {
        uint256 cyc = s.redCycle;
        RedCycleState storage rc = s.redCycles[cyc];
        rc.lastMatchTime = uint64(block.timestamp);
        rc.lastSettlementId = settlementId;

        uint256 totalB = rc.totalNormBasis;
        uint256 totalNet;
        for (uint256 k; k < rc.feeTiers.length; ++k) {
            uint16 fBps = rc.feeTiers[k];
            uint256 bF = rc.tierNormBasis[fBps];
            if (bF == 0) continue;
            uint256 grossF = bF == totalB ? matchedUsdc : matchedUsdc.mulDiv(bF, totalB);
            uint256 feeF = grossF.mulDiv(fBps, BPS);
            uint256 netF = grossF - feeF;
            totalFee += feeF;
            totalNet += netF;
            rc.cumNetPerBasisScaled[fBps] += netF.mulDiv(ACC_SCALE, bF);
            rc.tierOwedTracked[fBps] += netF;
        }
        uint256 grossDust = matchedUsdc - totalFee - totalNet;
        if (grossDust != 0) s.dustUsdc += grossDust;
        s.totalOwedUsdc += totalNet;
        // A refused fee joins the dust (swept to the fund) and cannot block the match (MISSED-04).
        if (!FeeTransfer.tryPay(s.usdc, feeRecipient, totalFee)) {
            s.dustUsdc += totalFee;
            emit IFlowEvents.FeeNotPaid(feeRecipient, totalFee);
        }

        if (M == R) {
            rc.unmatchedFactor = 0;
            s.redPoolShares = 0;
            s.totalEscrowShares -= R;
            s.totalHeldShares += R;
            s.redCycle = cyc + 1;
            s.redCycles[cyc + 1].unmatchedFactor = MATCH_SCALE;
        } else {
            uint256 newF = rc.unmatchedFactor.mulDiv(R - M, R);
            uint256 newR = totalB.mulDiv(newF, MATCH_SCALE);
            uint256 shareDust = (R - M) - newR;
            rc.unmatchedFactor = newF;
            s.redPoolShares = newR;
            s.totalEscrowShares -= (M + shareDust);
            s.totalHeldShares += M;
            if (shareDust != 0) s.dustShares += shareDust;
            if (newF == 0) {
                s.redCycle = cyc + 1;
                s.redCycles[cyc + 1].unmatchedFactor = MATCH_SCALE;
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Lazy per-owner sync & basis consumption
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Materialize all newly matched Deposit claims for `owner`.
    ///         Caller must have checkpointed `owner` on the exclusion ledger if subsequent mutation occurs.
    function syncOwnerDeposits(FlowState storage s, address owner) public {
        uint256[] storage reqs = s.ownerActiveDepReqs[owner];
        uint256 totalLen = s.depMatches.length;
        for (uint256 i; i < reqs.length; ++i) {
            uint256 rId = reqs[i];
            Request storage r = s.requests[rId];
            if (r.closed || !r.enrolled) continue;
            DepBucket storage b = s.depBuckets[r.matchCycle][r.expiryEpoch];
            uint256 endId = b.evicted ? b.endMatchId : totalLen;
            for (uint256 m = r.nextMatchId; m < endId; ++m) {
                DepMatchRecord storage rec = s.depMatches[m];
                if (rec.matchCycle != r.matchCycle) break;
                uint256 cShares = r.normBasis.mulDiv(rec.matchedShares, rec.totalNormBasis);
                uint256 cUsdc = r.normBasis.mulDiv(rec.matchedUsdc, rec.totalNormBasis);
                cShares = _settleDepMatchShares(s, rec, r.normBasis, cShares);
                if (cShares != 0) {
                    _pushClaim(
                        s,
                        Claim({
                            requestId: rId,
                            owner: owner,
                            kind: RequestKind.Deposit,
                            settlementId: rec.settlementId,
                            unlockAt: rec.matchTime + r.minHold,
                            shares: cShares,
                            usdc: cUsdc,
                            claimed: 0,
                            sharesClaimed: 0
                        })
                    );
                    s.ownerHeldShares[owner] += cShares;
                }
            }
            r.nextMatchId = endId;
            uint256 curF = b.evicted ? b.finalUnmatchedFactor : s.depCycleFactor[r.matchCycle];
            r.remaining = r.normBasis.mulDiv(curF, MATCH_SCALE);
            if (r.remaining == 0 && b.evicted) {
                _markClosedCount(s, r);
            }
        }

        // Compact closed items from active list
        uint256 k;
        while (k < reqs.length) {
            if (s.requests[reqs[k]].closed) {
                reqs[k] = reqs[reqs.length - 1];
                reqs.pop();
            } else {
                ++k;
            }
        }

        // Advance or drop owner deposit cohorts
        OwnerDepCohort[] storage cohorts = s.ownerDepCohorts[owner];
        uint256 j;
        while (j < cohorts.length) {
            OwnerDepCohort storage c = cohorts[j];
            DepBucket storage b = s.depBuckets[c.matchCycle][c.expiryEpoch];
            if (b.evicted || c.matchCycle != s.depCycle) {
                cohorts[j] = cohorts[cohorts.length - 1];
                cohorts.pop();
            } else {
                c.startMatchId = totalLen;
                ++j;
            }
        }
    }

    /// @dev Book one participant's floor share of a deposit match record. Each participant syncs a record exactly
    ///      once with the normBasis it held at booking (consume paths sync first), so `remainingNormBasis` reaches
    ///      zero when the last participant syncs; the floor-rounding leftover then has no owner and moves from held
    ///      shares to `dustShares`, keeping the books exact.
    function _settleDepMatchShares(
        FlowState storage s,
        DepMatchRecord storage rec,
        uint256 nb,
        uint256 cShares
    ) private returns (uint256) {
        uint256 remShares = rec.remainingShares;
        if (cShares > remShares) cShares = remShares;
        remShares -= cShares;
        uint256 remNb = rec.remainingNormBasis;
        remNb = nb >= remNb ? 0 : remNb - nb;
        if (remNb == 0 && remShares != 0) {
            s.totalHeldShares -= remShares;
            s.dustShares += remShares;
            remShares = 0;
        }
        rec.remainingShares = remShares;
        rec.remainingNormBasis = remNb;
        return cShares;
    }

    /// @notice Materialize all newly matched Redeem claims for `owner`.
    function syncOwnerRedeems(FlowState storage s, address owner) public {
        uint256[] storage reqs = s.ownerActiveRedReqs[owner];
        for (uint256 i; i < reqs.length; ++i) {
            uint256 rId = reqs[i];
            Request storage r = s.requests[rId];
            if (r.closed || !r.enrolled) continue;
            RedCycleState storage rc = s.redCycles[r.matchCycle];
            uint256 curF = rc.unmatchedFactor;
            uint256 remNow = r.normBasis.mulDiv(curF, MATCH_SCALE);
            uint256 filledShares = r.remaining > remNow ? r.remaining - remNow : 0;
            uint256 cumNow = rc.cumNetPerBasisScaled[r.exitFeeBps];
            uint256 earnedUsdc = r.normBasis.mulDiv(cumNow - r.entryCumScaled, ACC_SCALE);
            uint256 tracked = rc.tierOwedTracked[r.exitFeeBps];
            if (earnedUsdc > tracked) earnedUsdc = tracked;
            rc.tierOwedTracked[r.exitFeeBps] = tracked - earnedUsdc;
            r.entryCumScaled = cumNow;
            r.entryUnmatchedFactor = curF;
            r.remaining = remNow;

            if (filledShares != 0) {
                _pushClaim(
                    s,
                    Claim({
                        requestId: rId,
                        owner: owner,
                        kind: RequestKind.Redeem,
                        settlementId: rc.lastSettlementId,
                        unlockAt: rc.lastMatchTime,
                        shares: filledShares,
                        usdc: earnedUsdc,
                        claimed: 0,
                        sharesClaimed: 0
                    })
                );
            } else if (earnedUsdc != 0) {
                s.totalOwedUsdc -= earnedUsdc;
                s.dustUsdc += earnedUsdc;
            }

            if (remNow == 0) {
                _retireRedeemNormBasis(s, rc, r.exitFeeBps, r.normBasis);
                if (s.ownerRedStates[owner].matchCycle == r.matchCycle) {
                    uint256 curNb = s.ownerRedStates[owner].normBasis;
                    s.ownerRedStates[owner].normBasis =
                        curNb > r.normBasis ? curNb - r.normBasis : 0;
                }
                r.normBasis = 0;
                _markClosedCount(s, r);
            }
        }

        uint256 k;
        while (k < reqs.length) {
            if (s.requests[reqs[k]].closed) {
                reqs[k] = reqs[reqs.length - 1];
                reqs.pop();
            } else {
                ++k;
            }
        }
    }

    /// @notice Return the sub-minimum remainder of deposit request `rId` to its owner's USDC credit, as a cancel
    ///         would (safety review 0.9.0, MISSED-06). The settle walk calls it for an enrolled remainder below
    ///         `minRequestUsdc`, which never net-settles (RB-14).
    function refundDepositRemainder(FlowState storage s, uint256 rId) public {
        Request storage r = s.requests[rId];
        IRobotMoneyFundFull(s.fund).ledgerCheckpoint(r.owner);
        syncOwnerDeposits(s, r.owner);
        uint256 rem = r.remaining;
        if (r.closed || rem == 0) return;
        consumeDeposit(s, rId, rem, false);
        s.usdcCredit[r.owner] += rem;
        s.totalCreditUsdc += rem;
        emit IFlowEvents.CreditAdded(r.owner, rem, 0);
    }

    /// @notice Consume `consumed` USDC of deposit request `rId` (from net fill, cancel, expiry, or wind-down).
    ///         Assumes `syncOwnerDeposits(s, r.owner)` ALREADY ran immediately prior!
    function consumeDeposit(FlowState storage s, uint256 rId, uint256 consumed, bool keepLeftover)
        public
    {
        Request storage r = s.requests[rId];
        uint256 prevRem = r.remaining;
        uint256 leftover = prevRem - consumed;
        if (!r.enrolled || r.era < s.windDownEra) {
            r.remaining = leftover;
            s.totalPendingUsdc -= consumed;
            if (!keepLeftover || leftover == 0) {
                r.normBasis = 0;
                _closeDepositReq(s, rId, r);
            }
            return;
        }

        DepBucket storage b = s.depBuckets[r.matchCycle][r.expiryEpoch];
        if (b.evicted) {
            _consumeEvictedDeposit(s, b, r, prevRem, consumed, leftover);
            if (!keepLeftover || leftover == 0) _closeDepositReq(s, rId, r);
            return;
        }

        uint256 cyc = r.matchCycle;
        uint256 F = s.depCycleFactor[cyc];
        uint256 newNb = (keepLeftover && leftover != 0)
            ? (F == MATCH_SCALE ? leftover : leftover.mulDiv(MATCH_SCALE, F))
            : 0;
        _consumeActiveDeposit(s, b, r, consumed, newNb, F);
        r.normBasis = newNb;
        r.remaining = newNb == 0 ? 0 : (F == MATCH_SCALE ? leftover : newNb.mulDiv(F, MATCH_SCALE));
        if (!keepLeftover || r.remaining == 0) _closeDepositReq(s, rId, r);
    }

    function _consumeEvictedDeposit(
        FlowState storage s,
        DepBucket storage b,
        Request storage r,
        uint256 prevRem,
        uint256 consumed,
        uint256 leftover
    ) private {
        uint256 tracked = b.evictedUnmatchedUsdc;
        b.evictedUnmatchedUsdc = tracked - (prevRem > tracked ? tracked : prevRem);
        b.remainingNormBasis -= r.normBasis;
        if (b.remainingNormBasis == 0 && b.evictedUnmatchedUsdc != 0) {
            uint256 remDust = b.evictedUnmatchedUsdc;
            b.evictedUnmatchedUsdc = 0;
            s.totalPendingUsdc -= remDust;
            s.dustUsdc += remDust;
        }
        s.totalPendingUsdc -= consumed;
        r.remaining = leftover;
        if (leftover == 0) r.normBasis = 0;
    }

    function _consumeActiveDeposit(
        FlowState storage s,
        DepBucket storage b,
        Request storage r,
        uint256 consumed,
        uint256 newNb,
        uint256 F
    ) private {
        uint256 oldNb = r.normBasis;
        uint256 oldPool = s.depPoolUsdc;
        uint256 newB = s.depTotalNormBasis - oldNb + newNb;
        uint256 newPool = newB.mulDiv(F, MATCH_SCALE);
        uint256 poolDelta = oldPool > newPool ? oldPool - newPool : 0;
        if (poolDelta > consumed) {
            uint256 d = poolDelta - consumed;
            s.totalPendingUsdc -= d;
            s.dustUsdc += d;
        }
        s.totalPendingUsdc -= consumed;
        s.depTotalNormBasis = newB;
        s.depPoolUsdc = newPool;
        // An empty pool holds no hold: the next deposits set the cycle's mark afresh (AGY-10).
        b.totalNormBasis = b.totalNormBasis - oldNb + newNb;
        b.remainingNormBasis = b.remainingNormBasis - oldNb + newNb;

        OwnerDepCohort[] storage cohorts = s.ownerDepCohorts[r.owner];
        uint256 cyc = r.matchCycle;
        for (uint256 k; k < cohorts.length; ++k) {
            if (cohorts[k].matchCycle == cyc && cohorts[k].expiryEpoch == r.expiryEpoch) {
                cohorts[k].normBasis = cohorts[k].normBasis - oldNb + newNb;
                break;
            }
        }
    }

    /// @notice Consume `consumed` shares of redemption request `rId` (from net burn, cancel, notice, or wind-down).
    ///         Assumes `syncOwnerRedeems(s, r.owner)` ALREADY ran immediately prior!
    function consumeRedeem(FlowState storage s, uint256 rId, uint256 consumed, bool keepLeftover)
        public
    {
        Request storage r = s.requests[rId];
        uint256 prevRem = r.remaining;
        uint256 leftover = prevRem - consumed;
        if (!r.enrolled || r.era < s.windDownEra) {
            if (!r.enrolled) {
                s.ownerUnenrolledRedShares[r.owner] -= consumed;
            } else if (
                (!keepLeftover || leftover == 0)
                    && s.ownerRedStates[r.owner].matchCycle == r.matchCycle
            ) {
                uint256 curNb = s.ownerRedStates[r.owner].normBasis;
                s.ownerRedStates[r.owner].normBasis = curNb > r.normBasis ? curNb - r.normBasis : 0;
            }
            r.remaining = leftover;
            s.totalEscrowShares -= consumed;
            if (!keepLeftover || leftover == 0) {
                r.normBasis = 0;
                _closeRedeemReq(s, rId, r);
            }
            return;
        }

        RedCycleState storage rc = s.redCycles[r.matchCycle];
        uint256 curF = rc.unmatchedFactor;
        uint256 oldNb = r.normBasis;
        uint256 newNb = (keepLeftover && leftover != 0 && curF != 0)
            ? (curF == MATCH_SCALE ? leftover : leftover.mulDiv(MATCH_SCALE, curF))
            : 0;
        if (r.matchCycle == s.redCycle) {
            _consumeActiveRedeemPool(s, rc, r, consumed, oldNb, newNb, curF);
        }
        s.totalEscrowShares -= consumed;
        r.normBasis = newNb;
        r.remaining =
            newNb == 0 ? 0 : (curF == MATCH_SCALE ? leftover : newNb.mulDiv(curF, MATCH_SCALE));
        if (!keepLeftover || r.remaining == 0) _closeRedeemReq(s, rId, r);
    }

    function _consumeActiveRedeemPool(
        FlowState storage s,
        RedCycleState storage rc,
        Request storage r,
        uint256 consumed,
        uint256 oldNb,
        uint256 newNb,
        uint256 curF
    ) private {
        uint256 oldPool = s.redPoolShares;
        uint256 newB = rc.totalNormBasis - oldNb + newNb;
        uint256 newPool = newB.mulDiv(curF, MATCH_SCALE);
        uint256 poolDelta = oldPool > newPool ? oldPool - newPool : 0;
        if (poolDelta > consumed) {
            uint256 d = poolDelta - consumed;
            s.totalEscrowShares -= d;
            s.dustShares += d;
        }
        s.redPoolShares = newPool;
        rc.totalNormBasis = newB;
        rc.tierNormBasis[r.exitFeeBps] = rc.tierNormBasis[r.exitFeeBps] - oldNb + newNb;
        _flushEmptyRedeemTier(s, rc, r.exitFeeBps);
        if (s.ownerRedStates[r.owner].matchCycle == r.matchCycle) {
            s.ownerRedStates[r.owner].normBasis =
                s.ownerRedStates[r.owner].normBasis - oldNb + newNb;
        }
    }

    function _flushEmptyRedeemTier(FlowState storage s, RedCycleState storage rc, uint16 feeBps)
        private
    {
        if (rc.tierNormBasis[feeBps] == 0 && rc.tierOwedTracked[feeBps] != 0) {
            uint256 lo = rc.tierOwedTracked[feeBps];
            rc.tierOwedTracked[feeBps] = 0;
            s.totalOwedUsdc -= lo;
            s.dustUsdc += lo;
        }
    }

    function _retireRedeemNormBasis(
        FlowState storage s,
        RedCycleState storage rc,
        uint16 feeBps,
        uint256 nb
    ) private {
        rc.totalNormBasis -= nb;
        rc.tierNormBasis[feeBps] -= nb;
        _flushEmptyRedeemTier(s, rc, feeBps);
    }

    function _closeDepositReq(FlowState storage s, uint256 rId, Request storage r) private {
        if (!r.closed) _markClosedCount(s, r);
        uint256[] storage reqs = s.ownerActiveDepReqs[r.owner];
        for (uint256 i; i < reqs.length; ++i) {
            if (reqs[i] == rId) {
                reqs[i] = reqs[reqs.length - 1];
                reqs.pop();
                break;
            }
        }
    }

    function _closeRedeemReq(FlowState storage s, uint256 rId, Request storage r) private {
        if (!r.closed) _markClosedCount(s, r);
        uint256[] storage reqs = s.ownerActiveRedReqs[r.owner];
        for (uint256 i; i < reqs.length; ++i) {
            if (reqs[i] == rId) {
                reqs[i] = reqs[reqs.length - 1];
                reqs.pop();
                break;
            }
        }
    }

    function _markClosedCount(FlowState storage s, Request storage r) private {
        r.closed = true;
        if (s.epochOpen[r.epoch] != 0) s.epochOpen[r.epoch] -= 1;
        uint8 k = uint8(r.kind);
        if (s.sideOpen[k][r.epoch] != 0) s.sideOpen[k][r.epoch] -= 1;
    }

    function _pushClaim(FlowState storage s, Claim memory cl) private {
        uint256 cid = ++s.claimCount;
        s.claims[cid] = cl;
        s.claimsOf[cl.owner].push(cid);
        s.requestClaims[cl.requestId].push(cid);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Redemption Notice Returns (E40, RB-25)
    // ═════════════════════════════════════════════════════════════════════════

    function registerNotice(FlowState storage s, uint256 requestId, uint64 targetRound) public {
        if (s.noticeRequestsByRound[targetRound].length == 0) {
            s.pendingNoticeRounds.push(targetRound);
        }
        s.noticeRequestsByRound[targetRound].push(requestId);
    }

    function isNoticeRoundEnded(FlowState storage s, uint64 roundEpoch) public view returns (bool) {
        if (s.rounds[roundEpoch].done) return true;
        uint64 cur = FlowEpochs.current(s);
        return cur > roundEpoch + 1
            && block.timestamp >= FlowEpochs.endOf(s, roundEpoch) + s.params.settleWindow;
    }

    /// @notice Process all ended notice rounds. Safe to run in `settle()` or `withdrawCredit()`.
    /// @dev Returns at most `NOTICE_BUDGET` noticed redemptions per call (safety review 0.9.0, MISSED-01). The rest
    ///      wait for the next call, or their owners take them with `claimNoticeReturn`.
    function finalizeEndedNotices(FlowState storage s) public {
        uint256 budget = NOTICE_BUDGET;
        uint256 i;
        while (i < s.pendingNoticeRounds.length) {
            uint64 rEpoch = s.pendingNoticeRounds[i];
            if (!isNoticeRoundEnded(s, rEpoch)) {
                ++i;
                continue;
            }
            uint256[] storage reqIds = s.noticeRequestsByRound[rEpoch];
            while (reqIds.length != 0) {
                if (budget == 0) return;
                --budget;
                uint256 rId = reqIds[reqIds.length - 1];
                reqIds.pop();
                _returnNoticedRequest(s, rId);
            }
            uint256 last = s.pendingNoticeRounds.length - 1;
            if (i != last) s.pendingNoticeRounds[i] = s.pendingNoticeRounds[last];
            s.pendingNoticeRounds.pop();
        }
    }

    function claimNoticeReturn(FlowState storage s, uint256 requestId)
        public
        returns (uint256 returned)
    {
        Request storage r = s.requests[requestId];
        if (r.owner == address(0)) revert IFlowEvents.UnknownRequest(requestId);
        if (r.kind != RequestKind.Redeem) revert IFlowEvents.WrongRequestKind(requestId);
        if (r.noticeRound == 0) revert IFlowEvents.RequestNotPending(requestId);
        if (!isNoticeRoundEnded(s, r.noticeRound)) {
            revert IFlowEvents.NoticeNotReady(requestId, r.noticeRound + 2);
        }
        returned = _returnNoticedRequest(s, requestId);
    }

    function _returnNoticedRequest(FlowState storage s, uint256 requestId)
        private
        returns (uint256 returned)
    {
        Request storage r = s.requests[requestId];
        if (r.closed) return 0;
        IRobotMoneyFundFull(s.fund).ledgerCheckpoint(r.owner);
        syncOwnerRedeems(s, r.owner);
        if (r.closed || r.remaining == 0) return 0;
        returned = r.remaining;
        consumeRedeem(s, requestId, returned, false);
        s.shareCredit[r.owner] += returned;
        s.totalCreditShares += returned;
        emit IFlowEvents.RedemptionNoticeReturned(requestId, r.owner, returned);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Wind-Down (E38, E52, RB-22, RB-27)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice O(1) shutdown hook from `RobotMoneyFund.shutdown()`: closes active match pools to future rounds.
    function onShutdown(FlowState storage s) public {
        ensureInitialized(s);
        s.windDownEra += 1;
        s.depTotalNormBasis = 0;
        s.depPoolUsdc = 0;
        delete s.activeDepBuckets;
        s.depCycle += 1;
        s.depCycleFactor[s.depCycle] = MATCH_SCALE;
        s.redPoolShares = 0;
        s.redCycle += 1;
        s.redCycles[s.redCycle].unmatchedFactor = MATCH_SCALE;
        // The newest known epoch may still be open: a request made in it after a `restore` joins its id list, so the
        // cursor stays on it (its older requests are skipped by era). Every earlier epoch has ended and is passed.
        uint256 n = s.activeEpochs.length;
        s.enrollCursor = n == 0 ? 0 : n - 1;
        s.enrollPos = 0;
    }

    /// @notice Checkpoint `owner` on the exclusion ledger first (E52), sync matched fills, and release any
    ///         unfilled wind-down escrow for `owner` into credits (`usdcCredit` / `shareCredit`).
    function releaseWindDown(FlowState storage s, address owner)
        public
        returns (uint256 usdcReleased, uint256 sharesReleased)
    {
        if (owner == address(0)) revert IFlowEvents.ZeroAddress();
        IRobotMoneyFundFull(s.fund).ledgerCheckpoint(owner);
        syncOwnerDeposits(s, owner);
        syncOwnerRedeems(s, owner);

        uint256[] storage deps = s.ownerActiveDepReqs[owner];
        uint256 dIdx;
        while (dIdx < deps.length) {
            uint256 rId = deps[dIdx];
            Request storage r = s.requests[rId];
            if (!r.closed && r.era < s.windDownEra) {
                uint256 rem = r.remaining;
                if (rem != 0) {
                    s.totalPendingUsdc -= rem;
                    s.usdcCredit[owner] += rem;
                    s.totalCreditUsdc += rem;
                    usdcReleased += rem;
                }
                if (!r.closed) _markClosedCount(s, r);
                r.remaining = 0;
                r.normBasis = 0;
                deps[dIdx] = deps[deps.length - 1];
                deps.pop();
            } else {
                ++dIdx;
            }
        }

        uint256[] storage reds = s.ownerActiveRedReqs[owner];
        uint256 rIdx;
        while (rIdx < reds.length) {
            uint256 rId = reds[rIdx];
            Request storage r = s.requests[rId];
            if (!r.closed && r.era < s.windDownEra) {
                uint256 rem = r.remaining;
                if (rem != 0) {
                    if (!r.enrolled) s.ownerUnenrolledRedShares[owner] -= rem;
                    s.totalEscrowShares -= rem;
                    s.shareCredit[owner] += rem;
                    s.totalCreditShares += rem;
                    sharesReleased += rem;
                }
                if (!r.closed) _markClosedCount(s, r);
                r.remaining = 0;
                r.normBasis = 0;
                reds[rIdx] = reds[reds.length - 1];
                reds.pop();
            } else {
                ++rIdx;
            }
        }
        if (s.ownerRedStates[owner].matchCycle < s.redCycle) {
            s.ownerRedStates[owner].normBasis = 0;
        }
        if (usdcReleased != 0 || sharesReleased != 0) {
            emit IFlowEvents.WindDownReleased(owner, usdcReleased, sharesReleased);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Views & Exclusion Ledger Index Queries (E52, RB-22)
    // ═════════════════════════════════════════════════════════════════════════

    function currentMatchIndexes(FlowState storage s)
        public
        view
        returns (uint256[2] memory depIdx, uint256[2] memory redIdx)
    {
        depIdx[0] = s.depMatches.length;
        depIdx[1] = 0;
        redIdx[0] = s.redCycle == 0 ? 1 : s.redCycle;
        redIdx[1] = s.redCycle == 0 ? MATCH_SCALE : s.redCycles[s.redCycle].unmatchedFactor;
    }

    function queuedSharesOf(FlowState storage s, address account) public view returns (uint256) {
        (uint256[2] memory depIdx, uint256[2] memory redIdx) = currentMatchIndexes(s);
        return queuedSharesOfAt(s, account, depIdx, redIdx);
    }

    function queuedSharesOfAt(
        FlowState storage s,
        address account,
        uint256[2] memory depIdx,
        uint256[2] memory redIdx
    ) public view returns (uint256 shares) {
        shares = s.ownerHeldShares[account] + s.shareCredit[account]
            + s.ownerUnenrolledRedShares[account];

        OwnerRedState storage ors = s.ownerRedStates[account];
        if (ors.normBasis != 0) {
            if (ors.matchCycle == redIdx[0]) {
                shares += ors.normBasis.mulDiv(redIdx[1], MATCH_SCALE);
            } else if (ors.matchCycle < redIdx[0]) {
                uint256 f = s.redCycles[ors.matchCycle].unmatchedFactor;
                if (f != 0) shares += ors.normBasis.mulDiv(f, MATCH_SCALE);
            }
        }

        OwnerDepCohort[] storage cohorts = s.ownerDepCohorts[account];
        uint256 capLen = depIdx[0];
        if (capLen > s.depMatches.length) capLen = s.depMatches.length;
        for (uint256 i; i < cohorts.length; ++i) {
            OwnerDepCohort storage c = cohorts[i];
            DepBucket storage b = s.depBuckets[c.matchCycle][c.expiryEpoch];
            uint256 endId = (b.evicted && b.endMatchId < capLen) ? b.endMatchId : capLen;
            for (uint256 m = c.startMatchId; m < endId; ++m) {
                DepMatchRecord storage rec = s.depMatches[m];
                if (rec.matchCycle == c.matchCycle) {
                    shares += c.normBasis.mulDiv(rec.matchedShares, rec.totalNormBasis);
                }
            }
        }
    }

    /// @notice Live unfilled escrow of `requestId` right now (accounting for booked matches not yet materialized).
    function currentRequestRemaining(FlowState storage s, uint256 requestId)
        public
        view
        returns (uint256)
    {
        Request storage r = s.requests[requestId];
        if (r.closed) return 0;
        if (!r.enrolled) return r.remaining;
        if (r.kind == RequestKind.Deposit) {
            DepBucket storage b = s.depBuckets[r.matchCycle][r.expiryEpoch];
            uint256 curF = b.evicted ? b.finalUnmatchedFactor : s.depCycleFactor[r.matchCycle];
            return r.normBasis.mulDiv(curF, MATCH_SCALE);
        } else {
            return r.normBasis.mulDiv(s.redCycles[r.matchCycle].unmatchedFactor, MATCH_SCALE);
        }
    }

    /// @notice Unmaterialized unlocked deposit `(usdc, shares)` for one request or whole owner.
    function previewUnsyncedDepDeliverable(
        FlowState storage s,
        address owner,
        uint256 onlyRequestId,
        bool isShutdown
    ) public view returns (uint256 deliverableUsdc, uint256 deliverableShares) {
        uint256[] storage reqs = s.ownerActiveDepReqs[owner];
        uint256 totalLen = s.depMatches.length;
        for (uint256 i; i < reqs.length; ++i) {
            uint256 rId = reqs[i];
            if (onlyRequestId != 0 && rId != onlyRequestId) continue;
            Request storage r = s.requests[rId];
            if (r.closed || !r.enrolled) continue;
            DepBucket storage b = s.depBuckets[r.matchCycle][r.expiryEpoch];
            uint256 endId = b.evicted ? b.endMatchId : totalLen;
            for (uint256 m = r.nextMatchId; m < endId; ++m) {
                DepMatchRecord storage rec = s.depMatches[m];
                if (rec.matchCycle != r.matchCycle) break;
                if (!isShutdown) {
                    if (block.timestamp < rec.matchTime + r.minHold) continue;
                    Settlement storage st = s.settlements[rec.settlementId];
                    if (
                        st.frozenUntil > block.timestamp
                            && rec.matchTime + r.minHold > st.freezeSetAt
                    ) continue;
                }
                deliverableShares += r.normBasis.mulDiv(rec.matchedShares, rec.totalNormBasis);
                deliverableUsdc += r.normBasis.mulDiv(rec.matchedUsdc, rec.totalNormBasis);
            }
        }
    }

    /// @notice Unmaterialized matched redemption shares whose USDC has not yet been claimed.
    function previewUnsyncedRedClaimable(FlowState storage s, address owner, uint256 onlyRequestId)
        public
        view
        returns (uint256 sharesClaimable)
    {
        uint256[] storage reqs = s.ownerActiveRedReqs[owner];
        for (uint256 i; i < reqs.length; ++i) {
            uint256 rId = reqs[i];
            if (onlyRequestId != 0 && rId != onlyRequestId) continue;
            Request storage r = s.requests[rId];
            if (r.closed || !r.enrolled) continue;
            uint256 remNow =
                r.normBasis.mulDiv(s.redCycles[r.matchCycle].unmatchedFactor, MATCH_SCALE);
            if (r.remaining > remNow) sharesClaimable += (r.remaining - remNow);
        }
    }
}
