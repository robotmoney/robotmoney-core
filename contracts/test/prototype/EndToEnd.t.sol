// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.3 (deficit-first deposit), §4.4 (redeem,
//            redeemInKind, RedeemOnly), §5.1 (receipt to plan), §5.2 (glide path), §5.3 (one step), §5.5 (plan
//            states), §7 RB-1, RB-4, RB-6, RB-7
// Experiment prototype only (contracts/test/prototype/). Plan Step 2.3 (gate G3).
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IConsensusRecommendationReceipt} from "../../interfaces/IConsensusRecommendationReceipt.sol";
import {PrototypeHarness} from "./PrototypeHarness.sol";
import {Plan, PlanParams, PlanStatus, SkipReason, IFundEvents, BPS, IDLE_INDEX} from "./src/FundTypes.sol";
import {PlanMath} from "./src/PlanMath.sol";
import {IRobotMoneyFund} from "./src/interfaces/IRobotMoneyFund.sol";
import {IRebalanceGovernance} from "./src/interfaces/IRebalanceGovernance.sol";

/// @notice One-vault experiment, plan Step 2.3: the whole life of the fund in one test, on real Base venues.
///         Stage 1: a receipt-less `setTarget` plan; deposits land at target and deficit-first (§4.3).
///         Stage 2: receipts; the bad ones are refused, the good one is released and opens a plan in the same
///                  timelock call (§5.1, RB-1).
///         Stage 3: keeper steps until Converged, checking RB-7, RB-4, the plan budget and NAV/share after
///                  every step (§5.3, §5.5).
///         Stage 4: redeem and redeemInKind after convergence and while a plan is Paused (RB-6); `withdraw`
///                  reverts `RedeemOnly` (§4.4).
///         No market price, amount out or block number is hard-coded: every check is a relationship.
contract EndToEndTest is PrototypeHarness {
    using Math for uint256;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    /// @dev Raw share amount used to read NAV per share (shares carry a 10^18 virtual offset).
    uint256 internal constant PPS_UNIT = 1e30;
    /// @dev Upper bound on keeper calls: a 7-day path at one call per interval, plus a day of overrun.
    uint256 internal constant MAX_CALLS = 400;
    /// @dev Bob's deposit into the wETH deficit.
    uint256 internal constant DEFICIT_DEPOSIT = 50_000e6;

    uint256 private _e2eSalt;

    // The stale receipt of stage 2 (storage keeps stage 2 under the stack limit).
    bytes32 private _idOld;
    bytes32 private _dOld;
    uint16[6] private _older;

    // Step-loop tallies (storage keeps the loop body under the stack limit).
    uint256 private _executed;
    uint256 private _calls;
    uint256 private _totalCost;
    mapping(SkipReason => uint256) private _skips;

    /// @dev State captured right before one `step()` (same block as the step).
    struct Snap {
        uint256 nav;
        uint256 idle;
        uint256[] values;
        uint256 pps;
        uint256 costSpent;
        uint32 stepCount;
    }

    function setUp() public override {
        super.setUp();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  The test
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_endToEnd() public fixtureCovered {
        uint16[6] memory initial = bucketVec(6_000, 3_500, 500);
        uint16[6] memory proposed = bucketVec(3_000, 6_500, 500);

        // Coverage checkpoints between stages (replay only) keep each state-diff decode under the memory limit.
        _stage1SetTargetAndDeposits(initial);
        _fixtureCheckpoint();
        (uint256 planId, bytes32 receiptId) = _stage2Receipts(proposed);
        _fixtureCheckpoint();
        _stage3StepUntilConverged(planId, receiptId, proposed);
        _fixtureCheckpoint();
        _stage4Redemptions(initial);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Stage 1: setTarget, then deposits (§4.3)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _stage1SetTargetAndDeposits(uint16[6] memory initial) private {
        // RB-1: no direct caller may open a plan; only the timelock path works.
        (address[] memory ids, uint256[] memory w) = assetArrays(initial);
        vm.expectRevert();
        governance.setTarget(ids, w, PlanParams(PLAN_DURATION, COST_BUDGET_BPS));

        uint256 planId = setTargetViaTimelock(initial, PlanParams(PLAN_DURATION, COST_BUDGET_BPS));
        assertEq(planId, 1, "first plan");
        Plan memory p = fund.plan();
        assertEq(uint8(p.status), uint8(PlanStatus.Open), "plan 1 open");
        assertEq(p.receiptId, bytes32(0), "setTarget plan has no receipt");
        assertEq(p.navAtOpen, 0, "opened at NAV 0");
        for (uint256 i; i < N_ASSETS; ++i) {
            assertEq(p.startBps[i], p.endBps[i], "NAV 0: start equals end");
        }

        // First deposit: routed at the plan target.
        uint256 amount = 200_000e6;
        uint256 shares = deposit(alice, amount);
        assertGt(shares, 0, "alice shares");
        uint256 nav = fund.totalAssets();
        assertLe(nav, amount, "realized delta <= deposit");
        assertGe(nav, amount.mulDiv(BPS - MAX_SLIPPAGE_BPS, BPS), "realized delta >= slippage floor");
        (uint256[4] memory sw, uint256 idleBps) = bucketWeightsBps();
        uint256[4] memory ib = bucketsOf(initial);
        assertEq(sw[0], 0, "agent bucket empty");
        for (uint256 s = 1; s < 4; ++s) {
            assertApproxEqAbs(sw[s], ib[s], 60, "bucket at target after first deposit");
        }
        assertLe(idleBps, 10, "first deposit fully deployed");

        _deficitFirstDeposit();
    }

    /// @dev Knock wETH under its target with a real sale on its pool, let the TWAP absorb it (ORA-4), then a
    ///      second deposit must fill wETH's shortfall before splitting the rest by weight: wETH gets more than
    ///      its pro-rata share, and its gap to target shrinks.
    function _deficitFirstDeposit() private {
        movePrice(WETH_POOL, 1_000_000e6, false);
        vm.warp(block.timestamp + 2 * TWAP_WINDOW);
        (bool ok,) = fund.marketCheck(IDX_WETH);
        assertTrue(ok, "TWAP caught up with spot");

        (uint256 navBefore,, uint256[] memory vBefore) = fund.portfolioValues();
        uint256 curBps = fund.currentTargetBps()[IDX_WETH];
        uint256 targetAfter = (navBefore + DEFICIT_DEPOSIT).mulDiv(curBps, BPS);
        assertGt(targetAfter, vBefore[IDX_WETH], "wETH is under target before the deposit");
        uint256 gapBefore = targetAfter - vBefore[IDX_WETH];
        uint256 proRata = DEFICIT_DEPOSIT.mulDiv(fund.targetBps()[IDX_WETH], BPS);
        assertGt(gapBefore, proRata, "the price drop opened a real wETH deficit");

        deposit(bob, DEFICIT_DEPOSIT);

        (uint256 navAfter,, uint256[] memory vAfter) = fund.portfolioValues();
        assertGe(navAfter - navBefore, DEFICIT_DEPOSIT.mulDiv(BPS - MAX_SLIPPAGE_BPS, BPS), "bob realized delta floor");
        assertGt(vAfter[IDX_WETH] - vBefore[IDX_WETH], proRata, "deficit-first: wETH takes more than pro rata");
        uint256 targetNow = navAfter.mulDiv(curBps, BPS);
        uint256 gapAfter = targetNow > vAfter[IDX_WETH] ? targetNow - vAfter[IDX_WETH] : vAfter[IDX_WETH] - targetNow;
        assertLt(gapAfter, gapBefore - proRata, "deficit-first: wETH gap closed by more than pro rata");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Stage 2: receipts (§5.1, RB-1, RB-8)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _stage2Receipts(uint16[6] memory proposed) private returns (uint256 planId, bytes32 good) {
        // Three receipts, oldest first: a valid older one, one whose vector sums to 9 500, the good one.
        _older = bucketVec(5_000, 4_500, 500);
        uint16[6] memory short = bucketVec(5_000, 4_000, 500);
        (_idOld, _dOld) = recordReceipt(_older);
        (bytes32 idShort, bytes32 dShort) = recordReceipt(short);
        bytes32 dGood;
        (good, dGood) = recordReceipt(proposed);

        // RB-9: a vector that does not sum to 10 000 is refused, nothing released.
        _applyExpectRevert(idShort, dShort, short, abi.encodeWithSelector(IFundEvents.TargetSumInvalid.selector, 9_500));
        assertFalse(receipts.isReleased(idShort), "refused receipt not released");

        // RB-1: the target setter is the timelock alone.
        (address[] memory ids, uint256[] memory w) = assetArrays(proposed);
        vm.expectRevert();
        governance.applyReceipt(good, dGood, ids, w);

        planId = _applyGood(good, dGood, proposed);
        _refuseStaleAndReplay(good, dGood, proposed);
        assertEq(fund.currentPlanId(), planId, "refusals opened no plan");
    }

    /// @dev Apply the good receipt. Plan 1 is superseded, and the release happens in the same call.
    function _applyGood(bytes32 good, bytes32 dGood, uint16[6] memory proposed) private returns (uint256 planId) {
        // Schedule by hand so the snapshot below is taken in the block the plan opens in.
        (address[] memory ids, uint256[] memory w) = assetArrays(proposed);
        bytes memory data = abi.encodeCall(governance.applyReceipt, (good, dGood, ids, w));
        bytes32 salt = keccak256(abi.encode("e2e", ++_e2eSalt));
        timelock.schedule(address(governance), 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        (uint256 navOpen,, uint256[] memory valuesOpen) = fund.portfolioValues();
        timelock.execute(address(governance), 0, data, bytes32(0), salt);
        planId = fund.currentPlanId();
        assertEq(planId, 2, "second plan");
        IConsensusRecommendationReceipt.Receipt memory r = receipts.getReceiptById(good);
        assertTrue(r.released, "released by applyReceipt");
        assertEq(r.releasedAt, block.timestamp, "released in the apply call");
        assertEq(governance.lastAppliedRecordedAt(), r.recordedAt, "lastAppliedRecordedAt advanced");

        Plan memory p = fund.plan();
        assertEq(uint8(p.status), uint8(PlanStatus.Open), "plan 2 open");
        assertEq(p.receiptId, good, "plan bound to the receipt");
        assertEq(p.startTime, block.timestamp, "starts now");
        assertEq(p.endTime, block.timestamp + PLAN_DURATION, "default duration");
        // §5.1: the start is the ACTUAL weights, never the old plan's target.
        assertEq(p.navAtOpen, navOpen, "nav at open");
        uint16[] memory persistent = fund.targetBps();
        uint256 sumEnd;
        for (uint256 i; i < N_ASSETS; ++i) {
            assertEq(p.startBps[i], PlanMath.weightBps(valuesOpen[i], navOpen), "start = actual weight");
            assertEq(persistent[i], p.endBps[i], "persistent target = plan end");
            assertEq(p.endBps[i], proposed[i], "end target = the receipt's per-asset vector");
            sumEnd += p.endBps[i];
        }
        assertEq(sumEnd, BPS, "end targets sum to 100%");
        assertGt(p.turnoverUsdc, navOpen.mulDiv(2_500, BPS), "materially different vector: big turnover");
        assertEq(p.costBudget, p.turnoverUsdc.mulDiv(COST_BUDGET_BPS, BPS), "budget = turnover x bps");
    }

    /// @dev Stale: an older receipt is refused once a newer one applied, even with a valid vector. Replay: the
    ///      applied receipt cannot be applied twice.
    function _refuseStaleAndReplay(bytes32 good, bytes32 dGood, uint16[6] memory proposed) private {
        (bytes32 idOld, bytes32 dOld, uint16[6] memory older) = (_idOld, _dOld, _older);
        uint64 lastApplied = governance.lastAppliedRecordedAt();
        uint64 oldAt = receipts.getReceiptById(idOld).recordedAt;
        assertLt(oldAt, lastApplied, "older receipt really is older");
        _applyExpectRevert(
            idOld,
            dOld,
            older,
            abi.encodeWithSelector(IRebalanceGovernance.ReceiptNotNewerThanApplied.selector, idOld, oldAt, lastApplied)
        );
        assertFalse(receipts.isReleased(idOld), "stale receipt not released");
        _applyExpectRevert(
            good, dGood, proposed, abi.encodeWithSelector(IRebalanceGovernance.ReceiptAlreadyReleased.selector, good)
        );
    }

    /// @dev Schedule `applyReceipt` on the timelock, wait the delay, and expect the execution to revert with
    ///      `revertData` (the timelock bubbles the target's revert).
    function _applyExpectRevert(bytes32 id, bytes32 digest, uint16[6] memory bps, bytes memory revertData) private {
        (address[] memory ids, uint256[] memory w) = assetArrays(bps);
        bytes memory data = abi.encodeCall(governance.applyReceipt, (id, digest, ids, w));
        bytes32 salt = keccak256(abi.encode("e2e", ++_e2eSalt));
        timelock.schedule(address(governance), 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        vm.expectRevert(revertData);
        timelock.execute(address(governance), 0, data, bytes32(0), salt);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Stage 3: keeper steps until Converged (§5.3, §5.5, RB-4, RB-7)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _stage3StepUntilConverged(uint256 planId, bytes32 receiptId, uint16[6] memory proposed) private {
        // A 7-day path is ~340 real steps on real venues: more than forge's default 2^30 test gas. Metering is
        // paused for the loop only; nothing under test reads the meter except the Rebalancer's gas-starvation
        // guard, which then never fires.
        vm.pauseGasMetering();
        PlanStatus status = fund.planStatus();
        while (_calls < MAX_CALLS && status == PlanStatus.Open) {
            vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            _oneCheckedStep();
            if (_calls % 16 == 0) _fixtureCheckpoint();
            status = fund.planStatus();
        }
        vm.resumeGasMetering();

        Plan memory p = fund.plan();
        emit log_named_uint("keeper calls", _calls);
        emit log_named_uint("steps executed", _executed);
        emit log_named_uint("skips BelowMinStep", _skips[SkipReason.BelowMinStep]);
        emit log_named_uint("skips NothingToTrade", _skips[SkipReason.NothingToTrade]);
        emit log_named_uint("plan turnover (USDC 6dp)", p.turnoverUsdc);
        emit log_named_uint("plan costBudget", p.costBudget);
        emit log_named_uint("plan costSpent", p.costSpent);
        assertEq(p.id, planId, "same plan throughout");
        assertEq(p.receiptId, receiptId, "receipt plan");
        assertEq(uint8(status), uint8(PlanStatus.Converged), "plan converged");
        assertGe(block.timestamp, p.endTime, "converged only after the path end");
        assertGt(_executed, 0, "steps executed");
        assertEq(p.stepCount, _executed, "fund counted every executed step");
        assertEq(p.costSpent, _totalCost, "costSpent = sum of measured step costs");
        assertLe(p.costSpent, p.costBudget, "plan within budget");
        assertEq(_skips[SkipReason.StepFailed], 0, "no step failed in a quiet market");
        assertEq(_skips[SkipReason.MarketDeviation], 0, "no ORA-4 skip in a quiet market");
        assertEq(_skips[SkipReason.Cooldown], 0, "keeper waited every interval");

        // §5.5: every holding within toleranceBps of its end target, idle within the band.
        (uint256[] memory wNow, uint256 idleBps) = assetWeightsBps();
        for (uint256 i; i < N_ASSETS; ++i) {
            assertApproxEqAbs(wNow[i], p.endBps[i], TOLERANCE_BPS + 1, "asset within tolerance");
        }
        assertLe(idleBps, TOLERANCE_BPS, "idle within tolerance");
        (uint256[4] memory sw,) = bucketWeightsBps();
        uint256[4] memory pb = bucketsOf(proposed);
        for (uint256 s = 1; s < 4; ++s) {
            assertApproxEqAbs(sw[s], pb[s], 3 * TOLERANCE_BPS + 3, "bucket at the receipt's audit weight");
        }

        // A concluded plan does not trade.
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "converged plan does not trade");
        assertEq(uint8(why), uint8(SkipReason.PlanNotOpen), "PlanNotOpen after convergence");
    }

    /// @dev One keeper `step()` with the per-step assertions: previewStep agrees with step, NAV moves by the
    ///      measured cost only, cost <= cap (RB-4), costSpent <= budget, legs stay on their side of
    ///      `pathTarget(now)` (RB-7). A skip changes nothing.
    function _oneCheckedStep() private {
        Plan memory p = fund.plan();
        (SkipReason predicted, uint256 sell, uint256 buy, uint256 notional) = rebalancer.previewStep();
        Snap memory b = _snap();

        (bool did, SkipReason why) = keeperStep();
        ++_calls;
        Snap memory a = _snap();

        if (!did) {
            ++_skips[why];
            if (why != SkipReason.StepFailed) assertEq(uint8(why), uint8(predicted), "previewStep predicts the skip");
            assertEq(a.nav, b.nav, "skip: NAV unchanged");
            assertEq(a.costSpent, b.costSpent, "skip: no cost");
            assertEq(a.stepCount, b.stepCount, "skip: no step counted");
            return;
        }
        ++_executed;
        assertEq(uint8(predicted), uint8(SkipReason.None), "previewStep predicts the trade");
        assertGe(notional, MIN_STEP_USDC, "step at or above the dust floor");

        // RB-4: NAV falls by at most maxStepCostBps of notional, and the plan books exactly that cost.
        uint256 maxCost = notional.mulDiv(MAX_STEP_COST_BPS, BPS);
        uint256 cost = b.nav > a.nav ? b.nav - a.nav : 0;
        assertLe(cost, maxCost, "RB-4: step cost <= cap");
        assertLe(a.nav, b.nav + maxCost, "NAV does not jump on a step");
        assertEq(a.costSpent, b.costSpent + cost, "costSpent += measured cost");
        assertEq(a.stepCount, b.stepCount + 1, "stepCount += 1");
        assertLe(a.costSpent, fund.plan().costBudget, "plan costSpent <= budget");
        _totalCost += cost;

        // NAV/share: supply is unchanged, so it moves only by the bounded step cost.
        assertGe(a.pps + 1, b.pps.mulDiv(b.nav - maxCost, b.nav), "NAV/share loss bounded by the cost cap");
        assertLe(a.pps, b.pps.mulDiv(b.nav + maxCost, b.nav) + 1, "NAV/share gain bounded");

        // RB-7: at the step's own valuation (navBefore, now), the sell leg is still at or over its path target
        // and the buy leg at or under it. 2 wei absorbs the TWAP round trip of a basket leg.
        uint256 sellPath = PlanMath.pathTargetValue(p, sell, block.timestamp, b.nav);
        uint256 buyPath = PlanMath.pathTargetValue(p, buy, block.timestamp, b.nav);
        assertGe(_valueOf(a, sell) + 2, sellPath, "RB-7: sell leg not pushed under its path");
        assertLe(_valueOf(a, buy), buyPath + 2, "RB-7: buy leg not pushed over its path");
        assertLe(_valueOf(b, sell) - _valueOf(a, sell), notional + 2, "sell leg moved at most the notional");
    }

    function _snap() private view returns (Snap memory s) {
        (s.nav, s.idle, s.values) = fund.portfolioValues();
        s.pps = fund.convertToAssets(PPS_UNIT);
        Plan memory p = fund.plan();
        s.costSpent = p.costSpent;
        s.stepCount = p.stepCount;
    }

    function _valueOf(Snap memory s, uint256 index) private pure returns (uint256) {
        return index == IDLE_INDEX ? s.idle : s.values[index];
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Stage 4: redemptions (§4.4, RB-6)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _stage4Redemptions(uint16[6] memory initial) private {
        // §4.4: withdraw is not offered.
        vm.prank(alice);
        vm.expectRevert(IRobotMoneyFund.RedeemOnly.selector);
        fund.withdraw(1e6, alice, alice);
        vm.expectRevert(IRobotMoneyFund.RedeemOnly.selector);
        fund.previewWithdraw(1e6);
        assertEq(fund.maxWithdraw(alice), 0, "maxWithdraw 0");

        // After convergence: redeem a quarter of alice, then in kind a quarter of bob.
        uint256 aShares = fund.balanceOf(alice);
        _checkedRedeem(alice, aShares / 4);
        _checkedRedeemInKind(bob, carol, fund.balanceOf(bob) / 4);

        // A new plan back toward the initial vector, paused at once by the emergency key.
        uint256 planId = setTargetViaTimelock(initial, PlanParams(PLAN_DURATION, COST_BUDGET_BPS));
        vm.prank(emergency);
        fund.pauseRebalance();
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Paused), "paused");
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "paused plan does not trade");
        assertEq(uint8(why), uint8(SkipReason.PlanNotOpen), "paused: PlanNotOpen");

        // RB-6: both exits work while Paused, and they leave the plan as it was.
        _checkedRedeem(alice, fund.balanceOf(alice) / 2);
        _checkedRedeemInKind(bob, bob, fund.balanceOf(bob));
        assertEq(fund.balanceOf(bob), 0, "bob fully out in kind");
        assertEq(fund.currentPlanId(), planId, "same plan");
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Paused), "still paused after exits");

        // Alice exits the rest with redeem: the fund can always be emptied.
        _checkedRedeem(alice, fund.balanceOf(alice));
        assertEq(fund.totalSupply(), 0, "everyone out");
    }

    /// @dev `redeem` pays at least `previewRedeem` (the TWAP × slippage × fee floor), at most the fee-net TWAP
    ///      value of the shares, burns exactly `shares`, charges the exit fee, and never lowers the remaining
    ///      holders' NAV per share.
    function _checkedRedeem(address who, uint256 shares) private {
        vm.warp(block.timestamp + TWAP_WINDOW); // spot and TWAP agree, as in a quiet market
        uint256 floor = fund.previewRedeem(shares);
        uint256 gross = fund.convertToAssets(shares);
        uint256 supply = fund.totalSupply();
        uint256 pps = supply > shares ? fund.convertToAssets(PPS_UNIT) : 0;
        uint256 usdcBefore = IERC20(USDC).balanceOf(who);
        uint256 feeBefore = IERC20(USDC).balanceOf(feeRecipient);
        uint256 balBefore = fund.balanceOf(who);

        vm.prank(who);
        uint256 net = fund.redeem(shares, who, who);

        assertEq(IERC20(USDC).balanceOf(who) - usdcBefore, net, "paid what redeem returned");
        assertEq(fund.balanceOf(who), balBefore - shares, "shares burned");
        assertGe(net, floor, "redeem >= previewRedeem floor");
        assertLe(net, gross.mulDiv(BPS - EXIT_FEE_BPS, BPS) + gross.mulDiv(1, BPS), "redeem <= fee-net value");
        assertGt(IERC20(USDC).balanceOf(feeRecipient), feeBefore, "exit fee charged");
        if (pps != 0) assertGe(fund.convertToAssets(PPS_UNIT) + 1, pps, "stayers' NAV/share not lowered");
    }

    /// @dev `redeemInKind` pays the pro-rata USDC (idle plus lending) and each basket token, net of the exit fee,
    ///      with no swap: the TWAP value received is the fee-net share of NAV (to rounding), and stayers keep
    ///      their NAV per share.
    function _checkedRedeemInKind(address owner, address receiver, uint256 shares) private {
        uint256 gross = fund.convertToAssets(shares);
        uint256 supply = fund.totalSupply();
        uint256 pps = supply > shares ? fund.convertToAssets(PPS_UNIT) : 0;
        uint256[3] memory tokBefore = _basketBalances(receiver);
        uint256 usdcBefore = IERC20(USDC).balanceOf(receiver);

        vm.prank(owner);
        fund.redeemInKind(shares, receiver, owner);

        uint256 got = IERC20(USDC).balanceOf(receiver) - usdcBefore;
        assertGt(got, 0, "in kind: USDC leg paid");
        uint256[3] memory tokAfter = _basketBalances(receiver);
        uint256[3] memory idx = [IDX_WETH, IDX_CBBTC, IDX_DESPXA];
        // Each leg's fee is floored in token units, so the receiver can get up to one base unit of each
        // token above the exact fee-net amount (one cbBTC satoshi is worth hundreds of USDC wei). The
        // unit goes from the fee recipient to the receiver: the total leaving the fund is still floored.
        uint256 unitDust;
        for (uint256 k; k < 3; ++k) {
            uint256 dTok = tokAfter[k] - tokBefore[k];
            assertGt(dTok, 0, "in kind: basket token paid");
            got += fund.assetUsdcValue(idx[k], dTok);
            unitDust += fund.assetUsdcValue(idx[k], 1) + 1;
        }
        uint256 expected = gross.mulDiv(BPS - EXIT_FEE_BPS, BPS);
        assertLe(got, expected + unitDust + 10, "in kind <= fee-net share of NAV");
        assertGe(got + expected.mulDiv(1, BPS) + 10, expected, "in kind ~= fee-net share of NAV");
        if (pps != 0) assertGe(fund.convertToAssets(PPS_UNIT) + 1, pps, "stayers' NAV/share not lowered");
    }

    function _basketBalances(address who) private view returns (uint256[3] memory b) {
        b[0] = IERC20(WETH).balanceOf(who);
        b[1] = IERC20(CBBTC).balanceOf(who);
        b[2] = IERC20(DESPXA).balanceOf(who);
    }
}
