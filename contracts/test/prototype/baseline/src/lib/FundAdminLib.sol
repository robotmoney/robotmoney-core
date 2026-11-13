// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.1 (assets, per-asset targets), §4.2 (ADP-2 exclusion),
//            §5.1 (setTargetAndOpenPlan), §5.2 (glide path views), §5.6 (plan bounds), §6.1 (size)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
// FROZEN BASELINE (one-vault scaffold, 2026-11-11): a copy of the step 3c synchronous fund and its tests. Never edit.
// It is the sim's synchronous arm and the target of the baseline attack tests. The live tree is contracts/test/prototype/src.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStrategyAdapter} from "../../../../../interfaces/IStrategyAdapter.sol";
import {BasketAssetConfigGuard} from "../../../../../lib/BasketAssetConfigGuard.sol";
import {RobotMoneyVaultOps} from "../../../../../lib/RobotMoneyVaultOps.sol";
import {ExclusionLedger} from "../../../../../ExclusionLedger.sol";
import {
    AssetConfig,
    AssetKind,
    IFundEvents,
    Plan,
    PlanParams,
    PlanStatus,
    Venue,
    BPS,
    MAX_FUND_ASSETS,
    MIN_PLAN_DURATION,
    MAX_PLAN_DURATION,
    MAX_COST_BUDGET_BPS
} from "../FundTypes.sol";
import {PlanMath} from "../PlanMath.sol";
import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {FundState, FundStorage} from "./FundStorage.sol";
import {FundValuationLib} from "./FundValuationLib.sol";
import {FundFlowsLib} from "./FundFlowsLib.sol";

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
    ///         `active` is forced true and `targetBps` grows by a 0. There is no sleeve to check (§4.1).
    function addAsset(FundState storage s, AssetConfig memory c) public returns (uint256 index) {
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
            if (e.active && PlanMath.assetId(e) == id) revert IRobotMoneyFund.DuplicateAsset(i);
        }
    }

    function _checkLending(FundState storage s, AssetConfig memory c) private view {
        if (
            c.token != address(0) || c.pool != address(0) || c.poolFee != 0 || c.twapWindow != 0
                || c.capBps == 0 || c.capBps > BPS
        ) revert IFundEvents.InvalidParam();
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
        BasketAssetConfigGuard.Venue venue = BasketAssetConfigGuard.Venue(uint8(c.venue));
        BasketAssetConfigGuard.requireExecutionPoolMatchesTwap(c.pool, c.poolFee, venue);
        BasketAssetConfigGuard.requirePoolUsable(
            c.pool, c.token, s.usdc, c.twapWindow, FundStorage.MIN_POOL_LIQUIDITY
        );
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
        if (i >= s.assets.length || !s.assets[i].active) revert IFundEvents.InvalidAssetIndex(i);
        uint256 target = s.targetBps[i];
        if (target != 0) revert IRobotMoneyFund.AssetStillTargeted(i, target);
        // Owed in-kind legs keep the entry: a later re-listing of the same token would otherwise count them.
        if (s.deferredTotal[i] != 0) revert IRobotMoneyFund.AssetStillHeld(i);
        AssetConfig storage a = s.assets[i];
        if (a.kind == AssetKind.Lending) {
            if (IStrategyAdapter(a.adapter).totalAssets() != 0) {
                revert IRobotMoneyFund.AssetStillHeld(i);
            }
            RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
            uint256 id = x.openExclusionOf[i];
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
    ///      leaving the USDC owed to in-kind exits (`deferredTotal`) in the adapter, then close the record.
    function _restore(
        FundState storage s,
        RobotMoneyVaultOps.Exclusions storage x,
        uint256 i,
        uint256 id
    ) private {
        ExclusionLedger ledger = x.ledger;
        bool ok = FundFlowsLib.drain(
            s.usdc,
            s.assets[i].adapter,
            ledger,
            id,
            ExclusionLedger.RecoverySource.Restoration,
            s.deferredTotal[i]
        );
        if (!ok) revert IFundEvents.InvalidParam();
        delete x.openExclusionOf[i];
        ledger.finalize(id, ExclusionLedger.FinalizeReason.Restored);
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
        return _open(s, PlanMath.assetTargets(assets, bps, s.assets), params, receiptId);
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
