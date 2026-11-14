// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.3 steps 5-8 (executeStep), §5.8 (threats), §5.10 (the same
//            layers on the rebalance, step 3e), §6.1 (size), §7 RB-3, RB-4, RB-5, RB-7 and RB-19; step-3 finish plan §3.5
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapRouter} from "../../../../interfaces/ISwapRouter.sol";
import {BasketSwaps} from "../../../../lib/BasketSwaps.sol";
import {
    AssetConfig,
    AssetKind,
    IFundEvents,
    Plan,
    PlanStatus,
    StepOrder,
    StepResult,
    StepFeedCheck,
    StepPrices,
    BPS,
    IDLE_INDEX,
    MAX_STEP_COST_BPS
} from "../FundTypes.sol";
import {PlanMath} from "../PlanMath.sol";
import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {FundState} from "./FundStorage.sol";
import {FundValuationLib} from "./FundValuationLib.sol";
import {FundPositionLib} from "./FundPositionLib.sol";
import {StepFeedLib} from "./StepFeedLib.sol";

/// @title FundStepLib
/// @notice The rebalance step of `RobotMoneyFund` (`executeStep`, §5.3 steps 5 to 8, with the step 3e layers of
///         §5.10), as an externally linked library. `FundFlowsLib.executeStep` forwards to it, so it runs by nested
///         DELEGATECALL as the fund: `address(this)` is the fund, approvals and balances are the fund's. Moved out of
///         `FundFlowsLib` in step 3e for size (§6.1): with the step 3e checks that library would have sat 483 bytes
///         under EIP-170.
///
///         Every swap goes through `BasketSwaps.swap` with the asset's allowlisted `IBasketSwapAdapter` and pays the
///         fund itself; every USDC that leaves the fund here goes to an allowlisted Lending adapter or a Basket swap
///         adapter (RB-3, INV-1). Nothing here reads spot except ORA-4 (RB-5).
library FundStepLib {
    using Math for uint256;

    /// @dev The check 7 style snapshot of a step (RB-19): the supply, idle USDC and every counted asset's held amount
    ///      before the legs.
    struct StepSnap {
        uint256 supply;
        uint256 idle;
        uint256[] held;
    }

    /// @notice The legs of one rebalance step (`IRobotMoneyFund.executeStep`). The fund checks the role and
    ///         holds `nonReentrant`. Order: plan Open → legs valid and counted, ORA-4 on Basket legs (RB-5)
    ///         → step 3e feed checks (checks 2 and 4 of §5.9.3, `StepFeedCheckFailed`) → RB-7 path guard at
    ///         `navBefore` → snapshot → sell leg → buy leg → `navAfter` → RB-19 balance check → the cost at the feeds
    ///         and at the TWAP, each capped (RB-4) → plan accounting and the budget halt → `StepExecuted`.
    /// @dev Step 3e (proposal §5.10, RB-19; step-3 finish plan §3.5), all inside the fund so no caller can skip it:
    ///      - Feed health and TWAP against feed before any trade (`StepFeedLib.check`, the settlement's own
    ///        parameters from the bound queue; no queue fails closed).
    ///      - Balance check: after the legs the share supply is unchanged, every counted asset other than the two legs
    ///        holds exactly what it held, the sell leg did not grow and the buy leg did not shrink. Idle USDC is free.
    ///      - Cost booked against the feeds: `cost` = the fall of idle USDC plus both legs valued at the feeds, floored
    ///        at 0. Every other asset is unchanged, so this is the fund's NAV change at prices the fund cannot move
    ///        (cost report §4). The plan books it (`costSpent`, `StepExecuted.cost`, the budget halt). The TWAP cost
    ///        (`navBefore − navAfter`) is still measured, and the larger of the two must stay within `maxCostUsdc`:
    ///        the fund-side mirror of the order's limit from the stricter of the two prices. `StepCostBooked` logs
    ///        both.
    ///      The order's floors (`minSellUsdcOut`, `minBuyOut`) come from the stricter of the TWAP and the feed in
    ///      `Rebalancer._buildOrder`; the fund enforces them as before.
    function executeStep(FundState storage s, StepOrder memory o)
        public
        returns (StepResult memory r)
    {
        Plan storage p = s.plan;
        if (p.status != PlanStatus.Open) {
            revert IRobotMoneyFund.InvalidPlanTransition(p.id, p.status, PlanStatus.Open);
        }
        // RB-4 defence in depth: whatever the caller asks, a step may never accept a loss above the global
        // `MAX_STEP_COST_BPS` ceiling of its notional (the Rebalancer's governed cap sits at or below it).
        if (o.notionalUsdc == 0 || o.maxCostUsdc > o.notionalUsdc.mulDiv(MAX_STEP_COST_BPS, BPS)) {
            revert IFundEvents.InvalidParam();
        }
        if (o.sellIndex == o.buyIndex) revert IFundEvents.InvalidAssetIndex(o.buyIndex);
        // RB-4: a plan never spends more than its budget. The step's cost cap is at most what the budget has left,
        // so a last step cannot overshoot it (review B-F5).
        {
            uint256 left = p.costBudget > p.costSpent ? p.costBudget - p.costSpent : 0;
            if (o.maxCostUsdc > left) o.maxCostUsdc = left;
        }
        _checkLeg(s, o.sellIndex);
        _checkLeg(s, o.buyIndex);
        StepPrices memory px = _stepFeeds(s);
        r.navBefore = _pathGuard(s, o);
        StepSnap memory b;
        b.supply = IERC20(address(this)).totalSupply();
        (b.idle, b.held) = FundValuationLib.heldAmounts(s);
        _sellLeg(s, o, r);
        _buyLeg(s, o, r);
        r.navAfter = FundValuationLib.nav(s);
        r.cost = _stepBook(s, o, b, px, r.navBefore > r.navAfter ? r.navBefore - r.navAfter : 0);
        p.costSpent += r.cost;
        p.stepCount += 1;
        s.lastStepAt = uint64(block.timestamp);
        // Halt once the budget left is below this step's own cost: the next step like it could not fit, and only
        // the Safe extends a budget (§5.5). Never past the budget (the cap above), so `costSpent ≤ costBudget`.
        if (r.cost != 0 && p.costBudget - p.costSpent < r.cost) {
            s.haltCost = r.cost;
            p.status = PlanStatus.Halted;
            emit IFundEvents.PlanStatusChanged(p.id, PlanStatus.Open, PlanStatus.Halted);
        }
        _emitStep(p.id, o, r);
        FundValuationLib.recordNav(s);
    }

    /// @dev A non-idle leg must name a counted (active, not excluded) asset, and a Basket leg must pass ORA-4
    ///      (RB-5 defence in depth: the Rebalancer already masks failing assets).
    function _checkLeg(FundState storage s, uint256 i) private view {
        if (i == IDLE_INDEX) return;
        if (i >= s.assets.length || !FundValuationLib.isCounted(s, i)) {
            revert IFundEvents.InvalidAssetIndex(i);
        }
        if (s.assets[i].kind == AssetKind.Basket) FundValuationLib.requireMarket(s, i);
    }

    /// @dev Step 3e: checks 2 and 4 of §5.9.3 on the step (`StepFeedLib.check`), else `StepFeedCheckFailed`. Returns
    ///      every basket asset's feed and TWAP price for the cost at the feeds.
    function _stepFeeds(FundState storage s) private view returns (StepPrices memory px) {
        StepFeedCheck c;
        uint256 index;
        uint256 detail;
        (c, index, detail, px) = StepFeedLib.check(s.assets, s.usdc, s.flowQueue);
        if (c != StepFeedCheck.Ok) revert IRobotMoneyFund.StepFeedCheckFailed(c, index, detail);
    }

    /// @dev Step 3e after the legs: the RB-19 balance check against the snapshot `b`, then the cost at the feeds and
    ///      the cap on the larger of it and `twapCost` (RB-4). Emits `StepCostBooked`. Returns the cost the plan books.
    function _stepBook(
        FundState storage s,
        StepOrder memory o,
        StepSnap memory b,
        StepPrices memory px,
        uint256 twapCost
    ) private returns (uint256 cost) {
        uint256 supply1 = IERC20(address(this)).totalSupply();
        if (supply1 != b.supply) revert IRobotMoneyFund.StepSupplyChanged(b.supply, supply1);
        (uint256 idle1, uint256[] memory held1) = FundValuationLib.heldAmounts(s);
        uint256 n = held1.length;
        for (uint256 i; i < n; ++i) {
            uint256 h0 = b.held[i];
            uint256 h1 = held1[i];
            bool moved = i == o.sellIndex ? h1 > h0 : (i == o.buyIndex ? h1 < h0 : h1 != h0);
            if (moved) revert IRobotMoneyFund.StepBalanceChanged(i, h0, h1);
        }
        uint256 before = b.idle + _legsAtFeed(px, o, b.held);
        uint256 afterValue = idle1 + _legsAtFeed(px, o, held1);
        cost = before > afterValue ? before - afterValue : 0;
        uint256 worst = cost > twapCost ? cost : twapCost;
        if (worst > o.maxCostUsdc) revert IRobotMoneyFund.StepCostExceeded(worst, o.maxCostUsdc);
        emit IRobotMoneyFund.StepCostBooked(s.plan.id, before, afterValue, cost, twapCost);
    }

    /// @dev The step's two legs (held amounts `held`) at the feeds; an idle leg adds nothing (idle is counted apart).
    function _legsAtFeed(StepPrices memory px, StepOrder memory o, uint256[] memory held)
        private
        pure
        returns (uint256 v)
    {
        if (o.sellIndex != IDLE_INDEX) {
            v = StepFeedLib.feedValue(px, o.sellIndex, held[o.sellIndex]);
        }
        if (o.buyIndex != IDLE_INDEX) v += StepFeedLib.feedValue(px, o.buyIndex, held[o.buyIndex]);
    }

    /// @dev RB-7 guard: at `navBefore` and `now`, the sell leg sits over its `pathTarget` value by at least the
    ///      notional and a non-idle buy leg sits under it by at least the notional (`PlanMath.pathTargetValue`,
    ///      the same function the Rebalancer sizes with). Returns `navBefore`.
    function _pathGuard(FundState storage s, StepOrder memory o)
        private
        view
        returns (uint256 navBefore)
    {
        uint256 idle;
        uint256[] memory values;
        (navBefore, idle, values) = FundValuationLib.portfolio(s);
        Plan memory pm = s.plan;
        uint256 n = o.notionalUsdc;
        uint256 v = o.sellIndex == IDLE_INDEX ? idle : values[o.sellIndex];
        uint256 t = PlanMath.pathTargetValue(pm, o.sellIndex, block.timestamp, navBefore);
        if (v < t + n) revert IRobotMoneyFund.StepExceedsPath(o.sellIndex, n, v > t ? v - t : 0);
        if (o.buyIndex == IDLE_INDEX) return navBefore;
        v = values[o.buyIndex];
        t = PlanMath.pathTargetValue(pm, o.buyIndex, block.timestamp, navBefore);
        if (t < v + n) revert IRobotMoneyFund.StepExceedsPath(o.buyIndex, n, t > v ? t - v : 0);
    }

    /// @dev Sell leg → USDC (§5.3 step 6). Idle: take `notional` of idle (`InsufficientIdle`). Lending:
    ///      `withdraw(notional)`, measured by the fund's balance delta. Basket: sell
    ///      `min(balance, TWAP tokens for notional)` with floor `minSellUsdcOut`. Then require the USDC
    ///      received ≥ `minSellUsdcOut` (`StepBelowMinOut`).
    function _sellLeg(FundState storage s, StepOrder memory o, StepResult memory r) private {
        address usdc = s.usdc;
        uint256 n = o.notionalUsdc;
        uint256 got;
        if (o.sellIndex == IDLE_INDEX) {
            uint256 idle = IERC20(usdc).balanceOf(address(this));
            if (idle < n) revert IRobotMoneyFund.InsufficientIdle(n, idle);
            r.amountIn = n;
            got = n;
        } else {
            AssetConfig memory a = s.assets[o.sellIndex];
            if (a.kind == AssetKind.Lending) {
                got = FundPositionLib.take(s, o.sellIndex, n);
                r.amountIn = got;
            } else {
                uint256 amt = FundValuationLib.tokenValue(s, o.sellIndex, n);
                uint256 bal = FundValuationLib.heldBalance(s, o.sellIndex);
                if (amt > bal) amt = bal;
                r.amountIn = amt;
                got = _swap(a, a.token, usdc, amt, o.minSellUsdcOut);
            }
        }
        if (got < o.minSellUsdcOut) {
            revert IRobotMoneyFund.StepBelowMinOut(o.sellIndex, got, o.minSellUsdcOut);
        }
        r.usdcMoved = got;
    }

    /// @dev Buy leg (§5.3 step 6) with `spend = min(received, notional)`: idle keeps it; Lending deploys it
    ///      (USDC the venue hands back stays idle; `amountOut` is what the adapter kept); Basket buys with floor
    ///      `minBuyOut × spend / notional` (`StepBelowMinOut`). USDC received beyond the notional stays idle.
    function _buyLeg(FundState storage s, StepOrder memory o, StepResult memory r) private {
        uint256 spend = r.usdcMoved < o.notionalUsdc ? r.usdcMoved : o.notionalUsdc;
        if (o.buyIndex == IDLE_INDEX) {
            r.amountOut = spend;
            return;
        }
        AssetConfig memory a = s.assets[o.buyIndex];
        if (a.kind == AssetKind.Lending) {
            r.amountOut = FundPositionLib.supply(s, o.buyIndex, spend);
            return;
        }
        uint256 minOut = o.minBuyOut.mulDiv(spend, o.notionalUsdc);
        uint256 got = _swap(a, s.usdc, a.token, spend, minOut);
        if (got < minOut) revert IRobotMoneyFund.StepBelowMinOut(o.buyIndex, got, minOut);
        r.amountOut = got;
    }

    /// @dev `StepExecuted` in its own frame (stack depth without viaIR).
    function _emitStep(uint256 planId, StepOrder memory o, StepResult memory r) private {
        emit IFundEvents.StepExecuted(
            planId,
            o.sellIndex,
            o.buyIndex,
            o.notionalUsdc,
            r.amountIn,
            r.usdcMoved,
            r.amountOut,
            r.navBefore,
            r.navAfter,
            r.cost
        );
    }

    /// @dev Swap through the asset's adapter (`BasketSwaps.swap`: approve, swap with recipient = the fund, clear
    ///      approval). Returns `tokenOut` received by balance delta. (A copy of `FundFlowsLib._swap`.)
    function _swap(
        AssetConfig memory a,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) private returns (uint256 got) {
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        BasketSwaps.swap(
            a.adapter, tokenIn, tokenOut, a.poolFee, amountIn, minOut, ISwapRouter(address(0))
        );
        got = IERC20(tokenOut).balanceOf(address(this)) - before;
    }
}
