// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.8 (adverse actions and the defence for each),
//            §5.3 (one step), §5.4 (who calls), §5.5 (plan states), §7 RB-1, RB-2, RB-4, RB-5, RB-6, INV-1/INV-2
// Experiment prototype only (contracts/test/prototype/). Plan Step 2.4.
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IStrategyAdapter} from "../../interfaces/IStrategyAdapter.sol";

import {PrototypeHarness, IHarnessSwapRouter02} from "./PrototypeHarness.sol";
import {
    AssetStepParams,
    IFundEvents,
    Plan,
    PlanParams,
    PlanStatus,
    Roles,
    SkipReason,
    StepOrder,
    StepParams,
    BPS,
    IDLE_INDEX
} from "./src/FundTypes.sol";
import {IRobotMoneyFund} from "./src/interfaces/IRobotMoneyFund.sol";
import {IRebalancer} from "./src/interfaces/IRebalancer.sol";

/// @dev A token the fund does not hold as an asset, for the positive sweep case.
contract ForeignToken is ERC20 {
    constructor() ERC20("Foreign", "FRN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice One-vault experiment, plan Step 2.4: one short test per row of design doc §5.8, plus the authority
///         checks (RB-1, `executeStep` gate, INV-1/INV-2 sweep). Every test runs on the real Base fixture with the
///         production adapters. No market price, amount out or block number is hard-coded: assertions are bounds
///         and conservation relationships.
contract AdversarialTest is PrototypeHarness {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ALICE_DEPOSIT = 1_000_000e6;

    /// @dev What one `step()` call logged (RebalanceStep or RebalanceStepSkipped from the rebalancer).
    struct StepLog {
        uint256 sell;
        uint256 buy;
        uint256 notional;
        uint256 amountOut;
        uint256 cost;
        uint256 detail;
    }

    function setUp() public override {
        super.setUp();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  §5.8 row 1: slippage on a large trade
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev A deviation many times `maxStepUsdc` is closed in capped slices: every step's notional is
    ///      `min(over, under, maxStepUsdc)` and the idle leg moves by exactly the notional.
    function test_bigTrade_isSplitIntoCappedSteps() public fixtureCovered {
        _wethOnlyPlan(COST_BUDGET_BPS);
        uint256 cap = rebalancer.assetStepParams(IDX_WETH).maxStepUsdc;
        uint256 gap = _wethGap();
        assertGt(gap, cap * 5, "deviation is many steps wide");

        for (uint256 k; k < 5; ++k) {
            if (k != 0) vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            uint256 idleBefore = fund.idleUsdc();
            uint256 wethValueBefore = fund.assetValue(IDX_WETH);
            (bool did,, StepLog memory l) = _stepAs(keeper);
            assertTrue(did, "step executed");
            assertEq(l.sell, IDLE_INDEX, "sell leg is idle");
            assertEq(l.buy, IDX_WETH, "buy leg is weth");
            assertLe(l.notional, cap, "notional <= maxStepUsdc");
            assertEq(l.notional, cap, "deviation > cap: the step is exactly one cap slice");
            assertEq(idleBefore - fund.idleUsdc(), l.notional, "idle leg moved by exactly the notional");
            assertLe(fund.assetValue(IDX_WETH) - wethValueBefore, l.notional, "TWAP value bought <= notional");
        }
        assertGt(_wethGap(), 0, "large deviation still open after five capped steps");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  §5.8 row 2: sandwich of a step
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Spot pushed past `navDeviationGuardBps` in the step's block: the step skips with
    ///      `MarketDeviation` and trades nothing (RB-5). The fund refuses the same leg even from the rebalancer.
    function test_sandwich_spotPastGuard_skipsWithMarketReason() public fixtureCovered {
        uint256 planId = _wethOnlyPlan(COST_BUDGET_BPS);
        uint256 notional = _previewNotional();
        StepOrder memory honest = _honestBuyOrder(IDX_WETH, notional);

        (uint256 dev,) = _pushUp(WETH_POOL, IDX_WETH, NAV_DEVIATION_BPS + 1);
        (bool ok,) = fund.marketCheck(IDX_WETH);
        assertFalse(ok, "weth fails ORA-4");

        (SkipReason pr,,,) = rebalancer.previewStep();
        assertEq(uint8(pr), uint8(SkipReason.MarketDeviation), "preview: market");

        uint256 wethBal = IERC20(WETH).balanceOf(address(fund));
        uint256 idle = fund.idleUsdc();
        vm.expectEmit(true, false, false, true, address(rebalancer));
        emit IFundEvents.RebalanceStepSkipped(planId, SkipReason.MarketDeviation, IDLE_INDEX, IDLE_INDEX, IDX_WETH);
        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "no trade");
        assertEq(uint8(why), uint8(SkipReason.MarketDeviation), "market reason");
        assertEq(IERC20(WETH).balanceOf(address(fund)), wethBal, "weth untouched");
        assertEq(fund.idleUsdc(), idle, "idle untouched");
        assertEq(fund.lastStepAt(), 0, "no step recorded");
        assertEq(fund.plan().costSpent, 0, "no cost");

        // Defence in depth: the fund itself refuses a Basket leg that fails ORA-4.
        vm.prank(address(rebalancer));
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.NavMarketDeviationExceeded.selector, WETH, dev, NAV_DEVIATION_BPS)
        );
        fund.executeStep(honest);
    }

    /// @dev Spot pushed inside the ORA-4 band but beyond the step's slippage allowance: the floor comes from the
    ///      TWAP, so the swap reverts inside `executeStep` and the step skips `StepFailed` with no trade.
    function test_sandwich_spotInsideGuard_twapFloorRevertsSwap() public fixtureCovered {
        _wethOnlyPlan(COST_BUDGET_BPS);
        uint256 slip = rebalancer.assetStepParams(IDX_WETH).maxStepSlippageBps;
        (uint256 dev,) = _pushUp(WETH_POOL, IDX_WETH, slip + 30);
        assertLe(dev, NAV_DEVIATION_BPS, "push stays inside the ORA-4 band");
        (bool ok,) = fund.marketCheck(IDX_WETH);
        assertTrue(ok, "ORA-4 passes");

        uint256 wethBal = IERC20(WETH).balanceOf(address(fund));
        uint256 idle = fund.idleUsdc();
        uint256 nav = fund.totalAssets();
        (bool did, SkipReason why, StepLog memory l) = _stepAs(keeper);
        assertFalse(did, "no trade");
        assertEq(uint8(why), uint8(SkipReason.StepFailed), "swap floor from TWAP refused the pushed spot");
        assertEq(l.buy, IDX_WETH, "the weth leg was attempted");
        // Which check refused it matters: a floor quoted from SPOT (or 0) would let the swap fill at the pushed
        // price, and the step would then fail later on the cost cap instead. Only a TWAP floor fails in the swap.
        assertTrue(l.detail != uint32(IRobotMoneyFund.StepCostExceeded.selector), "not the cost cap: the floor bit");
        assertTrue(
            l.detail == uint32(bytes4(keccak256("Error(string)")))
                || l.detail == uint32(IRobotMoneyFund.StepBelowMinOut.selector),
            "refused by the swap's TWAP minOut"
        );
        assertEq(IERC20(WETH).balanceOf(address(fund)), wethBal, "weth untouched");
        assertEq(fund.idleUsdc(), idle, "idle untouched");
        assertEq(fund.totalAssets(), nav, "NAV untouched");
        assertEq(fund.lastStepAt(), 0, "no step recorded");
        assertGt(rebalancer.assetBackoffUntil(IDX_WETH), block.timestamp, "weth backed off");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  §5.8 row 3: manipulating the TWAP itself
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev One honest step runs first, so the cooldown is live. The attacker then pushes and holds for half
    ///      a TWAP window. While held, nothing trades: the cooldown (`stepInterval ≥ TWAP window`, §5.3 step 1)
    ///      binds first, so no step can price against a TWAP the push bent within one window of the last step.
    ///      Once the attacker unwinds (spot honest, TWAP still bent), no step runs before a full interval since
    ///      the last one, and the first that runs fills at honest prices: its loss against the pre-push honest
    ///      quote stays within `maxStepCostBps`.
    function test_twapPushShorterThanWindow_cannotExtractBeyondCap() public fixtureCovered {
        _wethOnlyPlan(COST_BUDGET_BPS);
        uint256 interval = rebalancer.effectiveStepInterval();
        assertGe(interval, TWAP_WINDOW, "cooldown is at least one TWAP window");
        (bool did, SkipReason why) = keeperStep();
        assertTrue(did, "a first honest step ran");
        uint256 t0 = fund.lastStepAt();
        // The honest reference: what the next step would see one interval on with no attack (its TWAP then
        // includes the first step's own impact, so the comparison isolates the attack).
        (uint256 n, uint256 honestTokens) = _honestQuoteAt(t0 + interval);

        (, uint256 bought) = _pushUp(WETH_POOL, IDX_WETH, 3 * NAV_DEVIATION_BPS);
        vm.warp(block.timestamp + TWAP_WINDOW / 2);
        assertLt(fund.assetTokenValue(IDX_WETH, n), honestTokens, "half-window hold bent the TWAP (and the floor)");

        // Held: the step cannot run against the pushed spot; inside one window of the last step the cooldown
        // binds before anything else.
        uint256 wethBal = IERC20(WETH).balanceOf(address(fund));
        (did, why) = keeperStep();
        assertFalse(did, "held push: no trade");
        assertEq(uint8(why), uint8(SkipReason.Cooldown), "held push inside the window: cooldown");
        assertEq(IERC20(WETH).balanceOf(address(fund)), wethBal, "weth untouched while held");

        // Released before the window completes: no step before t0 + interval; the first that runs is honest.
        _swapExactIn(WETH, bought);
        bool traded;
        for (uint256 k; k < 12 && !traded; ++k) {
            vm.warp(block.timestamp + 300);
            uint256 before = IERC20(WETH).balanceOf(address(fund));
            StepLog memory l;
            (traded, why, l) = _stepAs(keeper);
            uint256 got = IERC20(WETH).balanceOf(address(fund)) - before;
            if (block.timestamp < t0 + interval) {
                assertFalse(traded, "no step within one interval of the last");
                assertEq(uint8(why), uint8(SkipReason.Cooldown), "cooldown until a full window has passed");
            }
            if (!traded) {
                assertEq(got, 0, "skip: no weth moved");
                continue;
            }
            assertGe(block.timestamp, t0 + interval, "the next step waited a full interval");
            // Value of what the fund received, at the honest pre-push rate.
            uint256 honestValue = got * n / honestTokens;
            assertGe(
                honestValue,
                l.notional * (BPS - MAX_STEP_COST_BPS) / BPS,
                "loss vs honest price <= maxStepCostBps of notional"
            );
        }
        assertTrue(traded, "a step ran once the TWAP recovered");
    }

    /// @dev §5.6 bounds that keep the row-3 defence and every swap step live: a cooldown shorter than the TWAP
    ///      window, a slippage floor or cost cap at or below the pool fee(s), and a per-asset cap below the dust
    ///      floor are each refused (the last would stall a whole plan on one asset, §5.3 step 4).
    function test_stepParamBounds_refuseIntervalBelowWindowAndBoundsAtFee() public fixtureCovered {
        StepParams memory sp = rebalancer.stepParams();
        uint256 window = fund.maxTwapWindow();
        uint256 fee = fund.poolFeeBps(IDX_WETH);
        uint16 ceiling = uint16(fund.maxSlippageBps());
        vm.startPrank(address(timelock));

        StepParams memory bad = rebalancer.stepParams();
        bad.stepInterval = uint32(window - 1);
        vm.expectRevert(IFundEvents.StepParamOutOfBounds.selector);
        rebalancer.setStepParams(bad);

        // Two basket legs pay two pool fees: a cap at or below their sum is refused.
        bad = rebalancer.stepParams();
        uint256 twoFees = fee + fund.poolFeeBps(IDX_CBBTC);
        bad.maxStepCostBps = uint16(twoFees);
        vm.expectRevert(abi.encodeWithSelector(IFundEvents.BoundAtOrBelowPoolFee.selector, IDX_WETH, twoFees, twoFees));
        rebalancer.setStepParams(bad);

        vm.expectRevert(abi.encodeWithSelector(IFundEvents.BoundAtOrBelowPoolFee.selector, IDX_WETH, fee, fee));
        rebalancer.setAssetStepParams(IDX_WETH, AssetStepParams(MAJOR_MAX_STEP_USDC, uint16(fee)));

        vm.expectRevert(
            abi.encodeWithSelector(IRebalancer.MaxStepBelowMinStep.selector, IDX_DESPXA, MIN_STEP_USDC - 1, MIN_STEP_USDC)
        );
        rebalancer.setAssetStepParams(IDX_DESPXA, AssetStepParams(MIN_STEP_USDC - 1, ceiling));

        bad = rebalancer.stepParams();
        bad.minStepUsdc = DESPXA_MAX_STEP_USDC + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                IRebalancer.MaxStepBelowMinStep.selector, IDX_DESPXA, DESPXA_MAX_STEP_USDC, DESPXA_MAX_STEP_USDC + 1
            )
        );
        rebalancer.setStepParams(bad);
        vm.stopPrank();

        assertEq(rebalancer.effectiveStepInterval(), Math.max(sp.stepInterval, window), "interval >= window");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  §5.8 row 4: front-running a public receipt
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev A receipt raises the RWA sleeve. The plan buys deSPXA (the thin asset) slowly: every deSPXA buy is at
    ///      most its small `maxStepUsdc`, and its holding never runs ahead of `pathTarget(now)` (RB-7), so a trader
    ///      positioned ahead of the public receipt faces a slow, capped buyer.
    function test_frontRunReceipt_thinAssetBoughtInCappedSlicesBehindPath() public fixtureCovered {
        _holdEverything();
        recordAndApply(sleeveVec(4_000, 3_000, 3_000));
        // Three days in, the lending legs are over their path and deSPXA under it by more than its cap.
        vm.warp(block.timestamp + 3 days);
        uint256 despxaBuys;
        for (uint256 k; k < 6; ++k) {
            if (k != 0) vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            (bool did,, StepLog memory l) = _stepAs(keeper);
            if (!did || l.buy != IDX_DESPXA) continue;
            ++despxaBuys;
            assertLe(l.notional, DESPXA_MAX_STEP_USDC, "deSPXA buy <= its small maxStepUsdc");
            if (despxaBuys == 1) assertEq(l.notional, DESPXA_MAX_STEP_USDC, "days in, the cap binds");
            (uint256 nav,,) = fund.portfolioValues();
            (uint256[] memory t,) = fund.pathTarget(block.timestamp);
            assertLe(
                fund.assetValue(IDX_DESPXA), nav * (t[IDX_DESPXA] + 1) / BPS, "deSPXA never ahead of pathTarget(now)"
            );
        }
        assertGt(despxaBuys, 1, "deSPXA was bought over several capped steps");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  §5.8 row 5: keeper abuse
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev The keeper chooses only WHEN (RB-2): no amount-taking entry point, no direct `executeStep`. Its
    ///      worst timing (right after an adverse push, exactly at the cooldown edge) stays within the per-step
    ///      cost cap. A stranger cannot step before `keeperGrace`, and can after it.
    function test_keeperAbuse_timingOnly_withinCostCap() public fixtureCovered {
        _wethOnlyPlan(COST_BUDGET_BPS);
        uint256 n = _previewNotional();

        // No API takes amounts, assets or floors.
        vm.prank(keeper);
        (bool ok,) = address(rebalancer).call(abi.encodeWithSignature("step(uint256)", n));
        assertFalse(ok, "no step(amount) entry point");
        StepOrder memory greedy = _honestBuyOrder(IDX_WETH, n);
        greedy.minBuyOut = 0;
        greedy.maxCostUsdc = n;
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, keeper, Roles.REBALANCER_ROLE
            )
        );
        fund.executeStep(greedy);

        // Worst timing 1: step in the same block as an adverse push the keeper colludes with (small enough to
        // stay inside the floors, so the step runs and pays the push).
        _pushUp(WETH_POOL, IDX_WETH, 10);
        uint256 ran = _assertStepWithinCap(keeper) ? 1 : 0;
        if (ran == 0) vm.warp(block.timestamp + rebalancer.effectiveStepInterval() + 1);
        if (ran == 0) assertTrue(_assertStepWithinCap(keeper), "an honest-timed step runs");
        uint256 t0 = fund.lastStepAt();

        // A stranger is locked out until keeperGrace after the last step.
        uint256 openAt = rebalancer.permissionlessAt();
        assertEq(openAt, t0 + KEEPER_GRACE, "grace counts from the last step");
        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRebalancer.NotKeeperBeforeGrace.selector, stranger, openAt));
        rebalancer.step();

        // Worst timing 2: one second before the cooldown edge skips, exactly at the edge runs within the cap.
        uint256 interval = rebalancer.effectiveStepInterval();
        vm.warp(t0 + interval - 1);
        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "before the edge: no trade");
        assertEq(uint8(why), uint8(SkipReason.Cooldown), "cooldown");
        vm.warp(t0 + interval);
        if (_assertStepWithinCap(keeper)) ++ran;

        // After keeperGrace with no step, anyone may step.
        openAt = rebalancer.permissionlessAt();
        vm.warp(openAt - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRebalancer.NotKeeperBeforeGrace.selector, stranger, openAt));
        rebalancer.step();
        vm.warp(openAt);
        if (_assertStepWithinCap(stranger)) ++ran;
        assertGt(ran, 0, "at least one worst-timed step executed (the cap path is exercised)");
    }

    /// @dev The one input a permissionless caller controls is the gas limit (RB-2). A stranger after
    ///      `keeperGrace` who sends too little gas for the step gets `StepGasStarved`: no fake `StepFailed`, no
    ///      backoff, no trade. With enough gas the stranger's step is exactly the order `previewStep` showed (the
    ///      keeper's), and a real step uses well under `STEP_GAS_FLOOR`.
    function test_keeperAbuse_gasStarvationCannotForceBackoff() public fixtureCovered {
        _wethOnlyPlan(COST_BUDGET_BPS);
        uint256 openAt = rebalancer.permissionlessAt();
        if (block.timestamp < openAt) vm.warp(openAt);
        uint256 floor = rebalancer.STEP_GAS_FLOOR();
        uint256 idle = fund.idleUsdc();

        // Enough gas to pass the decision, not enough for the floor (and so for every nested frame of the step).
        uint256[2] memory limits = [floor, floor * 3 / 4];
        for (uint256 k; k < limits.length; ++k) {
            vm.prank(stranger);
            vm.expectRevert(IRebalancer.StepGasStarved.selector);
            rebalancer.step{gas: limits[k]}();
            assertEq(rebalancer.assetBackoffUntil(IDX_WETH), 0, "starved: no backoff");
            assertEq(fund.lastStepAt(), 0, "starved: nothing recorded");
            assertEq(fund.idleUsdc(), idle, "starved: no trade");
        }

        (SkipReason r, uint256 s, uint256 b, uint256 n) = rebalancer.previewStep();
        assertEq(uint8(r), uint8(SkipReason.None), "a step is ready");
        uint256 g0 = gasleft();
        (bool did,, StepLog memory l) = _stepAs(stranger);
        uint256 used = g0 - gasleft();
        assertTrue(did, "with enough gas the stranger's step runs");
        assertEq(l.sell, s, "same sell leg as the preview");
        assertEq(l.buy, b, "same buy leg as the preview");
        assertEq(l.notional, n, "same notional as the preview");
        assertLt(used, floor / 2, "a real step uses well under STEP_GAS_FLOOR");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  §5.8 row 6: deposit or redeem timed around a step
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Bob deposits right before a step and redeems right after. The share price moves across the step by
    ///      exactly the realized step cost (composition does not move it), and Bob's claim (before any fee) never
    ///      exceeds the realized value his deposit added.
    function test_depositRedeemAroundStep_sharePriceMovesAtMostStepCost() public fixtureCovered {
        _wethOnlyPlan(COST_BUDGET_BPS);
        uint256 aliceShares = fund.balanceOf(alice);
        uint256 aliceBefore = fund.convertToAssets(aliceShares);

        uint256 bobIn = 50_000e6;
        uint256 navPreDeposit = fund.totalAssets();
        uint256 bobShares = deposit(bob, bobIn);
        uint256 bobDelta = fund.totalAssets() - navPreDeposit;
        assertGe(fund.convertToAssets(aliceShares) + 1, aliceBefore, "bob's deposit does not dilute alice");
        assertLe(fund.convertToAssets(bobShares), bobDelta, "bob's claim <= the realized value he added");

        uint256 navBefore = fund.totalAssets();
        uint256 supply = fund.totalSupply();
        uint256 aliceMid = fund.convertToAssets(aliceShares);
        (bool did,, StepLog memory l) = _stepAs(keeper);
        assertTrue(did, "step executed");
        assertLe(l.cost, l.notional * MAX_STEP_COST_BPS / BPS, "step cost within cap");
        uint256 navAfter = fund.totalAssets();
        assertEq(fund.totalSupply(), supply, "a step mints and burns nothing");
        assertEq(navBefore > navAfter ? navBefore - navAfter : 0, l.cost, "NAV moved by exactly the realized step cost");
        // Share-price identity: claim_after = claim_before × navAfter / navBefore (to share-math rounding).
        assertApproxEqAbs(
            fund.convertToAssets(aliceShares), aliceMid * navAfter / navBefore, 2, "alice moves only by the cost"
        );
        uint256 bobGross = fund.convertToAssets(bobShares);
        assertLe(bobGross, bobDelta, "bob's gross claim never exceeds his realized delta");
        assertLe(bobDelta - bobGross, l.cost * bobShares / supply + 2, "bob bears only his pro-rata cost share");

        vm.prank(bob);
        uint256 bobOut = fund.redeem(bobShares, bob, bob);
        assertLe(bobOut, bobGross, "realized payout <= the claim (fee and slippage on top)");
    }

    /// @dev §4.3 / §5.7: a deposit that lands early in a plan routes against the CURRENT path target, idle
    ///      included. It never pushes an asset past `pathTarget(now)` (which the rebalancer would only sell back,
    ///      a round trip every holder pays), and the next step does not sell an asset.
    function test_depositMidPlan_routesAlongPathNotPastIt() public fixtureCovered {
        deposit(alice, 100_000e6);
        recordAndApply(sleeveVec(5_000, 5_000, 0));
        vm.warp(block.timestamp + 1 hours);
        deposit(bob, 50_000e6);
        (uint256 nav,, uint256[] memory values) = fund.portfolioValues();
        (uint256[] memory t, uint256 idlePath) = fund.pathTarget(block.timestamp);
        assertGt(idlePath, 9_000, "early in the plan idle's path is still high");
        for (uint256 i; i < values.length; ++i) {
            assertLe(values[i], nav * (t[i] + 1) / BPS, "deposit did not push an asset past its path");
        }
        (SkipReason r, uint256 sell,,) = rebalancer.previewStep();
        if (r == SkipReason.None || r == SkipReason.BelowMinStep) assertEq(sell, IDLE_INDEX, "no asset to sell back");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  §5.8 row 7: a venue freezes
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev deSPXA transfers revert (issuer freeze, mocked). Steps that touch deSPXA fail and back off; the
    ///      keeper on its normal cadence keeps converging the other assets; the plan stalls on deSPXA only.
    function test_venueFreeze_stallsOnlyThatAsset() public fixtureCovered {
        // Hold every asset (routed deposit), then retarget so deSPXA is the most underweight asset.
        uint256 spxaHeld = _holdEverything();
        recordAndApply(sleeveVec(3_000, 4_000, 3_000));
        vm.warp(fund.plan().endTime);
        (,, uint256 firstBuy,) = rebalancer.previewStep();
        assertEq(firstBuy, IDX_DESPXA, "deSPXA is the first buy");

        _freezeDespxa();
        uint256 otherBefore = _valueExcept(IDX_DESPXA);
        uint256 failed;
        uint256 executed;
        for (uint256 k; k < 10; ++k) {
            vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            (bool did, SkipReason why, StepLog memory l) = _stepAs(keeper);
            if (did) {
                ++executed;
                assertTrue(l.sell != IDX_DESPXA && l.buy != IDX_DESPXA, "executed steps avoid the frozen asset");
            } else if (why == SkipReason.StepFailed) {
                ++failed;
                assertTrue(l.sell == IDX_DESPXA || l.buy == IDX_DESPXA, "only deSPXA legs fail");
            }
            assertEq(IERC20(DESPXA).balanceOf(address(fund)), spxaHeld, "frozen balance unchanged");
        }
        assertGt(failed, 0, "the frozen asset was attempted and failed");
        assertGt(executed, 0, "other assets kept trading");
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Open), "plan still open, stalled on deSPXA only");
        // The other underweight assets converged to their path targets; deSPXA alone stays short.
        (uint256[] memory w,) = assetWeightsBps();
        (uint256[] memory t,) = fund.pathTarget(block.timestamp);
        assertApproxEqAbs(w[IDX_WETH], t[IDX_WETH], TOLERANCE_BPS, "weth converged");
        assertApproxEqAbs(w[IDX_CBBTC], t[IDX_CBBTC], TOLERANCE_BPS, "cbBTC converged");
        assertGt(t[IDX_DESPXA], w[IDX_DESPXA] + TOLERANCE_BPS, "deSPXA still short of target");
        assertGt(_valueExcept(IDX_DESPXA), otherBefore * 99 / 100, "others' value kept (cost only)");
    }

    /// @dev §5.8 "redeemInKind remains open" under the same deSPXA freeze, while the fund holds deSPXA: a holder
    ///      can still exit in kind and receives the USDC, wETH and cbBTC legs. The frozen deSPXA leg is not
    ///      forfeited to the stayers and not taken from them: it is deferred (net to alice, fee share to the fee
    ///      recipient), leaves NAV, and alice pulls it once the freeze lifts.
    function test_venueFreeze_redeemInKindStaysOpen() public fixtureCovered {
        uint256 spxaHeld = _holdEverything();
        _freezeDespxa();
        uint256 supply = fund.totalSupply();
        uint256 shares = fund.balanceOf(alice) / 10;
        uint256 usdcBefore = IERC20(USDC).balanceOf(alice);
        uint256 spxaValueBefore = fund.assetValue(IDX_DESPXA);
        vm.prank(alice);
        fund.redeemInKind(shares, alice, alice);
        assertGt(IERC20(USDC).balanceOf(alice), usdcBefore, "in-kind USDC leg paid");
        assertGt(IERC20(WETH).balanceOf(alice), 0, "in-kind weth leg paid");
        assertGt(IERC20(CBBTC).balanceOf(alice), 0, "in-kind cbBTC leg paid");

        // Conservation: the deSPXA leg is owed in full, the tokens never moved, the stayers keep exactly theirs.
        uint256 owedTotal = spxaHeld * shares / supply;
        uint256 feeShare = owedTotal * EXIT_FEE_BPS / BPS;
        assertEq(fund.deferredOf(IDX_DESPXA, alice), owedTotal - feeShare, "alice's net deSPXA leg is deferred");
        assertEq(fund.deferredOf(IDX_DESPXA, feeRecipient), feeShare, "the fee share is deferred");
        assertEq(fund.deferredTotal(IDX_DESPXA), owedTotal, "deferred == the pro-rata leg");
        assertEq(IERC20(DESPXA).balanceOf(address(fund)), spxaHeld, "frozen tokens stay in the fund");
        assertEq(IERC20(DESPXA).balanceOf(alice), 0, "nothing paid while frozen");
        assertApproxEqAbs(
            fund.assetValue(IDX_DESPXA),
            fund.assetUsdcValue(IDX_DESPXA, spxaHeld - owedTotal),
            1,
            "NAV counts only the stayers' deSPXA"
        );
        assertLt(fund.assetValue(IDX_DESPXA), spxaValueBefore, "the owed leg left NAV");

        // A second in-kind exit while frozen is not paid out of alice's claim.
        uint256 aliceOwed = fund.deferredOf(IDX_DESPXA, alice);
        vm.prank(alice);
        fund.redeemInKind(shares, alice, alice);
        assertGt(fund.deferredOf(IDX_DESPXA, alice), aliceOwed, "second exit defers its own leg on top");
        assertEq(IERC20(DESPXA).balanceOf(address(fund)), spxaHeld, "still frozen in the fund");

        // The issuer lifts the freeze: alice pulls exactly what she is owed; the stayers' deSPXA is untouched.
        vm.clearMockedCalls();
        uint256 owed = fund.deferredOf(IDX_DESPXA, alice);
        uint256 stayers = spxaHeld - fund.deferredTotal(IDX_DESPXA);
        vm.prank(alice);
        fund.claimDeferred(IDX_DESPXA, alice);
        assertEq(IERC20(DESPXA).balanceOf(alice), owed, "alice receives her deferred leg");
        assertEq(fund.deferredOf(IDX_DESPXA, alice), 0, "claim cleared");
        assertEq(
            IERC20(DESPXA).balanceOf(address(fund)) - fund.deferredTotal(IDX_DESPXA), stayers, "stayers keep theirs"
        );
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.NothingDeferred.selector, IDX_DESPXA, alice));
        fund.claimDeferred(IDX_DESPXA, alice);
    }

    /// @dev §5.8 row 7, "lending pause": the Aave venue refuses every withdrawal (paused reserve or 100%
    ///      utilization, mocked on the adapter). `redeemInKind` still pays the idle, the other lending venues and
    ///      every basket token; the Aave share is deferred, not forfeited, and is claimable once Aave pays again.
    function test_lendingStall_redeemInKindDefersOnlyThatVenue() public fixtureCovered {
        _holdEverything();
        uint256 aaveHeld = fund.assetValue(IDX_AAVE);
        assertGt(aaveHeld, 0, "fund holds Aave");
        vm.mockCallRevert(
            address(aaveAdapter), abi.encodeWithSelector(IStrategyAdapter.withdraw.selector), bytes("PAUSED")
        );
        uint256 supply = fund.totalSupply();
        uint256 shares = fund.balanceOf(alice) / 5;
        uint256 usdcBefore = IERC20(USDC).balanceOf(alice);
        uint256 navBefore = fund.totalAssets();
        vm.prank(alice);
        fund.redeemInKind(shares, alice, alice);
        assertGt(IERC20(USDC).balanceOf(alice), usdcBefore, "idle and the other lending venues paid");
        assertGt(IERC20(WETH).balanceOf(alice), 0, "weth leg paid");
        assertGt(IERC20(DESPXA).balanceOf(alice), 0, "deSPXA leg paid");
        uint256 owed = aaveHeld * shares / supply;
        assertEq(fund.deferredTotal(IDX_AAVE), owed, "the Aave share is deferred in full");
        assertEq(
            fund.deferredOf(IDX_AAVE, alice) + fund.deferredOf(IDX_AAVE, feeRecipient), owed, "net + fee share"
        );
        assertApproxEqAbs(fund.assetValue(IDX_AAVE), aaveHeld - owed, 2, "NAV counts only the stayers' Aave");
        // Stayers' NAV per share is unchanged by the stall (to rounding).
        assertApproxEqAbs(
            fund.totalAssets() * supply / (supply - shares), navBefore, navBefore / 1e6 + 10, "no value shifted"
        );

        // Before the venue reopens, the claim waits (no partial payout, the claim stays whole).
        vm.prank(alice);
        vm.expectRevert(bytes("PAUSED"));
        fund.claimDeferred(IDX_AAVE, alice);
        vm.clearMockedCalls();
        uint256 aliceOwed = fund.deferredOf(IDX_AAVE, alice);
        uint256 before = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        fund.claimDeferred(IDX_AAVE, alice);
        assertEq(IERC20(USDC).balanceOf(alice) - before, aliceOwed, "alice receives her deferred USDC");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  §5.8 row 8: runaway cost
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev A tiny budget: the plan halts on the first step that overruns it, further steps do nothing (keeper
    ///      or stranger), and only an ADMIN (timelock) budget extension reopens it.
    function test_runawayCost_haltsUntilAdminExtends() public fixtureCovered {
        uint256 planId = _wethOnlyPlan(1);
        Plan memory p = fund.plan();
        uint256 n = _previewNotional();

        (uint256 executed,, PlanStatus st) = stepUntilDone(40);
        assertEq(uint8(st), uint8(PlanStatus.Halted), "plan halted");
        assertGt(executed, 0, "steps ran before the halt");
        p = fund.plan();
        assertGt(p.costSpent, p.costBudget, "halted because spent > budget");
        assertLe(p.costSpent, p.costBudget + n * MAX_STEP_COST_BPS / BPS, "overrun <= one capped step");

        uint256 wethBal = IERC20(WETH).balanceOf(address(fund));
        uint256 idle = fund.idleUsdc();
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "halted: keeper does nothing");
        assertEq(uint8(why), uint8(SkipReason.PlanNotOpen), "plan not open");
        assertEq(rebalancer.permissionlessAt(), type(uint256).max, "no permissionless path while halted");
        vm.warp(block.timestamp + KEEPER_GRACE + 1);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IRebalancer.NotKeeperBeforeGrace.selector, stranger, type(uint256).max)
        );
        rebalancer.step();
        assertEq(IERC20(WETH).balanceOf(address(fund)), wethBal, "no trade while halted");
        assertEq(fund.idleUsdc(), idle, "idle unchanged while halted");

        // Only ADMIN extends; an extension that leaves spent > budget keeps it halted.
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, keeper, Roles.ADMIN_ROLE)
        );
        fund.extendBudget(1_000e6);
        uint256 over = p.costSpent - p.costBudget;
        if (over > 1) {
            timelockExecute(address(fund), abi.encodeCall(fund.extendBudget, (over - 1)));
            assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Halted), "insufficient extension stays halted");
        }
        // EMERGENCY can pause a Halted plan at once (§5.5); a later extension then leaves it Paused, and ADMIN's
        // resume returns it to Halted while it is still over budget.
        vm.prank(emergency);
        fund.pauseRebalance();
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Paused), "halted plan paused by the hot key");
        timelockExecute(address(fund), abi.encodeCall(fund.resumePlan, ()));
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Halted), "resume of an over-budget plan: Halted");

        timelockExecute(address(fund), abi.encodeCall(fund.extendBudget, (1_000e6)));
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Open), "extension reopens");
        assertEq(fund.currentPlanId(), planId, "same plan");
        (did,) = keeperStep();
        assertTrue(did, "reopened plan steps again");
        assertLe(fund.plan().costSpent, fund.plan().costBudget + n * MAX_STEP_COST_BPS / BPS, "still bounded");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Authority: RB-1, executeStep gate, INV-1/INV-2 sweep
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev RB-1: only `RebalanceGovernance` (GOVERNANCE_ROLE) opens a plan, and governance's own entry points
    ///      are timelock-only. Only the rebalancer (REBALANCER_ROLE) executes or concludes a step. The sweep
    ///      refuses USDC, the share token, every asset token and every lending adapter, and sends a foreign
    ///      token only to the fixed quarantine.
    function test_authority_governanceOpens_rebalancerExecutes_sweepRefusesHeld() public fixtureCovered {
        _holdEverything();

        address[6] memory callers =
            [address(this), keeper, stranger, address(timelock), address(rebalancer), emergency];
        PlanParams memory pp = PlanParams(PLAN_DURATION, COST_BUDGET_BPS);
        (uint8[] memory ids, uint256[] memory w) = sleeveArrays(sleeveVec(10_000, 0, 0));
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(_unauthorized(callers[i], Roles.GOVERNANCE_ROLE));
            fund.setTargetAndOpenPlan(sleeveVec(10_000, 0, 0), pp, bytes32(0));
        }
        (bytes32 rid, bytes32 digest) = recordReceipt(sleeveVec(10_000, 0, 0));
        vm.prank(submitter);
        vm.expectRevert(_unauthorized(submitter, Roles.TARGET_SETTER_ROLE));
        governance.applyReceipt(rid, digest, ids, w);
        vm.expectRevert(_unauthorized(address(this), Roles.TARGET_SETTER_ROLE));
        governance.applyReceipt(rid, digest, ids, w);
        vm.prank(keeper);
        vm.expectRevert(_unauthorized(keeper, Roles.ADMIN_ROLE));
        governance.setTarget(ids, w, pp);
        assertEq(governance.getRoleAdmin(Roles.TARGET_SETTER_ROLE), Roles.TARGET_SETTER_ROLE, "self-administered");
        assertEq(fund.currentPlanId(), 1, "no plan opened outside the timelock");

        // The plan roles are self-administered and bound once: not even ADMIN (the timelock) can hand them out.
        vm.startPrank(address(timelock));
        vm.expectRevert(_unauthorized(address(timelock), Roles.GOVERNANCE_ROLE));
        IAccessControl(address(fund)).grantRole(Roles.GOVERNANCE_ROLE, stranger);
        vm.expectRevert(_unauthorized(address(timelock), Roles.REBALANCER_ROLE));
        IAccessControl(address(fund)).grantRole(Roles.REBALANCER_ROLE, stranger);
        vm.expectRevert(IRobotMoneyFund.RolesAlreadyBound.selector);
        fund.bindRebalanceRoles(stranger, stranger);
        vm.stopPrank();

        StepOrder memory o = StepOrder(IDX_AAVE, IDLE_INDEX, 1_000e6, 0, 0, 1_000e6);
        address[6] memory notRebalancer = [address(this), keeper, stranger, address(timelock), address(governance), emergency];
        for (uint256 i; i < notRebalancer.length; ++i) {
            vm.prank(notRebalancer[i]);
            vm.expectRevert(_unauthorized(notRebalancer[i], Roles.REBALANCER_ROLE));
            fund.executeStep(o);
            vm.prank(notRebalancer[i]);
            vm.expectRevert(_unauthorized(notRebalancer[i], Roles.REBALANCER_ROLE));
            fund.concludePlan(PlanStatus.Converged);
        }

        address[8] memory protectedTokens = [
            USDC,
            address(fund),
            WETH,
            CBBTC,
            DESPXA,
            address(aaveAdapter),
            address(cometAdapter),
            address(moonwellAdapter)
        ];
        for (uint256 i; i < protectedTokens.length; ++i) {
            address t = protectedTokens[i];
            bool erc20 = i < 5;
            uint256 bal = erc20 ? IERC20(t).balanceOf(address(fund)) : 0;
            vm.prank(stranger);
            vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.ProtectedToken.selector, t));
            fund.sweepForeignToken(t);
            if (erc20) assertEq(IERC20(t).balanceOf(address(fund)), bal, "protected balance untouched");
        }
        assertGt(IERC20(WETH).balanceOf(address(fund)), 0, "weth is held");
        assertGt(IERC20(DESPXA).balanceOf(address(fund)), 0, "deSPXA is held");

        ForeignToken f = new ForeignToken();
        f.mint(address(fund), 1e18);
        vm.prank(stranger);
        fund.sweepForeignToken(address(f));
        assertEq(f.balanceOf(address(fund)), 0, "foreign swept");
        assertEq(f.balanceOf(fund.quarantineAddress()), 1e18, "to the fixed quarantine only");
        assertEq(f.balanceOf(stranger), 0, "never to the caller");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Alice deposits with no plan (all idle); cbBTC is made untradeable (maxStepUsdc 0) so wETH is the only
    ///      buy candidate; a 100% protocol plan opens (receipt for the default budget, else `setTarget` with
    ///      `budgetBps`); time moves to the plan's end so the path target is the end target.
    function _wethOnlyPlan(uint16 budgetBps) internal returns (uint256 planId) {
        deposit(alice, ALICE_DEPOSIT);
        timelockExecute(
            address(rebalancer), abi.encodeCall(rebalancer.setAssetStepParams, (IDX_CBBTC, AssetStepParams(0, 0)))
        );
        if (budgetBps == COST_BUDGET_BPS) {
            planId = recordAndApply(sleeveVec(0, 10_000, 0));
        } else {
            planId = setTargetViaTimelock(sleeveVec(0, 10_000, 0), PlanParams(PLAN_DURATION, budgetBps));
        }
        vm.warp(fund.plan().endTime);
        (SkipReason r, uint256 s, uint256 b,) = rebalancer.previewStep();
        assertEq(uint8(r), uint8(SkipReason.None), "setup: a step is ready");
        assertEq(s, IDLE_INDEX, "setup: sell idle");
        assertEq(b, IDX_WETH, "setup: buy weth");
    }

    /// @dev Plan to (60, 30, 10) at NAV 0, then a routed 100k deposit: the fund holds every asset. Returns the
    ///      deSPXA held.
    function _holdEverything() internal returns (uint256 spxaHeld) {
        recordAndApply(sleeveVec(6_000, 3_000, 1_000));
        deposit(alice, 100_000e6);
        spxaHeld = IERC20(DESPXA).balanceOf(address(fund));
        assertGt(spxaHeld, 0, "fund holds deSPXA");
    }

    /// @dev Issuer freeze: every deSPXA `transfer` and `transferFrom` reverts.
    function _freezeDespxa() internal {
        vm.mockCallRevert(DESPXA, abi.encodeWithSelector(IERC20.transfer.selector), bytes("FROZEN"));
        vm.mockCallRevert(DESPXA, abi.encodeWithSelector(IERC20.transferFrom.selector), bytes("FROZEN"));
    }

    /// @dev wETH's distance below its path target, at TWAP.
    function _wethGap() internal view returns (uint256) {
        (uint256 nav,,) = fund.portfolioValues();
        (uint256[] memory t,) = fund.pathTarget(block.timestamp);
        uint256 target = nav * t[IDX_WETH] / BPS;
        uint256 v = fund.assetValue(IDX_WETH);
        return target > v ? target - v : 0;
    }

    function _previewNotional() internal view returns (uint256 n) {
        (,,, n) = rebalancer.previewStep();
        assertGt(n, 0, "notional");
    }

    /// @dev `previewStep`'s notional at time `t`, and wETH's TWAP token amount for it, on the current state with
    ///      no market activity in between.
    function _honestQuoteAt(uint256 t) internal returns (uint256 n, uint256 tokens) {
        uint256 snap = vm.snapshotState();
        vm.warp(t);
        n = _previewNotional();
        tokens = fund.assetTokenValue(IDX_WETH, n);
        vm.revertToState(snap);
    }

    /// @dev The order the rebalancer would build for idle -> `buy` at `n` (§5.3 step 5).
    function _honestBuyOrder(uint256 buy, uint256 n) internal view returns (StepOrder memory o) {
        uint256 slip = rebalancer.assetStepParams(buy).maxStepSlippageBps;
        o = StepOrder({
            sellIndex: IDLE_INDEX,
            buyIndex: buy,
            notionalUsdc: n,
            minSellUsdcOut: 0,
            minBuyOut: fund.assetTokenValue(buy, n) * (BPS - slip) / BPS,
            maxCostUsdc: n * MAX_STEP_COST_BPS / BPS
        });
    }

    /// @dev Buy the token on `pool` in growing chunks until asset `idx`'s ORA-4 deviation is at least
    ///      `minDev` bps. Chunks double while the deviation is under half the goal, then hold, so the final
    ///      deviation lands near the goal (about 1x to 1.5x). Returns the deviation and the tokens bought.
    function _pushUp(address pool, uint256 idx, uint256 minDev) internal returns (uint256 dev, uint256 bought) {
        uint256 chunk = 25_000e6;
        (, dev) = fund.marketCheck(idx);
        for (uint256 k; k < 60 && dev < minDev; ++k) {
            bought += movePrice(pool, chunk, true);
            (, dev) = fund.marketCheck(idx);
            if (dev * 2 < minDev) chunk *= 2;
        }
        assertGe(dev, minDev, "push reached its goal");
    }

    /// @dev Sell `amount` of `token` for USDC on its fee-500 pool from this contract.
    function _swapExactIn(address token, uint256 amount) internal {
        IERC20(token).approve(ROUTER, amount);
        IHarnessSwapRouter02(ROUTER).exactInputSingle(
            IHarnessSwapRouter02.ExactInputSingleParams(token, USDC, POOL_FEE, address(this), amount, 0, 0)
        );
    }

    /// @dev `step()` as `caller`, returning what the rebalancer logged.
    function _stepAs(address caller) internal returns (bool did, SkipReason why, StepLog memory l) {
        vm.recordLogs();
        vm.prank(caller);
        (did, why) = rebalancer.step();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        l.sell = IDLE_INDEX;
        l.buy = IDLE_INDEX;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(rebalancer)) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == IFundEvents.RebalanceStep.selector) {
                (l.sell, l.buy, l.notional,, l.amountOut, l.cost,,) = abi.decode(
                    logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
                );
            } else if (t0 == IFundEvents.RebalanceStepSkipped.selector) {
                (, l.sell, l.buy, l.detail) = abi.decode(logs[i].data, (SkipReason, uint256, uint256, uint256));
            }
        }
    }

    /// @dev One step as `caller`: if it trades, the realized TWAP NAV loss equals the logged cost and stays
    ///      within `maxStepCostBps` of the notional (RB-4); if it does not, NAV is unchanged.
    function _assertStepWithinCap(address caller) internal returns (bool did) {
        uint256 navBefore = fund.totalAssets();
        SkipReason why;
        StepLog memory l;
        (did, why, l) = _stepAs(caller);
        uint256 navAfter = fund.totalAssets();
        if (!did) {
            assertEq(uint8(why), uint8(SkipReason.StepFailed), "a refused step is a caught failure");
            assertEq(navAfter, navBefore, "a refused step moves nothing");
            return false;
        }
        uint256 loss = navBefore > navAfter ? navBefore - navAfter : 0;
        assertEq(loss, l.cost, "logged cost = realized TWAP NAV loss");
        assertLe(loss, l.notional * MAX_STEP_COST_BPS / BPS, "loss <= maxStepCostBps of notional");
    }

    /// @dev Sum of every asset's TWAP value except `skip`.
    function _valueExcept(uint256 skip) internal view returns (uint256 sum) {
        (,, uint256[] memory values) = fund.portfolioValues();
        for (uint256 i; i < values.length; ++i) {
            if (i != skip) sum += values[i];
        }
    }

    function _unauthorized(address who, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role);
    }
}
