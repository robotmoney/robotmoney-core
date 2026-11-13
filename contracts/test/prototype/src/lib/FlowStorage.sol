// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md §3.1 (FlowQueue state), E8, E10, E12, E18, E20, E22;
//            docs/technical/one-vault-rebalancer-proposal.md §5.9.2, §5.9.3, §6.1 (size: logic in linked libraries)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {FlowLevers, FlowParams, Request, Claim, Settlement} from "../FlowTypes.sol";

/// @notice Every piece of FlowQueue state outside the OpenZeppelin namespaces, in one struct, so the queue's linked
///         libraries (`Flow*Lib`) take one storage reference per call. Owned by the `queue` agent after the
///         foundation agent (scaffold plan §6). Append-only once another agent reads a field.
///         Ids of requests, claims and settlements start at 1; 0 means none.
/// @param fund            The RobotMoneyFund (share token).
/// @param usdc            USDC.
/// @param usdcFeed        Chainlink USDC / USD.
/// @param usdcFeedMaxAge  Its maximum age.
/// @param sequencerFeed   Chainlink L2 sequencer uptime.
/// @param params          FlowParams (§5.9.5).
/// @param paused          EMERGENCY pause of requests and settlement.
/// @param requests        By request id.
/// @param requestCount    Last request id.
/// @param epochRequests   Request ids per epoch, in order (E18).
/// @param oldestEpoch     Hint: the oldest epoch that may still hold a pending request (settle walks from here). Any
///                        `setFlowParams` resets it to 0 (step 3 finish plan §3.1 item 3).
/// @param claims          By claim id.
/// @param claimCount      Last claim id.
/// @param claimsOf        Claim ids per owner, in order (oldest first for deposit / mint / redeem).
/// @param claimCursor     Per owner: index into `claimsOf` before which every claim is fully used.
/// @param settlements     By settlement id.
/// @param settlementCount Last settlement id.
/// @param usdcCredit      Per owner: USDC waiting for `withdrawCredit` (E22).
/// @param shareCredit     Per owner: shares waiting for `withdrawCredit` (E22).
/// @param queuedShares    Per owner: escrowed redemption shares plus undelivered deposit shares plus share credits
///                        (E13, RB-22: every share the queue holds for the owner).
/// @param depositUsed     Per period (`timestamp / epochLength`): deposit USDC settled (E20).
/// @param redeemUsed      Per period: redemption value settled, USDC (E20).
/// @param lastSettleAt    Time of the last settlement (check 5 and check 6 reference time).
/// @param lastSharePrice  NAV per share at the feeds at the last settlement, PRICE_SCALE (check 6).
/// @param lastLendRate    Per lending asset index: the venue's rate per unit at the last settlement (check 5).
/// @param totalPendingUsdc  Σ unfilled deposit escrow (conservation, eng plan §4.3).
/// @param totalEscrowShares Σ unfilled redemption escrow.
/// @param totalHeldShares   Σ deposit shares held and not yet delivered or returned.
/// @param totalOwedUsdc     Σ redemption USDC settled and not yet paid.
/// @param totalCreditUsdc   Σ usdcCredit.
/// @param totalCreditShares Σ shareCredit.
/// @custom:storage-location erc7201:robotmoney.storage.FlowQueue
struct FlowState {
    address fund;
    address usdc;
    address usdcFeed;
    uint32 usdcFeedMaxAge;
    address sequencerFeed;
    FlowParams params;
    bool paused;
    mapping(uint256 id => Request) requests;
    uint256 requestCount;
    mapping(uint64 epoch => uint256[] ids) epochRequests;
    uint64 oldestEpoch;
    mapping(uint256 id => Claim) claims;
    uint256 claimCount;
    mapping(address owner => uint256[] ids) claimsOf;
    mapping(address owner => uint256) claimCursor;
    mapping(uint256 id => Settlement) settlements;
    uint256 settlementCount;
    mapping(address owner => uint256) usdcCredit;
    mapping(address owner => uint256) shareCredit;
    mapping(address owner => uint256) queuedShares;
    mapping(uint256 period => uint256) depositUsed;
    mapping(uint256 period => uint256) redeemUsed;
    uint64 lastSettleAt;
    uint256 lastSharePrice;
    mapping(uint256 index => uint256) lastLendRate;
    uint256 totalPendingUsdc;
    uint256 totalEscrowShares;
    uint256 totalHeldShares;
    uint256 totalOwedUsdc;
    uint256 totalCreditUsdc;
    uint256 totalCreditShares;
    // ── Appended by `queue` (2026-11-11) ──
    /// @dev Per epoch: requests of that epoch not yet closed (settle and the Window check skip empty epochs).
    mapping(uint64 epoch => uint256) epochOpen;
    /// @dev Settle cursor (coordinator ruling 3): the next call continues at `epochRequests[cursorEpoch][cursorIndex]`.
    ///      A call that reaches the end of the settleable range puts it back on the oldest epoch (FlowSettleLib._walk).
    uint64 cursorEpoch;
    uint256 cursorIndex;
    /// @dev Claim ids per request (pending and claimable views).
    mapping(uint256 requestId => uint256[] ids) requestClaims;
    /// @dev Rounding dust the queue keeps on its own books, never paid to a flow user (conservation, eng plan §4.3):
    ///      USDC left over from per-request splits, shares left over from per-request splits. `sweep` sends it to
    ///      the fund with any gift (step 3 finish plan §3.1 item 7).
    uint256 dustUsdc;
    uint256 dustShares;
    // ── Appended by `fix-queue` (2026-11-12, step 3 finish plan §3.1). Since then `epochRequests`, `cursorEpoch`
    //    and `cursorIndex` above are no longer written; they stay for the layout. ──
    /// @dev Request ids per epoch and side (index `uint8(RequestKind)`), in order. Each side walks its own list, so
    ///      requests of one side that cannot fill never hold back the other side (item 2).
    mapping(uint64 epoch => uint256[] ids)[2] sideIds;
    /// @dev Per side and epoch: requests not yet closed (the walk passes over a side's empty epochs).
    mapping(uint64 epoch => uint256)[2] sideOpen;
    /// @dev Walk cursors `[class][side]`: class 0 holds the keeper's position, class 1 everyone else's. Only the
    ///      keeper's own calls move the keeper's (item 2). `epoch == 0` means: start a new pass at the oldest epoch.
    WalkCursor[2][2] cursors;
    /// @dev Epoch anchor (item 3). Epoch `e ≥ epochAnchorIndex − 1` ends at
    ///      `epochAnchorTime + (e + 1 − epochAnchorIndex) × epochLength`. Both are 0 until `epochLength` first changes,
    ///      so until then the epoch of time `t` is `t / epochLength`, as in the scaffold.
    uint64 epochAnchorIndex;
    uint64 epochAnchorTime;
    /// @dev End time of each epoch that held an open request when `epochLength` last changed (item 3). Later epochs
    ///      follow the anchor.
    mapping(uint64 epoch => uint64) epochEnd;
    /// @dev The epoch of the last settlement: check 6 counts the epochs passed from it (item 3).
    uint64 lastSettleEpoch;
    /// @dev Bit `i` set: lending asset `i` was excluded at the last settlement (check 6 reference, item 9).
    uint256 lastExcludedMask;
    /// @dev Per lending asset index: its held amount per share at the last settlement, PRICE_SCALE (item 9).
    mapping(uint256 index => uint256) lastLendPerShare;
    // ── Appended by `levers` (2026-11-12, step 3 finish plan §3.2). All zero: no lever, the design as written. ──
    /// @dev The attack-finding levers (`FlowLevers`), set by ADMIN_ROLE through `setFlowLevers`.
    FlowLevers levers;
    /// @dev The block of the last settlement that traded while `levers.basketCallBps` was on.
    uint64 leverTradeBlock;
    // ── Appended by the review fixes of 2026-11-12 (proposal §14). ──
    /// @dev USDC value each side already traded in `leverTradeBlock`: the per-call cap is a per-block budget, so a
    ///      small call in a block takes only its own part, not the whole block's room (review Q-F2).
    uint128 leverBlockDep;
    uint128 leverBlockRed;
    /// @dev The exclusion ledger's record count at the last settlement (check 6, review Q-F3).
    uint256 lastExclusionCount;
}

/// @notice Where a settle walk continues on one side (step 3 finish plan §3.1 item 2). `epoch == 0` means "start a new
///         pass at the oldest epoch in range" (epoch 0 is 1970 and is never in range).
struct WalkCursor {
    uint64 epoch;
    uint192 index;
}

/// @title FlowStorage
/// @notice ERC-7201 namespaced location of `FlowState` (`robotmoney.storage.FlowQueue`).
library FlowStorage {
    /// @dev keccak256(abi.encode(uint256(keccak256("robotmoney.storage.FlowQueue")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT =
        0x5ca698e4220eb646640b8313725773ea79d9bb0180fc107a75b91aa030545000;

    function layout() internal pure returns (FlowState storage $) {
        bytes32 slot = SLOT;
        assembly {
            $.slot := slot
        }
    }
}

/// @title FlowEpochs
/// @notice Epoch arithmetic that survives a change of `epochLength` (step 3 finish plan §3.1 item 3).
///
///         The scaffold computed an epoch as `timestamp / epochLength` everywhere. A new length then re-indexed every
///         epoch: open requests kept indices of the old scale, so after a longer length they lay in the "future"
///         (nothing could settle, every settle reverted `Window`) and after a shorter one they lay below the range
///         (orphaned, read as expired). Here indices only ever grow. A new length applies from the end of the epoch
///         in progress, which keeps its own end; epochs closed before keep theirs too (`epochEnd`). Settlement order,
///         expiry in epochs and the cap periods all count these indices.
library FlowEpochs {
    /// @notice The epoch in progress now.
    function current(FlowState storage s) internal view returns (uint64) {
        uint256 t0 = s.epochAnchorTime;
        if (block.timestamp < t0) return s.epochAnchorIndex - 1;
        return uint64(s.epochAnchorIndex + (block.timestamp - t0) / s.params.epochLength);
    }

    /// @notice When epoch `e` ends; its requests may settle from `endOf(e) + settleWindow`. For an epoch older than the
    ///         last change of `epochLength` that held no open request then, an upper bound (`epochAnchorTime`).
    function endOf(FlowState storage s, uint64 e) internal view returns (uint256) {
        uint256 stored = s.epochEnd[e];
        if (stored != 0) return stored;
        uint256 i0 = s.epochAnchorIndex;
        uint256 t0 = s.epochAnchorTime;
        if (uint256(e) + 1 >= i0) return t0 + (uint256(e) + 1 - i0) * s.params.epochLength;
        return t0;
    }

    /// @notice The newest epoch, at or above `floor`, that ended at or before time `t` and can hold a request
    ///         (`found` false if none). Ends grow with the index, so every epoch from `floor` to it ended by `t`.
    function newestEndedBy(FlowState storage s, uint256 t, uint64 floor)
        internal
        view
        returns (bool found, uint64 e)
    {
        uint256 i0 = s.epochAnchorIndex;
        uint256 t0 = s.epochAnchorTime;
        if (t >= t0) {
            // Epochs below i0 − 1 ended by t0 ≤ t; epoch e ≥ i0 − 1 ended by t iff e + 1 − i0 ≤ (t − t0) / L.
            uint256 n = i0 + (t - t0) / s.params.epochLength;
            if (n == 0 || n - 1 < floor) return (false, 0);
            return (true, uint64(n - 1));
        }
        // t < t0: only an epoch below i0 − 1 can have ended by t. One that can hold a request has its end stored.
        if (i0 < 2) return (false, 0);
        for (uint256 k = i0 - 2; k >= floor; --k) {
            uint256 end = s.epochEnd[uint64(k)];
            if (end != 0 && end <= t) return (true, uint64(k));
            if (k == 0) break;
        }
        return (false, 0);
    }
}
