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
    Quote,
    Request,
    RequestKind,
    RequestStatus,
    Claim,
    Settlement,
    SettleCheck
} from "../FlowTypes.sol";

/// @title IFlowQueue
/// @notice The entry point for timed deposits and redemptions of the one fund (E1, E2; ERC-7575 split of entry point
///         and share, ERC-7540 request and claim shape, with the departures of proposal §5.9.6). It holds pending
///         USDC, escrowed redemption shares and deposit shares in their hold. It holds none of the fund's assets.
///
///         Units: USDC amounts are 6-decimal USDC units; share amounts are raw fund share units; prices are
///         `usdc × PRICE_SCALE / shares` (FundTypes, 1e36). INTERFACES.md in the scaffold run directory lists the
///         caller, units and rounding of every function.
///
///         Authority:
///         - KEEPER_ROLE: `settle` at once; anyone else only after `keeperGrace` (E10).
///         - EMERGENCY_ROLE: `pause`, `freezeSettlement`.
///         - ADMIN_ROLE (timelock): `unpause`, `setFlowParams`, `releaseSettlement`, `allowReturn`.
///         - A request's owner: `cancel`, `exitInKind`, `withdrawExpired`, `redeem`. Credits: `withdrawCredit`.
///         - Anyone: requests (escrow from the caller only), `deposit` / `mint` (deliver to the owner only), views.
///         One reentrancy lock covers every state-changing entry point (eng plan §3.1).
///         Cancel, in-kind exit and every withdrawal stay open while paused (RB-15).
interface IFlowQueue is IFlowEvents {
    // ═════════════════════════════════════════════════════════════════════════
    //  Requests (§5.9.2 step 1)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Pull `usdc` from the caller into escrow and open a deposit request owned by `owner`. Reverts while
    ///         paused, `BelowMinRequest`, `AbovePerDepositCap`, `ZeroAddress`. Never changes an existing request.
    /// @param maxUsdcPerShare The most USDC per share the owner accepts (PRICE_SCALE). The request takes part in a
    ///                        settlement only if the deposit bound price is at or below it (E12, RB-14).
    function requestDeposit(uint256 usdc, uint256 maxUsdcPerShare, address owner) external returns (uint256 requestId);

    /// @notice Calls the fund's `ledgerCheckpoint(owner)` first (E13, RB-22), then pulls `shares` of the fund from
    ///         the caller into escrow and opens a redemption request owned by `owner`. Reverts while paused,
    ///         `BelowMinRequest` (valued at `lastGoodNav`; a redemption of the caller's whole balance is exempt).
    /// @param minUsdcPerShare The least USDC per share after the exit fee the owner accepts (PRICE_SCALE).
    function requestRedeem(uint256 shares, uint256 minUsdcPerShare, address owner) external returns (uint256 requestId);

    /// @notice The owner cancels the unfilled part of a pending or expired request; it goes to the owner's credit
    ///         (`withdrawCredit`, E22). Ledger hook first for a redemption. Open while paused.
    function cancel(uint256 requestId) external;

    /// @notice The owner takes the unfilled shares of a redemption request out at once through the fund's
    ///         `redeemInKind(shares, owner, queue)`; the assets go to the owner (E9). Ledger hook first. Open while
    ///         paused and whatever any price says.
    function exitInKind(uint256 requestId) external;

    /// @notice The owner withdraws the escrow of a request that expired after `maxRoll` epochs (E18). Pays the
    ///         owner (pull, E22). Ledger hook first for a redemption.
    function withdrawExpired(uint256 requestId) external returns (uint256 amount);

    /// @notice The caller withdraws every USDC and share credit booked to it (cancels, unused purchase USDC,
    ///         refunds, E22). Reverts `NothingToWithdraw`.
    function withdrawCredit() external returns (uint256 usdc, uint256 shares);

    // ═════════════════════════════════════════════════════════════════════════
    //  Settlement (§5.9.3, E7, E10, RB-16, RB-20)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Run the twelve steps of proposal §5.9.3 in one transaction, oldest request first. A failed check
    ///         reverts `SettleBlocked` (or the fund's own error) and changes no state. The inputs only limit this
    ///         call's work (RB-20): the most requests to process and the most USDC of deposits to process.
    ///         Anyone may call again at once to continue.
    /// @return settlementId The settlement recorded (0 when nothing took part).
    function settle(uint256 maxRequests, uint256 maxUsdc) external returns (uint256 settlementId);

    /// @notice The first check of §5.9.3 that fails right now for the caller `msg.sender`, with the asset index
    ///         (IDLE_INDEX when not asset-specific). Never reverts. `Ok` when every pre-trade check passes.
    function checkSettle() external view returns (SettleCheck check, uint256 index);

    // ═════════════════════════════════════════════════════════════════════════
    //  Claims (ERC-7540 shape, E8, RB-10, RB-11)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Deliver unlocked, unfrozen deposit shares of `receiver`'s claims, oldest first, up to `assets` of
    ///         their USDC cost. Anyone may call. The shares always go to `receiver`, who must be the claims' owner.
    /// @return shares Shares delivered (rounded DOWN within a partly used claim).
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    /// @notice Deliver exactly `shares` unlocked, unfrozen deposit shares of `receiver`'s claims. Anyone may call.
    /// @return assets Their USDC cost (rounded UP within a partly used claim).
    function mint(uint256 shares, address receiver) external returns (uint256 assets);

    /// @notice The owner (msg.sender == `owner`) takes the settled USDC of `shares` burned shares of its
    ///         redemption claims, oldest first, paid to `receiver`.
    /// @return assets USDC paid (rounded DOWN within a partly used claim).
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);

    /// @notice Not offered (§5.9.6). Reverts `RedeemOnly`.
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);

    // ═════════════════════════════════════════════════════════════════════════
    //  Emergency powers (§5.9.4, E17, RB-18): each can only delay or return
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice EMERGENCY_ROLE. Freeze the deposit shares of settlement `id` while they are in their hold, until
    ///         at most `now + maxFreeze`. A freeze ends by itself.
    function freezeSettlement(uint256 id) external;

    /// @notice ADMIN_ROLE. End the freeze of settlement `id`. Its claims deliver normally after their unlock time.
    function releaseSettlement(uint256 id) external;

    /// @notice ADMIN_ROLE. Let each depositor of the frozen settlement `id` take its own slice back in kind
    ///         (`takeReturn`). Nobody else can receive it.
    function allowReturn(uint256 id) external;

    /// @notice The owner of deposit claim `claimId` of a settlement under `allowReturn` takes its undelivered
    ///         shares out through the fund's `redeemInKind(shares, owner, queue)`.
    function takeReturn(uint256 claimId) external;

    /// @notice EMERGENCY_ROLE. Pause requests and settlement. Cancel, in-kind exit and withdrawals stay open.
    function pause() external;

    /// @notice ADMIN_ROLE.
    function unpause() external;

    /// @notice ADMIN_ROLE, inside the hard bounds of FlowTypes (`FlowParamOutOfBounds`).
    function setFlowParams(FlowParams calldata params) external;

    // ═════════════════════════════════════════════════════════════════════════
    //  Views
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice ERC-7575: the fund (the share token).
    function share() external view returns (address);

    /// @notice ERC-7575: USDC.
    function asset() external view returns (address);

    function flowParams() external view returns (FlowParams memory);

    /// @notice The USDC / USD feed, its maximum age, and the sequencer uptime feed.
    function feeds() external view returns (address usdcFeed, uint32 usdcFeedMaxAge, address sequencerFeed);

    function paused() external view returns (bool);

    /// @notice Epoch index of `block.timestamp` (`block.timestamp / epochLength`).
    function currentEpoch() external view returns (uint64);

    /// @notice Time the settlement window of `epoch` ends: `(epoch + 1) × epochLength + settleWindow`.
    function settleableAt(uint64 epoch) external view returns (uint64);

    function getRequest(uint256 requestId) external view returns (Request memory);
    function requestStatus(uint256 requestId) external view returns (RequestStatus);
    function getClaim(uint256 claimId) external view returns (Claim memory);
    function getSettlement(uint256 settlementId) external view returns (Settlement memory);
    /// @notice Request ids made in `epoch`, in order (E18).
    function epochRequests(uint64 epoch) external view returns (uint256[] memory);
    function requestCount() external view returns (uint256);
    function claimCount() external view returns (uint256);
    function settlementCount() external view returns (uint256);

    /// @notice USDC and share credits of `owner` waiting for `withdrawCredit`.
    function creditOf(address owner) external view returns (uint256 usdc, uint256 shares);

    /// @notice USDC used on each side in clock-time period `period` (`timestamp / epochLength`, E20).
    function periodFlow(uint256 period) external view returns (uint256 depositUsdc, uint256 redeemUsdc);

    /// @notice Escrowed redemption shares plus deposit shares held (not yet delivered) for `account` (E13, RB-22).
    function queuedSharesOf(address account) external view returns (uint256);

    /// @notice E21: worst case for a deposit of `usdc` made now. Never better than what a settlement in this block
    ///         would allow.
    function quoteDeposit(uint256 usdc) external view returns (Quote memory);

    /// @notice E21: worst case for a redemption of `shares` made now.
    function quoteRedeem(uint256 shares) external view returns (Quote memory);

    /// @notice ERC-7540: unfilled USDC of a pending deposit request of `controller` (its owner).
    function pendingDepositRequest(uint256 requestId, address controller) external view returns (uint256 assets);

    /// @notice ERC-7540: USDC cost of the unlocked, unfrozen, undelivered shares of that request's claims.
    function claimableDepositRequest(uint256 requestId, address controller) external view returns (uint256 assets);

    /// @notice ERC-7540: unfilled shares of a pending redemption request.
    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);

    /// @notice ERC-7540: burned shares of that request's claims whose USDC is not yet taken.
    function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);

    /// @notice ERC-7540 claim limits: what `deposit` / `mint` / `redeem` can take for `owner` now.
    function maxDeposit(address owner) external view returns (uint256 assets);
    function maxMint(address owner) external view returns (uint256 shares);
    function maxRedeem(address owner) external view returns (uint256 shares);

    /// @notice ERC-7540: previews revert for asynchronous flows (`PreviewNotSupported`). Use the quotes.
    function previewDeposit(uint256 assets) external view returns (uint256);
    function previewMint(uint256 shares) external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function previewWithdraw(uint256 assets) external view returns (uint256);

    // ── Appended by `queue` ──

    /// @notice The queue's own books (conservation, eng plan §4.3). See `FlowBooks`.
    function books() external view returns (FlowBooks memory);

    // ── Appended by `fix-queue` (2026-11-12, step 3 finish plan §3.1) ──

    /// @notice Anyone. Send the USDC and the shares the queue holds above its obligations (pending, owed and credited
    ///         USDC; escrowed, held and credited shares) to the fund: gifts and rounding dust. USDC raises the fund's
    ///         idle USDC (a gift to holders). Shares join the fund's own seed shares, which never move. Booked value
    ///         never moves (item 7).
    function sweep() external returns (uint256 usdc, uint256 shares);

    /// @notice Where `settle` continues on side `kind`: the keeper's own position (`keeperClass`) or everyone else's.
    ///         `epoch == 0`: the next call starts a new pass at the oldest epoch (item 2).
    function settleCursor(bool keeperClass, RequestKind kind) external view returns (uint64 epoch, uint256 index);
}
