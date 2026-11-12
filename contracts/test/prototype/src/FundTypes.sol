// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.1 (per-asset targets), §5.1 (plan), §5.3 (step),
//            §5.5 (plan states), §5.6 (governed parameters), §7 (RB invariants), §4.5 (asset admission), §5.9 (timed
//            flows, step 3d); docs/technical/one-vault-timed-flows-eng-plan.md E1 to E23
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

// ═══════════════════════════════════════════════════════════════════════════
//  Shared types for the one-vault experiment: RobotMoneyFund, Rebalancer and
//  RebalanceGovernance all import this file. Every struct and enum here is
//  ABI-visible on at least one of the three contracts, so changing a field
//  order is an interface change for all three engineers.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Constants ──────────────────────────────────────────────────────────────

/// @dev The basis-points denominator (same value as `BpsMath.BPS_DENOMINATOR`).
uint256 constant BPS = 10_000;

/// @dev Sentinel asset index meaning "idle USDC" in a step leg (§5.3 step 6: either leg may be
///      idle USDC). Never a valid index into the fund's asset list.
uint256 constant IDLE_INDEX = type(uint256).max;

/// @dev Hard cap on the fund's asset list length (lending plus basket). Keeps every per-asset loop
///      (NAV, redeem, leg picking) bounded.
uint256 constant MAX_FUND_ASSETS = 12;

// ─── Plan bounds (§5.6) ─────────────────────────────────────────────────────

/// @dev Shortest permitted glide path (§5.6 `duration`, min 1 day).
uint64 constant MIN_PLAN_DURATION = 1 days;
/// @dev Longest permitted glide path.
uint64 constant MAX_PLAN_DURATION = 90 days;
/// @dev Ceiling on a plan's `costBudgetBps` (5% of turnover). Suggested start is 30 bps.
uint16 constant MAX_COST_BUDGET_BPS = 500;

// ─── Step bounds (§5.6) ─────────────────────────────────────────────────────

/// @dev Floor on `stepInterval` (§5.6: max(longest TWAP window, 30 min)).
uint32 constant MIN_STEP_INTERVAL = 30 minutes;
/// @dev Ceiling on `stepInterval`.
uint32 constant MAX_STEP_INTERVAL = 1 days;
/// @dev Ceiling on `maxStepCostBps` (suggested start 50 bps).
uint16 constant MAX_STEP_COST_BPS = 500;
/// @dev Ceiling on `toleranceBps` (suggested start 50 bps).
uint16 constant MAX_TOLERANCE_BPS = 500;
/// @dev Ceiling on `keeperGrace` (suggested start 6 hours).
uint32 constant MAX_KEEPER_GRACE = 7 days;
/// @dev Ceiling on `maxOverrun` (suggested start 7 days).
uint32 constant MAX_OVERRUN = 30 days;

// ─── Timed flows (step 3d: proposal §4.5, §5.9; eng plan E1 to E23) ─────────

/// @dev Scale of every flow price (a request limit, a bound price, a realized price):
///      `price = usdcUnits × PRICE_SCALE / shareUnits`. The fund mints 10^18 share units per USDC unit at the
///      seed scale (`_decimalsOffset() == 18`), so a share bought at the seed scale costs exactly 1e18 (par).
///      A higher price is worse for a depositor and better for a redeemer.
uint256 constant PRICE_SCALE = 1e36;

/// @dev Venue rounding margin (proposal §5.9.3 check 10, plan §9 "venue rounding"): the fund supplies this many
///      USDC units MORE than the exact pro-rata amount to each lending venue in `mintInKind`, and withdraws this
///      many LESS in `sellForFlow`, so a venue that rounds one or two units against the caller never fails the
///      proportion check. The comparison itself is never loosened.
uint256 constant LENDING_ROUNDING_UNITS = 2;

/// @dev Default and hard bounds of the two flow parameters the FUND holds (§5.9.5; every other one lives in the
///      queue's `FlowParams`). `minSeedUsdc`: the least `seed` accepts (E14). `poolShareBps`: the most of a
///      pool's time-weighted active liquidity one basket target times the TVL cap may take (§4.5 rule 3, E15).
uint256 constant DEFAULT_MIN_SEED_USDC = 10_000e6;
uint256 constant MIN_MIN_SEED_USDC = 1e6;
uint256 constant MAX_MIN_SEED_USDC = 10_000_000e6;
uint16 constant DEFAULT_POOL_SHARE_BPS = 2_500;
uint16 constant MAX_POOL_SHARE_BPS = 10_000;

// ─── Step 3d, fund-extras (E9, E15, E19, E20; scaffold plan §7.4). Appended. ──

/// @dev Units of a lending position created per USDC unit when the position's units start (E9, RB-21). Units are
///      shares of that position: a fine scale keeps the rounding of each mint and burn far below one USDC unit.
uint256 constant POSITION_UNITS_PER_USDC = 1e18;

/// @dev The in-kind allowance of proposal §5.9.4 and E20, held by the fund (coordinator ruling 6, §5.9.5 "the fund
///      stores ... the in-kind allowance"). Per period of `inKindPeriod` seconds, in-kind exits take lending USDC up
///      to `max(inKindBps × lending holdings / 10 000, inKindFloorUsdc)`, counted in the venues' own USDC amounts.
///      Defaults equal the queue's flow-cap defaults (§5.9.5: 500 bps, 250 000 USDC, a 6 h epoch); ADMIN_ROLE keeps
///      them equal to the queue's values with `setInKindAllowance`.
uint16 constant DEFAULT_IN_KIND_BPS = 500;
uint128 constant DEFAULT_IN_KIND_FLOOR_USDC = 250_000e6;
uint32 constant DEFAULT_IN_KIND_PERIOD = 6 hours;
/// @dev Hard bounds of `setInKindAllowance` (the queue's epoch and flow-floor bounds).
uint128 constant MAX_IN_KIND_FLOOR_USDC = 100_000_000e6;
uint32 constant MIN_IN_KIND_PERIOD = 1 hours;
uint32 constant MAX_IN_KIND_PERIOD = 7 days;

/// @dev The settlement window the fund assumes before a FlowQueue is bound (§5.9.5 default). Used by the pool-history
///      check of `addAsset` and the pool-share rule of `setTargetAndOpenPlan` (§4.5 rules 2 and 3, E15). Once a queue
///      is bound both read the queue's own `FlowParams.settleWindow`.
uint32 constant DEFAULT_SETTLE_WINDOW = 1 hours;

/// @dev Upper bound on a basket asset's `maxFeedAge` at `addAsset` (E15): the longest Chainlink heartbeat on Base
///      (24 h) plus margin. A larger value would switch the staleness check off.
uint32 constant MAX_FEED_AGE = 2 days;

// ─── Roles ──────────────────────────────────────────────────────────────────

// ─── Step 3e (proposal §5.10, RB-19; step-3 finish plan §3.5). Appended. ─────

/// @dev Prices a rebalance step reads for its feed checks, per fund asset index (`StepFeedLib.check`). Both are
///      USDC units per whole token (`unit` raw units), rounded DOWN; 0 for a lending or inactive asset.
///      `feed`: the Chainlink USD price converted to USDC with the USDC / USD feed. `twap`: the asset's own TWAP over
///      its `twapWindow`, through its swap adapter (the TWAP the fund values NAV with and the Rebalancer sizes with).
struct StepPrices {
    uint256[] feed;
    uint256[] twap;
    uint256[] unit;
}

/// @title Roles
/// @notice Role identifiers shared by the three prototype contracts. Contracts re-export them as
///         `bytes32 public constant X_ROLE = Roles.X_ROLE;` so the getter exists in their ABI.
///
///         | Role               | Held by                     | Lives on                       |
///         | ------------------ | --------------------------- | ------------------------------ |
///         | ADMIN_ROLE         | TimelockController          | fund, rebalancer, governance   |
///         | EMERGENCY_ROLE     | emergency hot key           | fund (pauses), rebalancer none |
///         | GOVERNANCE_ROLE    | RebalanceGovernance proxy   | fund (`setTargetAndOpenPlan`)  |
///         | REBALANCER_ROLE    | Rebalancer proxy            | fund (`executeStep`, conclude) |
///         | KEEPER_ROLE        | keeper bot                  | rebalancer (`step` pre-grace)  |
///         | TARGET_SETTER_ROLE | TimelockController          | governance (`applyReceipt`)    |
///         | FLOW_ROLE          | FlowQueue proxy             | fund (`mintInKind`, `sellForFlow`, `ledgerCheckpoint`) |
///
///         On the FlowQueue: ADMIN_ROLE (timelock: params, release, allowReturn, unpause), EMERGENCY_ROLE (pause,
///         freezeSettlement) and KEEPER_ROLE (`settle` before `keeperGrace`).
library Roles {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    bytes32 internal constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 internal constant REBALANCER_ROLE = keccak256("REBALANCER_ROLE");
    bytes32 internal constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    /// @dev RebalanceGovernance's port of RouterGovernance.WEIGHT_SETTER_ROLE. Self-administered.
    bytes32 internal constant TARGET_SETTER_ROLE = keccak256("TARGET_SETTER_ROLE");
    /// @dev The FlowQueue's authority on the fund (E1). Bound once by `bindFlowRole`, then self-administered,
    ///      exactly like GOVERNANCE_ROLE and REBALANCER_ROLE, so no ADMIN_ROLE holder can hand it to anyone else.
    bytes32 internal constant FLOW_ROLE = keccak256("FLOW_ROLE");
}

/// @notice A function or branch of the scaffold that is not built yet. A stub reverts with this and a short
///         name of what is missing. It never returns a value and never passes a check it did not run.
error NotImplemented(string what);

// ─── Enums ──────────────────────────────────────────────────────────────────

/// @notice How a fund asset is held and valued (§4.2).
///         Lending: an `IStrategyAdapter`; valued 1:1 by `adapter.totalAssets()`.
///         Basket:  a token held by the fund; valued at TWAP through its `IBasketSwapAdapter`.
enum AssetKind {
    Lending,
    Basket
}

/// @notice Basket venue. Ordinals mirror `BasketVault.Venue` / `BasketAssetConfigGuard.Venue`
///         (V3 0, V4 1, Aerodrome 2). Ignored for Lending assets.
enum Venue {
    V3,
    V4,
    Aerodrome
}

/// @notice Plan lifecycle (§5.5). `None` is the zero value: no plan was ever opened.
///         Live statuses (a plan exists that may still trade or be resumed): Open, Halted, Paused.
///         Terminal statuses: Converged, Superseded, Expired.
///
///         Open       --(path end reached, every asset within tolerance; Rebalancer)--> Converged
///         Open       --(costSpent > costBudget, inside executeStep)-----------------> Halted
///         Halted     --(ADMIN extendBudget so costSpent <= costBudget)--------------> Open
///         Open       --(EMERGENCY pauseRebalance)-----------------------------------> Paused
///         Paused     --(ADMIN resumePlan)-------------------------------------------> Open
///         live       --(new setTargetAndOpenPlan, or ADMIN closePlan)---------------> Superseded
///         Open       --(now > endTime + maxOverrun; Rebalancer)---------------------> Expired
enum PlanStatus {
    None,
    Open,
    Converged,
    Halted,
    Paused,
    Superseded,
    Expired
}

/// @notice Why `Rebalancer.step()` returned without trading (§5.3, last paragraph).
enum SkipReason {
    /// @dev Not a skip: used as the `reason` return value when a step executed.
    None,
    /// @dev The fund's current plan is not `Open` (None, Halted, Paused or terminal).
    PlanNotOpen,
    /// @dev `block.timestamp < fund.lastStepAt() + stepInterval` (§5.3 step 1, RB-5).
    Cooldown,
    /// @dev A leg candidate failed the ORA-4 spot-vs-TWAP check and no eligible pair remained
    ///      (§5.3 step 2, RB-5). `detail` carries the asset index.
    MarketDeviation,
    /// @dev No asset is over its path target while another (or idle) is under it.
    NothingToTrade,
    /// @dev The best pair's notional is below `minStepUsdc` (§5.3 step 4).
    BelowMinStep,
    /// @dev `fund.executeStep` reverted (venue freeze, short fill under `minOut`, cost cap, RB-7
    ///      guard). The Rebalancer catches the revert so the keeper sees why. `detail` carries the
    ///      revert selector as a uint.
    StepFailed,
    /// @dev Not a skip: this `step()` moved the Open plan to a terminal status through
    ///      `fund.concludePlan` (Converged after `endTime` within `toleranceBps`, or Expired after
    ///      `endTime + maxOverrun`, §5.5). The fund's `PlanStatusChanged` is the only event.
    ///      `previewStep` reports it while the plan is still Open, so a keeper knows a `step()` call
    ///      is due. Appended last so the earlier ordinals are unchanged.
    Concluded,
    /// @dev Step 3e (proposal §5.10, RB-19): a feed check of the step failed (checks 2 and 4 of §5.9.3: the
    ///      sequencer, a basket feed, the USDC peg, or a basket TWAP outside `refBandBps` of its feed). No asset
    ///      backs off. `detail` carries the `StepFeedCheck` that failed; the Rebalancer's `StepFeedBlocked` event
    ///      names the asset and the feed status or deviation. Appended last so the earlier ordinals are unchanged.
    FeedCheck
}

/// @notice Which feed check of a rebalance step failed (step 3e, proposal §5.10: checks 2 and 4 of §5.9.3 run on
///         every step, inside the fund's `executeStep` and before it in `Rebalancer.step()`). `StepFeedLib.check`.
enum StepFeedCheck {
    /// @dev Every check passed.
    Ok,
    /// @dev No FlowQueue is bound to the fund: the sequencer feed, the USDC feed and `refBandBps` live in its
    ///      `FlowParams` and `feeds()` (proposal §5.9.5), so the step fails closed.
    NoQueue,
    /// @dev Check 2: the sequencer is down, or up for less than `sequencerGrace`. `detail` = the `FeedStatus`.
    Sequencer,
    /// @dev Check 2: an active basket asset's feed is not fresh and positive. `index` = the asset, `detail` = the
    ///      `FeedStatus`.
    Feed,
    /// @dev Check 2: the USDC / USD feed is unhealthy (`detail` = the `FeedStatus`) or outside `usdcPegBandBps`
    ///      (`detail` = its 8-decimal price).
    UsdcPeg,
    /// @dev Check 4 could not read an active basket asset's TWAP (the adapter reverted or priced a whole token at
    ///      0). `index` = the asset.
    TwapRead,
    /// @dev Check 4: an active basket asset's TWAP over its `twapWindow` sits more than `refBandBps` from its feed.
    ///      `index` = the asset, `detail` = the deviation in bps (rounded up).
    TwapVsFeed
}

/// @notice Result of one Chainlink read (`FeedLib`, E16, proposal §5.9.3 check 2). `Ok` is the zero value only
///         for readability in tests: a function that has not read a feed never returns `Ok`.
///         Shared by the fund (E19: `totalAssets` reverts on an unhealthy feed) and the queue (check 2).
enum FeedStatus {
    /// @dev The feed answered, the answer is positive, the round is complete and younger than `maxAge`.
    Ok,
    /// @dev No feed is configured for the asset (address(0)). A basket asset cannot be active so (RB-17).
    NoFeed,
    /// @dev `latestRoundData` reverted or returned malformed data.
    ReadFailed,
    /// @dev `answer <= 0`.
    NonPositive,
    /// @dev `updatedAt == 0` or `answeredInRound < roundId`: the round is not complete.
    RoundIncomplete,
    /// @dev `block.timestamp - updatedAt > maxAge`.
    Stale,
    /// @dev The L2 sequencer uptime feed reports down (answer 1).
    SequencerDown,
    /// @dev The sequencer is up, but came up less than `sequencerGrace` ago.
    SequencerGrace,
    /// @dev The USDC / USD feed is outside `usdcPegBandBps` of 1.
    OffPeg
}

// ─── Structs ────────────────────────────────────────────────────────────────

/// @notice One fund asset (§4.1, §4.2). Index `i` in the fund's asset list is stable for the
///         fund's life: assets are deactivated, never removed, so plan arrays stay aligned.
///         There is no sleeve or category field (§4.1, RB-9): the receipt's sleeve is an off-chain
///         label only. Each asset's target weight comes straight from the target vector.
///         Asset id: a target vector names an asset by `PlanMath.assetId`, its fund asset address.
///         That is `token` for a Basket asset and `adapter` for a Lending asset. At most one ACTIVE
///         entry has a given id (`addAsset` refuses a second, `DuplicateAsset`).
/// @param kind       Lending or Basket.
/// @param active     False after deactivation. An inactive asset has target 0 and must hold 0.
///                   A target vector may not name it (`TargetAssetNotActive`).
/// @param capBps     Lending only: hard ceiling on this adapter's share of fund NAV (ADP ramp
///                   control, ported `capBps`). 0 means "no cap" for Basket, and is invalid for
///                   Lending (use 10 000 for uncapped). A target above `capBps` is refused at plan
///                   open (`TargetExceedsCap`).
/// @param adapter    Lending: the `IStrategyAdapter` (binds an immutable VAULT == the fund).
///                   Basket: the vault-agnostic `IBasketSwapAdapter` (never address(0) here; the
///                   fund has no built-in SwapRouter path). Codehash-pinned and allowlisted.
/// @param token      Basket: the held token. Lending: address(0).
/// @param pool       Basket: the venue pool pairing `token` with USDC, used for both swap and TWAP
///                   (ORA-3 equality). Lending: address(0).
/// @param poolFee    Basket: the pool parameter forwarded to the swap adapter. V3 / V4: the fee in
///                   Uniswap units (hundredths of a bp: 500 = 5 bps, 3000 = 30 bps). Aerodrome: the
///                   pool's TICK SPACING (what the Aerodrome adapter takes), NOT a fee; the fund's
///                   `poolFeeBps` reads the fee from the pool's `fee()` (pips) for this venue and
///                   falls back to `poolFee` only when that read fails. Lending: 0.
/// @param twapWindow Basket: TWAP window in seconds, within the BasketVault bounds
///                   [600, 86 400]. Lending: 0.
/// @param venue      Basket venue (ignored for Lending).
/// @param feed       Basket (step 3d, §4.5 rule 1, E15, E16): the independent Chainlink `<token> / USD` aggregator.
///                   Required (non-zero) for a Basket asset at `addAsset`. Lending: address(0) (a lending asset is
///                   checked through its venue's own rate per unit, check 5).
/// @param maxFeedAge Basket: the most seconds since the feed's `updatedAt` for it to count as fresh (§5.9.5:
///                   the feed's heartbeat plus 5 minutes). Non-zero for a Basket asset. Lending: 0.
struct AssetConfig {
    AssetKind kind;
    bool active;
    uint16 capBps;
    address adapter;
    address token;
    address pool;
    uint24 poolFee;
    uint32 twapWindow;
    Venue venue;
    address feed;
    uint32 maxFeedAge;
}

/// @notice Per-plan parameters (§5.6 rows scoped "per plan"). Passed by RebalanceGovernance to
///         `setTargetAndOpenPlan`. Global step parameters live on the Rebalancer (`StepParams`).
/// @param duration      Glide-path length in seconds, in [MIN_PLAN_DURATION, MAX_PLAN_DURATION].
/// @param costBudgetBps Total cost the plan may spend, in bps of its turnover, in
///                      [1, MAX_COST_BUDGET_BPS].
struct PlanParams {
    uint64 duration;
    uint16 costBudgetBps;
}

/// @notice A rebalance plan (§5.1, §5.5). Stored by the fund; one current plan at a time.
/// @param id            1-based, increments on every `setTargetAndOpenPlan`. 0 = no plan.
/// @param status        See `PlanStatus`.
/// @param receiptId     The applied consensus receipt, or bytes32(0) for a `setTarget` plan.
/// @param startTime     `block.timestamp` at open.
/// @param endTime       `startTime + duration`.
/// @param startBps      Per asset (length == assetCount at open): the actual TWAP weight at open,
///                      floor-rounded. Snapshot rule: if NAV at open is 0 the start equals the end.
/// @param endBps        Per asset: the target vector at open (`PlanMath.assetTargets`), index-aligned,
///                      inactive assets 0. Sums to 10 000.
/// @param startIdleBps  Idle USDC's weight at open: `10 000 - Σ startBps` (absorbs rounding). The
///                      idle path target glides from this to 0.
/// @param navAtOpen     TWAP NAV at open (USDC, 6 decimals).
/// @param turnoverUsdc  One-sided planned turnover: `navAtOpen * Σ max(endBps_i - startBps_i, 0) / 10 000`.
/// @param costBudget    `turnoverUsdc * costBudgetBps / 10 000`, plus any `extendBudget` additions.
/// @param costSpent     Σ realized step cost (`navBefore - navAfter`, floored at 0) of this plan.
/// @param stepCount     Number of executed steps in this plan.
struct Plan {
    uint64 id;
    PlanStatus status;
    bytes32 receiptId;
    uint64 startTime;
    uint64 endTime;
    uint16[] startBps;
    uint16[] endBps;
    uint16 startIdleBps;
    uint256 navAtOpen;
    uint256 turnoverUsdc;
    uint256 costBudget;
    uint256 costSpent;
    uint32 stepCount;
}

/// @notice The order the Rebalancer sends to `RobotMoneyFund.executeStep` (§5.3 steps 4 to 7).
///         Every field is computed by the Rebalancer from chain state (RB-2).
/// @param sellIndex      Asset to reduce, or IDLE_INDEX (spend idle USDC).
/// @param buyIndex       Asset to grow, or IDLE_INDEX (keep the sell proceeds idle).
///                       `sellIndex != buyIndex`, and not both IDLE_INDEX.
/// @param notionalUsdc   USDC notional of the step at TWAP. Lending sell: USDC withdrawn. Basket
///                       sell: the fund sells `assetTokenValue(sellIndex, notionalUsdc)` tokens
///                       (capped at its balance). Idle sell: USDC spent on the buy leg.
/// @param minSellUsdcOut Floor on USDC received from the sell leg (§5.3 step 5,
///                       `TWAP quote × (1 − maxStepSlippageBps[sell])`). 0 when sell is idle.
/// @param minBuyOut      Floor on tokens received by a Basket buy leg for a spend of exactly
///                       `notionalUsdc` (`assetTokenValue(buy, notional) × (1 − slippage)`). If the
///                       sell leg returned less USDC than `notionalUsdc`, the fund spends what it got
///                       and scales this floor by `spend / notionalUsdc`. Ignored for Lending or
///                       idle buys.
/// @param maxCostUsdc    Per-step cost cap (`notionalUsdc × maxStepCostBps / 10 000`, RB-4). The fund
///                       reverts `StepCostExceeded` if `navBefore − navAfter` exceeds it.
struct StepOrder {
    uint256 sellIndex;
    uint256 buyIndex;
    uint256 notionalUsdc;
    uint256 minSellUsdcOut;
    uint256 minBuyOut;
    uint256 maxCostUsdc;
}

/// @notice What `RobotMoneyFund.executeStep` did.
/// @param navBefore  TWAP NAV before the legs (same valuation as `totalAssets()`).
/// @param navAfter   TWAP NAV after the legs.
/// @param amountIn   Amount of the sold asset that left its position (basket tokens, or USDC for a
///                   lending or idle sell).
/// @param usdcMoved  USDC that crossed the hub: received from the sell leg (or taken from idle).
/// @param amountOut  Amount of the bought asset received (basket tokens, USDC kept by a lending
///                   adapter, or USDC left idle for an idle buy).
/// @param cost       `navBefore > navAfter ? navBefore - navAfter : 0`.
struct StepResult {
    uint256 navBefore;
    uint256 navAfter;
    uint256 amountIn;
    uint256 usdcMoved;
    uint256 amountOut;
    uint256 cost;
}

/// @notice Global step parameters held by the Rebalancer (§5.6 rows scoped "global").
/// @param stepInterval   Cooldown between executed steps. >= max(MIN_STEP_INTERVAL,
///                       fund.maxTwapWindow()), <= MAX_STEP_INTERVAL.
/// @param keeperGrace    After this long with no executed step on an Open plan, `step()` is open to
///                       anyone. In [stepInterval, MAX_KEEPER_GRACE].
/// @param maxOverrun     After `endTime + maxOverrun` an unconverged Open plan expires.
///                       <= MAX_OVERRUN.
/// @param maxStepCostBps Per-step NAV-loss cap in bps of notional. In (max basket poolFeeBps,
///                       MAX_STEP_COST_BPS].
/// @param toleranceBps   Convergence band per asset (and idle) in bps of NAV. In [1, MAX_TOLERANCE_BPS].
/// @param minStepUsdc    Dust floor: a step below this notional is skipped `BelowMinStep`.
struct StepParams {
    uint32 stepInterval;
    uint32 keeperGrace;
    uint32 maxOverrun;
    uint16 maxStepCostBps;
    uint16 toleranceBps;
    uint128 minStepUsdc;
}

/// @notice Per-asset step parameters held by the Rebalancer, keyed by fund asset index (§5.6).
/// @param maxStepUsdc        Largest single-step notional touching this asset (from pool depth).
///                           0 means the asset is never traded by the rebalancer.
/// @param maxStepSlippageBps Floor against TWAP for this asset's leg. Basket: strictly above the
///                           asset's `poolFeeBps` and <= `fund.maxSlippageBps()`. Lending: <= that
///                           same ceiling; 0 allowed (withdrawals are 1:1).
struct AssetStepParams {
    uint128 maxStepUsdc;
    uint16 maxStepSlippageBps;
}

/// @notice One row of `Rebalancer.previewPlan` (§5.7 "Previewed").
/// @param currentBps  Actual TWAP weight now.
/// @param targetBps   This asset's target in the proposed per-asset vector (0 for an inactive asset).
/// @param turnoverUsdc |targetBps − currentBps| × NAV / 10 000.
/// @param estCostUsdc turnoverUsdc × poolFeeBps / 10 000 (0 for Lending).
struct PlanPreviewRow {
    uint256 currentBps;
    uint256 targetBps;
    uint256 turnoverUsdc;
    uint256 estCostUsdc;
}

/// @notice `RobotMoneyFund.initialize` parameters (ERC-4626 over USDC, share `rmFUND`).
/// @param usdc              The underlying asset.
/// @param name              Share name (e.g. "Robot Money Fund").
/// @param symbol            Share symbol ("rmFUND").
/// @param tvlCap            Max total assets after a deposit.
/// @param perDepositCap     Max USDC per deposit.
/// @param exitFeeBps        Exit fee on realized redeem proceeds, <= 100.
/// @param feeRecipient      Exit fee recipient.
/// @param maxSlippageBps    Redeem/deposit swap floor vs TWAP, <= 500, above every basket pool fee.
/// @param navDeviationGuardBps ORA-4 band; 0 disables; else above every basket pool fee, <= 2 000.
/// @param admin             Receives ADMIN_ROLE (deployer, then the timelock).
/// @param emergency         Receives EMERGENCY_ROLE.
struct FundInitParams {
    address usdc;
    string name;
    string symbol;
    uint256 tvlCap;
    uint256 perDepositCap;
    uint256 exitFeeBps;
    address feeRecipient;
    uint256 maxSlippageBps;
    uint256 navDeviationGuardBps;
    address admin;
    address emergency;
}

// ─── Shared events and errors ───────────────────────────────────────────────

/// @title IFundEvents
/// @notice Events and errors shared by the fund and the rebalancer. Both inherit this interface
///         (through IRobotMoneyFund / IRebalancer), so tests can `emit IFundEvents.X(...)`.
interface IFundEvents {
    // ── Plan lifecycle (emitted by RobotMoneyFund) ──

    /// @notice A plan opened (§5.1 step 3). Emitted after the previous live plan's
    ///         `PlanStatusChanged(..., Superseded)`.
    event PlanOpened(
        uint256 indexed planId,
        bytes32 indexed receiptId,
        uint16[] startBps,
        uint16[] endBps,
        uint64 startTime,
        uint64 endTime,
        uint256 turnoverUsdc,
        uint256 costBudget
    );

    /// @notice A plan moved between statuses (§5.5). Every transition emits exactly one.
    event PlanStatusChanged(uint256 indexed planId, PlanStatus from, PlanStatus to);

    /// @notice ADMIN raised a plan's budget (§5.5 "Safe extends").
    event PlanBudgetExtended(uint256 indexed planId, uint256 addedUsdc, uint256 newBudget);

    /// @notice The fund executed a step's legs (emitted by RobotMoneyFund inside `executeStep`).
    event StepExecuted(
        uint256 indexed planId,
        uint256 sellIndex,
        uint256 buyIndex,
        uint256 notionalUsdc,
        uint256 amountIn,
        uint256 usdcMoved,
        uint256 amountOut,
        uint256 navBefore,
        uint256 navAfter,
        uint256 cost
    );

    // ── Step outcome (emitted by Rebalancer, §5.3 step 9) ──

    /// @notice A step executed. `sellPathBps` / `buyPathBps` are the legs' path targets at the
    ///         step's timestamp (idle's path for an IDLE_INDEX leg).
    event RebalanceStep(
        uint256 indexed planId,
        uint256 sellIndex,
        uint256 buyIndex,
        uint256 notionalUsdc,
        uint256 amountIn,
        uint256 amountOut,
        uint256 cost,
        uint256 sellPathBps,
        uint256 buyPathBps
    );

    /// @notice `step()` returned without trading. `sellIndex` / `buyIndex` are the chosen legs when
    ///         known, else IDLE_INDEX. `detail`: asset index for MarketDeviation, revert selector
    ///         for StepFailed, the notional for BelowMinStep, the seconds remaining for Cooldown,
    ///         0 otherwise.
    event RebalanceStepSkipped(
        uint256 indexed planId, SkipReason reason, uint256 sellIndex, uint256 buyIndex, uint256 detail
    );

    // ── Shared errors ──

    error ZeroAddress();
    error InvalidParam();
    // ── Target vector checks (§4.1, RB-9). Each refused vector reverts the whole call. ──

    /// @notice A target vector names `asset`, which is not an active fund asset (unknown or
    ///         deactivated).
    error TargetAssetNotActive(address asset);
    /// @notice A target vector names `asset` more than once.
    error TargetAssetDuplicate(address asset);
    /// @notice A target vector leaves out the active asset `asset`. An explicit 0 is required to
    ///         sell an asset, so a vector can never sell one by forgetting it.
    error TargetAssetMissing(address asset);
    /// @notice A target vector's weights do not sum to 10 000. A single weight above 10 000 reverts
    ///         at once and reports that weight.
    error TargetSumInvalid(uint256 sum);
    /// @notice A Lending asset's target exceeds its `capBps` (a risk ceiling on one venue).
    error TargetExceedsCap(uint256 index, uint256 targetBps, uint256 capBps);
    /// @notice An asset index is out of range, inactive, or IDLE_INDEX where not allowed.
    error InvalidAssetIndex(uint256 index);
    /// @notice A plan parameter is out of its §5.6 bound.
    error PlanParamOutOfBounds();
    /// @notice A step parameter is out of its §5.6 bound.
    error StepParamOutOfBounds();
    /// @notice A slippage or deviation bound is at or below the asset's pool fee (§5.6 last para).
    error BoundAtOrBelowPoolFee(uint256 index, uint256 boundBps, uint256 poolFeeBps);
}
