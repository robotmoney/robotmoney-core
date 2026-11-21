// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md §8.2 (Rebalancer: SAFE-05, SAFE-06, E42),
//            docs/technical/one-vault-rebalancer-proposal.md §5.3 step 4, §5.5, §22
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PrototypeHarness} from "./PrototypeHarness.sol";
import {
    AssetStepParams,
    Plan,
    PlanParams,
    PlanStatus,
    SkipReason,
    StepParams,
    BPS
} from "../../FundTypes.sol";
import {IRobotMoneyFund} from "../../interfaces/IRobotMoneyFund.sol";

/// @title RebalancerGapsTest
/// @notice Step 3f audit gaps in the rebalancer, one dedicated test each: the last dust step (SAFE-05), the cost
///         floored at 0 (SAFE-06), the Halted rule, the budget fixed in USDC at the plan's start, and the stamp
///         `lastBasketStepAt` that only a basket-pool step moves (E42).
contract RebalancerGapsTest is PrototypeHarness {
    address internal alice = makeAddr("alice");
    uint256 internal constant DEPOSIT = 1_000_000e6;

    struct Booked {
        bool did;
        SkipReason why;
        uint256 feedCost;
        uint256 twapCost;
        uint256 planCostBefore;
        uint256 planCostAfter;
    }

    // ───────────────────────────── helpers ─────────────────────────────

    /// @dev A plan that buys only wETH with idle USDC. Mirrors the setup of the runaway-cost test.
    function _wethPlan(uint16 budgetBps, bool withDeposit) internal {
        if (withDeposit) deposit(alice, DEPOSIT);
        timelockExecute(
            address(rebalancer),
            abi.encodeCall(rebalancer.setAssetStepParams, (IDX_CBBTC, AssetStepParams(0, 0)))
        );
        setTargetViaTimelock(bucketVec(0, 10_000), PlanParams(PLAN_DURATION, budgetBps));
        vm.warp(fund.plan().endTime);
        refreshFeeds();
        coverageCheckpoint();
    }

    /// @dev One keeper step now with the booked cost read from the fund's event.
    function _bookedStep() internal returns (Booked memory b) {
        b.planCostBefore = fund.plan().costSpent;
        vm.recordLogs();
        vm.prank(keeper);
        (b.did, b.why) = rebalancer.step();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(fund)
                    && logs[i].topics[0] == IRobotMoneyFund.StepCostBooked.selector
            ) {
                (,, b.feedCost, b.twapCost) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            }
        }
        b.planCostAfter = fund.plan().costSpent;
    }

    function _nextStepWindow() internal {
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        refreshFeeds();
    }

    // ───────────────────────────── SAFE-06 ─────────────────────────────

    /// @notice SAFE-06: the booked cost is floored at 0. After a step that lost value, a step that GAINED value at the
    ///         feeds books 0 and `costSpent` stays where it was. A favourable step never buys back an earlier loss.
    function test_SAFE06_aFavourableStepBooksZeroAndNeverOffsetsAnEarlierLoss()
        public
        fixtureCovered
    {
        _wethPlan(COST_BUDGET_BPS, true);

        // Step 1: feeds equal the pool, so the pool fee and the price impact are a real loss.
        alignFeedsToPools();
        Booked memory b1 = _bookedStep();
        assertTrue(b1.did, "step 1 traded");
        assertGt(b1.feedCost, 0, "step 1 lost value at the feeds");
        assertEq(b1.planCostAfter, b1.planCostBefore + b1.feedCost, "step 1 booked its loss");
        uint256 spentAfterLoss = b1.planCostAfter;

        // Step 2: the outside market is above the pool, so buying at the pool gains at the feeds.
        _nextStepWindow();
        alignFeedsToPools();
        uint256 poolPx = poolPrice8(WETH_POOL, WETH);
        setFeedPrice(IDX_WETH, poolPx * 10_030 / 10_000);
        uint256 navFeedBefore = _feedValueOfFund();
        Booked memory b2 = _bookedStep();
        assertTrue(b2.did, "step 2 traded");
        uint256 navFeedAfter = _feedValueOfFund();
        assertGt(
            navFeedAfter, navFeedBefore, "step 2 gained value at the feeds (a negative raw cost)"
        );
        assertEq(b2.feedCost, 0, "a gain books a cost of 0");
        assertEq(b2.planCostAfter, spentAfterLoss, "the earlier loss is not offset");
        assertEq(fund.plan().costSpent, spentAfterLoss, "costSpent never falls");
    }

    /// @dev Fund value at the feeds: idle USDC plus every counted asset's balance at its feed, in USDC units. Only wETH
    ///      and USDC are held in this plan, so that is the whole fund.
    function _feedValueOfFund() internal view returns (uint256 v) {
        (, int256 px,,,) = _ethFeed();
        v = fund.idleUsdc() + IERC20(WETH).balanceOf(address(fund)) * uint256(px) / 1e20;
    }

    function _ethFeed() internal view returns (uint80, int256, uint256, uint256, uint80) {
        return IFeed(FEED_ETH).latestRoundData();
    }

    // ───────────────────────────── Halted rule ─────────────────────────────

    /// @notice The Halted rule at its three edges, with the budget set to a multiple of the first step's cost:
    ///         budget == cost leaves 0 and halts (SAFE-06 "exhausted at 0"; for a step with a cost the clause
    ///         `left < cost` also holds there, so the edge below it is the one that pins `<` against `<=`); budget == cost + cost - 1 leaves less than
    ///         one more step and halts; budget == 2 * cost leaves a whole step and stays Open.
    function test_haltedRule_exhaustedAtZeroAndBelowOneStepHaltAndAFullStepStaysOpen()
        public
        fixtureCovered
    {
        // The seed alone (100 000 USDC) is the turnover, so one bp of it is a budget smaller than one step's cost.
        _wethPlan(1, false);
        alignFeedsToPools();
        uint256 b0 = fund.plan().costBudget;
        uint256 snap = vm.snapshotState();

        // Measure the first step's cost under a budget that does not bind.
        _setBudget(b0 + 5_000e6, b0);
        Booked memory probe = _bookedStep();
        assertTrue(probe.did, "probe step traded");
        uint256 c = probe.feedCost;
        assertGt(
            c,
            b0,
            "the probe cost is above the plan's own budget, so the budget can be raised to it"
        );
        assertLe(
            probe.twapCost,
            c,
            "the TWAP cost does not exceed the booked cost, so the budget can equal the cost"
        );

        // Edge 1: budget == cost -> left 0 -> Halted.
        vm.revertToState(snap);
        _setBudget(c, b0);
        Booked memory e1 = _bookedStep();
        assertTrue(e1.did, "edge 1 traded");
        assertEq(e1.feedCost, c, "same cost");
        assertEq(fund.plan().costBudget - fund.plan().costSpent, 0, "nothing left");
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Halted), "exhausted at 0 halts");

        // Edge 2: left == cost - 1 (< one more step of this cost) -> Halted.
        vm.revertToState(snap);
        _setBudget(2 * c - 1, b0);
        Booked memory e2 = _bookedStep();
        assertTrue(e2.did, "edge 2 traded");
        assertEq(fund.plan().costBudget - fund.plan().costSpent, c - 1, "one wei short of a step");
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Halted), "left < the step's cost halts");

        // Edge 3: left == cost -> Open.
        vm.revertToState(snap);
        _setBudget(2 * c, b0);
        Booked memory e3 = _bookedStep();
        assertTrue(e3.did, "edge 3 traded");
        assertEq(fund.plan().costBudget - fund.plan().costSpent, c, "a whole step left");
        assertEq(
            uint8(fund.planStatus()), uint8(PlanStatus.Open), "left == the step's cost stays Open"
        );
    }

    /// @dev Move the plan's budget to `target` with `extendBudget`, which can only add. The plan is Open, so the
    ///      extension changes nothing else.
    function _setBudget(uint256 target, uint256 current) internal {
        require(target >= current, "test: budget below the plan's own");
        if (target == current) return;
        timelockExecute(
            address(fund), abi.encodeCall(IRobotMoneyFund.extendBudget, (target - current))
        );
        refreshFeeds();
        alignFeedsToPools();
    }

    // ───────────────────────────── budget fixed in USDC ─────────────────────────────

    /// @notice The budget is `turnover * costBudgetBps` in USDC at the plan's start. A later change of the fund's NAV
    ///         (a gift of USDC) does not move it.
    function test_budgetIsFixedInUsdcAtThePlansStart() public fixtureCovered {
        _wethPlan(COST_BUDGET_BPS, true);
        Plan memory p0 = fund.plan();
        assertGt(p0.costBudget, 0, "a budget was set");
        fundUsdc(address(fund), 500_000e6);
        alignFeedsToPools();
        _nextStepWindow();
        alignFeedsToPools();
        Booked memory b = _bookedStep();
        assertTrue(b.did, "a step traded after the NAV changed");
        assertEq(fund.plan().costBudget, p0.costBudget, "the budget in USDC did not follow the NAV");
    }

    // ───────────────────────────── SAFE-05 ─────────────────────────────

    /// @dev A 1 % lending shift on the 100 000 USDC seed fund: every deviation (the shift of about 1 000 USDC and the
    ///      drift the first plan left inside its 50 bp tolerance, about 500 USDC) is below `minStepUsdc` (5 000 USDC)
    ///      and above the 1 bp tolerance (10 USDC). Before `endTime` that is dust and the step skips `BelowMinStep`. After `endTime` it is
    ///      the last dust and takes one step.
    function _dustPlan() internal {
        investFund(assetVec(1_500, 1_500, 5_000, 2_000, 0));
        timelockExecute(
            address(rebalancer),
            abi.encodeCall(
                rebalancer.setStepParams,
                (StepParams({
                        stepInterval: rebalancer.stepParams().stepInterval,
                        maxOverrun: MAX_OVERRUN,
                        maxStepCostBps: MAX_STEP_COST_BPS,
                        toleranceBps: 1,
                        minStepUsdc: 5_000e6
                    }))
            )
        );
        setTargetViaTimelock(_shiftLending(100), PlanParams(1 days, COST_BUDGET_BPS));
        coverageCheckpoint();
    }

    /// @dev The fund's current weights as a vector, with `bps` moved from Moonwell to Aave. Basket weights are
    ///      the measured ones, so a plan to it moves lending only. The last asset takes the rounding.
    function _shiftLending(uint16 bps) internal view returns (uint16[5] memory v) {
        (uint256 nav,, uint256[] memory vals) = fund.portfolioValues();
        uint256 aave = vals[IDX_AAVE] * BPS / nav + bps;
        uint256 moon = vals[IDX_MOONWELL] * BPS / nav - bps;
        uint256 weth = vals[IDX_WETH] * BPS / nav;
        v = [uint16(aave), uint16(moon), uint16(weth), uint16(BPS - aave - moon - weth), 0];
    }

    /// @notice SAFE-05: dust is skipped before the plan's end and takes exactly one step after it.
    function test_SAFE05_dustSkipsBeforeEndAndTheLastDustTakesOneStepAfter() public fixtureCovered {
        _dustPlan();
        Plan memory p = fund.plan();

        // Inside the plan's time: dust, skipped.
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        refreshFeeds();
        (SkipReason before_,,, uint256 detail) = rebalancer.previewStep();
        assertEq(
            uint8(before_), uint8(SkipReason.BelowMinStep), "before endTime the dust is skipped"
        );
        assertLt(detail, 5_000e6, "the notional is under the dust floor");
        (bool did1, SkipReason why1) = keeperStep();
        assertFalse(did1, "no step on dust before endTime");
        assertEq(uint8(why1), uint8(SkipReason.BelowMinStep), "BelowMinStep");

        // At endTime the same dust is the last dust.
        vm.warp(p.endTime);
        refreshFeeds();
        (SkipReason after_, uint256 s, uint256 b, uint256 notional) = rebalancer.previewStep();
        assertEq(uint8(after_), uint8(SkipReason.None), "after endTime the last dust is a step");
        assertEq(s, IDX_MOONWELL, "the over leg sells");
        assertEq(b, IDX_AAVE, "the under leg buys");
        assertLt(notional, 5_000e6, "and it is below the dust floor");
        uint256 stepsBefore = fund.plan().stepCount;
        (bool did2,) = keeperStep();
        assertTrue(did2, "the last dust took a step");
        assertEq(fund.plan().stepCount, stepsBefore + 1, "exactly one step");
    }

    // ───────────────────────────── E42 stamp ─────────────────────────────

    /// @notice `lastBasketStepAt` moves with a step that trades a basket pool, and with nothing else: not a
    ///         lending-only step, not a step of a delisting sale (E42, RB-30).
    function test_E42_lastBasketStepAtOnlyMovesForABasketPoolStep() public fixtureCovered {
        investFund(assetVec(1_500, 1_500, 5_000, 2_000, 0));
        coverageCheckpoint();
        uint64 stamp = rebalancer.lastBasketStepAt();
        assertGt(stamp, 0, "the investing plan traded basket pools");

        // Lending-only: move 10 % between the two lending venues, basket weights unchanged. At the plan's end the
        // lending deviation (about 10 000 USDC) is far above the drift of the basket (inside 50 bp).
        setTargetViaTimelock(_shiftLending(1_000), PlanParams(1 days, COST_BUDGET_BPS));
        uint256 steps0 = fund.plan().stepCount;
        vm.warp(fund.plan().endTime);
        refreshFeeds();
        (SkipReason r, uint256 sIdx, uint256 bIdx,) = rebalancer.previewStep();
        assertEq(uint8(r), uint8(SkipReason.None), "a step is ready");
        assertTrue(!isBasketIndex(sIdx) && !isBasketIndex(bIdx), "both legs are lending or idle");
        (bool did,) = keeperStep();
        assertTrue(did, "the lending step ran");
        assertGt(fund.plan().stepCount, steps0, "it counted as a step");
        assertEq(rebalancer.lastBasketStepAt(), stamp, "a lending-only step does not stamp");

        // A delisting sale step.
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.delistAsset, (IDX_WETH)));
        assertTrue(fund.isAssetInSale(IDX_WETH), "wETH is in sale");
        uint256 wethBefore = IERC20(WETH).balanceOf(address(fund));
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval() + 2);
        refreshFeeds();
        vm.prank(keeper);
        bool sold = rebalancer.stepDelisted(IDX_WETH);
        assertTrue(sold, "a delisting step ran");
        assertLt(IERC20(WETH).balanceOf(address(fund)), wethBefore, "it sold wETH");
        assertEq(rebalancer.lastBasketStepAt(), stamp, "stepDelisted does not stamp");
    }
}

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}
