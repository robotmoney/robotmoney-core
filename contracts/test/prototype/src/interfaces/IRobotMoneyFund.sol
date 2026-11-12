// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4 (target architecture), §4.1-§4.4 (asset targets, NAV,
//            deposits, redemptions), §5.1 (setTargetAndOpenPlan), §5.3 (executeStep), §5.5 (plan admin), §6
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {
    AssetConfig,
    FeedStatus,
    IFundEvents,
    Plan,
    PlanParams,
    PlanStatus,
    StepOrder,
    StepResult,
    StepFeedCheck
} from "../FundTypes.sol";

/// @title IRobotMoneyFund
/// @notice The one vault (`RobotMoneyFund`, share `rmFUND`): an ERC-4626 over USDC behind
///         `GovernedUUPS`, holding a flat list of lending adapters and basket tokens. Each asset has one
///         target weight. No contract stores or reads a sleeve or category (§4.1, RB-9).
///
///         Authority (RB-1, RB-3):
///         - `setTargetAndOpenPlan`  GOVERNANCE_ROLE only (RebalanceGovernance).
///         - `executeStep`, `concludePlan`  REBALANCER_ROLE only (Rebalancer).
///         - `pauseRebalance`, `pauseDeposits`, `shutdown`, `emergencyUnwind`  EMERGENCY_ROLE.
///         - `resumePlan`, `extendBudget`, `closePlan`, asset config, caps, fees  ADMIN_ROLE (timelock).
///         - `redeem`, `redeemInKind`  never gated by plan state, pause, or shutdown (RB-6).
///
///         Implementation contract `initialize(FundInitParams p, address upgradeTimelock,
///         GovernedUUPS.UpgradeMode mode)` is not part of this interface.
///
///         ERC-4626 is NOT inherited here: the fund inherits `ERC4626Upgradeable` (which already is
///         `IERC4626`), and re-inheriting `IERC4626` would force `override(ERC4626Upgradeable,
///         IERC4626)` on every overridden ERC-4626 function. Callers that need both surfaces use
///         `IRobotMoneyFundFull` below. The fund contract is
///         `RobotMoneyFund is ERC4626Upgradeable, AdminFloorAccessControlCounter,
///         ReentrancyGuardUpgradeable, GovernedUUPS, IRobotMoneyFund`. It uses the counter variant of
///         the last-admin floor (the one `BasketVault` uses), not the Enumerable one: same floor
///         semantics, no `getRoleMember` enumeration, and it keeps the fund under EIP-170 (§6.1).
interface IRobotMoneyFund is IFundEvents {
    // ─── Fund events ─────────────────────────────────────────────────────────

    event AssetAdded(uint256 indexed index, AssetConfig config);
    event AssetDeactivated(uint256 indexed index);
    event AdapterCodeHashAllowedSet(bytes32 indexed codeHash, bool allowed);
    event DepositsPaused(address indexed account);
    event DepositsUnpaused(address indexed account);
    event Shutdown();
    event Restored(uint256 newTvlCap);
    event EmergencyUnwound(uint256 usdcRecovered);
    event RedeemedInKind(address indexed owner, address indexed receiver, uint256 shares);
    event ExitFeeCharged(address indexed owner, uint256 grossAssets, uint256 fee);
    event ForeignTokenSwept(address indexed token, uint256 amount);
    /// @notice An in-kind leg of asset `index` could not pay out (venue freeze, §5.8 row 7): `amount` is now
    ///         owed to `account` (`claimDeferred`) and left the holders' books.
    event InKindDeferred(uint256 indexed index, address indexed account, uint256 amount);
    /// @notice `account` pulled its deferred `amount` of asset `index` to `to`.
    event DeferredClaimed(uint256 indexed index, address indexed account, address to, uint256 amount);
    /// @notice `bindRebalanceRoles` granted the two plan roles, once.
    event RebalanceRolesBound(address governance, address rebalancer);

    // ─── Fund errors ─────────────────────────────────────────────────────────

    /// @notice `withdraw` / `previewWithdraw` are not offered (§4.4).
    error RedeemOnly();
    error DepositsArePaused();
    error FundIsShutdown();
    error TVLCapExceeded();
    error PerDepositCapExceeded();
    /// @notice Realized TWAP NAV delta of a deposit fell below the slippage floor (§4.3).
    error DepositBelowSlippageFloor(uint256 realizedDelta, uint256 floor);
    /// @notice ORA-4: spot deviates from TWAP beyond `navDeviationGuardBps` (deposit, executeStep).
    error NavMarketDeviationExceeded(address token, uint256 deviationBps, uint256 thresholdBps);
    error AdapterCodeHashNotAllowed(address adapter, bytes32 codeHash);
    error MaxAssetsReached();
    /// @notice The asset still holds value, so it cannot be deactivated.
    error AssetStillHeld(uint256 index);
    /// @notice The fund's persistent target still gives the asset weight, so it cannot be deactivated.
    ///         Apply a vector that names it with 0 first. Then no vector loses weight silently (RB-9).
    error AssetStillTargeted(uint256 index, uint256 targetBps);
    /// @notice Asset config (add, deactivate) is frozen while a plan is live
    ///         (Open, Halted or Paused). Close the plan first. `setAdapterCodeHashAllowed` is NOT
    ///         frozen: excluding a bad adapter (ADP-2) must never wait for a plan to end.
    error PlanLive(uint256 planId);
    /// @notice The plan is not in a status that allows this transition.
    error InvalidPlanTransition(uint256 planId, PlanStatus from, PlanStatus to);
    /// @notice A step would move a leg past its path target (RB-7 guard inside the fund).
    error StepExceedsPath(uint256 index, uint256 notional, uint256 room);
    /// @notice `navBefore − navAfter` exceeded `order.maxCostUsdc` (RB-4).
    error StepCostExceeded(uint256 cost, uint256 maxCost);
    /// @notice A leg received less than its floor.
    error StepBelowMinOut(uint256 index, uint256 received, uint256 minOut);
    /// @notice The idle sell leg asked for more USDC than the fund holds idle.
    error InsufficientIdle(uint256 requested, uint256 available);
    /// @notice `sweepForeignToken` named USDC, a fund asset token, or a lending adapter share token.
    error ProtectedToken(address token);
    /// @notice `addAsset`: the Lending adapter's immutable `VAULT()` is not this fund.
    error AdapterVaultMismatch(address adapter, address expected, address actual);
    /// @notice `addAsset`: the Lending adapter's `USDC()` is not the fund's asset.
    error AdapterAssetMismatch(address adapter, address expected, address actual);
    /// @notice `addAsset`: an active entry already has this asset id (`PlanMath.assetId`), of
    ///         either kind. One balance would count twice (NC-8), and a target vector could not
    ///         tell the two entries apart.
    error DuplicateAsset(uint256 existingIndex);
    /// @notice Deposits are closed while a Lending asset is excluded (ADP-2, core 1788): a deposit
    ///         would mint against a NAV the excluded value has left.
    error DepositsClosedDuringExclusion();
    /// @notice `claimDeferred`: `account` is owed nothing from asset `index`.
    error NothingDeferred(uint256 index, address account);
    /// @notice `claimDeferred`: the Lending adapter delivered `received` of the `owed` USDC; the claim stays.
    error DeferredShortfall(uint256 index, uint256 received, uint256 owed);
    /// @notice `bindRebalanceRoles` already ran (the plan roles bind once, RB-1).
    error RolesAlreadyBound();

    // ─── Step 3d: timed flows (proposal §4.5, §5.9; eng plan E1 to E23) ─────

    /// @notice `bindFlowRole` granted FLOW_ROLE to the queue, once (E1).
    event FlowRoleBound(address indexed queue);
    /// @notice `seed` minted `shares` to the fund itself for `usdc` (E14). Those shares never move.
    event Seeded(uint256 usdc, uint256 shares);
    /// @notice `mintInKind` bought the pro-rata slice and minted `sharesOut` to `to` (the queue) for `usdcSpent` (E3).
    event MintedInKind(address indexed to, uint256 sharesOut, uint256 usdcSpent, uint256 supplyBefore);
    /// @notice `sellForFlow` burned `shares` of `from` (the queue), sold their slice for `usdcGross`, paid `fee` to
    ///         the fee recipient and `usdcOut` to `from` (E4).
    event SoldForFlow(address indexed from, uint256 shares, uint256 usdcGross, uint256 fee, uint256 usdcOut);
    /// @notice An in-kind exit turned `units` of lending position `index` into a position-share claim of
    ///         `account` (E9, RB-21), beyond the period's allowance or because the venue could not pay.
    event PositionClaimRecorded(uint256 indexed index, address indexed account, uint256 units);
    /// @notice `account` redeemed `units` of its claim on lending position `index` for `usdc`, paid to `to`.
    event PositionClaimed(uint256 indexed index, address indexed account, address to, uint256 units, uint256 usdc);
    /// @notice ADMIN set the least seed (E14).
    event MinSeedUsdcSet(uint256 minSeedUsdc);
    /// @notice ADMIN set the pool-share rule (§4.5 rule 3).
    event PoolShareBpsSet(uint16 poolShareBps);

    /// @notice The fund's own `deposit`, `mint` and `redeem` are closed (E2): use the FlowQueue at `queue`
    ///         (address(0) before `bindFlowRole`). `redeemInKind` stays open on the fund.
    error UseFlowQueue(address queue);
    /// @notice `bindFlowRole` already ran.
    error FlowRoleAlreadyBound();
    /// @notice `seed` already ran, or the supply is not zero (E14).
    error AlreadySeeded();
    /// @notice `seed` below `minSeedUsdc` (E14).
    error SeedBelowMinimum(uint256 usdc, uint256 minSeedUsdc);
    /// @notice `mintInKind` / `sellForFlow` on a fund with zero supply (E14: a ratio has no meaning there).
    error NotSeeded();
    /// @notice A per-leg limit array does not have one entry per asset (`assetCount()`).
    error LegLimitsLength(uint256 given, uint256 expected);
    /// @notice `mintInKind` would spend more than `maxUsdc` (E3).
    error MintInKindOverMax(uint256 spent, uint256 maxUsdc);
    /// @notice A flow leg broke its per-swap limit: a purchase needed more than `limit` USDC, or a sale returned
    ///         less than `limit` USDC (proposal §5.9.3 checks 8 and 9). `amount` is what it needed or got.
    error FlowLegLimit(uint256 index, uint256 amount, uint256 limit);
    /// @notice Check 10 (RB-13), asserted inside the fund: for asset `index` (IDLE_INDEX for idle USDC)
    ///         `after × supplyBefore < before × supplyAfter`. The comparison is exact; the lending margin is
    ///         `LENDING_ROUNDING_UNITS`, applied to the amounts moved, never to this comparison.
    error ProportionViolated(uint256 index, uint256 before, uint256 afterAmount, uint256 supplyBefore, uint256 supplyAfter);
    /// @notice E19: a NAV view read an unhealthy feed for asset `index` (`IDLE_INDEX` for the USDC / USD feed).
    error FeedUnhealthy(uint256 index, FeedStatus status);
    /// @notice `addAsset` (E15, RB-17): a Basket asset without a feed or without a `maxFeedAge`.
    error MissingFeed(uint256 index);
    /// @notice `addAsset` (E15, RB-17): the pool cannot answer `observe` over one settlement window.
    error PoolHistoryTooShort(uint256 index, uint32 window);
    /// @notice `addAsset` (E15): a Lending adapter does not expose its venue's `ratePerUnit()`.
    error LendingRateUnavailable(address adapter);
    /// @notice `setTargetAndOpenPlan` (§4.5 rule 3, E15): `targetBps × tvlCap` is over `poolShareBps` of the
    ///         pool's time-weighted active liquidity for asset `index`.
    error PoolShareExceeded(uint256 index, uint256 targetUsdc, uint256 limitUsdc);
    /// @notice `claimPosition`: `account` holds no claim units on lending position `index`.
    error NoPositionClaim(uint256 index, address account);
    /// @notice `mintInKind` (E3): lending venue `index` kept only `placed` of the `asked` USDC (it refused the supply:
    ///         a supply cap, a pause). The whole purchase reverts, so the queue leaves the deposit side pending.
    error LendingSupplyRefused(uint256 index, uint256 placed, uint256 asked);
    /// @notice E14: the seed shares the fund holds for itself never move (no transfer, burn or in-kind exit).
    error SeedSharesLocked();

    // ─── Step 3d, fund-extras (E9, E15, E19, E20, E23; scaffold plan §7.4). Appended. ─────────────────

    /// @notice ADMIN set the in-kind allowance (E20, coordinator ruling 6).
    event InKindAllowanceSet(uint16 bps, uint128 floorUsdc, uint32 period);

    /// @notice ADMIN_ROLE. Set the in-kind allowance: per period of `period` seconds, in-kind exits take lending USDC
    ///         up to `max(bps × lending holdings / 10 000, floorUsdc)` (E20). `bps ≤ 10 000`, `floorUsdc ≤
    ///         MAX_IN_KIND_FLOOR_USDC`, `period` in [MIN_IN_KIND_PERIOD, MAX_IN_KIND_PERIOD] (`InvalidParam`).
    ///         The Safe keeps these equal to the queue's `maxEpochFlowBps`, `epochFlowFloorUsdc` and `epochLength`.
    function setInKindAllowance(uint16 bps, uint128 floorUsdc, uint32 period) external;

    /// @notice The in-kind allowance parameters and the lending USDC in-kind exits took in the current period.
    function inKindAllowance() external view returns (uint16 bps, uint128 floorUsdc, uint32 period, uint256 usedNow);

    // ─── Step 3e (proposal §5.10; RB-4, RB-5 and RB-19 from step 3e; step-3 finish plan §3.5). Appended. ─────

    /// @notice `executeStep` refused: a feed check of the step failed before any trade (checks 2 and 4 of §5.9.3
    ///         on the step, RB-19). See `StepFeedCheck` for `index` and `detail`.
    error StepFeedCheckFailed(StepFeedCheck check, uint256 index, uint256 detail);
    /// @notice RB-19: after the legs, asset `index` moved although it is not a leg, or a leg moved the wrong way (the
    ///         sell leg grew, the buy leg shrank). Amounts are the holders' held amounts (`heldBalances`).
    error StepBalanceChanged(uint256 index, uint256 before, uint256 afterAmount);
    /// @notice RB-19: the share supply changed inside a step.
    error StepSupplyChanged(uint256 before, uint256 afterSupply);

    /// @notice The step's cost at both prices (proposal §5.10, RB-4 from step 3e). `feedNavBefore` and `feedNavAfter`
    ///         value idle USDC and the step's two legs at the feeds (every other asset is unchanged, RB-19), so their
    ///         difference is the fund's NAV change at the feeds. `feedCost` = `max(feedNavBefore − feedNavAfter, 0)` is
    ///         the cost the plan books (`costSpent`, `StepExecuted.cost`). `twapCost` = `max(navBefore − navAfter, 0)`
    ///         at the TWAP. The step reverts `StepCostExceeded` when either exceeds the order's `maxCostUsdc`.
    event StepCostBooked(
        uint256 indexed planId, uint256 feedNavBefore, uint256 feedNavAfter, uint256 feedCost, uint256 twapCost
    );

    // ═════════════════════════════════════════════════════════════════════════
    //  ERC-4626 surface (§4.3, §4.4). Inherited signatures; semantics pinned here.
    // ═════════════════════════════════════════════════════════════════════════
    //
    //  totalAssets()   idle USDC + Σ active lending adapter.totalAssets()
    //                  + Σ basket balance × TWAP price (§4.2). Never reads spot.
    //  deposit(a, r)   Reverts DepositsArePaused / FundIsShutdown / TVLCapExceeded /
    //                  PerDepositCapExceeded / DepositsClosedDuringExclusion /
    //                  NavMarketDeviationExceeded (ORA-4 on every basket asset). Splits `a` with PlanMath.deficitSplit against
    //                  `currentTargetBps()`, deploys lending legs (capped by capBps headroom,
    //                  refused USDC stays idle) and buys basket legs (minOut from TWAP ×
    //                  (1 − maxSlippageBps)). Mints on the REALIZED TWAP NAV delta:
    //                  shares = delta × (supply + 10^offset) / (taBefore + 1). Reverts
    //                  DepositBelowSlippageFloor if delta < a × (1 − maxSlippageBps).
    //                  Returns the shares actually minted.
    //  mint(s, r)      Same path as deposit (realized-delta mint); may mint more than `s`.
    //  previewDeposit  Floor: shares for a × (1 − maxSlippageBps). Reverts on ORA-4 and on an
    //                  open exclusion like deposit.
    //  redeem(s, r, o) Pro rata across every holding: withdraws `s/supply` of each lending
    //                  adapter and sells `s/supply` of each basket token (TWAP floor ×
    //                  (1 − maxSlippageBps)), plus the pro-rata idle. A short lending fill
    //                  never reverts (pays what was realized); a lending withdraw that
    //                  REVERTS (venue frozen) reverts the redeem until the venue reopens
    //                  (a venue freeze, not rebalancing state). Exit fee on realized
    //                  proceeds. Never blocked by plan status, pause, or shutdown (RB-6).
    //                  Returns the USDC actually paid.
    //  previewRedeem   Worst case: gross × (1 − maxSlippageBps) × (1 − exitFeeBps).
    //  withdraw / previewWithdraw   revert RedeemOnly.
    //  maxDeposit      0 while paused, shut down or a lending asset is excluded, else
    //                  min(tvl headroom, perDepositCap).
    //  maxWithdraw     0 (withdraw is not offered).

    // ═════════════════════════════════════════════════════════════════════════
    //  Holder exits beyond ERC-4626
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Oracle-free, swap-free exit (§4.4): burn `shares` of `owner`; pay `receiver` the
    ///         pro-rata idle USDC, the pro-rata USDC withdrawn from each lending adapter, and the
    ///         pro-rata balance of each active basket token, each leg net of `exitFeeBps`.
    ///         Never gated by plan state, pause or shutdown (RB-6). Spends allowance when
    ///         `msg.sender != owner`. Rounding favours remaining holders.
    ///         A leg that cannot pay out (a frozen basket token, a lending venue that is paused or
    ///         fully utilized) does not revert the exit: its amount is deferred to `receiver` (and the
    ///         fee share to `feeRecipient`) and later pulled with `claimDeferred` (§5.8 row 7).
    ///         Step 3d (E9, E20, E23, RB-13, RB-21): asserts the proportion check. The lending part is paid in
    ///         USDC up to the period's in-kind allowance (`inKindAllowance`), pro rata over the venues; the rest,
    ///         and any part a venue cannot pay or whose value read reverts, becomes a claim on a share of that
    ///         lending position (`positionClaimOf`, `claimPosition`), never a fixed USDC amount. `receiver ==
    ///         address(0)` reverts `ZeroAddress`. Every claim or deferral is keyed to `owner` (E23), except for
    ///         shares the FlowQueue escrows (`owner == flowQueue()`), where it is keyed to `receiver`, the request's
    ///         owner the queue names. The exit fee applies to every leg, claims included.
    function redeemInKind(uint256 shares, address receiver, address owner) external;

    /// @notice Pull everything `msg.sender` is owed from asset `index` by past in-kind exits, to `to`.
    ///         Reverts `NothingDeferred`, or `DeferredShortfall` while the lending venue still cannot pay.
    function claimDeferred(uint256 index, address to) external returns (uint256 amount);

    /// @notice What `account` is owed from asset `index` (token units for Basket, USDC for Lending).
    function deferredOf(uint256 index, address account) external view returns (uint256);

    /// @notice Total owed from asset `index`; excluded from NAV and from every pro-rata leg.
    function deferredTotal(uint256 index) external view returns (uint256);

    // ═════════════════════════════════════════════════════════════════════════
    //  Step 3d: timed flows (proposal §4.3, §4.4, §4.5, §5.9; eng plan E1 to E23)
    // ═════════════════════════════════════════════════════════════════════════
    //
    //  The ERC-4626 entry points change meaning in step 3d (E2): the fund's own `deposit`, `mint` and `redeem`
    //  revert `UseFlowQueue(flowQueue())`; `withdraw` keeps reverting `RedeemOnly`; `totalAssets` and the convert
    //  views revert `FeedUnhealthy` when a feed is unhealthy (E19). The block comment above describes the step 3c
    //  behaviour that the frozen baseline (contracts/test/prototype/baseline/) keeps.
    //  Units: USDC amounts are 6-decimal USDC units; share amounts are raw share units (10^18 per USDC unit at
    //  the seed scale); prices use `PRICE_SCALE` (FundTypes). INTERFACES.md in the scaffold run directory lists
    //  caller, units and rounding for every function here.

    /// @notice ADMIN_ROLE, once: grant FLOW_ROLE to `queue` (E1). FLOW_ROLE is self-administered afterwards, so
    ///         no ADMIN_ROLE holder can grant it to another address. Reverts `FlowRoleAlreadyBound`, `ZeroAddress`.
    function bindFlowRole(address queue) external;

    /// @notice The bound FlowQueue (address(0) before `bindFlowRole`).
    function flowQueue() external view returns (address);

    /// @notice ADMIN_ROLE, once, only at zero supply (E14): pull `usdc` (≥ `minSeedUsdc`) from the caller and mint
    ///         `usdc × 10^18` shares (the existing share scale) to the fund itself. Those shares never move.
    ///         Reverts `AlreadySeeded`, `SeedBelowMinimum`.
    /// @return shares Shares minted to the fund.
    function seed(uint256 usdc) external returns (uint256 shares);

    /// @notice FLOW_ROLE only (E3). Buy the pro-rata slice for `sharesOut` new shares and mint them to the caller.
    ///         For every active asset and idle USDC, on held amounts (`heldBalances`): the fund adds
    ///         `ceil(held × sharesOut / supply)` (idle: kept from the USDC pulled; Lending: supplied, plus
    ///         `LENDING_ROUNDING_UNITS`; Basket: an exact-output swap whose input is at most `maxUsdcPerLeg[i]`).
    ///         Then it mints exactly `sharesOut` and asserts the proportion check (check 10, `ProportionViolated`).
    ///         The caller's USDC falls by exactly `usdcSpent` (≤ `maxUsdc`, else `MintInKindOverMax`); unused USDC is
    ///         never taken. A venue that refuses a supply reverts the call. Reverts `NotSeeded` at zero supply,
    ///         `LegLimitsLength`, `FlowLegLimit`.
    /// @param sharesOut      Shares to mint, computed by the caller and rounded DOWN.
    /// @param maxUsdc        The most USDC the caller lets the fund take (approved to the fund).
    /// @param maxUsdcPerLeg  Per asset index (length `assetCount()`): the most USDC the purchase of that Basket
    ///                       asset may spend (check 9). Ignored for Lending and inactive assets.
    /// @return usdcSpent     USDC taken from the caller.
    function mintInKind(uint256 sharesOut, uint256 maxUsdc, uint256[] calldata maxUsdcPerLeg)
        external
        returns (uint256 usdcSpent);

    /// @notice FLOW_ROLE only (E4). Burn `shares` of the caller, withdraw `floor(held × shares / supply)` of each
    ///         Lending position less `LENDING_ROUNDING_UNITS`, sell the same fraction of each Basket token with at
    ///         least `minUsdcPerLeg[i]` USDC out (check 8), add the pro-rata idle USDC, pay `exitFeeBps` of the
    ///         realized gross to the fee recipient and the rest to the caller. Asserts the proportion check.
    ///         Reverts `NotSeeded`, `LegLimitsLength`, `FlowLegLimit`, `ProportionViolated`.
    /// @return usdcOut USDC paid to the caller, net of the exit fee.
    function sellForFlow(uint256 shares, uint256[] calldata minUsdcPerLeg) external returns (uint256 usdcOut);

    /// @notice Lending position `index` claim of `account` (E9, RB-21): its units and their USDC value today
    ///         (`units × adapter.totalAssets() / positionUnits`, rounded down).
    function positionClaimOf(uint256 index, address account) external view returns (uint256 units, uint256 usdcValue);

    /// @notice Total units of lending position `index`, and the units held by claims (E9).
    function positionUnits(uint256 index) external view returns (uint256 totalUnits, uint256 claimUnits);

    /// @notice The caller redeems its whole claim on lending position `index` at today's value and the USDC goes
    ///         to `to` (E9, RB-21). Reverts `NoPositionClaim`, `ZeroAddress`, or `DeferredShortfall` while the
    ///         venue cannot pay (the claim then stays whole). fund-extras: it pays `LENDING_ROUNDING_UNITS` less than
    ///         the claim's value (venue rounding falls on the claim, never on the holders) and burns the claim's
    ///         units; a venue whose `withdraw` reverts reverts the call.
    /// @return usdc USDC paid.
    function claimPosition(uint256 index, address to) external returns (uint256 usdc);

    /// @notice FLOW_ROLE only (E13, RB-22). Checkpoint `account` in the exclusion ledger BEFORE the queue changes
    ///         its queued shares. A no-op while no exclusion record exists.
    function ledgerCheckpoint(address account) external;

    /// @notice What the exclusion ledger credits to `account` (E13): wallet shares plus the shares the queue holds
    ///         for it (`IFlowQueue.queuedSharesOf`). 0 for the queue's own address.
    function ledgerBalanceOf(address account) external view returns (uint256);

    /// @notice Held amounts (E3, E4, check 7): idle USDC, and per asset index the amount the fund holds net of
    ///         deferred in-kind claims (Lending: USDC in the adapter attributable to holders; Basket: tokens).
    ///         Assets that are not counted (inactive, or a Lending asset under an open ADP-2 exclusion) read 0: no
    ///         flow trades them, so the proportion check does not compare them. These are the amounts check 10
    ///         compares.
    function heldBalances() external view returns (uint256 idle, uint256[] memory held);

    /// @notice The last NAV computed while every feed was healthy, and its time (E19). Never reverts.
    ///         fund-extras: while `totalAssets()` reads (feeds healthy), it is `(totalAssets(), block.timestamp)`;
    ///         otherwise the value the fund recorded at its last `seed`, `mintInKind`, `sellForFlow` or `executeStep`
    ///         with healthy feeds, and that time; `(0, 0)` if it never recorded one.
    function lastGoodNav() external view returns (uint256 nav, uint64 at);

    /// @notice The least `seed` accepts (§5.9.5, fund-held).
    function minSeedUsdc() external view returns (uint256);

    /// @notice The pool-share rule (§4.5 rule 3, fund-held).
    function poolShareBps() external view returns (uint16);

    /// @notice ADMIN_ROLE. In [`MIN_MIN_SEED_USDC`, `MAX_MIN_SEED_USDC`].
    function setMinSeedUsdc(uint256 newMin) external;

    /// @notice ADMIN_ROLE. In (0, `MAX_POOL_SHARE_BPS`].
    function setPoolShareBps(uint16 newBps) external;

    /// @notice ADMIN_ROLE, once: grant GOVERNANCE_ROLE to `governance` and REBALANCER_ROLE to
    ///         `rebalancer`. Both roles are self-administered, so after this no ADMIN_ROLE holder can
    ///         grant either to anyone else (RB-1; the router's WEIGHT_SETTER_ROLE model). The contracts
    ///         behind both addresses are upgradeable proxies, so they never need re-binding.
    function bindRebalanceRoles(address governance, address rebalancer) external;

    // ═════════════════════════════════════════════════════════════════════════
    //  Plan entry points (§5.1, §5.3, §5.5)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Set the end target and open a plan (§5.1 step 3). GOVERNANCE_ROLE only (RB-1).
    ///         1. `params` within §5.6 bounds (`PlanParamOutOfBounds`).
    ///         2. `endBps = PlanMath.assetTargets(assets, bps, assetConfigs)`, which enforces the
    ///            §4.1 checks (RB-9): every listed asset is active (`TargetAssetNotActive`), no
    ///            asset is listed twice (`TargetAssetDuplicate`), every active asset is listed
    ///            (`TargetAssetMissing`), the weights sum to 10 000 (`TargetSumInvalid`), and a
    ///            Lending target is at or below its `capBps` (`TargetExceedsCap`). A length
    ///            mismatch reverts `InvalidParam`.
    ///         3. If the current plan is live (Open, Halted, Paused): status → Superseded
    ///            (`PlanStatusChanged`). Plans never stack.
    ///         4. Value every asset at TWAP; `(startBps, startIdleBps) = PlanMath.snapshotStart`.
    ///         5. Store the new plan: id = previous + 1, Open, startTime = now,
    ///            endTime = now + duration, turnover and budget per `Plan` docs, costSpent 0.
    ///            The fund's persistent target (`targetBps()`) becomes `endBps`.
    ///         6. Emit `PlanOpened`.
    /// @param assets    Asset ids, any order: each active asset's fund asset address
    ///                  (`PlanMath.assetId`: `token` for Basket, `adapter` for Lending).
    /// @param bps       Parallel target weights in bps of NAV. Idle USDC carries no target.
    /// @param params    Per-plan parameters.
    /// @param receiptId The applied receipt, or bytes32(0) for a `setTarget` plan.
    /// @return planId   The new plan's id.
    function setTargetAndOpenPlan(
        address[] calldata assets,
        uint256[] calldata bps,
        PlanParams calldata params,
        bytes32 receiptId
    ) external returns (uint256 planId);

    /// @notice Execute one step's legs (§5.3 steps 5-8). REBALANCER_ROLE only. `nonReentrant`.
    ///         Reverts unless the current plan is Open. Order of operations:
    ///         1. Validate indices (`InvalidAssetIndex`; sell != buy; not both idle; active).
    ///         2. ORA-4 on every Basket leg (`NavMarketDeviationExceeded`, RB-5 defence in depth).
    ///         3. Value all holdings at TWAP → `navBefore`. RB-7 guard: the sell leg must be over its
    ///            `pathTarget(now)` value by ≥ notional, and the buy leg (if not idle) under it by
    ///            ≥ notional, else `StepExceedsPath`.
    ///         4. Sell leg → USDC: Lending `withdraw(notional)` measured by balance delta; Basket
    ///            sells `min(balance, assetTokenValue(sell, notional))` tokens through its swap
    ///            adapter with recipient = fund; idle uses `notional` of idle USDC
    ///            (`InsufficientIdle`). Require received ≥ `minSellUsdcOut` (`StepBelowMinOut`).
    ///         5. Buy leg ← spend = min(received, notional): Lending `deploy(spend)` (USDC the
    ///            adapter hands back stays idle); Basket swap with floor `minBuyOut × spend /
    ///            notional`, recipient = fund (`StepBelowMinOut`); idle keeps it.
    ///         6. `navAfter` at TWAP; cost = max(navBefore − navAfter, 0); revert
    ///            `StepCostExceeded` if cost > `maxCostUsdc` (RB-4).
    ///         7. plan.costSpent += cost; plan.stepCount += 1; lastStepAt = now. If
    ///            costSpent > costBudget: status → Halted (`PlanStatusChanged`).
    ///         8. Emit `StepExecuted`.
    ///         Every swap recipient is the fund and every USDC destination is an allowlisted
    ///         adapter or swap adapter (RB-3, INV-1).
    function executeStep(StepOrder calldata order) external returns (StepResult memory result);

    /// @notice Move the Open plan to a terminal status decided by the Rebalancer (§5.5).
    ///         REBALANCER_ROLE only. `to` must be Converged (requires now ≥ endTime) or Expired
    ///         (requires now > endTime); anything else reverts `InvalidPlanTransition`.
    function concludePlan(PlanStatus to) external;

    /// @notice Open or Halted → Paused. EMERGENCY_ROLE (§5.5 "pause a plan at once"): a Halted plan is
    ///         paused too, so a queued `extendBudget` cannot reopen it behind the hot key's back.
    ///         Reverts `InvalidPlanTransition` otherwise.
    function pauseRebalance() external;

    /// @notice Paused → Open, or Paused → Halted when `costSpent > costBudget` (a plan paused while
    ///         Halted stays over budget until the Safe extends it). ADMIN_ROLE (§5.5).
    ///         Reverts `InvalidPlanTransition` otherwise.
    ///         Does not reset `lastStepAt`; the next step still observes the cooldown.
    function resumePlan() external;

    /// @notice Add `addedUsdc` to the live plan's `costBudget`. ADMIN_ROLE (§5.5). Allowed on Open,
    ///         Halted and Paused. A Halted plan becomes Open when `costSpent ≤ costBudget` after
    ///         the addition. Emits `PlanBudgetExtended` (and `PlanStatusChanged` when it reopens).
    function extendBudget(uint256 addedUsdc) external;

    /// @notice Close the live plan (Open, Halted or Paused) → Superseded. ADMIN_ROLE (§5.5
    ///         "Only the Safe ... closes it"). The persistent target is unchanged.
    function closePlan() external;

    // ═════════════════════════════════════════════════════════════════════════
    //  Views for the Rebalancer and governance tooling
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Number of assets (active and inactive). Indices are stable.
    function assetCount() external view returns (uint256);

    /// @notice The config of asset `index`.
    function assetConfig(uint256 index) external view returns (AssetConfig memory);

    /// @notice Every asset config, index-aligned.
    function assetConfigs() external view returns (AssetConfig[] memory);

    /// @notice Idle USDC held by the fund.
    function idleUsdc() external view returns (uint256);

    /// @notice USDC value of asset `index` at TWAP (Lending: `adapter.totalAssets()`; Basket:
    ///         balance × TWAP). 0 for an inactive asset and for an excluded Lending asset (ADP-2:
    ///         its balance leaves NAV while the exclusion record is open).
    function assetValue(uint256 index) external view returns (uint256);

    /// @notice One-call valuation: `nav == idle + Σ values == totalAssets()`.
    function portfolioValues() external view returns (uint256 nav, uint256 idle, uint256[] memory values);

    /// @notice USDC value of `tokenAmount` of Basket asset `index` at its TWAP. Lending: identity.
    function assetUsdcValue(uint256 index, uint256 tokenAmount) external view returns (uint256);

    /// @notice Amount of Basket asset `index` worth `usdcAmount` at its TWAP. Lending: identity.
    function assetTokenValue(uint256 index, uint256 usdcAmount) external view returns (uint256);

    /// @notice ORA-4 for one asset: `ok` when Lending and counted, when `navDeviationGuardBps == 0`,
    ///         or when |spot − TWAP| ≤ `navDeviationGuardBps`. Never reverts. An excluded Lending
    ///         asset (ADP-2) returns `ok == false`, so the Rebalancer's eligibility mask drops it. A
    ///         Basket asset whose TWAP, spot or observe read fails returns `(false, type(uint256).max)`.
    function marketCheck(uint256 index) external view returns (bool ok, uint256 deviationBps);

    /// @notice Asset `index`'s pool fee in bps, rounded UP (`ceil(fee pips / 100)`); 0 for Lending.
    ///         V3 / V4: fee pips = `poolFee`. Aerodrome: `poolFee` is the tick spacing, so the fee
    ///         pips are read from the pool's `fee()` (falls back to `poolFee` if that read fails).
    function poolFeeBps(uint256 index) external view returns (uint256);

    /// @notice Longest `twapWindow` over active Basket assets (0 if none). The Rebalancer's
    ///         `stepInterval` must be ≥ this (§5.3 step 1).
    function maxTwapWindow() external view returns (uint32);

    /// @notice Largest `poolFeeBps` over active Basket assets (0 if none).
    function maxPoolFeeBps() external view returns (uint256);

    /// @notice ORA-4 band in bps (0 = disabled).
    function navDeviationGuardBps() external view returns (uint256);

    /// @notice Deposit/redeem swap floor vs TWAP in bps; the ceiling for `maxStepSlippageBps`.
    function maxSlippageBps() external view returns (uint256);

    /// @notice The current plan (the latest opened; may be terminal). `id == 0` before any plan.
    function plan() external view returns (Plan memory);

    /// @notice The current plan's id (0 before any plan).
    function currentPlanId() external view returns (uint256);

    /// @notice The current plan's status (`None` before any plan).
    function planStatus() external view returns (PlanStatus);

    /// @notice Timestamp of the last executed step across all plans (0 if none). Not reset by a
    ///         new plan, so the cooldown always spans the previous trade.
    function lastStepAt() external view returns (uint64);

    /// @notice The persistent end target per asset (bps, index-aligned, sums to 10 000 once set;
    ///         all zero before the first plan). Survives the plan that set it.
    function targetBps() external view returns (uint16[] memory);

    /// @notice `pathTarget(t)` of the current plan per asset and for idle (§5.2), via
    ///         `PlanMath.pathTargetsBps`. With no plan ever opened returns zeros.
    function pathTarget(uint256 t) external view returns (uint256[] memory bps, uint256 idleBps);

    // Step 3d: `currentTargetBps()` (the target step 3c deposits routed against) is removed with the old deposit
    // path (scaffold plan §7.2 item 1; removed by `verify` once no live test read it). The baseline keeps it.

    /// @notice Actual TWAP weights per asset and idle, rounded down.
    function currentWeightsBps() external view returns (uint256[] memory bps, uint256 idleBps);

    /// @notice Whether deposits are paused.
    function depositsPaused() external view returns (bool);

    /// @notice Whether the fund is shut down.
    function isShutdown() external view returns (bool);

    /// @notice TVL cap, per-deposit cap, exit fee and its recipient.
    function config()
        external
        view
        returns (uint256 tvlCap, uint256 perDepositCap, uint256 exitFeeBps, address feeRecipient);

    /// @notice Whether adapter runtime code hash `codeHash` is allowlisted (ADP-2 / NC-2).
    function adapterCodeHashAllowed(bytes32 codeHash) external view returns (bool);

    /// @notice The fund's `ExclusionLedger` (created at initialize; holders of an excluded Lending
    ///         adapter claim recoveries there).
    function exclusionLedger() external view returns (address);

    /// @notice Open exclusion record id of asset `index` (0 = none).
    function openExclusionOf(uint256 index) external view returns (uint256);

    /// @notice The fixed address `sweepForeignToken` sends to (`ForeignTokenQuarantine.QUARANTINE`).
    function quarantineAddress() external pure returns (address);

    // ═════════════════════════════════════════════════════════════════════════
    //  Admin: assets (add / deactivate frozen while a plan is live → `PlanLive`)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Allow or disallow an adapter runtime codehash (ADP-2 / NC-2). ADMIN_ROLE. NOT frozen
    ///         by a live plan, and indices never change. Revoking the codehash of an active Lending
    ///         adapter EXCLUDES it: its balance leaves NAV, deposits close
    ///         (`DepositsClosedDuringExclusion`), `marketCheck` reads not ok, and an
    ///         `ExclusionLedger` record opens with a share-supply snapshot (every later share
    ///         movement is checkpointed). Re-allowing drains the adapter into that record, closes it,
    ///         and the (now empty) entry counts again. Exclusion is not confiscation: what the
    ///         adapter later returns belongs to the holders of the snapshot.
    function setAdapterCodeHashAllowed(bytes32 codeHash, bool allowed) external;

    /// @notice Append an asset. ADMIN_ROLE. Checks: adapter codehash allowlisted, Lending adapter
    ///         binds VAULT == fund (`AdapterVaultMismatch`) and USDC == the fund's asset
    ///         (`AdapterAssetMismatch`), Basket pool pairs token with USDC (ORA-3), twapWindow in
    ///         bounds, pool cardinality and liquidity (BasketAssetConfigGuard), no active duplicate
    ///         asset id, across kinds (`DuplicateAsset`), `assetCount < MAX_FUND_ASSETS`, Basket poolFeeBps <
    ///         maxSlippageBps and < navDeviationGuardBps when non-zero (`BoundAtOrBelowPoolFee`).
    ///         `config.active` is forced true. Its persistent target starts at 0. The next target
    ///         vector must name it (`TargetAssetMissing`).
    /// @return index The new asset's index.
    function addAsset(AssetConfig calldata config) external returns (uint256 index);

    /// @notice Deactivate asset `index` (never removed, indices stay stable). ADMIN_ROLE. Reverts
    ///         `AssetStillTargeted` unless its persistent target is 0. Reverts `AssetStillHeld`
    ///         unless its value is 0. A target vector may no longer name it.
    function deactivateAsset(uint256 index) external;

    // ═════════════════════════════════════════════════════════════════════════
    //  Admin: caps, fees, guards (ADMIN_ROLE unless noted)
    // ═════════════════════════════════════════════════════════════════════════

    function setTvlCap(uint256 newCap) external;
    function setPerDepositCap(uint256 newCap) external;
    /// @dev ≤ 100 bps.
    function setExitFeeBps(uint256 newBps) external;
    function setFeeRecipient(address newRecipient) external;
    /// @dev ≤ 500 and > maxPoolFeeBps() (`BoundAtOrBelowPoolFee`).
    function setMaxSlippageBps(uint256 newBps) external;
    /// @dev 0, or > maxPoolFeeBps() and ≤ 2 000 (`BoundAtOrBelowPoolFee`).
    function setNavDeviationGuardBps(uint256 newBps) external;

    // ═════════════════════════════════════════════════════════════════════════
    //  Lifecycle (§6: from both vault families)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice EMERGENCY_ROLE. Blocks deposit and mint only.
    function pauseDeposits() external;
    /// @notice ADMIN_ROLE.
    function unpauseDeposits() external;
    /// @notice EMERGENCY_ROLE. Deposits closed and tvlCap 0 until `restore`. Redeems stay open.
    function shutdown() external;
    /// @notice ADMIN_ROLE. Reverse `shutdown` with a new TVL cap.
    function restore(uint256 newTvlCap) external;
    /// @notice EMERGENCY_ROLE. Withdraw every lending adapter and sell every basket token to USDC
    ///         using the BasketVault emergency guards (`BasketSwaps.unwindAll` semantics). Also
    ///         pauses the live plan (Open → Paused) so the rebalancer stops.
    function emergencyUnwind() external;
    /// @notice Permissionless. Send a non-protected token's whole balance to the fixed quarantine
    ///         address (INV-1/INV-2). Protected: USDC, every asset token (active or not), and every
    ///         lending adapter's share token (`ProtectedToken`).
    function sweepForeignToken(address token) external;
}

/// @title IRobotMoneyFundFull
/// @notice The fund's full external surface (fund API + ERC-4626 + ERC-20) for callers: tests,
///         harnesses and the Rebalancer may cast the fund address to this. The fund contract does
///         not inherit it.
interface IRobotMoneyFundFull is IRobotMoneyFund, IERC4626 {}
