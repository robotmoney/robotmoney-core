// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9 (hardened flows: §5.9.2 epoch, §5.9.3 settlement,
//            §5.9.4 exits, §5.9.5 defaults, §5.9.6 interface), §7 (RB-10 to RB-18, RB-20 to RB-22);
//            docs/technical/one-vault-timed-flows-eng-plan.md E1, E2, E7, E8, E10 to E12, E17, E18, E20 to E22, §3.1
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

// ═══════════════════════════════════════════════════════════════════════════
//  Shared types of the FlowQueue (step 3d). Imported by the queue, its linked
//  libraries, the tests and the harness. Append-only after the foundation
//  agent: a field, an event or an error may be added; nothing another agent
//  uses may be renamed or removed (scaffold plan §6).
//
//  Units used everywhere below:
//  - USDC: 6-decimal USDC units.
//  - shares: raw fund share units (10^18 per USDC unit at the seed scale).
//  - price: `usdc × PRICE_SCALE / shares` (FundTypes.PRICE_SCALE = 1e36; par at the seed scale is 1e18).
//  - bps: of 10 000.
// ═══════════════════════════════════════════════════════════════════════════

// ─── FlowParams hard bounds (eng plan §2 "hard bounds fixed in the code") ──
//
// `setFlowParams` refuses any value outside these, and any combination that would stop every settlement
// (quorum above slices, a settle window not divisible into whole slices, a slice under MIN_SLICE_SECONDS).

uint32 constant MIN_EPOCH_LENGTH = 1 hours;
uint32 constant MAX_EPOCH_LENGTH = 7 days;
uint32 constant MIN_SETTLE_WINDOW = 10 minutes;
uint32 constant MAX_SETTLE_WINDOW = 1 days;
// Coordinator ruling 8 (2026-11-11) and proposal §5.9.5: `minHold` in [1 hour, 7 days], `maxFreeze` at most 14 days.
// Owner, 2026-11-13 (decision D4-11): the floor moved from 1 day to 1 hour, and 1 hour is the working default: the price
// manipulations the hold guards against cannot be sustained for an hour on assets with large pools.
uint32 constant MIN_HOLD = 1 hours;
uint32 constant MAX_HOLD = 7 days;
/// @dev Safety review 0.9.0 (agy MISSED-01): open requests one owner may hold per side. Every lazy owner sync walks
///      the owner's open list, so an unbounded list made one owner's sync, and the round enrollment that runs it per
///      request, quadratic in the list length.
uint256 constant MAX_OWNER_OPEN_REQUESTS = 16;
/// @dev Safety review 0.9.0 (agy MISSED-01): requests a round's enrollment enrolls per `settle` call (each checkpoints
///      the exclusion ledger and syncs its owner), requests it visits per call (a skip of a closed or expired request
///      is cheap), and noticed redemptions one call returns. A larger round takes more keeper calls, each under the
///      per-tx gas cap.
uint256 constant ENROLL_BUDGET = 32;
uint256 constant ENROLL_VISIT_MAX = 256;
/// @dev A call whose enrollment visited more than this many requests ends there, and the next call books the match and
///      walks the sides. A light round (the usual case) still enrolls and settles in one call.
uint256 constant ENROLL_PROCEED_MAX = 8;
/// @dev Gas one enrollment batch may use before it ends (after at least one enrollment): an owner sync is not a
///      fixed cost, so the count budgets above do not bound a call by themselves.
uint256 constant ENROLL_GAS_MAX = 4_000_000;
uint256 constant NOTICE_BUDGET = 16;
uint32 constant MIN_CANCEL_BUFFER = 1 minutes;
uint32 constant MAX_CANCEL_BUFFER = 6 hours;
uint32 constant DEFAULT_CANCEL_BUFFER = 15 minutes;
/// @dev E51 reference delay. The queue does not read the live timelock. The timelock's delay is an operating setting
///      (the Deploy 4 rehearsal runs 15 minutes), and a bound that followed it would make every default parameter set
///      invalid there. The bound is this constant: `maxRoll * epochLength <= TIMELOCK_DELAY_REFERENCE` and
///      `maxPause >= TIMELOCK_DELAY_REFERENCE + epochLength`. It is the longest delay the release runbook may schedule.
///      `FlowQueue.t.sol` tests both edges.
uint32 constant TIMELOCK_DELAY_REFERENCE = 48 hours;
uint32 constant MIN_MAX_PAUSE = 48 hours;
uint32 constant MAX_PAUSE_DURATION = 14 days;
uint32 constant DEFAULT_MAX_PAUSE = 72 hours;
/// @dev Default match band (bps of NAV, plan 8.5): the whole match books only when TWAP NAV is this close to feed NAV.
uint16 constant DEFAULT_MATCH_BAND_BPS = 10;
uint16 constant MAX_EPOCH_FLOW_BPS = 10_000;
uint128 constant MAX_EPOCH_FLOW_FLOOR_USDC = 100_000_000e6;
uint16 constant MAX_SHARE_PRICE_MOVE_BPS = 5_000;
uint16 constant MAX_ROLL = 64;
uint128 constant MAX_MIN_REQUEST_USDC = 1_000_000e6;
uint32 constant MIN_FREEZE = 1 hours;
uint32 constant MAX_FREEZE = 14 days;
uint8 constant MIN_SLICES = 3;
uint8 constant MAX_SLICES = 48;
uint32 constant MIN_SLICE_SECONDS = 60;
uint16 constant MAX_DISPERSION_BPS = 2_000;
uint16 constant MAX_REF_BAND_BPS = 2_000;
uint16 constant MAX_LEG_BAND_BPS = 2_000;
uint32 constant MAX_SEQUENCER_GRACE = 1 days;
uint16 constant MAX_USDC_PEG_BAND_BPS = 1_000;
uint16 constant MAX_LEND_RATE_GROWTH_BPS = 1_000;

// ─── Enums ──────────────────────────────────────────────────────────────────

/// @notice Which side a request or a claim is on.
enum RequestKind {
    Deposit,
    Redeem
}

/// @notice Life of a request (§5.9.2, E40). A request may fill in parts (match and/or net, each fill is a claim, E8).
///         `Pending` covers a partly filled request (redemptions never expire by time). `Expired` is reported for an
///         unfilled deposit once `maxRoll` epochs passed; the escrow waits for `withdrawExpired`. `Closed` means
///         nothing is left in escrow for it: filled completely, cancelled, notice returned, wind-down released, or
///         expired deposit withdrawn.
enum RequestStatus {
    None,
    Pending,
    Expired,
    Closed
}

/// @notice The checks of proposal §5.9.3 and §5.11.4, in order (E7, E33, E34, E36). `checkSettle` returns the first
///         that fails; `settle` reverts `SettleBlocked` with it. `Ok` means every pre-trade check passes.
///         `LendRate` no longer gates `settle` (E36/SAFE-09: it closes deposits/match for the round while redemptions
///         still settle); `market()` and `checkSettle()` keep `SettleCheck.LendRate` informational for quotes/views.
enum SettleCheck {
    /// @dev Every pre-trade check passes.
    Ok,
    /// @dev Check 1: no epoch with a pending request has its settlement window ended.
    Window,
    /// @dev Check 1: caller does not hold `KEEPER_ROLE` (E34).
    Caller,
    /// @dev Check 1: the queue is paused or the fund is in wind-down.
    Paused,
    /// @dev Check 2: the sequencer feed reports down or is inside `sequencerGrace`.
    Sequencer,
    /// @dev Check 2: a non-`inSale` basket asset's feed is stale, not positive, incomplete or unreadable.
    Feed,
    /// @dev Check 2: the USDC / USD feed is unhealthy or outside `usdcPegBandBps`.
    UsdcPeg,
    /// @dev Check 3: fewer than `quorum` slices sit within `dispersionBps` of the median. `index` names the asset.
    TwapQuorum,
    /// @dev Check 4: a non-`inSale` TWAP is more than `refBandBps` from its feed. `index` names the asset.
    TwapVsFeed,
    /// @dev Check 5: a lending venue's rate per unit grew more than `maxLendRateGrowthBps` per day.
    LendRate,
    /// @dev Check 6: NAV per share at the feeds moved more than `maxSharePriceMoveBps` per epoch passed.
    SharePrice,
    /// @dev Check 8: a sale returned less than its limit (raised by the fund as `FlowLegLimit`).
    RedeemLeg,
    /// @dev Check 9: a purchase needed more than its limit (raised by the fund as `FlowLegLimit`).
    DepositLeg,
    /// @dev Check 10: the fund's proportion check failed (raised by the fund as `ProportionViolated`).
    Proportion,
    /// @dev Check 11: the net-side realized price is outside the per-swap limits (E33).
    RealizedPrice
}

// ─── Structs ────────────────────────────────────────────────────────────────

/// @notice Every queue parameter of proposal §5.9.5 and §5.11 (D39, E39, E51).
///         `ADMIN_ROLE` sets it through the timelock inside the hard bounds above.
/// @param epochLength          Epoch length and the clock-time period of each flow cap (§5.9.5: 6 h).
/// @param settleWindow         Wait after an epoch closes before it may settle; also the TWAP window (1 h).
/// @param minHold              Hold of deposit shares after their settlement (1 h, D4-11).
/// @param keeperGrace          Retired in Step 3f (`settle()` is KEEPER_ROLE-only, E34); kept at index 3
///                             for storage and tuple compatibility.
/// @param maxEpochFlowBps      Each side's cap per period, in bps of NAV at the feeds (500, E20).
/// @param epochFlowFloorUsdc   Each side's cap is at least this (250 000 USDC, E20).
/// @param maxSharePriceMoveBps Share-price breaker per epoch passed since the last settlement (1 000, check 6).
/// @param maxRoll              Epochs after which an unfilled deposit expires / redemption notice unlocks (8, E18/E40).
/// @param minRequestUsdc       Least request size (100 USDC, E11); a whole-balance redemption is exempt.
/// @param maxFreeze            Longest freeze of one settlement's deposit shares (7 days, E17).
/// @param slices               Equal slices of `settleWindow` for the TWAP median (12, E6).
/// @param quorum               Slices that must sit within `dispersionBps` of the median (9, check 3).
/// @param dispersionBps        Slice band around the median (100, check 3).
/// @param refBandBps           TWAP against feed band (90, check 4).
/// @param legBandBps           Per-swap limit band around the stricter of feed and TWAP (100, checks 8 and 9).
/// @param sequencerGrace       Time the sequencer must have been up (1 h, check 2).
/// @param usdcPegBandBps       USDC / USD band around 1 (50, check 2).
/// @param maxLendRateGrowthBps Most growth per day of a venue's rate per unit (10, check 5).
/// @param cancelBuffer         Seconds before epoch close when `cancel` locks (15 min default, D39).
/// @param maxPause             Duration (and cooldown for `pauseQueue`/`pauseRebalance`) of self-expiring pauses (72 h, E39).
/// @param matchBandBps         Match band (plan 8.5 fallback): the whole match books only when the TWAP NAV sits within
///                             this many bps of the feed NAV. Tighter than `refBandBps`. Outside it the round nets at
///                             the feed price with no match. Must be at most `refBandBps`.
struct FlowParams {
    uint32 epochLength;
    uint32 settleWindow;
    uint32 minHold;
    uint32 keeperGrace;
    uint16 maxEpochFlowBps;
    uint128 epochFlowFloorUsdc;
    uint16 maxSharePriceMoveBps;
    uint16 maxRoll;
    uint128 minRequestUsdc;
    uint32 maxFreeze;
    uint8 slices;
    uint8 quorum;
    uint16 dispersionBps;
    uint16 refBandBps;
    uint16 legBandBps;
    uint32 sequencerGrace;
    uint16 usdcPegBandBps;
    uint16 maxLendRateGrowthBps;
    uint32 cancelBuffer;
    uint32 maxPause;
    uint16 matchBandBps;
}

/// @notice `FlowQueue.initialize` parameters.
struct FlowQueueInit {
    address fund;
    address usdc;
    address admin;
    address emergency;
    address keeper;
    address usdcFeed;
    uint32 usdcFeedMaxAge;
    address sequencerFeed;
    FlowParams params;
}

/// @notice One forward-priced request (E25, E40, E41, E52).
/// @param owner                Owns the request and every claim from it. Named by the caller; never changed.
/// @param kind                 Deposit or Redeem.
/// @param epoch                Epoch index the request was made in.
/// @param amount               Escrowed at the request: USDC (Deposit) or shares (Redeem).
/// @param remaining            Last synced unfilled escrow (views compute current live remaining from match index).
/// @param closed               Nothing is left in escrow for this request.
/// @param exitFeeBps           Redeem only: Fund `exitFeeBps` snapshotted at creation (E41).
/// @param minHold              Deposit only: Queue `minHold` snapshotted at creation (E41).
/// @param maxRoll              Queue `maxRoll` snapshotted at creation (E41).
/// @param createdAt            Timestamp at creation (for deposit-stop cancel window check).
/// @param expiryEpoch          `epoch + maxRoll` at creation.
/// @param expiresAt            Deposit: end of `expiryEpoch`; Redeem: `type(uint64).max` (never expires).
/// @param noticeRound          Redeem only: target round epoch when `giveRedemptionNotice` was given (0 = none).
/// @param era                  Queue wind-down era when created (`windDownEra`).
/// @param enrolled             True once enrolled into the active match pool.
/// @param matchCycle           Cycle in which this request enrolled (`depCycle` or `redCycle`).
/// @param normBasis            Factor-normalized escrow basis in `matchCycle`.
/// @param entryCumScaled       Redeem only: tier cumulative USDC per normBasis at last sync/enroll.
/// @param entryUnmatchedFactor Unmatched factor at creation/enroll/last sync (Redeem).
/// @param nextMatchId          Deposit only: next `depMatches` index to materialize for this request.
struct Request {
    address owner;
    RequestKind kind;
    uint64 epoch;
    uint256 amount;
    uint256 remaining;
    bool closed;
    uint16 exitFeeBps;
    uint32 minHold;
    uint16 maxRoll;
    uint64 createdAt;
    uint64 expiryEpoch;
    uint64 expiresAt;
    uint64 noticeRound;
    uint64 era;
    bool enrolled;
    uint256 matchCycle;
    uint256 normBasis;
    uint256 entryCumScaled;
    uint256 entryUnmatchedFactor;
    uint256 nextMatchId;
}

/// @notice One fill of one request (E8: each fill is its own claim with its own unlock time).
/// @param requestId    The request it came from.
/// @param owner        The request's owner. The only receiver (RB-11).
/// @param kind         Deposit (shares held until `unlockAt`) or Redeem (USDC claimable at once).
/// @param settlementId The settlement that made it (the freeze is per settlement, E17).
/// @param unlockAt     Deposit: settlement time + `minHold`. Redeem: settlement time.
/// @param shares       Deposit: shares held for the owner. Redeem: shares burned.
/// @param usdc         Deposit: USDC spent for them. Redeem: USDC owed to the owner (net of the exit fee).
/// @param claimed      Deposit: shares already delivered or returned. Redeem: USDC already paid.
/// @param sharesClaimed Redeem only (appended by `queue`): burned shares whose USDC was already taken. The USDC paid
///                     is always `usdc × sharesClaimed / shares` rounded DOWN, so partial claims never sum above
///                     `usdc`. Deposit: unused (0).
struct Claim {
    uint256 requestId;
    address owner;
    RequestKind kind;
    uint64 settlementId;
    uint64 unlockAt;
    uint256 shares;
    uint256 usdc;
    uint256 claimed;
    uint256 sharesClaimed;
}

/// @notice One round settlement or match record (proposal §5.9.3 check 12, §5.11.4, E24, E49).
struct Settlement {
    uint64 time;
    address settler;
    uint256 matchedShares;
    uint256 matchedUsdc;
    uint256 matchSharePrice;
    uint256 usdcIn;
    uint256 sharesMinted;
    uint256 sharesBurned;
    uint256 usdcOut;
    uint64 frozenUntil;
    uint64 freezeSetAt;
    uint64 holdEndsAt;
}

/// @notice Terms returned by `quoteDeposit` / `quoteRedeem` (E31, FLOW-08): fee, cutoff, timing, and guard bands. No price.
struct Quote {
    uint256 feeBps;
    uint64 cancelCutoff;
    uint64 earliestSettle;
    uint64 holdEnds;
    uint16 refBandBps;
    uint16 legBandBps;
}

/// @notice Keeper & Safe liveness disclosures surfaced alongside terms (E31, E34, E38, E39, FLOW-08).
struct QueueLiveness {
    bool keeperConfigured;
    bool queuePausedNow;
    uint64 queuePausedUntil;
    bool depositsStoppedNow;
    bool windDownActive;
    uint32 cancelBuffer;
    uint32 maxPause;
}

// ─── Settlement internals (appended by `queue`) ────────────────────────────
//
// Used between `FlowQueue` and its linked libraries (`FlowCheckLib`, `FlowSettleLib`, `FlowMatchLib`).

/// @dev `AssetPrice.kind` values.
uint8 constant PRICE_KIND_NONE = 0;
uint8 constant PRICE_KIND_LENDING = 1;
uint8 constant PRICE_KIND_BASKET = 2;

/// @notice Per-swap price limits and NAV prices of one asset (E12, checks 8 and 9, E53), in USDC units per whole token.
struct AssetPrice {
    uint8 kind;
    bool inSale;
    uint256 unit;
    uint256 buyPerToken;
    uint256 sellPerToken;
    uint256 feedPerToken;
    uint256 twapPerToken;
}

/// @notice Everything `settle` decides before trading (checks 1 to 7 of proposal §5.9.3 & §5.11.4).
struct SettleContext {
    uint256 supply;
    uint256 idle;
    uint256[] held;
    AssetPrice[] prices;
    uint256 navFeed;
    uint256 navTwap;
    uint256 sharePrice;
    uint256 matchSharePrice;
    uint256 exitFeeBps;
    uint256 tvlCap;
    bool depositsOpen;
    bool lendRateOk;
    uint256 lendRateFailIdx;
    uint256 lendRateFailDetail;
    uint64 roundEpoch;
    uint64 firstEpoch;
    uint64 lastEpoch;
    uint256[] lendRates;
    uint256 excludedMask;
    uint256 saleMask;
}

/// @notice One fill handed to a side of a settlement: `amount` of request `requestId` (USDC for a deposit, shares for
///         a redemption) and the cap value it uses (USDC, E20).
struct Fill {
    uint256 requestId;
    uint256 amount;
    uint256 capValue;
}

/// @notice The queue's own books (eng plan §4.3 conservation, §6 "three accounting systems"; appended by `queue`).
///         Every amount the queue holds belongs to exactly one line. Absent gifts, the queue's USDC balance equals
///         `pendingUsdc + owedUsdc + creditUsdc + dustUsdc` and its share balance equals
///         `escrowShares + heldShares + creditShares + dustShares`. A gift only raises a balance above its books.
/// @param pendingUsdc  Σ unfilled deposit escrow (pending and expired requests).
/// @param owedUsdc     Σ settled redemption USDC not yet taken with `redeem`.
/// @param creditUsdc   Σ USDC credits waiting for `withdrawCredit` (cancels, unused purchase USDC).
/// @param dustUsdc     USDC left over from per-request rounding. Belongs to no flow user.
/// @param escrowShares Σ unfilled redemption escrow (pending and expired requests).
/// @param heldShares   Σ deposit shares in their hold or unlocked, not yet delivered or returned.
/// @param creditShares Σ share credits waiting for `withdrawCredit` (cancelled redemptions).
/// @param dustShares   Shares left over from per-request rounding. Belongs to no flow user.
struct FlowBooks {
    uint256 pendingUsdc;
    uint256 owedUsdc;
    uint256 creditUsdc;
    uint256 dustUsdc;
    uint256 escrowShares;
    uint256 heldShares;
    uint256 creditShares;
    uint256 dustShares;
}

// ─── Events and errors ──────────────────────────────────────────────────────

/// @title IFlowEvents
/// @notice Events and errors of the FlowQueue. `IFlowQueue` inherits this, so tests can `emit IFlowEvents.X(...)`.
///         `NotImplemented(string)` is the file-level error of FundTypes.sol.
interface IFlowEvents {
    // ── Requests (§5.9.2, §5.11.3, E25, E40) ──
    event DepositRequested(
        uint256 indexed requestId,
        address indexed owner,
        address indexed sender,
        uint256 usdc,
        uint64 epoch
    );
    event RedeemRequested(
        uint256 indexed requestId,
        address indexed owner,
        address indexed sender,
        uint256 shares,
        uint64 epoch
    );
    /// @notice The unfilled part went to the owner's credit (`withdrawCredit`).
    event RequestCancelled(uint256 indexed requestId, address indexed owner, uint256 unfilled);
    /// @notice The owner withdrew the escrow of an expired deposit request.
    event ExpiredWithdrawn(uint256 indexed requestId, address indexed owner, uint256 amount);
    /// @notice Owner gave post-`maxRoll` redemption notice for `requestId`, targeting `noticeRound`.
    event RedemptionNoticeGiven(
        uint256 indexed requestId, address indexed owner, uint64 noticeRound
    );
    /// @notice Unfilled shares of a noticed redemption moved to credit at round end.
    event RedemptionNoticeReturned(
        uint256 indexed requestId, address indexed owner, uint256 shares
    );
    /// @notice Wind-down (`shutdown`) released queued escrows for `owner` into credits.
    event WindDownReleased(address indexed owner, uint256 usdcReleased, uint256 sharesReleased);

    // ── Settlement & Whole Match (§5.9.3, §5.11.4, E24, E35, E36) ──
    /// @notice A settle call recorded nothing while the per-call basket cap (`FlowLevers.basketCallBps`) left a side
    ///         less room than its minimum fill.
    event SettleCallRoomBelowMinimum(uint256 depositRoom, uint256 redeemRoom);

    event Matched(
        uint64 indexed roundEpoch,
        uint256 indexed settlementId,
        uint256 matchedShares,
        uint256 matchedUsdc,
        uint256 feeUsdc,
        uint256 sharePrice
    );
    /// @notice The match was not booked: TWAP NAV sat `devBps` from feed NAV, past `matchBandBps`. The round nets at feed.
    event MatchSkipped(uint64 indexed roundEpoch, uint256 devBps);
    /// @notice Round's first `settle` stopped deposits/matching (`reason`: 1=state stop, 2=lend rate, 3=venue liquidity).
    event DepositStoppedForRound(uint64 indexed epoch, uint8 reason);

    event Settled(
        uint256 indexed settlementId,
        address indexed settler,
        uint256 sharePrice,
        uint256 matchedShares,
        uint256 matchedUsdc,
        uint256 usdcIn,
        uint256 sharesMinted,
        uint256 sharesBurned,
        uint256 usdcOut
    );
    event DepositFilled(
        uint256 indexed requestId,
        uint256 indexed claimId,
        uint256 indexed settlementId,
        uint256 usdc,
        uint256 shares,
        uint64 unlockAt
    );
    event RedeemFilled(
        uint256 indexed requestId,
        uint256 indexed claimId,
        uint256 indexed settlementId,
        uint256 shares,
        uint256 usdc
    );

    // ── Claims and credits (§5.9.2 steps 6 and 7, E8, E22) ──
    /// @notice Unlocked deposit shares went to their owner. `caller` may be anyone (E8).
    event SharesDelivered(
        address indexed owner, address indexed caller, uint256 shares, uint256 usdc
    );
    /// @notice Settled redemption USDC went from the owner's claims to `receiver`.
    event RedeemClaimed(
        address indexed owner, address indexed receiver, uint256 shares, uint256 usdc
    );
    event CreditAdded(address indexed owner, uint256 usdc, uint256 shares);
    event CreditWithdrawn(address indexed owner, uint256 usdc, uint256 shares);

    // ── Emergency (§5.9.4, §5.11.5, E17, E39, E49) ──
    event SettlementFrozen(uint256 indexed settlementId, uint64 until);
    event SettlementReleased(uint256 indexed settlementId);
    event QueuePaused(address indexed account, uint64 until);
    event QueueUnpaused(address indexed account);
    event FlowParamsSet(FlowParams params);

    // ── Errors ──
    error ZeroAddress();
    error ZeroAmount();
    /// @notice A request below `minRequestUsdc` (a redemption valued at `lastGoodNav`), not a whole balance (E11).
    error BelowMinRequest(uint256 valueUsdc, uint256 minRequestUsdc);
    /// @notice `owner` already holds `MAX_OWNER_OPEN_REQUESTS` open requests on this side.
    error TooManyOpenRequests(address owner);
    /// @notice A deposit request above the fund's per-deposit cap (E11).
    error AbovePerDepositCap(uint256 usdc, uint256 cap);
    error NotRequestOwner(uint256 requestId, address caller);
    error UnknownRequest(uint256 requestId);
    error WrongRequestKind(uint256 requestId);
    /// @notice The request has nothing left in escrow, or is expired where a live one is needed.
    error RequestNotPending(uint256 requestId);
    error RequestNotExpired(uint256 requestId);
    error RequestLocked(uint256 requestId);
    error InKindClosed();
    error NoticeNotReady(uint256 requestId, uint64 readyEpoch);
    error NoticeAlreadyGiven(uint256 requestId);
    error UnknownClaim(uint256 claimId);
    error ClaimLocked(uint256 claimId, uint64 unlockAt);
    error ClaimFrozen(uint256 claimId, uint64 frozenUntil);
    /// @notice `deposit` / `mint` / `redeem`: less is claimable than asked.
    error NotEnoughClaimable(uint256 asked, uint256 claimable);
    error NothingToWithdraw(address owner);
    /// @notice A request or settlement while paused or while fund is in wind-down.
    error QueueIsPaused();
    error FundIsShutdown();
    error PauseOnCooldown(uint64 availableAt);
    error StepInWindow(uint64 lastBasketStepAt, uint32 settleWindow);
    /// @notice `settle` failed check `check` of §5.9.3 for asset `index` (IDLE_INDEX when not asset-specific).
    error SettleBlocked(SettleCheck check, uint256 index, uint256 detail);
    /// @notice A FlowParams field is outside its hard bound. `field` is its position in the struct (0-based).
    error FlowParamOutOfBounds(uint256 field);
    error UnknownSettlement(uint256 settlementId);
    error SettlementNotFrozen(uint256 settlementId);
    error SettlementAlreadyFrozen(uint256 settlementId);
    error FreezeOnCooldown(uint64 availableAt);
    /// @notice `freezeSettlement` after every claim of the settlement unlocked (only shares in their hold freeze).
    error FreezeOutsideHold(uint256 settlementId);
    /// @notice ERC-7540: previews revert for asynchronous flows. Use `quoteDeposit` / `quoteRedeem` (E21).
    error PreviewNotSupported();
    /// @notice `withdraw` is not offered (§5.9.6); use `redeem`.
    error RedeemOnly();

    // ── Appended by `queue` ──
    /// @notice One side of settlement `settlementId` did not trade: its call into the fund, or a check after it
    ///         (8 to 11), failed. That side changed no state and stays pending (coordinator ruling 1, RB-15).
    event SideFailed(uint256 indexed settlementId, RequestKind kind, bytes reason);
    /// @notice A queue entry point that only the queue itself may call (the per-side self-calls of `settle`).
    error OnlySelf();
    /// @notice Caller is not the fund contract.
    error OnlyFund();
    /// @notice The fund returned or moved something other than what it was asked (defensive; a fund defect).
    error FundResultMismatch(uint256 expected, uint256 actual);
    error SettleSideOutOfGas(RequestKind kind);

    // ── Appended by `fix-queue` (2026-11-12) ──
    event Swept(address indexed caller, uint256 usdc, uint256 shares);
    /// @notice USDC refused a fee of `amount` to `to` (safety review 0.9.0, MISSED-04). The fee joined `dustUsdc`, which
    ///         `sweep` sends to the fund.
    event FeeNotPaid(address indexed to, uint256 amount);

    // ── Appended by `levers` (2026-11-12, step 3 finish plan §3.2) ──
    event FlowLeversSet(FlowLevers levers);
    error FlowLeverOutOfBounds(uint256 field);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  Levers for the attack findings (appended by `levers`, 2026-11-12, step 3 finish plan §3.2)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/// @dev Hard bounds of `FlowLevers`.
uint16 constant MAX_BASKET_CALL_BPS = 10_000;
/// @dev The owner's decided default for `FlowLevers.basketCallBps` (owner delegation, 2026-11-12; lever L5 of the
///      step 3 finish report §8): 5 bps of each basket pool's time-weighted USDC depth per call. `initialize` sets it.
uint16 constant DEFAULT_BASKET_CALL_BPS = 5;
uint8 constant LEG_PRICE_STRICTER = 0;
uint8 constant LEG_PRICE_TWAP_ONLY = 1;
uint8 constant LEG_PRICE_FEED_ONLY = 2;

/// @notice Candidate levers for the sandwich (D-AT-1, A7), slow-ramp (D-AT-2, A10) findings, built behind
///         parameters so the owner can choose (step 3 finish plan §3.2, §4). `initialize` sets `basketCallBps` to
///         `DEFAULT_BASKET_CALL_BPS` (5) and `legPriceMode` to `LEG_PRICE_STRICTER`, the decided defaults. Every field
///         0 leaves the queue exactly as proposal §5.9 first described it (the lever measurements' L0 row).
///         Kept out of `FlowParams` on purpose: that struct is built field by field in tests other agents own, so a
///         new field there would break them (FlowParams stays append-free).
/// @param basketCallBps Per-call cap on each basket leg of a settlement: one call may buy or sell at most
///                      `basketCallBps` of the pool's time-weighted USDC depth over `settleWindow`
///                      (`FundValuationLib.poolUsdcDepth`, the depth the §4.5 pool-share rule reads) of each basket
///                      asset. Each side's room shrinks so that its pro-rata leg in every basket asset stays under the
///                      cap; a larger flow fills in parts over several calls (a partial fill keeps the cursor, RB-20).
///                      While on, at most one settlement that trades is recorded per block, so the parts land in
///                      different blocks. Why: a one-block sandwich gains about (the fund's own price impact − 2 ×
///                      the pool fee) on the attacker's pushed volume; with the cap at the pool fee in bps the
///                      fund's own impact (≈ 2 × leg / depth) is at most twice the fee. 0: off.
/// @param legPriceMode  The price the per-swap limits (checks 8 and 9) and the bound prices start from:
///                      `LEG_PRICE_STRICTER` (0, the design: a purchase from the lower of TWAP and feed, a sale from
///                      the higher), `LEG_PRICE_TWAP_ONLY` (1) or `LEG_PRICE_FEED_ONLY` (2). Check 4 is unchanged.
struct FlowLevers {
    uint16 basketCallBps;
    uint8 legPriceMode;
}
