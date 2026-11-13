// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.10 (the same layers on the rebalance, step 3e), §5.3
//            (one step), §5.4 (who calls), §5.8 (threats: sandwich of a step, keeper abuse), §7 RB-4, RB-5 and RB-19,
//            §10 step 3e (A20), §13 G3 and G8; step-3 finish plan §3.5
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardUpgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IBasketSwapAdapter} from "../../interfaces/IBasketSwapAdapter.sol";

import {PrototypeHarness, IHarnessSwapRouter02, IHarnessV3Pool} from "./PrototypeHarness.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {UniswapV3ExactOutSwapAdapter} from "./src/adapters/UniswapV3ExactOutSwapAdapter.sol";
import {
    FeedStatus,
    IFundEvents,
    PlanParams,
    PlanStatus,
    SkipReason,
    StepFeedCheck,
    StepOrder,
    BPS,
    IDLE_INDEX
} from "./src/FundTypes.sol";
import {IRobotMoneyFund} from "./src/interfaces/IRobotMoneyFund.sol";
import {Rebalancer} from "./src/Rebalancer.sol";

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  A hostile swap venue for the RB-19 balance check
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/// @title Step3eHostileSwapAdapter
/// @notice `vm.etch` places it over the harness's swap adapter (whose code keeps no storage; every setting here is an
///         immutable, so it survives the etch). It swaps exactly as the production `UniswapV3SwapAdapter` does (pull
///         the input, SwapRouter02 `exactInputSingle` to the recipient with the caller's floor) and prices the TWAP
///         through a real adapter copy. Then it misbehaves:
///         - `GIFT` > 0: it sends `GIFT` of `GIFT_TOKEN` (an asset the step does not trade) to the fund, so a third
///           asset moves inside the step. RB-19 must refuse the step.
///         - `REENTER_FUND` set: it calls `redeemInKind` on the fund with shares it holds, which would change the
///           supply inside the step. The fund's reentrancy guard must refuse it first.
contract Step3eHostileSwapAdapter {
    using SafeERC20 for IERC20;

    address public immutable ROUTER_;
    address public immutable REAL;
    address public immutable GIFT_TOKEN;
    uint256 public immutable GIFT;
    address public immutable REENTER_FUND;
    uint256 public immutable REENTER_SHARES;

    constructor(address router, address real, address giftToken, uint256 gift, address reenterFund, uint256 shares) {
        ROUTER_ = router;
        REAL = real;
        GIFT_TOKEN = giftToken;
        GIFT = gift;
        REENTER_FUND = reenterFund;
        REENTER_SHARES = shares;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256
    ) external returns (uint256 amountOut) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(ROUTER_, amountIn);
        amountOut = IHarnessSwapRouter02(ROUTER_).exactInputSingle(
            IHarnessSwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, fee, recipient, amountIn, minAmountOut, 0)
        );
        IERC20(tokenIn).forceApprove(ROUTER_, 0);
        if (GIFT != 0) IERC20(GIFT_TOKEN).safeTransfer(recipient, GIFT);
        if (REENTER_FUND != address(0)) {
            IRobotMoneyFund(REENTER_FUND).redeemInKind(REENTER_SHARES, address(this), address(this));
        }
    }

    function twapPrice(address pool, address base, address quote, uint256 amount, uint32 window)
        external
        view
        returns (uint256)
    {
        return IBasketSwapAdapter(REAL).twapPrice(pool, base, quote, amount, window);
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  Step 3e on the live fund and the Rebalancer
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/// @title Step3eTest
/// @notice Step 3e (proposal §5.10, RB-19, A20) on the live harness and the real Base fixture (replay, no RPC):
///         - the feed checks of a step (checks 2 and 4 of §5.9.3), in the Rebalancer (a skip with a reason, no
///           backoff) and inside the fund (`StepFeedCheckFailed`, nothing moves);
///         - the order's limits from the stricter of TWAP and feed, for each direction;
///         - the cost booked at the feeds, and capped there;
///         - the RB-19 balance check inside the fund;
///         - backoff only on the keeper's own failed calls;
///         - A20: a keeper's sandwich of a step, and a budget halt forced by feed noise.
///
///         The world model. The replay fixture has no arbitrageur and the mock feeds post only when a test writes
///         them. A step loop here therefore re-posts every feed before each step (a live Chainlink feed posts at
///         least once per heartbeat) and, where the test models a market that follows the fund's own trades,
///         moves each basket feed to its pool (`alignFeedsToPools`, the harness's own model for settlements). A
///         test that measures a feed check sets the feed explicitly and says so.
///
///         Every attack number is in USDC units (6 decimals) at REFERENCE prices: each basket token at its pool's
///         spot when the attack starts (where the feed also sits). A `G8` log line per result has the scaffold's
///         format `id,attackerNet,attackerNetAaveFee,flashBorrowed,holdersLoss,pendingLoss,navRef` (holdersLoss is
///         the loss beyond the honest step's own cost; pendingLoss is 0: a step has no pending user).
contract Step3eTest is PrototypeHarness {
    using Math for uint256;

    /// @dev Labels shared with Attacks.t.sol, so their fixture slots are the recorded ones.
    address internal alice = makeAddr("alice");
    address internal attacker = makeAddr("attacker");
    address internal stranger = makeAddr("dave");

    uint256 internal constant FLASH_USDC = 30_000_000e6;
    uint256 internal constant AAVE_FLASH_FEE_BPS = 5;
    /// @dev G8 (proposal §13): holders lose at most 1 bps of NAV.
    uint256 internal constant G8_HOLDER_LOSS_BPS = 1;
    /// @dev The feeds' deviation thresholds the timed sim models (sim/TimedSimBase.sol: ETH / USD 0.15 %, cbBTC / USD
    ///      0.3 %): a live feed lags its market by up to this much between rounds.
    uint256 internal constant ETH_FEED_DEV_BPS = 15;
    uint256 internal constant CBBTC_FEED_DEV_BPS = 30;

    // ─── Attack bookkeeping (storage: the bodies are long) ───────────────────────────────────────────
    uint256 internal refWeth;
    uint256 internal refCbbtc;

    /// @dev One A20 result.
    struct Pnl {
        int256 attackerNet;
        uint256 borrowed;
        uint256 holdersLoss;
        uint256 extraLoss;
        uint256 navRef;
        bool stepped;
    }

    function setUp() public override {
        super.setUp();
        vm.label(alice, "alice");
        vm.label(attacker, "attacker");
        vm.label(stranger, "stranger");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Feed checks of a step (§5.10 "feed health and TWAP against feed"; RB-5 and RB-19 from step 3e)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Quiet market, feeds at the pools: the step passes its feed checks and trades.
    function test_RB19_feedChecks_quietMarket_stepTrades() public fixtureCovered {
        _buyWethReady();
        (bool did, SkipReason why) = keeperStep();
        assertTrue(did, "the step traded");
        assertEq(uint8(why), uint8(SkipReason.None), "no skip");
    }

    function test_RB19_feedCheck_sequencerDown_noStep() public fixtureCovered {
        _buyWethReady();
        MockAggregator(FEED_SEQUENCER).setRound(0, 1, block.timestamp, block.timestamp);
        _assertFeedBlocked(StepFeedCheck.Sequencer, IDLE_INDEX, uint256(FeedStatus.SequencerDown));
    }

    function test_RB19_feedCheck_sequencerInGrace_noStep() public fixtureCovered {
        _buyWethReady();
        MockAggregator(FEED_SEQUENCER).setRound(0, 0, block.timestamp - 10 minutes, block.timestamp);
        _assertFeedBlocked(StepFeedCheck.Sequencer, IDLE_INDEX, uint256(FeedStatus.SequencerGrace));
    }

    /// @dev The ETH / USD feed one second past its `maxFeedAge` (heartbeat + 5 minutes).
    function test_RB19_feedCheck_basketFeedStale_noStep() public fixtureCovered {
        _buyWethReady();
        uint256 t = block.timestamp - ETH_FEED_MAX_AGE - 1;
        MockAggregator(FEED_ETH).setRound(8, feedPrice8[FEED_ETH], t, t);
        _assertFeedBlocked(StepFeedCheck.Feed, IDX_WETH, uint256(FeedStatus.Stale));
    }

    /// @dev A feed of an asset the step does not trade (cbBTC) also blocks it: every basket TWAP feeds the NAV the
    ///      path targets come from.
    function test_RB19_feedCheck_otherBasketFeedNonPositive_noStep() public fixtureCovered {
        _buyWethReady();
        MockAggregator(FEED_CBBTC).setRound(8, 0, block.timestamp, block.timestamp);
        _assertFeedBlocked(StepFeedCheck.Feed, IDX_CBBTC, uint256(FeedStatus.NonPositive));
    }

    /// @dev USDC at 0.994 (60 bps off, the band is 50): `detail` is the USDC price.
    function test_RB19_feedCheck_usdcOffPeg_noStep() public fixtureCovered {
        _buyWethReady();
        setUsdcFeedPrice(0.994e8);
        _assertFeedBlocked(StepFeedCheck.UsdcPeg, IDLE_INDEX, 0.994e8);
    }

    /// @dev The wETH feed 60 bps above its pool (the TWAP sits at the pool in a quiet market): check 4 fails,
    ///      `detail` is the deviation in bps, rounded up, computed as the check does.
    function test_RB19_feedCheck_twapOutsideRefBand_noStep() public fixtureCovered {
        _buyWethReady();
        _setFeedOffsetBps(IDX_WETH, 60);
        _assertFeedBlocked(StepFeedCheck.TwapVsFeed, IDX_WETH, _twapVsFeedBps(IDX_WETH));
        assertGt(_twapVsFeedBps(IDX_WETH), queue.flowParams().refBandBps, "outside the band");
    }

    /// @dev 40 bps off (inside the 50 bps band) passes check 4: the band is the only bound. The buy still meets
    ///      its floor (feed below TWAP would tighten it; here the feed is above, so the TWAP sets it).
    function test_RB19_feedCheck_twapInsideRefBand_steps() public fixtureCovered {
        _buyWethReady();
        _setFeedOffsetBps(IDX_WETH, 40);
        assertLe(_twapVsFeedBps(IDX_WETH), queue.flowParams().refBandBps, "inside the band");
        (bool did,) = keeperStep();
        assertTrue(did, "the step traded");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  The limit from the stricter price, each direction (§5.10)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice A purchase pays at most the LOWER of TWAP and feed, plus the asset's slippage bound. Feed below the
    ///         TWAP: the feed sets the floor. Feed above: the TWAP does. Either way the floor is at least the step 3c
    ///         TWAP-only floor.
    function test_3e_limit_purchase_fromTheLowerOfTwapAndFeed() public fixtureCovered {
        _buyWethReady();
        uint256 slip = rebalancer.assetStepParams(IDX_WETH).maxStepSlippageBps;
        int256[2] memory offsets = [int256(-30), int256(30)];
        for (uint256 k; k < 2; ++k) {
            _setFeedOffsetBps(IDX_WETH, offsets[k]);
            (SkipReason r, StepOrder memory o) = rebalancer.previewOrder();
            assertEq(uint8(r), uint8(SkipReason.None), "a step is ready");
            assertEq(o.buyIndex, IDX_WETH, "buys wETH");
            uint256 twapPx = fund.assetUsdcValue(IDX_WETH, 1e18);
            uint256 feedPx = _feedPx(IDX_WETH);
            // Tokens for the notional at the lower price = the larger of the two quotes.
            uint256 atTwap = fund.assetTokenValue(IDX_WETH, o.notionalUsdc);
            uint256 atFeed = o.notionalUsdc.mulDiv(1e18, feedPx, Math.Rounding.Ceil);
            uint256 expected = Math.max(atTwap, atFeed).mulDiv(BPS, BPS + slip, Math.Rounding.Ceil);
            assertEq(o.minBuyOut, expected, "floor = notional at the lower price / (1 + slip)");
            uint256 step3c = fund.assetTokenValue(IDX_WETH, o.notionalUsdc).mulDiv(BPS - slip, BPS);
            assertGe(o.minBuyOut, step3c, "never looser than the step 3c TWAP floor");
            if (offsets[k] < 0) assertLt(feedPx, twapPx, "feed is the lower price");
            else assertGt(feedPx, twapPx, "TWAP is the lower price");
            emit log_named_int("feed offset (bps)", offsets[k]);
            emit log_named_uint("  minBuyOut (wei)", o.minBuyOut);
            emit log_named_uint("  step 3c TWAP-only floor (wei)", step3c);
        }
    }

    /// @notice A sale receives at least the HIGHER of TWAP and feed, less the asset's slippage bound.
    function test_3e_limit_sale_fromTheHigherOfTwapAndFeed() public fixtureCovered {
        _sellWethReady();
        uint256 slip = rebalancer.assetStepParams(IDX_WETH).maxStepSlippageBps;
        int256[2] memory offsets = [int256(30), int256(-30)];
        for (uint256 k; k < 2; ++k) {
            _setFeedOffsetBps(IDX_WETH, offsets[k]);
            (SkipReason r, StepOrder memory o) = rebalancer.previewOrder();
            assertEq(uint8(r), uint8(SkipReason.None), "a step is ready");
            assertEq(o.sellIndex, IDX_WETH, "sells wETH");
            uint256 amt = fund.assetTokenValue(IDX_WETH, o.notionalUsdc);
            uint256 hi = Math.max(fund.assetUsdcValue(IDX_WETH, amt), amt.mulDiv(_feedPx(IDX_WETH), 1e18, Math.Rounding.Ceil));
            uint256 expected = hi.mulDiv(BPS - slip, BPS, Math.Rounding.Ceil);
            assertEq(o.minSellUsdcOut, expected, "floor = amt at the higher price x (1 - slip)");
            uint256 step3c = fund.assetUsdcValue(IDX_WETH, amt).mulDiv(BPS - slip, BPS);
            assertGe(o.minSellUsdcOut, step3c, "never looser than the step 3c TWAP floor");
            emit log_named_int("feed offset (bps)", offsets[k]);
            emit log_named_uint("  minSellUsdcOut", o.minSellUsdcOut);
            emit log_named_uint("  step 3c TWAP-only floor", step3c);
        }
    }

    /// @notice The feed 45 bps above the pool (inside the 50 bps band): a wETH sale must receive at least
    ///         feed x (1 - 50 bps), about the pool price less 5 bps, which the 5 bps pool fee alone denies. The step
    ///         fails inside the swap and trades nothing, where the step 3c TWAP-only floor (pool less 50 bps) would
    ///         have let it sell 45 bps under the outside price.
    function test_3e_limit_saleBelowTheFeedRefused_whereTheTwapFloorWouldPass() public fixtureCovered {
        _sellWethReady();
        _setFeedOffsetBps(IDX_WETH, 45);
        (SkipReason r, StepOrder memory o) = rebalancer.previewOrder();
        assertEq(uint8(r), uint8(SkipReason.None), "the feed checks pass (inside the band)");
        uint256 slip = rebalancer.assetStepParams(IDX_WETH).maxStepSlippageBps;
        uint256 amt = fund.assetTokenValue(IDX_WETH, o.notionalUsdc);
        uint256 step3c = fund.assetUsdcValue(IDX_WETH, amt).mulDiv(BPS - slip, BPS);
        assertGt(o.minSellUsdcOut, step3c, "the feed raised the floor");
        (, uint256[] memory held0) = fund.heldBalances();
        uint256 spent0 = fund.plan().costSpent;
        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "no trade");
        assertEq(uint8(why), uint8(SkipReason.StepFailed), "refused inside the swap");
        (, uint256[] memory held1) = fund.heldBalances();
        assertEq(held1[IDX_WETH], held0[IDX_WETH], "wETH untouched");
        assertEq(fund.plan().costSpent, spent0, "nothing booked");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Cost booked at the feeds (§5.10, RB-4 from step 3e; cost report §4)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice A wETH purchase with the feed 20 bps under the pool: the cost booked is the fall of NAV at the feeds
    ///         (recomputed here from the held amounts), not the TWAP's. The plan books exactly it, and the step's
    ///         `cost` reports it.
    function test_3e_costBookedAtTheFeeds() public fixtureCovered {
        _buyWethReady();
        _setFeedOffsetBps(IDX_WETH, -20);
        uint256 feedPx = _feedPx(IDX_WETH);
        (, StepOrder memory o) = rebalancer.previewOrder();
        (uint256 idle0, uint256[] memory held0) = fund.heldBalances();
        uint256 spent0 = fund.plan().costSpent;
        vm.recordLogs();
        (bool did,) = keeperStep();
        assertTrue(did, "the step traded");
        (uint256 idle1, uint256[] memory held1) = fund.heldBalances();
        uint256 feedBefore = idle0 + held0[IDX_WETH].mulDiv(feedPx, 1e18);
        uint256 feedAfter = idle1 + held1[IDX_WETH].mulDiv(feedPx, 1e18);
        uint256 expected = feedBefore > feedAfter ? feedBefore - feedAfter : 0;
        (uint256 fb, uint256 fa, uint256 feedCost, uint256 twapCost) = _lastCostBooked();
        assertEq(fb, feedBefore, "feed NAV before (idle + legs)");
        assertEq(fa, feedAfter, "feed NAV after");
        assertEq(feedCost, expected, "booked = the fall at the feeds");
        assertEq(fund.plan().costSpent - spent0, feedCost, "the plan booked the feed cost");
        assertGt(feedCost, twapCost, "the feed sees the 20 bps the TWAP misses");
        assertLe(feedCost, o.maxCostUsdc, "within the cap");
        emit log_named_uint("feed cost (booked)", feedCost);
        emit log_named_uint("TWAP cost (step 3c booking)", twapCost);
    }

    /// @notice The cap applies to the cost at the feeds: an order the fund receives with a cap of 30 bps, for a
    ///         wETH purchase with the feed 40 bps under the pool, reverts `StepCostExceeded` with the feed cost,
    ///         although the TWAP cost is a few bps. The floors are left loose here, so only the cap can refuse.
    function test_3e_costCapAppliesAtTheFeeds() public fixtureCovered {
        _buyWethReady();
        _setFeedOffsetBps(IDX_WETH, -40);
        (, StepOrder memory o) = rebalancer.previewOrder();
        o.minBuyOut = 0;
        o.maxCostUsdc = o.notionalUsdc.mulDiv(30, BPS);
        uint256 snap = vm.snapshotState();
        // What the fund would book without the cap: run it with the global ceiling, read the event, roll back.
        StepOrder memory loose =
            StepOrder(o.sellIndex, o.buyIndex, o.notionalUsdc, o.minSellUsdcOut, 0, o.notionalUsdc.mulDiv(500, BPS));
        vm.recordLogs();
        vm.prank(address(rebalancer));
        fund.executeStep(loose);
        (,, uint256 feedCost, uint256 twapCost) = _lastCostBooked();
        vm.revertToState(snap);
        assertGt(feedCost, o.maxCostUsdc, "the feed cost is above 30 bps");
        assertLt(twapCost, o.maxCostUsdc, "the TWAP cost is below it");
        vm.prank(address(rebalancer));
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.StepCostExceeded.selector, feedCost, o.maxCostUsdc));
        fund.executeStep(o);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-19: a step changes only its two traded assets and idle USDC, never the supply
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Every step of a plan that moves between all five kinds of holding: seen from outside, each executed
    ///         step changed only its two legs (sell down, buy up) and idle, and never the supply.
    function test_RB19_everyExecutedStep_changesOnlyItsLegsAndIdle() public fixtureCovered {
        _investAtEnd(assetVec(2_500, 2_500, 2_500, 2_500, 0));
        setTargetViaTimelock(assetVec(4_000, 1_000, 1_000, 4_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        vm.warp(fund.plan().endTime);
        uint256 executed;
        for (uint256 k; k < 12 && fund.planStatus() == PlanStatus.Open; ++k) {
            vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            _freshFeeds();
            (SkipReason r, StepOrder memory o) = rebalancer.previewOrder();
            (, uint256[] memory h0) = fund.heldBalances();
            uint256 supply0 = fund.totalSupply();
            (bool did,) = keeperStep();
            if (!did) continue;
            assertEq(uint8(r), uint8(SkipReason.None), "previewed");
            ++executed;
            (, uint256[] memory h1) = fund.heldBalances();
            assertEq(fund.totalSupply(), supply0, "RB-19: supply unchanged");
            for (uint256 i; i < h0.length; ++i) {
                if (i == o.sellIndex) assertLe(h1[i], h0[i], "RB-19: the sell leg did not grow");
                else if (i == o.buyIndex) assertGe(h1[i], h0[i], "RB-19: the buy leg did not shrink");
                else assertEq(h1[i], h0[i], "RB-19: every other asset unchanged");
            }
        }
        assertGt(executed, 1, "several steps ran");
    }

    /// @notice A venue that moves a third asset inside the step (a hostile swap adapter that sends cbBTC to the fund
    ///         during a wETH purchase): the fund refuses the step (`StepBalanceChanged` on cbBTC) and nothing moves.
    function test_RB19_balanceCheck_refusesAStepThatMovesAThirdAsset() public fixtureCovered {
        _investAtEnd(assetVec(2_500, 2_500, 2_500, 2_500, 0));
        setTargetViaTimelock(assetVec(1_500, 2_000, 4_000, 2_500, 0), PlanParams(1 days, COST_BUDGET_BPS));
        vm.warp(fund.plan().endTime);
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        _freshFeeds();
        (SkipReason r, StepOrder memory o) = rebalancer.previewOrder();
        assertEq(uint8(r), uint8(SkipReason.None), "a step is ready");
        assertEq(o.buyIndex, IDX_WETH, "buys wETH");
        assertTrue(o.sellIndex != IDX_CBBTC, "cbBTC is not a leg");

        uint256 gift = 1e4; // 0.0001 cbBTC
        _etchHostile(gift, address(0), 0);
        deal(CBBTC, address(swapAdapter), gift);
        (, uint256[] memory held0) = fund.heldBalances();

        vm.prank(address(rebalancer));
        vm.expectRevert(
            abi.encodeWithSelector(
                IRobotMoneyFund.StepBalanceChanged.selector, IDX_CBBTC, held0[IDX_CBBTC], held0[IDX_CBBTC] + gift
            )
        );
        fund.executeStep(o);

        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "no trade");
        assertEq(uint8(why), uint8(SkipReason.StepFailed), "the fund refused it");
        (, uint256[] memory held1) = fund.heldBalances();
        for (uint256 i; i < held0.length; ++i) {
            assertEq(held1[i], held0[i], "nothing moved");
        }
    }

    /// @notice The supply half of RB-19: a venue that tries to change the supply inside a step (`redeemInKind` from
    ///         the swap callback) is refused by the fund's reentrancy guard before the balance check is reached. The
    ///         `StepSupplyChanged` check is defence in depth behind it; no path reaches it.
    function test_RB19_supplyCannotChangeInsideAStep_reentryRefused() public fixtureCovered {
        uint256 shares = deposit(alice, 10_000e6);
        assertGt(shares, 0, "alice holds shares");
        _buyWethReady();
        (, StepOrder memory o) = rebalancer.previewOrder();
        vm.prank(alice);
        fund.transfer(address(swapAdapter), shares);
        _etchHostile(0, address(fund), shares);
        uint256 supply0 = fund.totalSupply();
        vm.prank(address(rebalancer));
        vm.expectRevert(ReentrancyGuardUpgradeable.ReentrancyGuardReentrantCall.selector);
        fund.executeStep(o);
        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "no trade");
        assertEq(uint8(why), uint8(SkipReason.StepFailed), "refused");
        assertEq(fund.totalSupply(), supply0, "supply unchanged");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Backoff only on the keeper's own failed calls (§5.10)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice After keeperGrace a stranger pushes the wETH pool past the step's floor and calls `step()` in the
    ///         same transaction: the step fails and nothing backs off. The keeper's own failed call does back off.
    function test_3e_backoff_onlyOnTheKeepersOwnFailedCall() public fixtureCovered {
        _buyWethReady();
        vm.warp(block.timestamp + KEEPER_GRACE);
        _freshFeeds();
        assertLe(rebalancer.permissionlessAt(), block.timestamp, "open to anyone");
        uint256 slip = rebalancer.assetStepParams(IDX_WETH).maxStepSlippageBps;
        fundUsdc(attacker, FLASH_USDC);
        _pushBps(attacker, WETH_POOL, WETH, int256(slip + 30));

        vm.prank(stranger);
        (bool did, SkipReason why) = rebalancer.step();
        assertFalse(did, "no trade");
        assertEq(uint8(why), uint8(SkipReason.StepFailed), "the floor refused the pushed pool");
        assertEq(rebalancer.assetBackoffUntil(IDX_WETH), 0, "a stranger's failure backs nothing off");
        (SkipReason next,,,) = rebalancer.previewStep();
        assertEq(uint8(next), uint8(SkipReason.None), "wETH stays eligible");

        (did, why) = keeperStep();
        assertFalse(did, "the keeper's call fails too");
        assertGt(rebalancer.assetBackoffUntil(IDX_WETH), block.timestamp, "the keeper's failure backs wETH off");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A20 (proposal §10 step 3e): a keeper's sandwich of a step
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice The keeper (or anyone who orders trades around the keeper's call) buys wETH to push the pool up, calls
    ///         `step()` while the step buys 50,000 USDC of wETH, and sells back. Push sizes inside and past the step's
    ///         limit; the best is scored. Holders' loss is measured beyond the honest step's own cost.
    function test_A20_keeperSandwichOfAStep_purchase() public fixtureCovered {
        _buyWethReady();
        _sandwich(true, "A20 keeper sandwich of a step, purchase leg");
    }

    /// @notice The same purchase sandwich in a fund of about 1,000,000 USDC (alice deposits 900,000 through the queue
    ///         first), so the 50,000 USDC step is 5 % of NAV instead of half of it: G8's holders' bound is in bps of
    ///         NAV, the attacker's net is not.
    function test_A20_keeperSandwichOfAStep_purchase_fundOf1M() public fixtureCovered {
        deposit(alice, 900_000e6);
        coverageCheckpoint();
        _buyWethReady();
        _sandwich(true, "A20 keeper sandwich of a step, purchase leg, NAV 1M");
    }

    /// @notice The same around a sale: the attacker sells wETH first, the step sells 25,000 USDC of wETH into the
    ///         lowered pool, the attacker buys back.
    function test_A20_keeperSandwichOfAStep_sale() public fixtureCovered {
        _sellWethReady();
        _sandwich(false, "A20 keeper sandwich of a step, sale leg");
    }

    /// @notice A sandwich after the attacker held the pushed price for one TWAP window (no arbitrage: holding is free
    ///         in this model). The TWAP has followed the pool; the feed (the outside market) has not. Check 4 lets a
    ///         push inside `refBandBps` through, and the purchase limit then comes from the feed, the lower price.
    function test_A20_keeperSandwichAfterATwapDrag_purchase() public fixtureCovered {
        _buyWethReady();
        int256[2] memory pushes = [int256(30), int256(45)];
        Pnl memory best;
        best.attackerNet = type(int256).min;
        uint256 honest = _honestLoss();
        for (uint256 k; k < pushes.length; ++k) {
            uint256 snap = vm.snapshotState();
            _setRef();
            uint256 nav0 = _navRef();
            fundUsdc(attacker, FLASH_USDC);
            uint256 v0 = _valueOf(attacker);
            (uint256 spent, uint256 bought) = _pushBps(attacker, WETH_POOL, WETH, pushes[k]);
            // Hold for one TWAP window; the outside market (the feeds) stays where it was.
            vm.warp(block.timestamp + TWAP_WINDOW);
            refreshFeeds();
            (SkipReason pr, StepOrder memory o) = rebalancer.previewOrder();
            (bool did,) = keeperStep();
            _sellExact(attacker, WETH_POOL, WETH, USDC, bought);
            Pnl memory r = _pnl(v0, nav0, honest, spent, did);
            string memory label = string.concat("A20 TWAP drag then sandwich, push +", vm.toString(pushes[k]), " bps");
            emit log_named_uint(string.concat(label, ": preview reason"), uint8(pr));
            emit log_named_uint(string.concat(label, ": TWAP vs feed (bps)"), _twapVsFeedBps(IDX_WETH));
            if (pr == SkipReason.None) {
                uint256 slip = rebalancer.assetStepParams(IDX_WETH).maxStepSlippageBps;
                emit log_named_uint(string.concat(label, ": step 3e minBuyOut (wei)"), o.minBuyOut);
                emit log_named_uint(
                    string.concat(label, ": step 3c TWAP-only floor (wei)"),
                    fund.assetTokenValue(IDX_WETH, o.notionalUsdc).mulDiv(BPS - slip, BPS)
                );
            }
            _report(label, r);
            if (r.attackerNet > best.attackerNet) best = r;
            vm.revertToState(snap);
        }
        _report("A20 TWAP drag then sandwich, best push", best);
        _g8OrFinding("A20 TWAP drag then sandwich", best);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A20: a budget halt forced by noise
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Each basket feed lags its pool by its deviation threshold, alternating above and below at each step
    ///         (zero-mean noise at the sim's thresholds). The plan buys 80 % basket from idle over one day. Does the
    ///         booking at the feeds (floored at 0 per step) halt it?
    function test_A20_noiseHalt_alternatingLagAtTheFeedThresholds() public fixtureCovered {
        _noiseRun(ETH_FEED_DEV_BPS, CBBTC_FEED_DEV_BPS, false, "A20 noise, alternating lag at the feed thresholds");
    }

    /// @notice The keeper steps only when each traded feed lags against the fund (below the pool for a purchase,
    ///         above for a sale) by its deviation threshold: the most a keeper's timing books with live feeds.
    function test_A20_noiseHalt_keeperTimesAdverseLag_atTheFeedThresholds() public fixtureCovered {
        _noiseRun(ETH_FEED_DEV_BPS, CBBTC_FEED_DEV_BPS, true, "A20 noise, keeper times adverse lag at the thresholds");
    }

    /// @notice The same at a 40 bps lag (inside `refBandBps`, and the most a purchase can book and still meet its
    ///         floor: slippage bound 50 less the 5 bps fee and impact). A gap this wide needs a feed that lags past its
    ///         own deviation threshold, or a TWAP that lags the pool.
    function test_A20_noiseHalt_keeperTimesAdverseLag_40bps() public fixtureCovered {
        _noiseRun(40, 40, true, "A20 noise, keeper times adverse lag of 40 bps");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Gas of one step (STEP_GAS_FLOOR)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice The step 3e step reads the feeds twice (Rebalancer and fund) and the held amounts twice. The costliest
    ///         step (two swaps, every asset held) must stay under half the Rebalancer's `STEP_GAS_FLOOR`, the
    ///         margin the scaffold's gas-starvation test asserts (Adversarial.t.sol).
    function test_3e_stepGas_underTheFloor() public fixtureCovered {
        _investAtEnd(assetVec(2_500, 2_500, 2_500, 2_500, 0));
        setTargetViaTimelock(assetVec(2_500, 2_500, 0, 5_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        vm.warp(fund.plan().endTime + rebalancer.effectiveStepInterval());
        _freshFeeds();
        (SkipReason r, StepOrder memory o) = rebalancer.previewOrder();
        assertEq(uint8(r), uint8(SkipReason.None), "a step is ready");
        assertEq(o.sellIndex, IDX_WETH, "sells wETH");
        assertEq(o.buyIndex, IDX_CBBTC, "buys cbBTC: two swaps, the costliest step");
        uint256 g = gasleft();
        (bool did,) = keeperStep();
        g -= gasleft();
        assertTrue(did, "traded");
        emit log_named_uint("sell leg", o.sellIndex);
        emit log_named_uint("buy leg", o.buyIndex);
        emit log_named_uint("gas of one basket-to-basket step (keeper call)", g);
        emit log_named_uint("STEP_GAS_FLOOR", rebalancer.STEP_GAS_FLOOR());
        assertLt(g, rebalancer.STEP_GAS_FLOOR() / 2, "under half of STEP_GAS_FLOOR");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: worlds
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Re-post every feed now and move each basket feed to its pool (a market that follows the fund's own
    ///      trades; see the contract note).
    function _freshFeeds() internal {
        refreshFeeds();
        alignFeedsToPools();
    }

    /// @dev The seed (100,000 USDC) is idle. A 1-day plan to (aave 15 %, moonwell 15 %, wETH 50 %, cbBTC 20 %); warp to
    ///      its end; fresh feeds. The next step buys 50,000 USDC of wETH with idle USDC.
    function _buyWethReady() internal returns (uint256 planId) {
        planId = setTargetViaTimelock(assetVec(1_500, 1_500, 5_000, 2_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        vm.warp(fund.plan().endTime);
        _freshFeeds();
        (SkipReason r, uint256 s, uint256 b,) = rebalancer.previewStep();
        assertEq(uint8(r), uint8(SkipReason.None), "setup: a step is ready");
        assertEq(s, IDLE_INDEX, "setup: sells idle");
        assertEq(b, IDX_WETH, "setup: buys wETH");
    }

    /// @dev Invest the seed at (aave 25 %, moonwell 25 %, wETH 50 %), then a plan to (aave 50 %, moonwell 30 %,
    ///      cbBTC 20 %): the next step sells wETH into Aave.
    function _sellWethReady() internal {
        _investAtEnd(assetVec(2_500, 2_500, 5_000, 0, 0));
        setTargetViaTimelock(assetVec(5_000, 3_000, 0, 2_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        vm.warp(fund.plan().endTime + rebalancer.effectiveStepInterval());
        _freshFeeds();
        (SkipReason r, uint256 s,,) = rebalancer.previewStep();
        assertEq(uint8(r), uint8(SkipReason.None), "setup: a step is ready");
        assertEq(s, IDX_WETH, "setup: sells wETH");
    }

    /// @dev Open a 1-day plan to `v`, warp to its end and step (fresh feeds before each step) until it is no longer
    ///      Open: a quick way to hold every asset.
    function _investAtEnd(uint16[5] memory v) internal {
        setTargetViaTimelock(v, PlanParams(1 days, COST_BUDGET_BPS));
        vm.warp(fund.plan().endTime);
        for (uint256 k; k < 16 && fund.planStatus() == PlanStatus.Open; ++k) {
            vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            _freshFeeds();
            keeperStep();
        }
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Converged), "setup: invested");
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        _freshFeeds();
        coverageCheckpoint();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: feeds
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Set basket asset `index`'s feed `bps` away from its pool's spot (positive: above), written now.
    function _setFeedOffsetBps(uint256 index, int256 bps) internal {
        (address pool, address token) = index == IDX_WETH ? (WETH_POOL, WETH) : (CBBTC_POOL, CBBTC);
        uint256 p = poolPrice8(pool, token);
        uint256 f = bps >= 0 ? p.mulDiv(BPS + uint256(bps), BPS) : p.mulDiv(BPS - uint256(-bps), BPS);
        setFeedPrice(index, f);
    }

    /// @dev The feed price of `index` in USDC per whole token, as `StepFeedLib` converts it (USDC / USD feed).
    function _feedPx(uint256 index) internal view returns (uint256) {
        (, int256 a,,,) = MockAggregator(fund.assetConfig(index).feed).latestRoundData();
        (, int256 u,,,) = MockAggregator(FEED_USDC).latestRoundData();
        return uint256(a).mulDiv(1e6, uint256(u));
    }

    /// @dev Check 4's deviation for `index` now, as `StepFeedLib` computes it (bps, rounded up).
    function _twapVsFeedBps(uint256 index) internal view returns (uint256) {
        uint256 unit = index == IDX_WETH ? 1e18 : 1e8;
        uint256 twap = fund.assetUsdcValue(index, unit);
        uint256 feed = _feedPx(index);
        return (twap > feed ? twap - feed : feed - twap).mulDiv(BPS, feed, Math.Rounding.Ceil);
    }

    /// @dev The step is ready; one feed check is broken. Asserts: the preview and `step()` skip `FeedCheck` with
    ///      the right event, nothing moves, nothing backs off; and the fund itself refuses the honest order with
    ///      `StepFeedCheckFailed(check, index, detail)`.
    function _assertFeedBlocked(StepFeedCheck check, uint256 index, uint256 detail) internal {
        _assertStepSkipsFeed(check, index, detail);
        _assertFundRefusesFeed(check, index, detail);
    }

    function _assertStepSkipsFeed(StepFeedCheck check, uint256 index, uint256 detail) internal {
        uint256 planId = fund.currentPlanId();
        (SkipReason pr,,,) = rebalancer.previewStep();
        assertEq(uint8(pr), uint8(SkipReason.FeedCheck), "preview: FeedCheck");
        (SkipReason por, StepOrder memory none) = rebalancer.previewOrder();
        assertEq(uint8(por), uint8(SkipReason.FeedCheck), "previewOrder: FeedCheck");
        assertEq(none.notionalUsdc, 0, "no order");

        (uint256 idle0, uint256[] memory held0) = fund.heldBalances();
        uint256 spent0 = fund.plan().costSpent;
        uint64 last0 = fund.lastStepAt();
        vm.expectEmit(true, false, false, true, address(rebalancer));
        emit Rebalancer.StepFeedBlocked(planId, check, index, detail);
        vm.expectEmit(true, false, false, true, address(rebalancer));
        emit IFundEvents.RebalanceStepSkipped(planId, SkipReason.FeedCheck, IDLE_INDEX, IDLE_INDEX, uint256(check));
        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "no trade");
        assertEq(uint8(why), uint8(SkipReason.FeedCheck), "FeedCheck");
        (uint256 idle1, uint256[] memory held1) = fund.heldBalances();
        assertEq(idle1, idle0, "idle untouched");
        for (uint256 i; i < held0.length; ++i) {
            assertEq(held1[i], held0[i], "no asset moved");
        }
        assertEq(fund.plan().costSpent, spent0, "nothing booked");
        assertEq(fund.lastStepAt(), last0, "no step recorded");
        assertEq(rebalancer.assetBackoffUntil(IDX_WETH), 0, "nothing backs off");
    }

    /// @dev Defence in depth: the fund refuses the step itself, whatever the order.
    function _assertFundRefusesFeed(StepFeedCheck check, uint256 index, uint256 detail) internal {
        StepOrder memory o = StepOrder(IDLE_INDEX, IDX_WETH, 10_000e6, 0, 0, 10_000e6 * MAX_STEP_COST_BPS / BPS);
        bytes memory want = abi.encodeWithSelector(IRobotMoneyFund.StepFeedCheckFailed.selector, check, index, detail);
        vm.prank(address(rebalancer));
        vm.expectRevert(want);
        fund.executeStep(o);
    }

    /// @dev The last `StepCostBooked` the fund emitted in the recorded logs.
    function _lastCostBooked() internal returns (uint256 fb, uint256 fa, uint256 feedCost, uint256 twapCost) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter != address(fund) || l.topics[0] != IRobotMoneyFund.StepCostBooked.selector) continue;
            (fb, fa, feedCost, twapCost) = abi.decode(l.data, (uint256, uint256, uint256, uint256));
            found = true;
            break;
        }
        assertTrue(found, "StepCostBooked emitted");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: the hostile venue
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Put `Step3eHostileSwapAdapter` over the harness swap adapter. Its TWAP reads go to a real copy.
    function _etchHostile(uint256 gift, address reenterFund, uint256 shares) internal {
        UniswapV3ExactOutSwapAdapter real = new UniswapV3ExactOutSwapAdapter(ROUTER);
        Step3eHostileSwapAdapter h =
            new Step3eHostileSwapAdapter(ROUTER, address(real), CBBTC, gift, reenterFund, shares);
        vm.etch(address(swapAdapter), address(h).code);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: A20 sandwich
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev The honest step from this state (a snapshot), then each push size from the same state.
    function _sandwich(bool purchase, string memory id) internal {
        uint256 honest = _honestLoss();
        int256[6] memory pushes = [int256(10), int256(20), int256(30), int256(40), int256(45), int256(60)];
        Pnl memory best;
        best.attackerNet = type(int256).min;
        for (uint256 k; k < pushes.length; ++k) {
            uint256 snap = vm.snapshotState();
            _setRef();
            uint256 nav0 = _navRef();
            fundUsdc(attacker, FLASH_USDC);
            if (!purchase) deal(WETH, attacker, 1_000e18);
            uint256 v0 = _valueOf(attacker);
            int256 push = purchase ? pushes[k] : -pushes[k];
            (uint256 spent, uint256 got) = _pushBps(attacker, WETH_POOL, WETH, push);
            (bool did,) = keeperStep();
            if (purchase) _sellExact(attacker, WETH_POOL, WETH, USDC, got);
            else _sellExact(attacker, WETH_POOL, USDC, WETH, got);
            uint256 borrowedUsdc = purchase ? spent : spent.mulDiv(refWeth, 1e18);
            Pnl memory r = _pnl(v0, nav0, honest, borrowedUsdc, did);
            _report(string.concat(id, ", push ", vm.toString(pushes[k]), " bps"), r);
            if (r.attackerNet > best.attackerNet) best = r;
            vm.revertToState(snap);
        }
        _report(string.concat(id, ", best push"), best);
        _g8OrFinding(id, best);
    }

    /// @dev The holders' loss of the honest step from this state, at reference prices (rolled back).
    function _honestLoss() internal returns (uint256 loss) {
        uint256 snap = vm.snapshotState();
        _setRef();
        uint256 nav0 = _navRef();
        (bool did,) = keeperStep();
        assertTrue(did, "the honest step trades");
        uint256 nav1 = _navRef();
        loss = nav0 > nav1 ? nav0 - nav1 : 0;
        emit log_named_uint("honest step: holders' cost at reference prices", loss);
        vm.revertToState(snap);
    }

    function _pnl(uint256 v0, uint256 nav0, uint256 honest, uint256 borrowedUsdc, bool did)
        internal
        view
        returns (Pnl memory r)
    {
        r.attackerNet = int256(_valueOf(attacker)) - int256(v0);
        r.borrowed = borrowedUsdc;
        uint256 nav1 = _navRef();
        r.holdersLoss = nav0 > nav1 ? nav0 - nav1 : 0;
        r.extraLoss = r.holdersLoss > honest ? r.holdersLoss - honest : 0;
        r.navRef = nav0;
        r.stepped = did;
    }

    function _report(string memory id, Pnl memory r) internal {
        int256 aave = r.attackerNet - int256(r.borrowed.mulDiv(AAVE_FLASH_FEE_BPS, BPS));
        emit log_named_string("attack", id);
        emit log_named_string("  the step traded", r.stepped ? "yes" : "no");
        emit log_named_int("  attacker net (flash fee 0, Morpho)", r.attackerNet);
        emit log_named_int("  attacker net (flash fee 5 bps, Aave V3)", aave);
        emit log_named_uint("  flash borrowed", r.borrowed);
        emit log_named_uint("  holders' loss at reference prices", r.holdersLoss);
        emit log_named_uint("  holders' loss beyond the honest step", r.extraLoss);
        emit log_named_uint("  holders' loss beyond the honest step, bps of NAV x100", r.extraLoss * BPS * 100 / r.navRef);
        emit log_named_uint("  NAV at reference prices", r.navRef);
        emit log_named_string(
            "G8",
            string.concat(
                id,
                ",",
                vm.toString(r.attackerNet),
                ",",
                vm.toString(aave),
                ",",
                vm.toString(r.borrowed),
                ",",
                vm.toString(r.extraLoss),
                ",0,",
                vm.toString(r.navRef)
            )
        );
    }

    /// @dev G8 (proposal §13), both clauses: the attacker's net is at most zero, and the holders lose at most 1 bps of
    ///      NAV beyond the honest step's own cost. Unlike a flow (where Attacks.t.sol hard-asserts the holders' bound,
    ///      because the design says holders never lose to a flow), a step's cost is the holders' by design (§5.7), and
    ///      the step's own slippage bound is what a keeper's sandwich can take. So BOTH clauses are scored as a design
    ///      finding: logged `G8 FINDING` with the numbers and skipped (PROTO_ATTACK_FINDINGS_FAIL=1 makes it fail),
    ///      as the scaffold scores design findings. Nothing is loosened: either clause failing is a G8 fail.
    function _g8OrFinding(string memory id, Pnl memory r) internal {
        bool holders = r.extraLoss > r.navRef.mulDiv(G8_HOLDER_LOSS_BPS, BPS);
        if (r.attackerNet <= 0 && !holders) return;
        _finding(
            string.concat(
                id,
                ": G8 FAIL (design finding), attacker net ",
                vm.toString(r.attackerNet),
                ", holders' loss beyond the honest step ",
                vm.toString(r.extraLoss),
                " USDC units (",
                vm.toString(r.extraLoss * BPS * 100 / r.navRef),
                " hundredths of a bps of NAV; G8 allows 100)"
            )
        );
    }

    function _finding(string memory why) internal {
        emit log_named_string("G8 FINDING", why);
        if (vm.envOr("PROTO_ATTACK_FINDINGS_FAIL", false)) revert(why);
        _skipCovered(why);
    }

    /// @dev Reference prices: each pool's spot now.
    function _setRef() internal {
        refWeth = poolPrice8(WETH_POOL, WETH) / 100;
        refCbbtc = poolPrice8(CBBTC_POOL, CBBTC) / 100;
    }

    /// @dev NAV at reference prices: idle, the lending holders' parts, each basket token at its reference.
    function _navRef() internal view returns (uint256 nav) {
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        nav = idle;
        for (uint256 i; i < held.length; ++i) {
            if (i == IDX_WETH) nav += held[i].mulDiv(refWeth, 1e18);
            else if (i == IDX_CBBTC) nav += held[i].mulDiv(refCbbtc, 1e8);
            else nav += held[i];
        }
    }

    function _valueOf(address who) internal view returns (uint256) {
        return IERC20(USDC).balanceOf(who) + IERC20(WETH).balanceOf(who).mulDiv(refWeth, 1e18)
            + IERC20(CBBTC).balanceOf(who).mulDiv(refCbbtc, 1e8);
    }

    /// @dev `who` moves `token`'s USDC price at `pool` by `bps` (positive: buys the token) through SwapRouter02 with a
    ///      price limit, so the pool stops at the target. Returns the input spent and the output received.
    function _pushBps(address who, address pool, address token, int256 bps)
        internal
        returns (uint256 spent, uint256 got)
    {
        uint160 target = _pushTarget(pool, token, bps);
        (address tokenIn, address tokenOut) = bps > 0 ? (USDC, token) : (token, USDC);
        uint256 inBefore = IERC20(tokenIn).balanceOf(who);
        uint256 outBefore = IERC20(tokenOut).balanceOf(who);
        vm.startPrank(who);
        IERC20(tokenIn).approve(ROUTER, inBefore);
        IHarnessSwapRouter02(ROUTER).exactInputSingle(
            IHarnessSwapRouter02.ExactInputSingleParams(
                tokenIn, tokenOut, IHarnessV3Pool(pool).fee(), who, inBefore, 0, target
            )
        );
        IERC20(tokenIn).approve(ROUTER, 0);
        vm.stopPrank();
        spent = inBefore - IERC20(tokenIn).balanceOf(who);
        got = IERC20(tokenOut).balanceOf(who) - outBefore;
    }

    /// @dev The sqrt price that moves `token`'s USDC price at `pool` by `bps`.
    function _pushTarget(address pool, address token, int256 bps) internal view returns (uint160) {
        IHarnessV3Pool p = IHarnessV3Pool(pool);
        (uint160 sqrtP,,,,,,) = p.slot0();
        uint256 a = bps > 0 ? uint256(bps) : uint256(-bps);
        uint256 sqrtF = Math.sqrt((bps > 0 ? BPS + a : BPS - a) * 1e36 / BPS);
        return p.token0() == token
            ? uint160(uint256(sqrtP).mulDiv(sqrtF, 1e18))
            : uint160(uint256(sqrtP).mulDiv(1e18, sqrtF));
    }

    /// @dev `who` sells exactly `amountIn` of `tokenIn` for `tokenOut` at `pool` (the unwind of a push).
    function _sellExact(address who, address pool, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (uint256 got)
    {
        if (amountIn == 0) return 0;
        vm.startPrank(who);
        IERC20(tokenIn).approve(ROUTER, amountIn);
        got = IHarnessSwapRouter02(ROUTER).exactInputSingle(
            IHarnessSwapRouter02.ExactInputSingleParams(
                tokenIn, tokenOut, IHarnessV3Pool(pool).fee(), who, amountIn, 0, 0
            )
        );
        vm.stopPrank();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: A20 noise
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Totals of one noise run.
    struct Noise {
        uint256 calls;
        uint256 executed;
        uint256 failed;
        uint256 feedSkips;
        uint256 booked;
        uint256 twapCost;
        int256 signedFeed;
        uint256 maxStepBooked;
        uint256 haltedAtCall;
    }

    /// @dev A 1-day plan from the idle seed to (aave 10 %, moonwell 10 %, wETH 40 %, cbBTC 40 %), stepped by the
    ///      keeper every `effectiveStepInterval` until it is no longer Open. Before each step every feed is re-posted
    ///      at its pool, then each basket feed is set `devWeth` / `devCbbtc` bps off it: alternating in sign at each
    ///      call (`adverse` false), or against the fund on the step's own basket legs (below the pool for a purchase,
    ///      above for a sale; `adverse` true). Logs the plan's booked cost against its budget and turnover, the TWAP
    ///      cost and the signed cost at the feeds (what a booking that nets gains against losses would hold).
    function _noiseRun(uint256 devWeth, uint256 devCbbtc, bool adverse, string memory id) internal {
        setTargetViaTimelock(assetVec(1_000, 1_000, 4_000, 4_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        Noise memory z;
        while (z.calls < 160 && fund.planStatus() == PlanStatus.Open) {
            vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            _freshFeeds();
            (SkipReason pr, StepOrder memory o) = rebalancer.previewOrder();
            int256 sw = adverse ? _adverseSign(o, IDX_WETH, pr) : (z.calls % 2 == 0 ? int256(1) : int256(-1));
            int256 sc = adverse ? _adverseSign(o, IDX_CBBTC, pr) : sw;
            if (sw != 0) _setFeedOffsetBps(IDX_WETH, sw * int256(devWeth));
            if (sc != 0) _setFeedOffsetBps(IDX_CBBTC, sc * int256(devCbbtc));
            vm.recordLogs();
            (bool did, SkipReason why) = keeperStep();
            ++z.calls;
            if (did) {
                ++z.executed;
                (uint256 fb, uint256 fa, uint256 feedCost, uint256 twapCost) = _lastCostBooked();
                z.booked += feedCost;
                z.twapCost += twapCost;
                z.signedFeed += int256(fb) - int256(fa);
                if (feedCost > z.maxStepBooked) z.maxStepBooked = feedCost;
                assertLe(feedCost, o.maxCostUsdc, "each booked step is within its cap");
            } else if (why == SkipReason.StepFailed) {
                ++z.failed;
            } else if (why == SkipReason.FeedCheck) {
                ++z.feedSkips;
            }
            if (fund.planStatus() == PlanStatus.Halted && z.haltedAtCall == 0) z.haltedAtCall = z.calls;
            if (z.calls % 16 == 0) coverageCheckpoint();
        }
        _noiseReport(id, z);
        assertEq(fund.plan().costSpent, z.booked, "costSpent = the sum of the booked step costs");
        if (z.haltedAtCall != 0) {
            _finding(
                string.concat(
                    id,
                    ": G3/G5 FINDING, the plan halted on its budget at call ",
                    vm.toString(z.haltedAtCall),
                    " (booked ",
                    vm.toString(z.booked),
                    ", TWAP cost ",
                    vm.toString(z.twapCost),
                    ", signed feed cost ",
                    vm.toString(z.signedFeed),
                    ", budget ",
                    vm.toString(fund.plan().costBudget),
                    " USDC units)"
                )
            );
        }
    }

    /// @dev The sign of the feed lag that books the most cost on basket asset `i` for order `o`: below the pool when
    ///      the step buys `i`, above when it sells `i`, none otherwise.
    function _adverseSign(StepOrder memory o, uint256 i, SkipReason pr) internal pure returns (int256) {
        if (pr != SkipReason.None) return 0;
        if (o.buyIndex == i) return -1;
        if (o.sellIndex == i) return 1;
        return 0;
    }

    function _noiseReport(string memory id, Noise memory z) internal {
        uint256 turnover = fund.plan().turnoverUsdc;
        emit log_named_string("noise run", id);
        emit log_named_uint("  plan status (1 Open, 2 Converged, 3 Halted, 6 Expired)", uint8(fund.planStatus()));
        emit log_named_uint("  halted at keeper call (0 = never)", z.haltedAtCall);
        emit log_named_uint("  keeper calls", z.calls);
        emit log_named_uint("  steps executed", z.executed);
        emit log_named_uint("  steps failed (StepFailed)", z.failed);
        emit log_named_uint("  steps skipped by the feed checks", z.feedSkips);
        emit log_named_uint("  turnover (USDC units)", turnover);
        emit log_named_uint("  budget (USDC units)", fund.plan().costBudget);
        emit log_named_uint("  booked at the feeds, floored per step (costSpent)", z.booked);
        emit log_named_uint("  booked, bps of turnover x100", z.booked * BPS * 100 / turnover);
        emit log_named_uint("  TWAP cost sum (step 3c booking)", z.twapCost);
        emit log_named_uint("  TWAP cost, bps of turnover x100", z.twapCost * BPS * 100 / turnover);
        emit log_named_int("  signed cost at the feeds (gains net losses)", z.signedFeed);
        emit log_named_int("  signed cost, bps of turnover x100", z.signedFeed * int256(BPS) * 100 / int256(turnover));
        emit log_named_uint("  largest booked step", z.maxStepBooked);
    }
}

/// @title Step3eNoQueueTest
/// @notice The fund with no FlowQueue bound: the sequencer feed, the USDC feed and `refBandBps` are unknown, so a step
///         fails closed (`StepFeedCheck.NoQueue`) in the Rebalancer and inside the fund.
contract Step3eNoQueueTest is PrototypeHarness {
    function _bindQueueAtSetUp() internal pure override returns (bool) {
        return false;
    }

    function test_RB19_feedCheck_noQueueBound_failsClosed() public fixtureCovered {
        setTargetViaTimelock(assetVec(1_500, 1_500, 5_000, 2_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        vm.warp(fund.plan().endTime);
        refreshFeeds();
        (SkipReason pr,,,) = rebalancer.previewStep();
        assertEq(uint8(pr), uint8(SkipReason.FeedCheck), "preview: FeedCheck");
        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "no trade");
        assertEq(uint8(why), uint8(SkipReason.FeedCheck), "FeedCheck");
        StepOrder memory o = StepOrder(IDLE_INDEX, IDX_WETH, 10_000e6, 0, 0, 10_000e6 * MAX_STEP_COST_BPS / BPS);
        vm.prank(address(rebalancer));
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.StepFeedCheckFailed.selector, StepFeedCheck.NoQueue, IDLE_INDEX, 0)
        );
        fund.executeStep(o);
    }
}
