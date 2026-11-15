// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.2 (epoch), §5.9.3 (settlement), §5.9.4 (exits and
//            emergency powers), §5.9.6 (the vault interface), §7 (RB-10 to RB-18, RB-20 to RB-22);
//            docs/technical/one-vault-timed-flows-eng-plan.md E1, E2, E8, E10 to E13, E17, E18, E20 to E22, §3.1
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {
    FlowBooks,
    FlowParams,
    IFlowEvents,
    QueueLiveness,
    Quote,
    Request,
    RequestKind,
    RequestStatus,
    Claim,
    Settlement,
    SettleCheck
} from "../FlowTypes.sol";

/// @title IFlowQueue
/// @notice The entry point for timed, netted, forward-priced deposits and redemptions of the one fund (E1, E2, E24-E42).
///         Authority:
///         - KEEPER_ROLE: `settle` (keeper-only, E34).
///         - EMERGENCY_ROLE: self-expiring `pauseQueue` (with cooldown, E39), rate-limited `freezeSettlement` (E49).
///         - ADMIN_ROLE (timelock): `unpauseQueue`, `setFlowParams`, `releaseSettlement`.
///         - A request's owner: `cancel` (cutoff + stop windows), `withdrawExpired` (deposits), `giveRedemptionNotice`
///           (redemptions > `maxRoll`), `redeem`.
///         - Fund only: `onShutdown()` (releases active escrows on wind-down).
interface IFlowQueue is IFlowEvents {
    // ═════════════════════════════════════════════════════════════════════════
    //  Requests (§5.9.2 step 1, §5.11.3, E25, E40, E41)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Pull `usdc` from the caller into escrow and open a forward-priced deposit request owned by `owner`.
    function requestDeposit(uint256 usdc, address owner)
        external
        returns (uint256 requestId);

    /// @notice Calls the fund's `ledgerCheckpoint(owner)` first (E13, RB-22), then pulls `shares` of the fund from
    ///         the caller into escrow and open a forward-priced redemption request owned by `owner`.
    function requestRedeem(uint256 shares, address owner)
        external
        returns (uint256 requestId);

    /// @notice Owner cancels unfilled escrow before `endOf(epoch) - cancelBuffer`, during a deposit stop (deposits),
    ///         or during wind-down. Credited to `withdrawCredit`.
    function cancel(uint256 requestId) external;

    /// @notice Owner withdraws escrow of an expired Deposit request (`cur > expiryEpoch`). Redemptions never expire.
    function withdrawExpired(uint256 requestId) external returns (uint256 amount);

    /// @notice Owner gives post-`maxRoll` redemption notice (`E40`). Returns unfilled shares after `noticeRound` ends.
    function giveRedemptionNotice(uint256 requestId) external returns (uint64 noticeRound);

    /// @notice Moves unfilled shares of a noticed redemption into `shareCredit` once `noticeRound` has ended.
    function claimNoticeReturn(uint256 requestId) external returns (uint256 shares);

    /// @notice Fund-only hook called by `RobotMoneyFund.shutdown()` to release active queue escrows on wind-down.
    function onShutdown() external;

    /// @notice Releases `owner`'s wind-down queued escrows into `creditOf(owner)` after checkpointing the ledger.
    function releaseWindDown(address owner) external returns (uint256 usdc, uint256 shares);

    /// @notice The caller withdraws every USDC and share credit booked to it (`withdrawCredit`).
    function withdrawCredit() external returns (uint256 usdc, uint256 shares);

    // ═════════════════════════════════════════════════════════════════════════
    //  Settlement (§5.9.3, §5.11.4, E24, E34, E35, E36, E42)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Keeper-only round settlement (`KEEPER_ROLE`). First call books Whole Match `M` O(1); subsequent calls trade net side.
    function settle(uint256 maxRequests, uint256 maxUsdc) external returns (uint256 settlementId);

    /// @notice The first check of §5.9.3 that fails right now for caller `msg.sender`. Never reverts.
    function checkSettle() external view returns (SettleCheck check, uint256 index);

    // ═════════════════════════════════════════════════════════════════════════
    //  Claims (ERC-7540 shape, E8, RB-10, RB-11)
    // ═════════════════════════════════════════════════════════════════════════

    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function mint(uint256 shares, address receiver) external returns (uint256 assets);
    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets);
    function withdraw(uint256 assets, address receiver, address owner)
        external
        returns (uint256 shares);

    // ═════════════════════════════════════════════════════════════════════════
    //  Emergency powers (§5.9.4, §5.11.5, E17, E39, E49)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice EMERGENCY_ROLE. Freeze deposit shares of settlement `id` while in hold (`<= maxFreeze`, max 1 per `maxFreeze`).
    function freezeSettlement(uint256 id) external;

    /// @notice ADMIN_ROLE. End the freeze of settlement `id`.
    function releaseSettlement(uint256 id) external;

    /// @notice EMERGENCY_ROLE. Self-expiring pause (`now + maxPause`), reverts `PauseOnCooldown` before `end + maxPause`.
    function pauseQueue() external;

    /// @notice ADMIN_ROLE. Clears `queuePausedUntil` early (cooldown still applies from previous end).
    function unpauseQueue() external;

    /// @notice ADMIN_ROLE, inside hard bounds of FlowTypes (`E51`).
    function setFlowParams(FlowParams calldata params) external;

    // ═════════════════════════════════════════════════════════════════════════
    //  Views
    // ═════════════════════════════════════════════════════════════════════════

    function share() external view returns (address);
    function asset() external view returns (address);
    function flowParams() external view returns (FlowParams memory);
    function feeds()
        external
        view
        returns (address usdcFeed, uint32 usdcFeedMaxAge, address sequencerFeed);
    function queuePaused() external view returns (bool);
    function queuePausedUntil() external view returns (uint64);
    function liveness() external view returns (QueueLiveness memory);
    function currentEpoch() external view returns (uint64);
    function settleableAt(uint64 epoch) external view returns (uint64);
    function getRequest(uint256 requestId) external view returns (Request memory);
    function requestStatus(uint256 requestId) external view returns (RequestStatus);
    function getClaim(uint256 claimId) external view returns (Claim memory);
    function getSettlement(uint256 settlementId) external view returns (Settlement memory);
    function epochRequests(uint64 epoch) external view returns (uint256[] memory);
    function requestCount() external view returns (uint256);
    function claimCount() external view returns (uint256);
    function settlementCount() external view returns (uint256);
    function creditOf(address owner) external view returns (uint256 usdc, uint256 shares);
    function periodFlow(uint256 period)
        external
        view
        returns (uint256 depositUsdc, uint256 redeemUsdc);

    /// @notice Queued shares held for `account` at the current match index (escrowed + matched deposit + held + credits).
    function queuedSharesOf(address account) external view returns (uint256);

    /// @notice Current match indexes `(depIdx, redIdx)` stored by `FundExclusionLedger` when an exclusion opens (E52).
    function currentMatchIndexes()
        external
        view
        returns (uint256[2] memory depIdx, uint256[2] memory redIdx);

    /// @notice Historical queued shares of `account` evaluated at stored indexes `(depIdx, redIdx)` (E52, RB-22).
    function queuedSharesOfAt(
        address account,
        uint256[2] calldata depIdx,
        uint256[2] calldata redIdx
    ) external view returns (uint256);

    /// @notice Terms for a deposit of `usdc` made now: fee, cancel cutoff, earliest settle, hold end, and guard bands.
    function quoteDeposit(uint256 usdc) external view returns (Quote memory);

    /// @notice Terms for a redemption of `shares` made now: fee, cancel cutoff, earliest settle, hold end, and guard bands.
    function quoteRedeem(uint256 shares) external view returns (Quote memory);

    function pendingDepositRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256 assets);
    function claimableDepositRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256 assets);
    function pendingRedeemRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256 shares);
    function claimableRedeemRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256 shares);
    function maxDeposit(address owner) external view returns (uint256 assets);
    function maxMint(address owner) external view returns (uint256 shares);
    function maxRedeem(address owner) external view returns (uint256 shares);
    function previewDeposit(uint256 assets) external view returns (uint256);
    function previewMint(uint256 shares) external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function previewWithdraw(uint256 assets) external view returns (uint256);
    function books() external view returns (FlowBooks memory);
    function sweep() external returns (uint256 usdc, uint256 shares);
    function settleCursor(bool keeperClass, RequestKind kind)
        external
        view
        returns (uint64 epoch, uint256 index);
}
