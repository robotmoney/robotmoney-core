// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.1 (assets, per-asset targets), §4.2 (ADP-2 exclusion),
//            §4.5 (asset admission rule, D12), §5.1 (setTargetAndOpenPlan), §5.2 (glide path views), §5.6 (plan
//            bounds), §6.1 (size), §7 RB-17; docs/technical/one-vault-timed-flows-eng-plan.md E15, E20
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStrategyAdapter} from "../../../../interfaces/IStrategyAdapter.sol";
import {IObservablePool} from "../../../../interfaces/IObservablePool.sol";
import {BasketAssetConfigGuard} from "../../../../lib/BasketAssetConfigGuard.sol";
import {RobotMoneyVaultOps} from "../../../../lib/RobotMoneyVaultOps.sol";
import {ExclusionLedger} from "../../../../ExclusionLedger.sol";
import {FundExclusionLedger} from "../FundExclusionLedger.sol";
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
    DEFAULT_MIN_SEED_USDC,
    DEFAULT_POOL_SHARE_BPS,
    DEFAULT_IN_KIND_BPS,
    DEFAULT_IN_KIND_FLOOR_USDC,
    DEFAULT_IN_KIND_PERIOD,
    MAX_FEED_AGE,
    LENDING_ROUNDING_UNITS,
    MAX_POOL_SHARE_BPS
} from "../FundTypes.sol";
import {PlanMath} from "../PlanMath.sol";
import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {ILendingRateAdapter} from "../interfaces/IFlowAdapters.sol";
import {FeedLib} from "./FeedLib.sol";
import {FundState, FundStorage} from "./FundStorage.sol";
import {FundValuationLib} from "./FundValuationLib.sol";
import {FundPositionLib} from "./FundPositionLib.sol";

/// @dev The identity views every in-tree lending adapter exposes (immutables `USDC` and `VAULT`).
interface IFundLendingIdentity {
    function USDC() external view returns (address);
    function VAULT() external view returns (address);
}

/// @title FundAdminLib
/// @notice Asset configuration, ADP-2 exclusion sync, plan opening and the glide-path views of
///         `RobotMoneyFund`, as an externally linked library (DELEGATECALL as the fund). The fund checks every
///         role; this library checks every value.
library FundAdminLib {
    using Math for uint256;

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
    ///           the venue rate check 5 reads; and `feed`, `maxFeedAge` must be 0 (`InvalidParam`).
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

    /// @notice Body of `setPoolShareBps` (`poolShare` true) and `setTvlCap` (false). §4.5 rule 3 holds for the live
    ///         targets after either change (review B-F4): a tighter pool share or a higher TVL cap re-checks it. A
    ///         looser pool share or a lower cap is never refused.
    function setLimit(FundState storage s, bool poolShare, uint256 value) public {
        bool check;
        if (poolShare) {
            if (value == 0 || value > MAX_POOL_SHARE_BPS) revert IFundEvents.InvalidParam();
            check = value < s.poolShareBps;
            s.poolShareBps = uint16(value);
            emit IRobotMoneyFund.PoolShareBpsSet(uint16(value));
        } else {
            check = value > s.tvlCap;
            s.tvlCap = value;
        }
        if (check) FundValuationLib.requirePoolShare(s, s.targetBps);
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

    /// @dev `deactivateAsset` for a lending entry (review B-F1). The holders' part of the adapter must be at most
    ///      `LENDING_ROUNDING_UNITS` (the fund's own paths leave that much: `drain`, `claimPosition`, `sellForFlow`);
    ///      the position claims' part may stay, it remains claimable. An adapter whose `totalAssets()` read fails
    ///      may leave only while its exclusion record is open: its value is already in the ledger.
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
    }

    /// @notice Deactivate asset `i` (`IRobotMoneyFund.deactivateAsset`). The fund must hold nothing of it:
    ///         Lending `adapter.totalAssets() == 0`; Basket a zero balance or dust whose TWAP sale floor rounds
    ///         to 0 USDC (QA plan D6), and nothing still owed to in-kind exits (`deferredTotal`), else
    ///         `AssetStillHeld`. Its persistent target must already be 0, else `AssetStillTargeted`.
    ///         So an inactive asset always has target 0 (RB-9), and deposits never route to it.
    ///         A target vector may no longer name it. A Lending entry's open
    ///         exclusion record closes (`Removed`, core 1820); it stays claimable forever.
    function deactivateAsset(FundState storage s, uint256 i) public {
        requireNoLivePlan(s);
        if (i >= s.assets.length || !s.assets[i].active) revert IFundEvents.InvalidAssetIndex(i);
        uint256 target = s.targetBps[i];
        if (target != 0) revert IRobotMoneyFund.AssetStillTargeted(i, target);
        // Owed in-kind legs keep the entry: a later re-listing of the same token would otherwise count them.
        if (s.deferredTotal[i] != 0) revert IRobotMoneyFund.AssetStillHeld(i);
        AssetConfig storage a = s.assets[i];
        if (a.kind == AssetKind.Lending) {
            RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
            uint256 id = x.openExclusionOf[i];
            _requireLendingEmpty(s, i, a.adapter, id);
            if (id != 0) {
                delete x.openExclusionOf[i];
                x.ledger.finalize(id, ExclusionLedger.FinalizeReason.Removed);
            }
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
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  ADP-2 exclusion (§4.2: "Lending adapters keep ADP-2 exclusion and the ExclusionLedger")
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Create the fund's exclusion ledger, once, from the fund's initializer (replaces
    ///         `RobotMoneyVaultOps.createLedger`). Step 3d (E13, RB-22): the ledger is `FundExclusionLedger`, the test
    ///         copy whose per-holder balance is the fund's `ledgerBalanceOf` (wallet plus queued shares). It is stored
    ///         in the same `RobotMoneyVaultOps.Exclusions` slot, typed as `ExclusionLedger`: the copy has the same
    ///         ABI for every call the fund makes (`open`, `credit`, `finalize`, `checkpoint`), and the same enum
    ///         ordinals. Its creation code lives here, in a linked library, so it does not count against the fund's
    ///         EIP-170 budget. Reverts `InvalidParam` if a ledger already exists.
    function createLedger(address usdc) public returns (address ledger) {
        RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
        if (address(x.ledger) != address(0)) revert IFundEvents.InvalidParam();
        ledger = address(new FundExclusionLedger(address(this), IERC20(usdc)));
        x.ledger = ExclusionLedger(ledger);
    }

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
        Plan storage p = s.plan;
        PlanStatus st = p.status;
        if (op == PlanOp.Conclude) {
            PlanStatus to = PlanStatus(arg);
            bool timeOk = (to == PlanStatus.Converged && block.timestamp >= p.endTime)
                || (to == PlanStatus.Expired && block.timestamp > p.endTime);
            if (!timeOk) revert IRobotMoneyFund.InvalidPlanTransition(p.id, st, to);
            _move(p, PlanStatus.Open, to);
        } else if (op == PlanOp.Pause) {
            _move(
                p, st == PlanStatus.Halted ? PlanStatus.Halted : PlanStatus.Open, PlanStatus.Paused
            );
        } else if (op == PlanOp.Resume) {
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
        } else if (st == PlanStatus.Open || st == PlanStatus.Halted) {
            _move(p, st, PlanStatus.Paused);
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

    /// @dev Over budget: spent past it (a plan from before the review fix B-F5), or the budget left is below the
    ///      cost of the step that halted it.
    function _overBudget(FundState storage s, Plan storage p) private view returns (bool) {
        if (p.costSpent > p.costBudget) return true;
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
        uint16[] memory endBps = PlanMath.assetTargets(assets, bps, s.assets);
        FundValuationLib.requirePoolShare(s, endBps);
        return _open(s, endBps, params, receiptId);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Step 3d parameters the fund holds (§5.9.5)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice From the fund's `initialize`: the step 3d defaults the fund holds (`minSeedUsdc`, `poolShareBps`, the
    ///         in-kind allowance of E20), then the exclusion ledger (`createLedger`).
    function initFlows(FundState storage s, address usdc) public {
        s.minSeedUsdc = DEFAULT_MIN_SEED_USDC;
        s.poolShareBps = DEFAULT_POOL_SHARE_BPS;
        s.inKindBps = DEFAULT_IN_KIND_BPS;
        s.inKindFloorUsdc = DEFAULT_IN_KIND_FLOOR_USDC;
        s.inKindPeriod = DEFAULT_IN_KIND_PERIOD;
        createLedger(usdc);
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
}
