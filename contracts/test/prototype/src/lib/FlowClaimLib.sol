// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.2 steps 1, 6 and 7 (request, hold, roll and expiry),
//            §5.9.4 (exits and emergency powers), §5.9.6 (claims), RB-10, RB-11, RB-12, RB-15, RB-18, RB-22;
//            docs/technical/one-vault-timed-flows-eng-plan.md E8, E9, E11, E13, E17, E18, E22
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    Claim, FlowParams, IFlowEvents, Request, RequestKind, RequestStatus, Settlement
} from "../FlowTypes.sol";
import {IRobotMoneyFundFull} from "../interfaces/IRobotMoneyFund.sol";
import {FlowEpochs, FlowState} from "./FlowStorage.sol";

/// @title FlowClaimLib
/// @notice Requests, exits, claims and the emergency powers of the FlowQueue, linked (`public`) for size.
///
///         Ledger rule (E13, RB-22): before any change of an owner's queued shares (`FlowState.queuedShares`:
///         escrowed redemption shares, deposit shares in their hold, and share credits) the queue calls
///         `fund.ledgerCheckpoint(owner)`. Every function here that changes them does that first.
///
///         Returns are pulled (E22): every payment goes to `msg.sender` acting as the owner, or, for a claim, to the
///         owner (deposit / mint, RB-11) or to a receiver the owner itself names (redeem). Nobody can push escrow,
///         refunds or in-kind returns to another address.
library FlowClaimLib {
    using Math for uint256;
    using SafeERC20 for IERC20;

    // ═════════════════════════════════════════════════════════════════════════
    //  Requests (§5.9.2 step 1, E11)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `FlowQueue.requestDeposit`. Pulls `usdc` from `msg.sender` only (ruling 10).
    function requestDeposit(FlowState storage s, uint256 usdc, uint256 maxUsdcPerShare, address owner)
        public
        returns (uint256 requestId)
    {
        _open(s, owner);
        if (usdc == 0 || maxUsdcPerShare == 0) revert IFlowEvents.ZeroAmount();
        FlowParams memory p = s.params;
        if (usdc < p.minRequestUsdc) revert IFlowEvents.BelowMinRequest(usdc, p.minRequestUsdc);
        (, uint256 perDepositCap,,) = IRobotMoneyFundFull(s.fund).config();
        if (usdc > perDepositCap) revert IFlowEvents.AbovePerDepositCap(usdc, perDepositCap);

        requestId = _newRequest(s, owner, RequestKind.Deposit, usdc, maxUsdcPerShare);
        s.totalPendingUsdc += usdc;
        uint256 before = IERC20(s.usdc).balanceOf(address(this));
        IERC20(s.usdc).safeTransferFrom(msg.sender, address(this), usdc);
        if (IERC20(s.usdc).balanceOf(address(this)) - before != usdc) {
            revert IFlowEvents.FundResultMismatch(usdc, IERC20(s.usdc).balanceOf(address(this)) - before);
        }
        emit IFlowEvents.DepositRequested(
            requestId, owner, msg.sender, usdc, maxUsdcPerShare, s.requests[requestId].epoch
        );
    }

    /// @notice Body of `FlowQueue.requestRedeem`. Ledger hook for `owner` first, then pulls `shares` from
    ///         `msg.sender`. The minimum is valued at `lastGoodNav` (DOWN); a redemption of the caller's whole
    ///         wallet balance is exempt (E11).
    function requestRedeem(FlowState storage s, uint256 shares, uint256 minUsdcPerShare, address owner)
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
            if (value < minUsdc && shares != fund.balanceOf(msg.sender)) {
                revert IFlowEvents.BelowMinRequest(value, minUsdc);
            }
        }
        requestId = _newRequest(s, owner, RequestKind.Redeem, shares, minUsdcPerShare);
        // E13 / RB-22: the owner's queued shares are about to change. The caller's wallet side is checkpointed by
        // the fund's own transfer hook.
        fund.ledgerCheckpoint(owner);
        s.queuedShares[owner] += shares;
        s.totalEscrowShares += shares;
        IERC20(address(fund)).safeTransferFrom(msg.sender, address(this), shares);
        emit IFlowEvents.RedeemRequested(
            requestId, owner, msg.sender, shares, minUsdcPerShare, s.requests[requestId].epoch
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Exits that read no price (§5.9.4): cancel, in-kind exit, expired escrow, credits
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `FlowQueue.cancel`: the unfilled part of a pending or expired request goes to the owner's
    ///         credit, exactly (RB-12). Open while paused (RB-15).
    function cancel(FlowState storage s, uint256 requestId) public {
        Request storage r = _owned(s, requestId);
        uint256 rem = r.remaining;
        r.remaining = 0;
        _close(s, r);
        if (r.kind == RequestKind.Deposit) {
            s.totalPendingUsdc -= rem;
            s.usdcCredit[r.owner] += rem;
            s.totalCreditUsdc += rem;
            emit IFlowEvents.CreditAdded(r.owner, rem, 0);
        } else {
            // Escrow becomes credit: the owner's queued shares do not change, the hook runs anyway (cheap, and the
            // rule "hook before every change of queued state" then has no exception).
            IRobotMoneyFundFull(s.fund).ledgerCheckpoint(r.owner);
            s.totalEscrowShares -= rem;
            s.shareCredit[r.owner] += rem;
            s.totalCreditShares += rem;
            emit IFlowEvents.CreditAdded(r.owner, 0, rem);
        }
        emit IFlowEvents.RequestCancelled(requestId, r.owner, rem);
    }

    /// @notice Body of `FlowQueue.exitInKind`: the unfilled shares of a redemption request leave at once through the
    ///         fund's `redeemInKind(shares, owner, queue)`; the assets go to the owner (E9). Open while paused.
    function exitInKind(FlowState storage s, uint256 requestId) public {
        Request storage r = _owned(s, requestId);
        if (r.kind != RequestKind.Redeem) revert IFlowEvents.WrongRequestKind(requestId);
        uint256 rem = r.remaining;
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        fund.ledgerCheckpoint(r.owner);
        s.queuedShares[r.owner] -= rem;
        s.totalEscrowShares -= rem;
        r.remaining = 0;
        _close(s, r);
        uint256 before = fund.balanceOf(address(this));
        fund.redeemInKind(rem, r.owner, address(this));
        if (before - fund.balanceOf(address(this)) != rem) {
            revert IFlowEvents.FundResultMismatch(rem, before - fund.balanceOf(address(this)));
        }
        emit IFlowEvents.RequestExitedInKind(requestId, r.owner, rem);
    }

    /// @notice Body of `FlowQueue.withdrawExpired`: after `maxRoll` epochs the owner takes the unfilled escrow (E18).
    function withdrawExpired(FlowState storage s, uint256 requestId) public returns (uint256 amount) {
        Request storage r = _owned(s, requestId);
        if (FlowEpochs.current(s) <= uint256(r.epoch) + s.params.maxRoll) {
            revert IFlowEvents.RequestNotExpired(requestId);
        }
        amount = r.remaining;
        r.remaining = 0;
        _close(s, r);
        if (r.kind == RequestKind.Deposit) {
            s.totalPendingUsdc -= amount;
            IERC20(s.usdc).safeTransfer(r.owner, amount);
        } else {
            IRobotMoneyFundFull(s.fund).ledgerCheckpoint(r.owner);
            s.queuedShares[r.owner] -= amount;
            s.totalEscrowShares -= amount;
            IERC20(s.fund).safeTransfer(r.owner, amount);
        }
        emit IFlowEvents.ExpiredWithdrawn(requestId, r.owner, amount);
    }

    /// @notice Body of `FlowQueue.withdrawCredit`: pays `msg.sender` every USDC and share credit booked to it.
    function withdrawCredit(FlowState storage s) public returns (uint256 usdc, uint256 shares) {
        usdc = s.usdcCredit[msg.sender];
        shares = s.shareCredit[msg.sender];
        if (usdc == 0 && shares == 0) revert IFlowEvents.NothingToWithdraw(msg.sender);
        if (shares != 0) {
            IRobotMoneyFundFull(s.fund).ledgerCheckpoint(msg.sender);
            s.shareCredit[msg.sender] = 0;
            s.totalCreditShares -= shares;
            s.queuedShares[msg.sender] -= shares;
            IERC20(s.fund).safeTransfer(msg.sender, shares);
        }
        if (usdc != 0) {
            s.usdcCredit[msg.sender] = 0;
            s.totalCreditUsdc -= usdc;
            IERC20(s.usdc).safeTransfer(msg.sender, usdc);
        }
        emit IFlowEvents.CreditWithdrawn(msg.sender, usdc, shares);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Claims (E8, RB-10, RB-11): stored fills, never a convert view
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `FlowQueue.deposit` (`byShares == false`, `amount` = USDC of cost) and `FlowQueue.mint`
    ///         (`byShares == true`, `amount` = shares). Delivers `receiver`'s unlocked, unfrozen deposit claims
    ///         oldest first, only to `receiver` (RB-11). Reverts `NotEnoughClaimable` when less is claimable.
    /// @return shares Shares delivered.
    /// @return assets Their USDC cost: for `mint`, rounded UP per claim; for `deposit`, at most `amount`.
    function deliver(FlowState storage s, address receiver, uint256 amount, bool byShares)
        public
        returns (uint256 shares, uint256 assets)
    {
        if (receiver == address(0)) revert IFlowEvents.ZeroAddress();
        if (amount == 0) revert IFlowEvents.ZeroAmount();
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        // E13: checkpoint before the receiver's queued shares fall.
        fund.ledgerCheckpoint(receiver);
        uint256[] storage ids = s.claimsOf[receiver];
        uint256 left = amount;
        bool prefix = true;
        for (uint256 k = s.claimCursor[receiver]; k < ids.length && left != 0; ++k) {
            Claim storage c = s.claims[ids[k]];
            if (c.kind == RequestKind.Deposit && c.claimed < c.shares && deliverable(s, c)) {
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
        s.queuedShares[receiver] -= shares;
        s.totalHeldShares -= shares;
        IERC20(address(fund)).safeTransfer(receiver, shares);
        emit IFlowEvents.SharesDelivered(receiver, msg.sender, shares, assets);
    }

    /// @dev One deposit claim's part of a delivery. Cost of the first `n` shares of a claim is
    ///      `ceil(usdc × n / shares)`, so partial deliveries never sum to less than the claim's cost.
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
                // The most shares whose cost fits in `left` (DOWN); what does not buy a whole share unit stays unspent
                // and the request is complete.
                x = (costBefore + left).mulDiv(c.shares, c.usdc) - c.claimed;
                if (x > rem) x = rem;
                leftAfter = 0;
            }
        }
        cost = c.usdc.mulDiv(c.claimed + x, c.shares, Math.Rounding.Ceil) - costBefore;
    }

    /// @notice Body of `FlowQueue.redeem`: the owner takes the settled USDC of `shares` burned shares of its
    ///         redemption claims, oldest first, to `receiver`. USDC per claim `usdc × sharesClaimed / shares` (DOWN).
    function redeemClaims(FlowState storage s, uint256 shares, address receiver, address owner)
        public
        returns (uint256 assets)
    {
        if (msg.sender != owner) revert IFlowEvents.NotRequestOwner(0, msg.sender);
        if (receiver == address(0)) revert IFlowEvents.ZeroAddress();
        if (shares == 0) revert IFlowEvents.ZeroAmount();
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
    //  Emergency powers (§5.9.4, E17, RB-18): each can only delay or return
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `FlowQueue.freezeSettlement`: only while the settlement's deposit shares are in their hold;
    ///         ends by itself at `now + maxFreeze` (the clock starts at the freeze call, ruling 8). A new freeze starts
    ///         with returns disallowed: a return allowed under an earlier freeze does not carry over (step 3 finish
    ///         plan §3.1 item 6).
    function freeze(FlowState storage s, uint256 id) public {
        Settlement storage st = _settlement(s, id);
        if (st.sharesMinted == 0 || block.timestamp >= st.holdEndsAt) revert IFlowEvents.FreezeOutsideHold(id);
        if (st.frozenUntil > block.timestamp) revert IFlowEvents.SettlementAlreadyFrozen(id);
        st.frozenUntil = uint64(block.timestamp) + s.params.maxFreeze;
        st.returnAllowed = false;
        emit IFlowEvents.SettlementFrozen(id, st.frozenUntil);
    }

    /// @notice Body of `FlowQueue.releaseSettlement`: ends the freeze now and any return it allowed (item 6: the
    ///         scaffold left `returnAllowed` set, so a depositor could still take its held shares out early after the
    ///         release, RB-11); claims then deliver after their unlock.
    function release(FlowState storage s, uint256 id) public {
        Settlement storage st = _settlement(s, id);
        if (st.frozenUntil <= block.timestamp) revert IFlowEvents.SettlementNotFrozen(id);
        st.frozenUntil = uint64(block.timestamp);
        st.returnAllowed = false;
        emit IFlowEvents.SettlementReleased(id);
    }

    /// @notice Body of `FlowQueue.allowReturn`: while frozen, lets each depositor of `id` take its own slice back in
    ///         kind (`takeReturn`). Nobody else can receive it (RB-18).
    function allowReturn(FlowState storage s, uint256 id) public {
        Settlement storage st = _settlement(s, id);
        if (st.frozenUntil <= block.timestamp) revert IFlowEvents.SettlementNotFrozen(id);
        st.returnAllowed = true;
        emit IFlowEvents.SettlementReturnAllowed(id);
    }

    /// @notice Body of `FlowQueue.takeReturn`: the claim's owner takes its undelivered shares out through the fund's
    ///         `redeemInKind(shares, owner, queue)`, paid to the owner only.
    function takeReturn(FlowState storage s, uint256 claimId) public {
        Claim storage c = s.claims[claimId];
        if (c.owner == address(0)) revert IFlowEvents.UnknownClaim(claimId);
        if (c.owner != msg.sender) revert IFlowEvents.NotRequestOwner(c.requestId, msg.sender);
        if (c.kind != RequestKind.Deposit) revert IFlowEvents.WrongRequestKind(c.requestId);
        if (!s.settlements[c.settlementId].returnAllowed) revert IFlowEvents.ReturnNotAllowed(c.settlementId);
        uint256 x = c.shares - c.claimed;
        if (x == 0) revert IFlowEvents.NothingToWithdraw(msg.sender);
        IRobotMoneyFundFull fund = IRobotMoneyFundFull(s.fund);
        fund.ledgerCheckpoint(c.owner);
        c.claimed = c.shares;
        s.queuedShares[c.owner] -= x;
        s.totalHeldShares -= x;
        uint256 before = fund.balanceOf(address(this));
        fund.redeemInKind(x, c.owner, address(this));
        if (before - fund.balanceOf(address(this)) != x) {
            revert IFlowEvents.FundResultMismatch(x, before - fund.balanceOf(address(this)));
        }
        emit IFlowEvents.ReturnTaken(claimId, c.owner, x);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Sweep (step 3 finish plan §3.1 item 7, D-AT-5)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `FlowQueue.sweep`: anyone sends the USDC and the shares the queue holds above its obligations
    ///         to the fund. Obligations are exactly the booked amounts some owner can still take: pending, owed and
    ///         credited USDC; escrowed, held and credited shares. What lies above them is rounding dust (booked to
    ///         nobody, `dustUsdc` / `dustShares`) and gifts. Proof that booked value never moves: the amount sent is
    ///         `balance − obligations` when positive, else 0, so after the sweep the balance is at least the
    ///         obligations; no obligation changes here; and every later payment is bounded by its own booked line
    ///         (E22 credits, claims, escrow), whose sum is the obligations. USDC lands in the fund's idle USDC, a gift
    ///         to holders. Shares land beside the fund's seed shares, which never move (`SeedSharesLocked`): out of
    ///         circulation for good. The destination is this run's assumed choice (plan §4); the owner may change it.
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

    /// @notice Request ids made in `epoch`, in order: the deposit and redemption lists merged by id (ids grow in
    ///         creation order).
    function epochRequests(FlowState storage s, uint64 epoch) public view returns (uint256[] memory ids) {
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

    /// @notice A deposit claim can be delivered now: its hold ended and its settlement is not frozen.
    function deliverable(FlowState storage s, Claim storage c) internal view returns (bool) {
        return block.timestamp >= c.unlockAt && s.settlements[c.settlementId].frozenUntil <= block.timestamp;
    }

    function status(FlowState storage s, uint256 requestId) public view returns (RequestStatus) {
        Request storage r = s.requests[requestId];
        if (r.owner == address(0)) return RequestStatus.None;
        if (r.closed) return RequestStatus.Closed;
        if (FlowEpochs.current(s) > uint256(r.epoch) + s.params.maxRoll) return RequestStatus.Expired;
        return RequestStatus.Pending;
    }

    /// @notice ERC-7540 pending amount of `requestId` for `controller` (its owner): the unfilled part while the
    ///         request can still fill; 0 otherwise.
    function pending(FlowState storage s, uint256 requestId, address controller, RequestKind kind)
        public
        view
        returns (uint256)
    {
        Request storage r = s.requests[requestId];
        if (r.owner != controller || r.kind != kind || status(s, requestId) != RequestStatus.Pending) return 0;
        return r.remaining;
    }

    /// @notice ERC-7540 claimable amount of `requestId` for `controller`: Deposit, the USDC cost of its deliverable
    ///         undelivered shares; Redeem, its burned shares whose USDC is not yet taken.
    function claimable(FlowState storage s, uint256 requestId, address controller, RequestKind kind)
        public
        view
        returns (uint256 total)
    {
        Request storage r = s.requests[requestId];
        if (r.owner != controller || r.kind != kind) return 0;
        uint256[] storage ids = s.requestClaims[requestId];
        for (uint256 k; k < ids.length; ++k) {
            Claim storage c = s.claims[ids[k]];
            if (kind == RequestKind.Deposit) {
                if (c.claimed < c.shares && deliverable(s, c)) {
                    total += c.usdc - c.usdc.mulDiv(c.claimed, c.shares, Math.Rounding.Ceil);
                }
            } else {
                total += c.shares - c.sharesClaimed;
            }
        }
    }

    /// @notice ERC-7540 claim limits of `owner` now: deliverable deposit cost (`maxDeposit`), deliverable deposit
    ///         shares (`maxMint`) and claimable redeemed shares (`maxRedeem`).
    function maxClaims(FlowState storage s, address owner)
        public
        view
        returns (uint256 depositAssets, uint256 depositShares, uint256 redeemShares)
    {
        uint256[] storage ids = s.claimsOf[owner];
        for (uint256 k = s.claimCursor[owner]; k < ids.length; ++k) {
            Claim storage c = s.claims[ids[k]];
            if (c.kind == RequestKind.Deposit) {
                if (c.claimed < c.shares && deliverable(s, c)) {
                    depositShares += c.shares - c.claimed;
                    depositAssets += c.usdc - c.usdc.mulDiv(c.claimed, c.shares, Math.Rounding.Ceil);
                }
            } else {
                redeemShares += c.shares - c.sharesClaimed;
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═════════════════════════════════════════════════════════════════════════

    function _open(FlowState storage s, address owner) private view {
        if (s.paused) revert IFlowEvents.QueueIsPaused();
        if (owner == address(0)) revert IFlowEvents.ZeroAddress();
    }

    /// @dev The request goes on its side's list of its epoch (`sideIds`): each side walks its own (item 2).
    function _newRequest(FlowState storage s, address owner, RequestKind kind, uint256 amount, uint256 limit)
        private
        returns (uint256 requestId)
    {
        uint64 epoch = FlowEpochs.current(s);
        requestId = ++s.requestCount;
        s.requests[requestId] = Request({
            owner: owner,
            kind: kind,
            epoch: epoch,
            amount: amount,
            remaining: amount,
            limit: limit,
            closed: false
        });
        s.sideIds[uint8(kind)][epoch].push(requestId);
        s.sideOpen[uint8(kind)][epoch] += 1;
        s.epochOpen[epoch] += 1;
    }

    /// @dev The request, which must exist, belong to `msg.sender` and still hold escrow.
    function _owned(FlowState storage s, uint256 requestId) private view returns (Request storage r) {
        r = s.requests[requestId];
        if (r.owner == address(0)) revert IFlowEvents.UnknownRequest(requestId);
        if (r.owner != msg.sender) revert IFlowEvents.NotRequestOwner(requestId, msg.sender);
        if (r.closed || r.remaining == 0) revert IFlowEvents.RequestNotPending(requestId);
    }

    function _settlement(FlowState storage s, uint256 id) private view returns (Settlement storage st) {
        if (id == 0 || id > s.settlementCount) revert IFlowEvents.UnknownSettlement(id);
        st = s.settlements[id];
    }

    function _close(FlowState storage s, Request storage r) private {
        r.closed = true;
        s.epochOpen[r.epoch] -= 1;
        s.sideOpen[uint8(r.kind)][r.epoch] -= 1;
    }

    /// @dev A claim with nothing left to deliver or to pay.
    function _done(Claim storage c) private view returns (bool) {
        return c.kind == RequestKind.Deposit ? c.claimed >= c.shares : c.sharesClaimed >= c.shares;
    }
}
