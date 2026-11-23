// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.2, §5.9.4, §5.9.6, §5.11.3-§5.11.7;
//            docs/technical/one-vault-timed-flows-eng-plan.md E8, E11, E13, E17, E18, E22, E25, E26, E38-E41, E49, E52
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    Claim,
    FlowParams,
    IFlowEvents,
    Request,
    RequestKind,
    RequestStatus,
    Settlement
} from "../FlowTypes.sol";
import {IRobotMoneyFundFull} from "../interfaces/IRobotMoneyFund.sol";
import {FlowEpochs, FlowState} from "./FlowStorage.sol";
import {FlowCheckLib} from "./FlowCheckLib.sol";
import {FlowMatchLib} from "./FlowMatchLib.sol";

/// @title FlowClaimLib
/// @notice Limit-free requests, cancels (with `cancelBuffer` & deposit-stop exits), expiry, redemption notice,
///         claims, wind-down-aware freeze, and sweep for Step 3f `FlowQueue`.
///
///         Ledger rule (E13, RB-22, E52): before any mutation of an owner's queued shares (escrow, held, credit),
///         `fund.ledgerCheckpoint(owner)` runs first so index snapshots capture pre-change balances.
library FlowClaimLib {
    using Math for uint256;
    using SafeERC20 for IERC20;

    // ═════════════════════════════════════════════════════════════════════════
    //  Requests (E11, E25, E41, RB-31)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `FlowQueue.requestDeposit(usdc, owner)` (limit-free, terms locked at creation).
    function requestDeposit(FlowState storage s, uint256 usdc, address owner)
        public
        returns (uint256 requestId)
    {
        uint16 exitFeeBps = _checkDeposit(s, usdc, owner);
        requestId = _createDeposit(s, owner, usdc, exitFeeBps);
        _pullUsdc(s, usdc);
    }

    /// @notice Body of `FlowQueue.requestDepositWithPermit(usdc, owner, deadline, v, r, s)`: an EIP-2612
    ///         single-transaction deposit. The caller signs a permit typed-data message (spender = this queue,
    ///         value = `usdc`) and the queue runs `permit(msg.sender, address(this), usdc, deadline, v, r, s)`
    ///         inside a try/catch BEFORE the pull, so a mempool front-run of the permit cannot DoS the deposit:
    ///         the revert is absorbed and the pull succeeds on the front-run allowance. The Request is created
    ///         identically to `requestDeposit`, sharing its validation and Request-creation/pull helpers.
    function requestDepositWithPermit(
        FlowState storage s,
        uint256 usdc,
        address owner,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 sigS
    ) public returns (uint256 requestId) {
        uint16 exitFeeBps = _checkDeposit(s, usdc, owner);
        try IERC20Permit(s.usdc).permit(msg.sender, address(this), usdc, deadline, v, r, sigS) {}
            catch {}
        requestId = _createDeposit(s, owner, usdc, exitFeeBps);
        _pullUsdc(s, usdc);
    }

    /// @notice Body of `FlowQueue.requestRedeem(shares, owner)` (limit-free, snapshots `exitFeeBps`, never expires).
    function requestRedeem(FlowState storage s, uint256 shares, address owner)
        public
        returns (uint256 requestId)
    {
        _open(s, owner);
        if (shares == 0) revert IFlowEvents.ZeroAmount();
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        {
            uint256 minUsdc = s.params.minRequestUsdc;
            (uint256 nav,) = fund.lastGoodNav();
            uint256 supply = fund.totalSupply();
            uint256 value = supply == 0 ? 0 : shares.mulDiv(nav, supply);
            // The whole-balance exception is for a holder's own exit only (safety review 0.9.0, MISSED-01): a request
            // that names another owner meets the minimum, so dust cannot fill that owner's open-request slots.
            if (value < minUsdc && (shares != fund.balanceOf(msg.sender) || owner != msg.sender)) {
                revert IFlowEvents.BelowMinRequest(value, minUsdc);
            }
        }
        (,, uint256 exitFeeBps,) = fund.config();
        requestId = _newRequest(s, owner, RequestKind.Redeem, shares, uint16(exitFeeBps));
        uint64 epoch = s.requests[requestId].epoch;

        // Checkpoint owner BEFORE increasing ownerUnenrolledRedShares (RB-22).
        fund.ledgerCheckpoint(owner);
        FlowMatchLib.registerCreated(s, requestId, owner, RequestKind.Redeem, epoch, shares);
        s.totalEscrowShares += shares;
        IERC20(address(fund)).safeTransferFrom(msg.sender, address(this), shares);
        emit IFlowEvents.RedeemRequested(requestId, owner, msg.sender, shares, epoch);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Exits: cancel (D39, E26, E40), deposit expiry, redemption notice, credits
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `FlowQueue.cancel`: cancels the unfilled remainder to credit.
    ///         Respects `cancelBuffer`, except after cutoff when shutdown or a deposit stop unlocks deposits (E40).
    function cancel(FlowState storage s, uint256 requestId) public {
        Request storage r = _owned(s, requestId);
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        bool shutdown = fund.isShutdown() || r.era < s.windDownEra;
        if (!shutdown) {
            uint256 cutoff = FlowEpochs.endOf(s, r.epoch) - s.params.cancelBuffer;
            if (block.timestamp >= cutoff) {
                if (r.kind != RequestKind.Deposit || !_depositStopAllowsCancel(s, fund, r)) {
                    revert IFlowEvents.RequestLocked(requestId);
                }
            }
        }

        // Checkpoint BEFORE syncing or mutating owner queued shares (RB-22).
        fund.ledgerCheckpoint(r.owner);
        uint256 rem;
        if (r.kind == RequestKind.Deposit) {
            FlowMatchLib.syncOwnerDeposits(s, r.owner);
            rem = r.remaining;
            if (rem == 0) revert IFlowEvents.RequestNotPending(requestId);
            FlowMatchLib.consumeDeposit(s, requestId, rem, false);
            s.usdcCredit[r.owner] += rem;
            s.totalCreditUsdc += rem;
            emit IFlowEvents.CreditAdded(r.owner, rem, 0);
        } else {
            FlowMatchLib.syncOwnerRedeems(s, r.owner);
            rem = r.remaining;
            if (rem == 0) revert IFlowEvents.RequestNotPending(requestId);
            FlowMatchLib.consumeRedeem(s, requestId, rem, false);
            s.shareCredit[r.owner] += rem;
            s.totalCreditShares += rem;
            emit IFlowEvents.CreditAdded(r.owner, 0, rem);
        }
        emit IFlowEvents.RequestCancelled(requestId, r.owner, rem);
    }

    /// @notice Body of `FlowQueue.withdrawExpired`: deposits only (E40). Redemptions never expire.
    function withdrawExpired(FlowState storage s, uint256 requestId)
        public
        returns (uint256 amount)
    {
        Request storage r = _owned(s, requestId);
        if (r.kind != RequestKind.Deposit) revert IFlowEvents.WrongRequestKind(requestId);
        if (!_isDepositExpired(s, r)) revert IFlowEvents.RequestNotExpired(requestId);

        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        fund.ledgerCheckpoint(r.owner);
        FlowMatchLib.syncOwnerDeposits(s, r.owner);
        amount = r.remaining;
        if (amount == 0) revert IFlowEvents.RequestNotPending(requestId);
        FlowMatchLib.consumeDeposit(s, requestId, amount, false);
        IERC20(s.usdc).safeTransfer(r.owner, amount);
        emit IFlowEvents.ExpiredWithdrawn(requestId, r.owner, amount);
    }

    /// @notice Body of `FlowQueue.giveRedemptionNotice`: after `maxRoll`, schedules unfilled remainder to
    ///         return at the end of the active open round or the forming epoch's round (E40, RB-25).
    function giveRedemptionNotice(FlowState storage s, uint256 requestId)
        public
        returns (uint64 targetRound)
    {
        Request storage r = _owned(s, requestId);
        if (r.kind != RequestKind.Redeem) revert IFlowEvents.WrongRequestKind(requestId);
        if (r.noticeRound != 0) revert IFlowEvents.NoticeAlreadyGiven(requestId);
        if (IRobotMoneyFundFull(s.fund).isShutdown() || r.era < s.windDownEra) {
            revert IFlowEvents.FundIsShutdown();
        }
        uint64 cur = FlowEpochs.current(s);
        if (cur <= r.expiryEpoch) {
            revert IFlowEvents.NoticeNotReady(requestId, r.expiryEpoch + 1);
        }
        targetRound = (cur > 0 && !s.rounds[cur - 1].done) ? cur - 1 : cur;
        r.noticeRound = targetRound;
        FlowMatchLib.registerNotice(s, requestId, targetRound);
        emit IFlowEvents.RedemptionNoticeGiven(requestId, r.owner, targetRound);
    }

    /// @notice Body of `FlowQueue.withdrawCredit`: finalizes ended notices and releases wind-down escrows
    ///         automatically if shut down, then pays all USDC and share credits to `msg.sender`.
    function withdrawCredit(FlowState storage s) public returns (uint256 usdc, uint256 shares) {
        FlowMatchLib.finalizeEndedNotices(s);
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        if (fund.isShutdown()) {
            FlowMatchLib.releaseWindDown(s, msg.sender);
        }
        usdc = s.usdcCredit[msg.sender];
        shares = s.shareCredit[msg.sender];
        if (usdc == 0 && shares == 0) revert IFlowEvents.NothingToWithdraw(msg.sender);
        if (shares != 0) {
            fund.ledgerCheckpoint(msg.sender);
            s.shareCredit[msg.sender] = 0;
            s.totalCreditShares -= shares;
            IERC20(address(fund)).safeTransfer(msg.sender, shares);
        }
        if (usdc != 0) {
            s.usdcCredit[msg.sender] = 0;
            s.totalCreditUsdc -= usdc;
            IERC20(s.usdc).safeTransfer(msg.sender, usdc);
        }
        emit IFlowEvents.CreditWithdrawn(msg.sender, usdc, shares);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Claims (E8, E38, RB-10, RB-11): lazy-synced & FIFO delivered
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `FlowQueue.deposit` (`byShares == false`) and `FlowQueue.mint` (`byShares == true`).
    function deliver(FlowState storage s, address receiver, uint256 amount, bool byShares)
        public
        returns (uint256 shares, uint256 assets)
    {
        if (receiver == address(0)) revert IFlowEvents.ZeroAddress();
        if (amount == 0) revert IFlowEvents.ZeroAmount();
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        fund.ledgerCheckpoint(receiver);
        FlowMatchLib.syncOwnerDeposits(s, receiver);

        bool shutdown = fund.isShutdown();
        uint256[] storage ids = s.claimsOf[receiver];
        uint256 left = amount;
        bool prefix = true;
        for (uint256 k = s.claimCursor[receiver]; k < ids.length && left != 0; ++k) {
            Claim storage c = s.claims[ids[k]];
            if (
                c.kind == RequestKind.Deposit && c.claimed < c.shares
                    && _deliverable(s, c, shutdown)
            ) {
                uint256 x;
                uint256 cost;
                (x, cost, left) = _take(c, left, byShares);
                c.claimed += x;
                shares += x;
                assets += cost;
            }
            if (prefix && _done(c)) s.claimCursor[receiver] = k + 1;
            else prefix = false;
        }
        if (left != 0) revert IFlowEvents.NotEnoughClaimable(amount, amount - left);
        s.ownerHeldShares[receiver] -= shares;
        s.totalHeldShares -= shares;
        IERC20(address(fund)).safeTransfer(receiver, shares);
        emit IFlowEvents.SharesDelivered(receiver, msg.sender, shares, assets);
    }

    function _take(Claim storage c, uint256 left, bool byShares)
        private
        view
        returns (uint256 x, uint256 cost, uint256 leftAfter)
    {
        uint256 rem = c.shares - c.claimed;
        uint256 costBefore = c.usdc.mulDiv(c.claimed, c.shares, Math.Rounding.Ceil);
        if (byShares) {
            x = left < rem ? left : rem;
            leftAfter = left - x;
        } else {
            uint256 remCost = c.usdc - costBefore;
            if (left >= remCost) {
                x = rem;
                leftAfter = left - remCost;
            } else {
                x = (costBefore + left).mulDiv(c.shares, c.usdc) - c.claimed;
                if (x > rem) x = rem;
                leftAfter = 0;
            }
        }
        cost = c.usdc.mulDiv(c.claimed + x, c.shares, Math.Rounding.Ceil) - costBefore;
    }

    /// @notice Body of `FlowQueue.redeem`: syncs owner redemption matches, then pays claim USDC FIFO.
    function redeemClaims(FlowState storage s, uint256 shares, address receiver, address owner)
        public
        returns (uint256 assets)
    {
        if (msg.sender != owner) revert IFlowEvents.NotRequestOwner(0, msg.sender);
        if (receiver == address(0)) revert IFlowEvents.ZeroAddress();
        if (shares == 0) revert IFlowEvents.ZeroAmount();

        IRobotMoneyFundFull(s.fund).ledgerCheckpoint(owner);
        FlowMatchLib.syncOwnerRedeems(s, owner);

        uint256[] storage ids = s.claimsOf[owner];
        uint256 left = shares;
        bool prefix = true;
        for (uint256 k = s.claimCursor[owner]; k < ids.length && left != 0; ++k) {
            Claim storage c = s.claims[ids[k]];
            if (c.kind == RequestKind.Redeem && c.sharesClaimed < c.shares) {
                uint256 rem = c.shares - c.sharesClaimed;
                uint256 x = left < rem ? left : rem;
                uint256 paidAfter = c.usdc.mulDiv(c.sharesClaimed + x, c.shares);
                assets += paidAfter - c.claimed;
                c.claimed = paidAfter;
                c.sharesClaimed += x;
                left -= x;
            }
            if (prefix && _done(c)) s.claimCursor[owner] = k + 1;
            else prefix = false;
        }
        if (left != 0) revert IFlowEvents.NotEnoughClaimable(shares, shares - left);
        s.totalOwedUsdc -= assets;
        IERC20(s.usdc).safeTransfer(receiver, assets);
        emit IFlowEvents.RedeemClaimed(owner, receiver, shares, assets);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Emergency powers (E38, E39, E49, RB-18): freeze (rate-limited, no returns) & sweep
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `FlowQueue.freezeSettlement`: covers matched + net-minted deposit shares while in hold;
    ///         at most one freeze per `maxFreeze` window (E49); blocked during wind-down (E38).
    function freeze(FlowState storage s, uint256 id) public {
        if (IRobotMoneyFundFull(s.fund).isShutdown()) revert IFlowEvents.FundIsShutdown();
        Settlement storage st = _settlement(s, id);
        if (s.lastFreezeAt != 0 && block.timestamp < uint256(s.lastFreezeAt) + s.params.maxFreeze) {
            revert IFlowEvents.FreezeOnCooldown(uint64(
                    uint256(s.lastFreezeAt) + s.params.maxFreeze
                ));
        }
        if ((st.matchedShares + st.sharesMinted) == 0 || block.timestamp >= st.holdEndsAt) {
            revert IFlowEvents.FreezeOutsideHold(id);
        }
        if (st.frozenUntil > block.timestamp) revert IFlowEvents.SettlementAlreadyFrozen(id);

        uint64 until = uint64(block.timestamp) + s.params.maxFreeze;
        st.frozenUntil = until;
        st.freezeSetAt = uint64(block.timestamp);
        s.lastFreezeAt = uint64(block.timestamp);
        emit IFlowEvents.SettlementFrozen(id, until);
    }

    /// @notice Body of `FlowQueue.releaseSettlement`: ends an active freeze early.
    function release(FlowState storage s, uint256 id) public {
        Settlement storage st = _settlement(s, id);
        if (st.frozenUntil <= block.timestamp) revert IFlowEvents.SettlementNotFrozen(id);
        st.frozenUntil = uint64(block.timestamp);
        emit IFlowEvents.SettlementReleased(id);
    }

    /// @notice Body of `FlowQueue.sweep`: sends surplus above obligations (gifts + dust) to the fund.
    function sweep(FlowState storage s) public returns (uint256 usdc, uint256 shares) {
        uint256 owedUsdc = s.totalPendingUsdc + s.totalOwedUsdc + s.totalCreditUsdc;
        uint256 owedShares = s.totalEscrowShares + s.totalHeldShares + s.totalCreditShares;
        uint256 balUsdc = IERC20(s.usdc).balanceOf(address(this));
        uint256 balShares = IERC20(s.fund).balanceOf(address(this));
        if (balUsdc >= owedUsdc) {
            usdc = balUsdc - owedUsdc;
            s.dustUsdc = 0;
        }
        if (balShares >= owedShares) {
            shares = balShares - owedShares;
            s.dustShares = 0;
        }
        if (usdc != 0) IERC20(s.usdc).safeTransfer(s.fund, usdc);
        if (shares != 0) IERC20(s.fund).safeTransfer(s.fund, shares);
        emit IFlowEvents.Swept(msg.sender, usdc, shares);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Views
    // ═════════════════════════════════════════════════════════════════════════

    function epochRequests(FlowState storage s, uint64 epoch)
        public
        view
        returns (uint256[] memory ids)
    {
        uint256[] storage d = s.sideIds[uint8(RequestKind.Deposit)][epoch];
        uint256[] storage r = s.sideIds[uint8(RequestKind.Redeem)][epoch];
        ids = new uint256[](d.length + r.length);
        uint256 i;
        uint256 j;
        for (uint256 k; k < ids.length; ++k) {
            if (j == r.length || (i < d.length && d[i] < r[j])) ids[k] = d[i++];
            else ids[k] = r[j++];
        }
    }

    function deliverable(FlowState storage s, Claim storage c) internal view returns (bool) {
        return _deliverable(s, c, IRobotMoneyFundFull(s.fund).isShutdown());
    }

    function _deliverable(FlowState storage s, Claim storage c, bool isShutdown)
        private
        view
        returns (bool)
    {
        if (isShutdown) return true;
        if (block.timestamp < c.unlockAt) return false;
        Settlement storage st = s.settlements[c.settlementId];
        return !(st.frozenUntil > block.timestamp && c.unlockAt > st.freezeSetAt);
    }

    function status(FlowState storage s, uint256 requestId) public view returns (RequestStatus) {
        Request storage r = s.requests[requestId];
        if (r.owner == address(0)) return RequestStatus.None;
        if (r.closed || FlowMatchLib.currentRequestRemaining(s, requestId) == 0) {
            return RequestStatus.Closed;
        }
        if (_isDepositExpired(s, r)) return RequestStatus.Expired;
        return RequestStatus.Pending;
    }

    function pending(FlowState storage s, uint256 requestId, address controller, RequestKind kind)
        public
        view
        returns (uint256)
    {
        Request storage r = s.requests[requestId];
        if (
            r.owner != controller || r.kind != kind || status(s, requestId) != RequestStatus.Pending
        ) {
            return 0;
        }
        return FlowMatchLib.currentRequestRemaining(s, requestId);
    }

    function claimable(FlowState storage s, uint256 requestId, address controller, RequestKind kind)
        public
        view
        returns (uint256 total)
    {
        Request storage r = s.requests[requestId];
        if (r.owner != controller || r.kind != kind) return 0;
        bool shutdown = IRobotMoneyFundFull(s.fund).isShutdown();
        uint256[] storage ids = s.requestClaims[requestId];
        for (uint256 k; k < ids.length; ++k) {
            Claim storage c = s.claims[ids[k]];
            if (kind == RequestKind.Deposit) {
                if (c.claimed < c.shares && _deliverable(s, c, shutdown)) {
                    total += c.usdc - c.usdc.mulDiv(c.claimed, c.shares, Math.Rounding.Ceil);
                }
            } else {
                total += c.shares - c.sharesClaimed;
            }
        }
        if (kind == RequestKind.Deposit) {
            (uint256 unsyncedUsdc,) =
                FlowMatchLib.previewUnsyncedDepDeliverable(s, controller, requestId, shutdown);
            total += unsyncedUsdc;
        } else {
            total += FlowMatchLib.previewUnsyncedRedClaimable(s, controller, requestId);
        }
    }

    function maxClaims(FlowState storage s, address owner)
        public
        view
        returns (uint256 depositAssets, uint256 depositShares, uint256 redeemShares)
    {
        bool shutdown = IRobotMoneyFundFull(s.fund).isShutdown();
        uint256[] storage ids = s.claimsOf[owner];
        for (uint256 k = s.claimCursor[owner]; k < ids.length; ++k) {
            Claim storage c = s.claims[ids[k]];
            if (c.kind == RequestKind.Deposit) {
                if (c.claimed < c.shares && _deliverable(s, c, shutdown)) {
                    depositShares += c.shares - c.claimed;
                    depositAssets += c.usdc - c.usdc.mulDiv(c.claimed, c.shares, Math.Rounding.Ceil);
                }
            } else {
                redeemShares += c.shares - c.sharesClaimed;
            }
        }
        (uint256 unsyncedUsdc, uint256 unsyncedDepShares) =
            FlowMatchLib.previewUnsyncedDepDeliverable(s, owner, 0, shutdown);
        depositAssets += unsyncedUsdc;
        depositShares += unsyncedDepShares;
        redeemShares += FlowMatchLib.previewUnsyncedRedClaimable(s, owner, 0);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═════════════════════════════════════════════════════════════════════════

    function _open(FlowState storage s, address owner) private view {
        if (s.paused || (s.queuePausedUntil != 0 && block.timestamp < s.queuePausedUntil)) {
            revert IFlowEvents.QueueIsPaused();
        }
        if (IRobotMoneyFundFull(s.fund).isShutdown()) revert IFlowEvents.FundIsShutdown();
        if (owner == address(0)) revert IFlowEvents.ZeroAddress();
    }

    /// @dev Shared deposit validation of `requestDeposit` and `requestDepositWithPermit` (E11): open queue, then
    ///      the zero / minimum / per-deposit-cap gates, returning the fund's current `exitFeeBps` for the request.
    function _checkDeposit(FlowState storage s, uint256 usdc, address owner)
        private
        view
        returns (uint16 exitFeeBps)
    {
        _open(s, owner);
        if (usdc == 0) revert IFlowEvents.ZeroAmount();
        if (usdc < s.params.minRequestUsdc) {
            revert IFlowEvents.BelowMinRequest(usdc, s.params.minRequestUsdc);
        }
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        (, uint256 perDepositCap, uint256 feeBps,) = fund.config();
        if (usdc > perDepositCap) revert IFlowEvents.AbovePerDepositCap(usdc, perDepositCap);
        exitFeeBps = uint16(feeBps);
    }

    /// @dev Shared Request creation of `requestDeposit` and `requestDepositWithPermit`: `_newRequest`, the
    ///      pending-USDC book, match registration and `DepositRequested`, identically for both entry points.
    function _createDeposit(FlowState storage s, address owner, uint256 usdc, uint16 exitFeeBps)
        private
        returns (uint256 requestId)
    {
        requestId = _newRequest(s, owner, RequestKind.Deposit, usdc, exitFeeBps);
        s.totalPendingUsdc += usdc;
        uint64 epoch = s.requests[requestId].epoch;
        FlowMatchLib.registerCreated(s, requestId, owner, RequestKind.Deposit, epoch, usdc);
        emit IFlowEvents.DepositRequested(requestId, owner, msg.sender, usdc, epoch);
    }

    /// @dev Shared USDC pull of `requestDeposit` and `requestDepositWithPermit`: `safeTransferFrom` the caller,
    ///      then require the balance increased by exactly `usdc` (fee-on-transfer guard, shared with deposits).
    function _pullUsdc(FlowState storage s, uint256 usdc) private {
        uint256 before = IERC20(s.usdc).balanceOf(address(this));
        IERC20(s.usdc).safeTransferFrom(msg.sender, address(this), usdc);
        uint256 received = IERC20(s.usdc).balanceOf(address(this)) - before;
        if (received != usdc) revert IFlowEvents.FundResultMismatch(usdc, received);
    }

    function _newRequest(
        FlowState storage s,
        address owner,
        RequestKind kind,
        uint256 amount,
        uint16 exitFeeBps
    ) private returns (uint256 requestId) {
        FlowParams storage p = s.params;
        uint64 epoch = FlowEpochs.current(s);
        uint64 expiryEpoch = epoch + p.maxRoll;
        requestId = ++s.requestCount;
        Request storage r = s.requests[requestId];
        r.owner = owner;
        r.kind = kind;
        r.epoch = epoch;
        r.amount = amount;
        r.remaining = amount;
        r.exitFeeBps = exitFeeBps;
        r.minHold = p.minHold;
        if (kind == RequestKind.Deposit && p.minHold > s.maxDepositMinHold) {
            s.maxDepositMinHold = p.minHold;
        }
        r.maxRoll = p.maxRoll;
        r.createdAt = uint64(block.timestamp);
        r.expiryEpoch = expiryEpoch;
        r.expiresAt = kind == RequestKind.Deposit
            ? uint64(FlowEpochs.endOf(s, expiryEpoch))
            : type(uint64).max;
        r.era = s.windDownEra;

        s.sideIds[uint8(kind)][epoch].push(requestId);
        s.sideOpen[uint8(kind)][epoch] += 1;
        s.epochOpen[epoch] += 1;
    }

    function _owned(FlowState storage s, uint256 requestId)
        private
        view
        returns (Request storage r)
    {
        r = s.requests[requestId];
        if (r.owner == address(0)) revert IFlowEvents.UnknownRequest(requestId);
        if (r.owner != msg.sender) revert IFlowEvents.NotRequestOwner(requestId, msg.sender);
        if (r.closed || r.remaining == 0) revert IFlowEvents.RequestNotPending(requestId);
    }

    function _isDepositExpired(FlowState storage s, Request storage r) private view returns (bool) {
        if (r.kind != RequestKind.Deposit) return false;
        return FlowEpochs.current(s) > r.expiryEpoch
            || (r.expiresAt != 0 && block.timestamp >= r.expiresAt);
    }

    function _depositStopAllowsCancel(
        FlowState storage s,
        IRobotMoneyFundFull fund,
        Request storage r
    ) private view returns (bool) {
        if (fund.depositsPaused() || fund.hasAssetInSale() || FlowCheckLib.excludedMask(s) != 0) {
            return true;
        }
        uint64 cur = FlowEpochs.current(s);
        uint64 stopEnd = fund.lastStateStopEndedAt();
        uint64 pauseUntil = fund.depositsPausedUntil();
        if (pauseUntil != 0 && pauseUntil <= block.timestamp && pauseUntil > stopEnd) {
            stopEnd = pauseUntil;
        }
        if (stopEnd != 0 && stopEnd >= FlowEpochs.startOf(s, cur) && r.createdAt <= stopEnd) {
            return true;
        }
        return s.lastDepositStopEpoch != 0 && r.epoch <= s.lastDepositStopEpoch
            && cur <= s.openStopCancelUntilEpoch;
    }

    function _settlement(FlowState storage s, uint256 id)
        private
        view
        returns (Settlement storage st)
    {
        if (id == 0 || id > s.settlementCount) revert IFlowEvents.UnknownSettlement(id);
        st = s.settlements[id];
    }

    function _done(Claim storage c) private view returns (bool) {
        return c.kind == RequestKind.Deposit ? c.claimed >= c.shares : c.sharesClaimed >= c.shares;
    }
}
