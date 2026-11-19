// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.1 (assets, per-asset targets), §4.2 (ADP-2 exclusion),
//            §4.5 (asset admission rule, D12), §5.1 (setTargetAndOpenPlan), §5.2 (glide path views), §5.6 (plan
//            bounds), §6.1 (size), §7 RB-17; docs/technical/one-vault-timed-flows-eng-plan.md E15, E20
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IObservablePool} from "../interfaces/IObservablePool.sol";
import {BasketAssetConfigGuard} from "./BasketAssetConfigGuard.sol";
import {RobotMoneyVaultOps} from "./RobotMoneyVaultOps.sol";
import {ExclusionLedger} from "../ExclusionLedger.sol";
import {
    AssetConfig,
    AssetKind,
    FeedStatus,
    IFundEvents,
    Plan,
    PlanParams,
    PlanStatus,
    Venue,
    BPS,
    MAX_FUND_ASSETS,
    MIN_PLAN_DURATION,
    MAX_PLAN_DURATION,
    MAX_COST_BUDGET_BPS,
    MAX_FEED_AGE,
    MIN_MIN_SEED_USDC,
    MAX_MIN_SEED_USDC,
    MAX_POOL_SHARE_BPS,
    LENDING_ROUNDING_UNITS
} from "../FundTypes.sol";
import {PlanMath} from "../PlanMath.sol";
import {IFlowQueue} from "../interfaces/IFlowQueue.sol";
import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {ILendingRateAdapter} from "../interfaces/IFlowAdapters.sol";
import {FeedLib} from "./FeedLib.sol";
import {FundState, FundStorage} from "./FundStorage.sol";
import {FundValuationLib} from "./FundValuationLib.sol";
import {FundPositionLib} from "./FundPositionLib.sol";
import {FundDelistLib} from "./FundDelistLib.sol";

/// @dev The identity views every in-tree lending adapter exposes (immutables `USDC` and `VAULT`).
interface IFundLendingIdentity {
    function USDC() external view returns (address);
    function VAULT() external view returns (address);
}

/// @title FundAdminLib
/// @notice Asset configuration, ADP-2 exclusion sync, plan opening, admin setters, lifecycle ops, and the
///         glide-path views of `RobotMoneyFund`, as an externally linked library (DELEGATECALL as the fund).
///         The fund checks every role; this library checks every value.
library FundAdminLib {
    using Math for uint256;

    uint8 internal constant ADMIN_SET_MIN_SEED_USDC = 0;
    uint8 internal constant ADMIN_SET_POOL_SHARE_BPS = 1;
    uint8 internal constant ADMIN_SET_TVL_CAP = 2;
    uint8 internal constant ADMIN_SET_PER_DEPOSIT_CAP = 3;
    uint8 internal constant ADMIN_SET_EXIT_FEE_BPS = 4;
    uint8 internal constant ADMIN_SET_FEE_RECIPIENT = 5;
    uint8 internal constant ADMIN_SET_MAX_SLIPPAGE_BPS = 6;
    uint8 internal constant ADMIN_SET_NAV_DEV_GUARD_BPS = 7;
    uint8 internal constant ADMIN_SET_MIN_POOL_DEPTH_USDC = 8;
    uint8 internal constant ADMIN_SET_FEE_MARGIN_BPS = 9;
    uint8 internal constant ADMIN_SET_DELIST_BAND_BPS = 10;
    uint8 internal constant ADMIN_SET_DELIST_BUDGET_BPS = 11;
    uint8 internal constant ADMIN_SET_MAX_BASKET_BPS = 12;
    uint8 internal constant ADMIN_DEACTIVATE_ASSET = 13;
    uint8 internal constant ADMIN_DELIST_ASSET = 14;
    uint8 internal constant ADMIN_PAUSE_DEPOSITS = 15;
    uint8 internal constant ADMIN_UNPAUSE_DEPOSITS = 16;
    uint8 internal constant ADMIN_SHUTDOWN = 17;
    uint8 internal constant ADMIN_RESTORE = 18;

    // ═════════════════════════════════════════════════════════════════════════
    //  Assets (§4.1)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Append asset `c` (`IRobotMoneyFund.addAsset`). Checks, in order:
    ///         - `assetCount < MAX_FUND_ASSETS` (`MaxAssetsReached`); adapter non-zero (`ZeroAddress`);
    ///         - ADP-2 / NC-2: the adapter's runtime code hash is allowlisted (`AdapterCodeHashNotAllowed`);
    ///         - no ACTIVE entry with the same asset id (`PlanMath.assetId`: adapter for Lending, token for
    ///           Basket), of either kind (`DuplicateAsset`, NC-8 / core 1789: two active entries would count
    ///           one balance twice, and a target vector could not tell them apart);
    ///         - Lending: token, pool, poolFee, twapWindow zero; capBps in [1, 10 000]
    ///           (`InvalidParam`); the adapter reports `VAULT() == fund` (`AdapterVaultMismatch`) and
    ///           `USDC() == usdc` (`AdapterAssetMismatch`);
    ///         - Basket: venue V3 or Aerodrome (V4 is refused: its redeem sell
    ///           anchor, core 1793, is not ported); token and pool non-zero; twapWindow in [600, 86 400];
    ///           ORA-3 execution pool == TWAP pool and pool usability (pair, cardinality, history,
    ///           liquidity) through the linked `BasketAssetConfigGuard`; pool fee strictly below
    ///           `maxSlippageBps` and below a non-zero `navDeviationGuardBps` (`BoundAtOrBelowPoolFee`).
    ///         Step 3d admission rule (proposal §4.5, E15, RB-17):
    ///         - Basket: a feed and its `maxFeedAge` (non-zero, `maxFeedAge ≤ MAX_FEED_AGE`; else `MissingFeed`),
    ///           and the feed must read healthy now (`FeedLib.read`, else `FeedUnhealthy(index, status)`): a listed
    ///           asset must have a live outside feed (rule 1). The pool must answer `observe` over one settlement
    ///           window (`settleWindow`: the bound queue's, else `DEFAULT_SETTLE_WINDOW`), else
    ///           `PoolHistoryTooShort(index, window)` (rule 2).
    ///         - Lending: the adapter must answer `ratePerUnit()` with a non-zero rate (`LendingRateUnavailable`),
    ///           the venue rate check 5 reads, and `availableLiquidity()` (`LendingLiquidityUnavailable`, E44); and `feed`, `maxFeedAge` must be 0 (`InvalidParam`).
    ///         `active` is forced true and `targetBps` grows by a 0. There is no sleeve to check (§4.1).
    function addAsset(FundState storage s, AssetConfig memory c) public returns (uint256 index) {
        requireNoLivePlan(s);
        index = s.assets.length;
        if (index >= MAX_FUND_ASSETS) revert IRobotMoneyFund.MaxAssetsReached();
        if (c.adapter == address(0)) revert IFundEvents.ZeroAddress();
        bytes32 hash = c.adapter.codehash;
        if (!s.codeHashAllowed[hash]) {
            revert IRobotMoneyFund.AdapterCodeHashNotAllowed(c.adapter, hash);
        }
        if (c.kind == AssetKind.Lending) {
            _checkLending(s, c);
        } else {
            _checkBasket(s, c, index);
        }
        _rejectDuplicate(s, c);
        c.active = true;
        s.assets.push(c);
        s.targetBps.push(0);
        emit IRobotMoneyFund.AssetAdded(index, c);
    }

    function _rejectDuplicate(FundState storage s, AssetConfig memory c) private view {
        uint256 n = s.assets.length;
        address id = PlanMath.assetId(c);
        for (uint256 i; i < n; ++i) {
            AssetConfig memory e = s.assets[i];
            if (PlanMath.assetId(e) != id) continue;
            if (e.active) revert IRobotMoneyFund.DuplicateAsset(i);
            // An inactive lending entry whose position claims are still open prices them from the adapter's whole
            // `totalAssets()`; listing the same adapter again would let those claims read new holders' money
            // (review B-F3).
            if (e.kind == AssetKind.Lending && s.positionClaimTotal[i] != 0) {
                revert IRobotMoneyFund.DuplicateAsset(i);
            }
        }
    }

    function _checkLending(FundState storage s, AssetConfig memory c) private view {
        if (
            c.token != address(0) || c.pool != address(0) || c.poolFee != 0 || c.twapWindow != 0
                || c.capBps == 0 || c.capBps > BPS || c.feed != address(0) || c.maxFeedAge != 0
        ) revert IFundEvents.InvalidParam();
        // E15: the venue's own rate per unit (check 5) must be readable and non-zero.
        (bool ok, bytes memory ret) =
            c.adapter.staticcall(abi.encodeCall(ILendingRateAdapter.ratePerUnit, ()));
        if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) == 0) {
            revert IRobotMoneyFund.LendingRateUnavailable(c.adapter);
        }
        // E44: the venue-cash view must answer at admission. The settle's venue check and the match read it, and a
        // missing view would read as an empty venue. Overstatement cannot be tested here (the view is the venue's
        // live cash). It is bounded where it is used: a short pay is caught by the venue check (A34).
        (ok, ret) = c.adapter.staticcall(abi.encodeCall(ILendingRateAdapter.availableLiquidity, ()));
        if (!ok || ret.length < 32) revert IRobotMoneyFund.LendingLiquidityUnavailable(c.adapter);
        IFundLendingIdentity id = IFundLendingIdentity(c.adapter);
        address vault = id.VAULT();
        if (vault != address(this)) {
            revert IRobotMoneyFund.AdapterVaultMismatch(c.adapter, address(this), vault);
        }
        address asset = id.USDC();
        if (asset != s.usdc) revert IRobotMoneyFund.AdapterAssetMismatch(c.adapter, s.usdc, asset);
    }

    function _checkBasket(FundState storage s, AssetConfig memory c, uint256 index) private view {
        // Uniswap V4 recorder pools need BasketVault's USDC sell anchor on redeem (core 1793,
        // `BasketViews.checkSellAnchor`), which this prototype does not port: refuse them (§4.2, §4.4).
        if (c.venue == Venue.V4) revert IFundEvents.InvalidParam();
        if (c.token == address(0) || c.pool == address(0)) revert IFundEvents.ZeroAddress();
        if (
            c.twapWindow < FundStorage.MIN_TWAP_WINDOW || c.twapWindow > FundStorage.MAX_TWAP_WINDOW
        ) {
            revert IFundEvents.InvalidParam();
        }
        // E15, §4.5 rule 1: a live outside feed, with its maximum age.
        if (c.feed == address(0) || c.maxFeedAge == 0 || c.maxFeedAge > MAX_FEED_AGE) {
            revert IRobotMoneyFund.MissingFeed(index);
        }
        (FeedStatus st,) = FeedLib.read(c.feed, c.maxFeedAge);
        if (st != FeedStatus.Ok) revert IRobotMoneyFund.FeedUnhealthy(index, st);
        BasketAssetConfigGuard.Venue venue = BasketAssetConfigGuard.Venue(uint8(c.venue));
        BasketAssetConfigGuard.requireExecutionPoolMatchesTwap(c.pool, c.poolFee, venue);
        BasketAssetConfigGuard.requirePoolUsable(
            c.pool, c.token, s.usdc, c.twapWindow, FundStorage.MIN_POOL_LIQUIDITY
        );
        // E15, §4.5 rule 2: one settlement window of pool history (what check 3 reads at every settlement).
        uint32 w = FundValuationLib.settleWindow(s);
        uint32[] memory ago = new uint32[](2);
        ago[0] = w;
        try IObservablePool(c.pool).observe(ago) returns (int56[] memory, uint160[] memory) {}
        catch {
            revert IRobotMoneyFund.PoolHistoryTooShort(index, w);
        }
        // Price the fee the same way `poolFeeBps` will once the entry exists (Aerodrome reads `fee()`).
        uint256 pips = c.poolFee;
        if (c.venue == Venue.Aerodrome) {
            (bool ok, bytes memory data) = c.pool.staticcall(abi.encodeWithSignature("fee()"));
            if (ok && data.length == 32) pips = abi.decode(data, (uint256));
        }
        uint256 feeBps = (pips + 99) / 100;
        if (s.maxSlippageBps <= feeBps) {
            revert IFundEvents.BoundAtOrBelowPoolFee(index, s.maxSlippageBps, feeBps);
        }
        uint256 guard = s.navDeviationGuardBps;
        if (guard != 0 && guard <= feeBps) {
            revert IFundEvents.BoundAtOrBelowPoolFee(index, guard, feeBps);
        }
        FundDelistLib.requireBasketFeeAdmission(s, c.adapter, c.pool, c.poolFee);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  ADP-2 exclusion (§4.2: "Lending adapters keep ADP-2 exclusion and the ExclusionLedger")
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Match exclusion records to adapter eligibility (`RobotMoneyVaultOps.syncExclusions`, with
    ///         eligibility = code hash allowlisted). An active Lending entry whose code hash is no longer
    ///         allowed and that has no record gets one, snapshotting `supply` (skipped at zero supply): its
    ///         balance leaves NAV and everything later recovered from it belongs pro rata to the holders at
    ///         this moment (core 1820, exclusion is not confiscation). With `restore`, an entry that is
    ///         eligible again and still has a record is drained INTO the record first (`InvalidParam` when
    ///         it cannot pay out), then the record closes (`Restored`) and the empty entry counts again.
    /// @return opened True when a record opened (the fund then checkpoints every share balance change).
    function syncExclusions(FundState storage s, uint256 supply, bool restore)
        public
        returns (bool opened)
    {
        RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
        ExclusionLedger ledger = x.ledger;
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            AssetConfig storage a = s.assets[i];
            if (!a.active || a.kind != AssetKind.Lending) continue;
            bool eligible = s.codeHashAllowed[a.adapter.codehash];
            uint256 id = x.openExclusionOf[i];
            if (id == 0) {
                if (eligible || supply == 0) continue;
                x.openExclusionOf[i] = ledger.open(i, a.adapter, supply);
                opened = true;
            } else if (eligible && restore) {
                _restore(s, x, i, id);
            }
        }
        if (opened) x.snapshots = true;
    }

    /// @dev `syncExclusions` restore branch (own frame for stack depth): drain entry `i` into record `id`,
    ///      leaving the USDC owed to in-kind exits (`deferredTotal`) and the position claims' part in the adapter
    ///      (`FundPositionLib.drain`, which also burns the holders' units), then close the record.
    function _restore(
        FundState storage s,
        RobotMoneyVaultOps.Exclusions storage x,
        uint256 i,
        uint256 id
    ) private {
        ExclusionLedger ledger = x.ledger;
        bool ok =
            FundPositionLib.drain(s, i, ledger, id, ExclusionLedger.RecoverySource.Restoration);
        if (!ok) revert IFundEvents.InvalidParam();
        delete x.openExclusionOf[i];
        ledger.finalize(id, ExclusionLedger.FinalizeReason.Restored);
        if (!FundValuationLib.anyExcluded(s) && block.timestamp > s.lastStateStopEndedAt) {
            s.lastStateStopEndedAt = uint64(block.timestamp);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Plan transitions (§5.5). Moved out of the fund in step 3d for its size budget (§6.1); the semantics are
    //  the step 3c fund's, unchanged. The fund checks every role.
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Which transition `planOp` runs.
    /// @dev Conclude: `concludePlan(to)`, `arg = uint256(to)`; REBALANCER_ROLE. Open → Converged (now ≥ endTime) or
    ///      Expired (now > endTime).
    ///      Pause: `pauseRebalance`; EMERGENCY_ROLE. Open or Halted → Paused.
    ///      Resume: `resumePlan`; ADMIN_ROLE. Paused → Open, or → Halted while over budget (`_overBudget`).
    ///      Extend: `extendBudget(arg)`; ADMIN_ROLE. Live plan's budget += arg; Halted → Open once the budget left
    ///      covers the step that halted it.
    ///      Close: `closePlan`; ADMIN_ROLE. Live → Superseded.
    ///      UnwindPause: the tail of `emergencyUnwind`; ADMIN_ROLE (owner, 2026-11-13). Open or Halted → Paused, else nothing.
    enum PlanOp {
        Conclude,
        Pause,
        Resume,
        Extend,
        Close,
        UnwindPause
    }

    /// @notice Run plan transition `op` (see `PlanOp`). Every transition emits exactly one `PlanStatusChanged`;
    ///         a transition the current status does not allow reverts `InvalidPlanTransition`.
    function planOp(FundState storage s, PlanOp op, uint256 arg) public {
        if (
            op == PlanOp.Conclude || op == PlanOp.Pause || op == PlanOp.Extend || op == PlanOp.Close
        ) {
            FundDelistLib.syncExpiredPause(s);
        }
        Plan storage p = s.plan;
        PlanStatus st = p.status;
        if (op == PlanOp.Conclude) {
            PlanStatus to = PlanStatus(arg);
            bool timeOk = (to == PlanStatus.Converged && block.timestamp >= p.endTime)
                || (to == PlanStatus.Expired && block.timestamp > p.endTime);
            if (!timeOk) revert IRobotMoneyFund.InvalidPlanTransition(p.id, st, to);
            _move(p, PlanStatus.Open, to);
        } else if (op == PlanOp.Pause) {
            if (
                s.rebalancePauseCooldownUntil != 0
                    && block.timestamp < s.rebalancePauseCooldownUntil
            ) {
                revert IRobotMoneyFund.PauseOnCooldown(s.rebalancePauseCooldownUntil);
            }
            _move(
                p, st == PlanStatus.Halted ? PlanStatus.Halted : PlanStatus.Open, PlanStatus.Paused
            );
            uint32 pauseLen = FundValuationLib.maxPause(s);
            uint64 until = uint64(block.timestamp) + pauseLen;
            s.rebalancePausedUntil = until;
            s.rebalancePauseCooldownUntil = until + pauseLen;
        } else if (op == PlanOp.Resume) {
            s.rebalancePausedUntil = 0;
            _move(p, PlanStatus.Paused, _overBudget(s, p) ? PlanStatus.Halted : PlanStatus.Open);
        } else if (op == PlanOp.Extend) {
            if (!_isLive(st)) revert IRobotMoneyFund.InvalidPlanTransition(p.id, st, st);
            uint256 budget = p.costBudget + arg;
            p.costBudget = budget;
            emit IFundEvents.PlanBudgetExtended(p.id, arg, budget);
            if (st == PlanStatus.Halted && !_overBudget(s, p)) {
                s.haltCost = 0;
                _move(p, PlanStatus.Halted, PlanStatus.Open);
            }
        } else if (op == PlanOp.Close) {
            if (!_isLive(st)) {
                revert IRobotMoneyFund.InvalidPlanTransition(p.id, st, PlanStatus.Superseded);
            }
            _move(p, st, PlanStatus.Superseded);
        } else {
            FundDelistLib.unwindPausePlan(s);
        }
    }

    /// @notice Revert `PlanLive` while a plan is Open, Halted or Paused (asset config is frozen then).
    function requireNoLivePlan(FundState storage s) internal view {
        Plan storage p = s.plan;
        if (_isLive(p.status)) revert IRobotMoneyFund.PlanLive(p.id);
    }

    /// @dev One plan transition `from → to` (§5.5), with exactly one `PlanStatusChanged`.
    function _move(Plan storage p, PlanStatus from, PlanStatus to) private {
        if (p.status != from) revert IRobotMoneyFund.InvalidPlanTransition(p.id, p.status, to);
        p.status = to;
        emit IFundEvents.PlanStatusChanged(p.id, from, to);
    }

    /// @dev Over budget: spent reached/exceeded budget (SAFE-06), or the budget left is below the
    ///      cost of the step that halted it.
    function _overBudget(FundState storage s, Plan storage p) private view returns (bool) {
        if (p.costSpent >= p.costBudget) return true;
        return p.costBudget - p.costSpent < s.haltCost;
    }

    function _isLive(PlanStatus st) private pure returns (bool) {
        return st == PlanStatus.Open || st == PlanStatus.Halted || st == PlanStatus.Paused;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Plan open (§5.1 step 3)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `IRobotMoneyFund.setTargetAndOpenPlan` (the fund checks GOVERNANCE_ROLE, RB-1):
    ///         validate params; `endBps = PlanMath.assetTargets(assets, bps, s.assets)`, which runs every §4.1
    ///         vector check (RB-9, including a Lending end target ≤ its `capBps`); supersede a live plan (plans
    ///         never stack); snapshot the ACTUAL TWAP weights as the start (never the old plan's target); store
    ///         and emit.
    function openPlan(
        FundState storage s,
        address[] memory assets,
        uint256[] memory bps,
        PlanParams memory params,
        bytes32 receiptId
    ) public returns (uint256 planId) {
        if (
            params.duration < MIN_PLAN_DURATION || params.duration > MAX_PLAN_DURATION
                || params.costBudgetBps == 0 || params.costBudgetBps > MAX_COST_BUDGET_BPS
        ) revert IFundEvents.PlanParamOutOfBounds();
        uint16[] memory endBps = PlanMath.assetTargets(assets, bps, s.assets, s.maxBasketBps);
        FundValuationLib.requirePoolShare(s, endBps);
        FundDelistLib.requireTargetsFeeBand(s, endBps);
        return _open(s, endBps, params, receiptId);
    }

    /// @dev `openPlan` after the vector became `endBps` (own frame for stack depth).
    function _open(
        FundState storage s,
        uint16[] memory endBps,
        PlanParams memory params,
        bytes32 receiptId
    ) private returns (uint256 planId) {
        Plan storage p = s.plan;
        PlanStatus prev = p.status;
        if (prev == PlanStatus.Open || prev == PlanStatus.Halted || prev == PlanStatus.Paused) {
            p.status = PlanStatus.Superseded;
            emit IFundEvents.PlanStatusChanged(p.id, prev, PlanStatus.Superseded);
        }

        (uint256 navNow,, uint256[] memory values) = FundValuationLib.portfolio(s);
        (uint16[] memory startBps, uint16 startIdle) =
            PlanMath.snapshotStart(values, navNow, endBps);
        uint256 turnover = PlanMath.turnoverUsdc(startBps, endBps, navNow);

        planId = uint256(p.id) + 1;
        p.id = uint64(planId);
        p.status = PlanStatus.Open;
        p.receiptId = receiptId;
        p.startTime = uint64(block.timestamp);
        p.endTime = uint64(block.timestamp) + params.duration;
        p.startBps = startBps;
        p.endBps = endBps;
        p.startIdleBps = startIdle;
        p.navAtOpen = navNow;
        p.turnoverUsdc = turnover;
        p.costBudget = turnover.mulDiv(params.costBudgetBps, BPS);
        p.costSpent = 0;
        s.haltCost = 0;
        p.stepCount = 0;

        s.targetBps = endBps;
        _emitOpened(p);
    }

    function _emitOpened(Plan storage p) private {
        emit IFundEvents.PlanOpened(
            p.id,
            p.receiptId,
            p.startBps,
            p.endBps,
            p.startTime,
            p.endTime,
            p.turnoverUsdc,
            p.costBudget
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Consolidated Admin Setters & Lifecycle Ops
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Consolidated admin setter and lifecycle dispatcher called via one `DELEGATECALL` site on the fund.
    function adminOp(FundState storage s, uint8 op, uint256 val, address addr, address caller)
        public
    {
        if (op <= ADMIN_SET_MAX_BASKET_BPS) {
            _adminParamOp(s, op, val, addr);
        } else {
            _adminLifecycleOp(s, op, val, caller);
        }
    }

    function _adminParamOp(FundState storage s, uint8 op, uint256 val, address addr) private {
        if (op == ADMIN_SET_MIN_SEED_USDC) {
            if (val < MIN_MIN_SEED_USDC || val > MAX_MIN_SEED_USDC) {
                revert IFundEvents.InvalidParam();
            }
            s.minSeedUsdc = val;
            emit IRobotMoneyFund.MinSeedUsdcSet(val);
        } else if (op == ADMIN_SET_POOL_SHARE_BPS) {
            if (val == 0 || val > MAX_POOL_SHARE_BPS) revert IFundEvents.InvalidParam();
            bool tighter = val < s.poolShareBps;
            s.poolShareBps = uint16(val);
            emit IRobotMoneyFund.PoolShareBpsSet(uint16(val));
            if (tighter) FundValuationLib.requirePoolShare(s, s.targetBps);
        } else if (op == ADMIN_SET_TVL_CAP) {
            bool higher = val > s.tvlCap;
            s.tvlCap = val;
            if (higher) FundValuationLib.requirePoolShare(s, s.targetBps);
        } else if (op == ADMIN_SET_PER_DEPOSIT_CAP) {
            s.perDepositCap = val;
        } else if (op == ADMIN_SET_EXIT_FEE_BPS) {
            if (val > FundStorage.MAX_EXIT_FEE_BPS) revert IFundEvents.InvalidParam();
            s.exitFeeBps = val;
        } else if (op == ADMIN_SET_FEE_RECIPIENT) {
            if (addr == address(0)) revert IFundEvents.ZeroAddress();
            s.feeRecipient = addr;
        } else if (op == ADMIN_SET_MAX_SLIPPAGE_BPS) {
            if (val > FundStorage.MAX_SLIPPAGE_BPS) revert IFundEvents.InvalidParam();
            FundValuationLib.requireAboveFees(s, val);
            s.maxSlippageBps = val;
        } else if (op == ADMIN_SET_NAV_DEV_GUARD_BPS) {
            if (val > FundStorage.MAX_NAV_DEVIATION_BPS) revert IFundEvents.InvalidParam();
            if (val != 0) FundValuationLib.requireAboveFees(s, val);
            s.navDeviationGuardBps = val;
        } else if (op == ADMIN_SET_MIN_POOL_DEPTH_USDC) {
            s.minPoolDepthUsdc = val;
            emit IRobotMoneyFund.MinPoolDepthUsdcSet(val);
        } else {
            if (val > BPS) revert IFundEvents.InvalidParam();
            uint16 bpsVal = uint16(val);
            if (op == ADMIN_SET_FEE_MARGIN_BPS) {
                uint16 prev = s.feeMarginBps;
                s.feeMarginBps = bpsVal;
                if (val > prev) FundDelistLib.requireTargetsFeeBand(s, s.targetBps);
                emit IRobotMoneyFund.FeeMarginBpsSet(bpsVal);
            } else if (op == ADMIN_SET_DELIST_BAND_BPS) {
                s.delistBandBps = bpsVal;
                emit IRobotMoneyFund.DelistBandBpsSet(bpsVal);
            } else if (op == ADMIN_SET_DELIST_BUDGET_BPS) {
                s.delistBudgetBps = bpsVal;
                emit IRobotMoneyFund.DelistBudgetBpsSet(bpsVal);
            } else {
                s.maxBasketBps = bpsVal;
                emit IRobotMoneyFund.MaxBasketBpsSet(bpsVal);
            }
        }
    }

    function _adminLifecycleOp(FundState storage s, uint8 op, uint256 val, address caller) private {
        if (op == ADMIN_DEACTIVATE_ASSET) {
            _deactivateAsset(s, val);
        } else if (op == ADMIN_DELIST_ASSET) {
            FundDelistLib.delistAsset(s, val);
        } else if (op == ADMIN_PAUSE_DEPOSITS) {
            _pauseDeposits(s, caller);
        } else if (op == ADMIN_UNPAUSE_DEPOSITS) {
            _unpauseDeposits(s, caller);
        } else if (op == ADMIN_SHUTDOWN) {
            s.shutdown = true;
            s.tvlCap = 0;
            FundDelistLib.unwindPausePlan(s);
            address q = s.flowQueue;
            if (q != address(0)) IFlowQueue(q).onShutdown();
            emit IRobotMoneyFund.Shutdown();
        } else if (op == ADMIN_RESTORE) {
            if (!s.shutdown || val == 0 || s.perDepositCap > val) {
                revert IFundEvents.InvalidParam();
            }
            s.shutdown = false;
            s.tvlCap = val;
            emit IRobotMoneyFund.Restored(val);
        } else {
            revert IFundEvents.InvalidParam();
        }
    }

    function _deactivateAsset(FundState storage s, uint256 i) private {
        Plan storage p = s.plan;
        if (
            p.status == PlanStatus.Open || p.status == PlanStatus.Halted
                || p.status == PlanStatus.Paused
        ) {
            revert IRobotMoneyFund.PlanLive(p.id);
        }
        if (i >= s.assets.length || !s.assets[i].active) revert IFundEvents.InvalidAssetIndex(i);
        uint256 target = s.targetBps[i];
        if (target != 0) revert IRobotMoneyFund.AssetStillTargeted(i, target);
        if (s.deferredTotal[i] != 0 || s.delistClaimedTokens[i] != 0) {
            revert IRobotMoneyFund.AssetStillHeld(i);
        }
        AssetConfig storage a = s.assets[i];
        bool closedExclusion;
        if (a.kind == AssetKind.Lending) {
            RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
            uint256 id = x.openExclusionOf[i];
            _requireLendingEmpty(s, i, a.adapter, id);
            if (id != 0) {
                delete x.openExclusionOf[i];
                x.ledger.finalize(id, ExclusionLedger.FinalizeReason.Removed);
                closedExclusion = true;
            }
        } else if (s.inSale[i]) {
            if (FundValuationLib.heldBalance(s, i) != 0) revert IRobotMoneyFund.AssetStillHeld(i);
            FundDelistLib.closeDelistSale(s, i);
            return;
        } else {
            uint256 bal = IERC20(a.token).balanceOf(address(this));
            if (bal != 0) {
                uint256 floor =
                    FundValuationLib.usdcValue(s, i, bal) * (BPS - s.maxSlippageBps) / BPS;
                if (floor != 0) revert IRobotMoneyFund.AssetStillHeld(i);
            }
        }
        a.active = false;
        emit IRobotMoneyFund.AssetDeactivated(i);
        if (
            closedExclusion && !FundValuationLib.anyExcluded(s)
                && block.timestamp > s.lastStateStopEndedAt
        ) {
            s.lastStateStopEndedAt = uint64(block.timestamp);
        }
    }

    function _requireLendingEmpty(FundState storage s, uint256 i, address adapter, uint256 openId)
        private
        view
    {
        (bool ok, bytes memory ret) =
            adapter.staticcall(abi.encodeCall(IStrategyAdapter.totalAssets, ()));
        if (!ok || ret.length < 32) {
            if (openId == 0) revert IRobotMoneyFund.AssetStillHeld(i);
            return;
        }
        uint256 held = abi.decode(ret, (uint256));
        uint256 units = s.positionUnits[i];
        uint256 claims = units == 0 ? 0 : held.mulDiv(s.positionClaimTotal[i], units);
        if (held > claims + LENDING_ROUNDING_UNITS) revert IRobotMoneyFund.AssetStillHeld(i);
    }

    function _pauseDeposits(FundState storage s, address caller) private {
        uint64 prevUntil = s.depositsPausedUntil;
        if (prevUntil != 0 && prevUntil <= block.timestamp && prevUntil > s.lastStateStopEndedAt) {
            s.lastStateStopEndedAt = uint64(prevUntil);
        }
        uint64 until = uint64(block.timestamp + FundValuationLib.maxPause(s));
        s.depositsPaused = false;
        s.depositsPausedUntil = until;
        emit IRobotMoneyFund.DepositsPaused(caller);
    }

    function _unpauseDeposits(FundState storage s, address caller) private {
        uint64 prevUntil = s.depositsPausedUntil;
        if (s.depositsPaused || (prevUntil != 0 && block.timestamp < prevUntil)) {
            if (block.timestamp > s.lastStateStopEndedAt) {
                s.lastStateStopEndedAt = uint64(block.timestamp);
            }
        } else if (prevUntil != 0 && prevUntil > s.lastStateStopEndedAt) {
            s.lastStateStopEndedAt = prevUntil;
        }
        s.depositsPaused = false;
        s.depositsPausedUntil = 0;
        emit IRobotMoneyFund.DepositsUnpaused(caller);
    }
}
