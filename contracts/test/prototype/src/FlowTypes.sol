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
// Coordinator ruling 8 (2026-11-11) and proposal §5.9.5: `minHold` in [1 day, 7 days], `maxFreeze` at most 14 days.
uint32 constant MIN_HOLD = 1 days;
uint32 constant MAX_HOLD = 7 days;
uint32 constant MIN_FLOW_KEEPER_GRACE = 1 hours;
uint32 constant MAX_FLOW_KEEPER_GRACE = 7 days;
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

/// @notice Life of a request (§5.9.2). A request may fill in parts (each fill is a claim, E8). `Pending` covers a
///         partly filled request. `Expired` is reported by views once `maxRoll` epochs passed with an unfilled part;
///         the escrow then waits for `withdrawExpired`. `Closed` means nothing is left in escrow for it: filled
///         completely, cancelled, exited in kind, or its expired escrow withdrawn.
enum RequestStatus {
    None,
    Pending,
    Expired,
    Closed
}

/// @notice The checks of proposal §5.9.3, in order (E7). `checkSettle` returns the first that fails; `settle`
///         reverts `SettleBlocked` with it. `Ok` means every check that can be evaluated before trading passes.
///         RedeemLeg, DepositLeg, Proportion and RealizedPrice can only fail inside a settlement.
enum SettleCheck {
    /// @dev Every pre-trade check passes.
    Ok,
    /// @dev Check 1: no epoch with a pending request has its settlement window ended.
    Window,
    /// @dev Check 1: the caller is not the keeper and `keeperGrace` has not passed.
    Caller,
    /// @dev Check 1: the queue is paused.
    Paused,
    /// @dev Check 2: the sequencer feed reports down or is inside `sequencerGrace`.
    Sequencer,
    /// @dev Check 2: a basket asset's feed is stale, not positive, incomplete or unreadable. `index` names it.
    Feed,
    /// @dev Check 2: the USDC / USD feed is unhealthy or outside `usdcPegBandBps`.
    UsdcPeg,
    /// @dev Check 3: fewer than `quorum` slices sit within `dispersionBps` of the median. `index` names the asset.
    TwapQuorum,
    /// @dev Check 4: a TWAP is more than `refBandBps` from its feed. `index` names the asset.
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
    /// @dev Check 11: the realized price is outside a bound price.
    RealizedPrice
}

// ─── Structs ────────────────────────────────────────────────────────────────

/// @notice Every queue parameter of proposal §5.9.5 except `poolShareBps` and `minSeedUsdc` (the fund holds those)
///         and `maxFeedAge` (per feed, in the fund's `AssetConfig`; the USDC feed's in `FlowQueueInit`).
///         `ADMIN_ROLE` sets it through the timelock inside the hard bounds above.
/// @param epochLength          Epoch length and the clock-time period of each flow cap (§5.9.5: 6 h).
/// @param settleWindow         Wait after an epoch closes before it may settle; also the TWAP window (1 h).
/// @param minHold              Hold of deposit shares after their settlement (24 h, E8).
/// @param keeperGrace          After the window ends, anyone may settle once this passed (6 h, E10).
/// @param maxEpochFlowBps      Each side's cap per period, in bps of NAV at the feeds (500, E20).
/// @param epochFlowFloorUsdc   Each side's cap is at least this (250 000 USDC, E20).
/// @param maxSharePriceMoveBps Share-price breaker per epoch passed since the last settlement (1 000, check 6).
/// @param maxRoll              Epochs after which an unfilled request expires (8, E18).
/// @param minRequestUsdc       Least request size (100 USDC, E11); a whole-balance redemption is exempt.
/// @param maxFreeze            Longest freeze of one settlement's deposit shares (7 days, E17).
/// @param slices               Equal slices of `settleWindow` for the TWAP median (12, E6).
/// @param quorum               Slices that must sit within `dispersionBps` of the median (9, check 3).
/// @param dispersionBps        Slice band around the median (100, check 3).
/// @param refBandBps           TWAP against feed band (90, check 4; owner default 2026-11-12, lever L10).
/// @param legBandBps           Per-swap limit band around the stricter of feed and TWAP (100, checks 8 and 9).
///                             Must be above every basket pool fee.
/// @param sequencerGrace       Time the sequencer must have been up (1 h, check 2).
/// @param usdcPegBandBps       USDC / USD band around 1 (50, check 2).
/// @param maxLendRateGrowthBps Most growth per day of a venue's rate per unit (10, check 5).
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
}

/// @notice `FlowQueue.initialize` parameters.
/// @param fund            The RobotMoneyFund (the share token, ERC-7575 `share()`).
/// @param usdc            The fund's asset (ERC-7575 `asset()`).
/// @param admin           Receives ADMIN_ROLE (deployer, then the timelock).
/// @param emergency       Receives EMERGENCY_ROLE.
/// @param keeper          Receives KEEPER_ROLE (address(0): none, grace path only).
/// @param usdcFeed        Chainlink USDC / USD (check 2 peg, and USD → USDC conversion of feed prices).
/// @param usdcFeedMaxAge  Its maximum age in seconds.
/// @param sequencerFeed   Chainlink L2 sequencer uptime feed (check 2).
/// @param params          Initial FlowParams, inside the hard bounds.
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

/// @notice One request (E12, E18; eng plan §3.1 "state per request").
/// @param owner     Owns the request and every claim from it. Named by the caller; never changed.
/// @param kind      Deposit or Redeem.
/// @param epoch     Epoch index the request was made in (`block.timestamp / epochLength` at the request).
/// @param amount    Escrowed at the request: USDC (Deposit) or shares (Redeem).
/// @param remaining Still unfilled and still in escrow: USDC (Deposit) or shares (Redeem).
/// @param limit     Deposit: the most USDC per share (`maxUsdcPerShare`); Redeem: the least USDC per share after the
///                  exit fee (`minUsdcPerShare`). In PRICE_SCALE units.
/// @param closed    Nothing is left in escrow for this request (see `RequestStatus.Closed`).
struct Request {
    address owner;
    RequestKind kind;
    uint64 epoch;
    uint256 amount;
    uint256 remaining;
    uint256 limit;
    bool closed;
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

/// @notice One `settle` call that traded (proposal §5.9.3 check 12 "record").
/// @param time              `block.timestamp` of the settlement.
/// @param settler           The caller.
/// @param depositBoundPrice The most a depositor could pay per share (PRICE_SCALE, rounded UP), from the per-swap
///                          limits (E12). 0 when no deposit took part.
/// @param redeemBoundPrice  The least a redeemer could receive per share (PRICE_SCALE, rounded DOWN). 0 when no
///                          redemption took part.
/// @param usdcIn            USDC spent by the deposits (sum of fills).
/// @param sharesMinted      Shares minted to the queue for the deposits.
/// @param sharesBurned      Shares burned for the redemptions.
/// @param usdcOut           USDC paid to the queue for the redemptions, net of the exit fee.
/// @param frozenUntil       0 when not frozen; else the freeze ends by itself at this time (E17, RB-18).
/// @param returnAllowed     ADMIN let each depositor of this settlement pull its slice in kind (`takeReturn`).
/// @param holdEndsAt        Appended by `queue`: `time + minHold` at the settlement, the unlock time of every deposit
///                          claim it made. `freezeSettlement` is allowed only before it (shares in their hold).
struct Settlement {
    uint64 time;
    address settler;
    uint256 depositBoundPrice;
    uint256 redeemBoundPrice;
    uint256 usdcIn;
    uint256 sharesMinted;
    uint256 sharesBurned;
    uint256 usdcOut;
    uint64 frozenUntil;
    bool returnAllowed;
    uint64 holdEndsAt;
}

/// @notice `quoteDeposit` / `quoteRedeem` (E21): the worst case the protocol's own limits allow right now.
/// @param boundPrice     Deposit: the most USDC per share (rounded UP); Redeem: the least USDC per share after the
///                       exit fee (rounded DOWN). PRICE_SCALE units.
/// @param worstAmount    Deposit: the fewest shares the USDC would buy at `boundPrice` (rounded DOWN). Redeem: the
///                       least USDC the shares would pay (rounded DOWN).
/// @param feeBps         Deposit: 0 (the users of a settlement pay the purchase cost, there is no fee class).
///                       Redeem: the fund's `exitFeeBps`.
/// @param earliestSettle Earliest time a request made now can settle (its epoch's end plus `settleWindow`).
/// @param holdEnds       Deposit: `earliestSettle + minHold`. Redeem: `earliestSettle` (USDC claimable at once).
struct Quote {
    uint256 boundPrice;
    uint256 worstAmount;
    uint256 feeBps;
    uint64 earliestSettle;
    uint64 holdEnds;
}

// ─── Settlement internals (appended by `queue`) ────────────────────────────
//
// Used between `FlowQueue` and its linked libraries (`FlowCheckLib`, `FlowSettleLib`). ABI-visible only on the
// queue's self-call entry points, which nobody but the queue itself can call.

/// @dev `AssetPrice.kind` values.
uint8 constant PRICE_KIND_NONE = 0;
uint8 constant PRICE_KIND_LENDING = 1;
uint8 constant PRICE_KIND_BASKET = 2;

/// @notice Per-swap price limits of one basket asset for one settlement (E12, checks 8 and 9), in USDC units per
///         whole token (`unit` base units). Computed before any trade from the feed (check 2) and the slice-median
///         TWAP (check 3) only.
/// @param kind         PRICE_KIND_NONE (inactive), PRICE_KIND_LENDING or PRICE_KIND_BASKET.
/// @param unit         `10 ** decimals()` of the basket token (0 otherwise).
/// @param buyPerToken  The most a purchase may pay: `min(feed, TWAP) × (1 + legBandBps)`, rounded UP.
/// @param sellPerToken The least a sale must receive: `max(feed, TWAP) × (1 − legBandBps)`, rounded DOWN.
/// @param feedPerToken At the feed (USD feed / USDC feed), rounded DOWN. NAV at the feeds (checks 6, caps).
struct AssetPrice {
    uint8 kind;
    uint256 unit;
    uint256 buyPerToken;
    uint256 sellPerToken;
    uint256 feedPerToken;
}

/// @notice Everything `settle` decides before trading (checks 1 to 7 of proposal §5.9.3).
/// @param supply        Fund share supply (check 7 snapshot).
/// @param idle          Idle USDC (`heldBalances`).
/// @param held          Held amount per asset index (`heldBalances`).
/// @param prices        Per asset index.
/// @param navFeed       NAV at the feeds, USDC, rounded DOWN.
/// @param sharePrice    `navFeed × PRICE_SCALE / supply` (check 6).
/// @param exitFeeBps    The fund's exit fee.
/// @param depositBound  The most a depositor can pay per share (PRICE_SCALE, UP), batch rounding included.
/// @param redeemBound   The least a redeemer receives per share after the fee (PRICE_SCALE, DOWN); 0 = the
///                      redemption side cannot be bounded and does not trade.
/// @param tvlCap        The fund's TVL cap (deposits must leave `navFeed + usdc ≤ tvlCap`).
/// @param depositsOpen  False while the fund pauses deposits, is shut down or excludes a lending asset (check 1):
///                      deposit requests are then not processed and redemptions settle alone.
/// @param firstEpoch    The oldest epoch that can still hold a live (unexpired) request.
/// @param lastEpoch     The newest epoch this caller may settle: its settlement window has ended, and for a caller
///                      without KEEPER_ROLE also its `keeperGrace` (step 3 finish plan §3.1 item 1).
/// @param lendRates     Appended by `fix-queue`: per asset index, the lending venue's rate per unit that check 5 read
///                      and accepted (0 for other assets). The settlement records one of these when its read after
///                      the trades fails, never a stale reference (item 5).
/// @param excludedMask  Appended by `fix-queue`: bit `i` set when asset `i` has an open exclusion record now (check 1;
///                      check 6's reference, item 9).
struct SettleContext {
    uint256 supply;
    uint256 idle;
    uint256[] held;
    AssetPrice[] prices;
    uint256 navFeed;
    uint256 sharePrice;
    uint256 exitFeeBps;
    uint256 depositBound;
    uint256 redeemBound;
    uint256 tvlCap;
    bool depositsOpen;
    uint64 firstEpoch;
    uint64 lastEpoch;
    uint256[] lendRates;
    uint256 excludedMask;
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
    // ── Requests (§5.9.2) ──
    event DepositRequested(
        uint256 indexed requestId, address indexed owner, address indexed sender, uint256 usdc, uint256 maxUsdcPerShare, uint64 epoch
    );
    event RedeemRequested(
        uint256 indexed requestId, address indexed owner, address indexed sender, uint256 shares, uint256 minUsdcPerShare, uint64 epoch
    );
    /// @notice The unfilled part went to the owner's credit (`withdrawCredit`).
    event RequestCancelled(uint256 indexed requestId, address indexed owner, uint256 unfilled);
    /// @notice The unfilled redemption shares left through the fund's `redeemInKind`, paid to the owner.
    event RequestExitedInKind(uint256 indexed requestId, address indexed owner, uint256 shares);
    /// @notice The owner withdrew the escrow of an expired request.
    event ExpiredWithdrawn(uint256 indexed requestId, address indexed owner, uint256 amount);

    // ── Settlement (§5.9.3) ──
    /// @notice A settle call recorded nothing while the per-call basket cap (`FlowLevers.basketCallBps`) left a side
    ///         less room than its minimum fill: a thin basket pool holds every request (review Q-F5). The rooms the
    ///         call had, in USDC.
    event SettleCallRoomBelowMinimum(uint256 depositRoom, uint256 redeemRoom);

    event Settled(
        uint256 indexed settlementId,
        address indexed settler,
        uint256 depositBoundPrice,
        uint256 redeemBoundPrice,
        uint256 usdcIn,
        uint256 sharesMinted,
        uint256 sharesBurned,
        uint256 usdcOut
    );
    event DepositFilled(
        uint256 indexed requestId, uint256 indexed claimId, uint256 indexed settlementId, uint256 usdc, uint256 shares, uint64 unlockAt
    );
    event RedeemFilled(
        uint256 indexed requestId, uint256 indexed claimId, uint256 indexed settlementId, uint256 shares, uint256 usdc
    );
    /// @notice A pending request did not take part because its limit does not admit the bound price (E12, RB-14).
    event RequestSkipped(uint256 indexed requestId, uint256 indexed settlementId, uint256 boundPrice, uint256 limit);

    // ── Claims and returns (§5.9.2 steps 6 and 7, E8, E22) ──
    /// @notice Unlocked deposit shares went to their owner. `caller` may be anyone (E8).
    event SharesDelivered(address indexed owner, address indexed caller, uint256 shares, uint256 usdc);
    /// @notice Settled redemption USDC went from the owner's claims to `receiver`.
    event RedeemClaimed(address indexed owner, address indexed receiver, uint256 shares, uint256 usdc);
    event CreditAdded(address indexed owner, uint256 usdc, uint256 shares);
    event CreditWithdrawn(address indexed owner, uint256 usdc, uint256 shares);

    // ── Emergency (§5.9.4, E17) ──
    event SettlementFrozen(uint256 indexed settlementId, uint64 until);
    event SettlementReleased(uint256 indexed settlementId);
    event SettlementReturnAllowed(uint256 indexed settlementId);
    /// @notice A depositor took its frozen slice back in kind after `allowReturn`.
    event ReturnTaken(uint256 indexed claimId, address indexed owner, uint256 shares);
    event QueuePaused(address indexed account);
    event QueueUnpaused(address indexed account);
    event FlowParamsSet(FlowParams params);

    // ── Errors ──
    error ZeroAddress();
    error ZeroAmount();
    /// @notice A request below `minRequestUsdc` (a redemption valued at `lastGoodNav`), not a whole balance (E11).
    error BelowMinRequest(uint256 valueUsdc, uint256 minRequestUsdc);
    /// @notice A deposit request above the fund's per-deposit cap (E11).
    error AbovePerDepositCap(uint256 usdc, uint256 cap);
    error NotRequestOwner(uint256 requestId, address caller);
    error UnknownRequest(uint256 requestId);
    error WrongRequestKind(uint256 requestId);
    /// @notice The request has nothing left in escrow, or is expired where a live one is needed.
    error RequestNotPending(uint256 requestId);
    error RequestNotExpired(uint256 requestId);
    error UnknownClaim(uint256 claimId);
    error ClaimLocked(uint256 claimId, uint64 unlockAt);
    error ClaimFrozen(uint256 claimId, uint64 frozenUntil);
    /// @notice `deposit` / `mint` / `redeem`: less is claimable than asked.
    error NotEnoughClaimable(uint256 asked, uint256 claimable);
    error NothingToWithdraw(address owner);
    /// @notice A request or a settlement while paused (cancel, in-kind exit and withdrawals stay open).
    error QueueIsPaused();
    /// @notice `settle` failed check `check` of §5.9.3 for asset `index` (IDLE_INDEX when not asset-specific).
    ///         A failed check reverts the whole call and changes no state (RB-12, RB-15).
    error SettleBlocked(SettleCheck check, uint256 index, uint256 detail);
    /// @notice A FlowParams field is outside its hard bound. `field` is its position in the struct (0-based).
    error FlowParamOutOfBounds(uint256 field);
    error UnknownSettlement(uint256 settlementId);
    error SettlementNotFrozen(uint256 settlementId);
    error SettlementAlreadyFrozen(uint256 settlementId);
    /// @notice `freezeSettlement` after every claim of the settlement unlocked (only shares in their hold freeze).
    error FreezeOutsideHold(uint256 settlementId);
    error ReturnNotAllowed(uint256 settlementId);
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
    /// @notice The fund returned or moved something other than what it was asked (defensive; a fund defect).
    error FundResultMismatch(uint256 expected, uint256 actual);
    /// @notice `settle` has too little gas left to give side `kind` its whole fixed gas budget
    ///         (`FlowSettleLib.sideGas`). The whole `settle` reverts, so the gas a caller sends cannot choose which side
    ///         settles (RB-20). Call again with more gas. (Until `fix-queue`, 2026-11-12, it fired after a failed side
    ///         that left less than a third of the gas; that also reverted the other side when a venue burned its gas.)
    error SettleSideOutOfGas(RequestKind kind);

    // ── Appended by `fix-queue` (2026-11-12) ──
    /// @notice USDC and shares above the queue's obligations (gifts and rounding dust) went to the fund
    ///         (`sweep`, step 3 finish plan §3.1 item 7).
    event Swept(address indexed caller, uint256 usdc, uint256 shares);

    // ── Appended by `levers` (2026-11-12, step 3 finish plan §3.2) ──
    /// @notice ADMIN_ROLE set the attack-finding levers (`FlowLevers`).
    event FlowLeversSet(FlowLevers levers);
    /// @notice A FlowLevers field is outside its hard bound. `field` is its position in the struct (0-based).
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
