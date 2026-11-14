// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.5 rule 3 (time-weighted depth), §5.3 (one step),
//            §5.5 (plan states), §5.6 (governed parameters), §14 (adversarial code review of 2026-11-12)
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {PrototypeHarness} from "./PrototypeHarness.sol";
import {PlanParams, PlanStatus, SkipReason, IDLE_INDEX} from "./src/FundTypes.sol";
import {IObservablePool} from "../../interfaces/IObservablePool.sol";
import {FundValuationLib} from "./src/lib/FundValuationLib.sol";
import {FlowQueueFixesBase} from "./FlowQueueFixes.t.sol";
import {FlowLevers, FlowParams, IFlowEvents} from "./src/FlowTypes.sol";
import {ILendingRateAdapter} from "./src/interfaces/IFlowAdapters.sol";

/// @title ReviewFixesRebalancerTest
/// @notice One test per error the adversarial review of 2026-11-12 found in the rebalancer, each failing on the code
///         before its fix (logs in the evidence folder named in proposal §14).
contract ReviewFixesRebalancerTest is PrototypeHarness {
    /// @notice R-F1: a basket asset whose step cap is below `minStepUsdc` (here: its depth cannot be read) must not
    ///         become a leg that can only skip `BelowMinStep`; the next asset behind it trades.
    function test_RF1_aDepthCappedAssetIsMaskedAndTheRestOfThePlanTrades() public fixtureCovered {
        setTargetViaTimelock(
            assetVec(1_500, 1_500, 5_000, 2_000, 0), PlanParams(1 days, COST_BUDGET_BPS)
        );
        _depthUnreadable(WETH_POOL);
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        refreshFeeds();
        (SkipReason r,, uint256 b,) = rebalancer.previewStep();
        assertEq(uint8(r), uint8(SkipReason.None), "a step is ready");
        assertTrue(b != IDX_WETH, "wETH (cap 0) is not a leg");
        (bool did,) = keeperStep();
        assertTrue(did, "the plan trades another asset");
    }

    /// @notice R-F1: with every remaining pair masked by its cap the skip names the reason (`DepthCap`).
    function test_RF1_onlyDepthCappedAssetsLeftSkipsDepthCap() public fixtureCovered {
        setTargetViaTimelock(assetVec(5_000, 0, 5_000, 0, 0), PlanParams(1 days, COST_BUDGET_BPS));
        _depthUnreadable(WETH_POOL);
        // Aave follows its path; once it is at its end only idle → wETH is left, and wETH is masked.
        SkipReason why;
        uint256 s;
        uint256 b;
        for (uint256 k; k < 80; ++k) {
            vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            refreshFeeds();
            (why, s, b,) = rebalancer.previewStep();
            if (why == SkipReason.DepthCap || block.timestamp > fund.plan().endTime + 2 hours) {
                break;
            }
            if (why == SkipReason.None) keeperStep();
            if (k % 8 == 7) coverageCheckpoint();
        }
        assertEq(
            uint8(why),
            uint8(SkipReason.DepthCap),
            "only wETH is under target, and it is depth capped"
        );
        assertEq(s, IDLE_INDEX, "no leg");
        assertEq(b, IDLE_INDEX, "no leg");
    }

    /// @notice R-F4: a proxy upgraded from an implementation without the depth slot reads 0 there; the cap must
    ///         still be the default, never off or zero.
    function test_RF4_anUnsetDepthSlotReadsAsTheDefault() public fixtureCovered {
        uint256 capBefore = rebalancer.assetStepCap(IDX_WETH);
        vm.store(address(rebalancer), bytes32(uint256(4)), bytes32(0));
        assertEq(rebalancer.stepDepthBps(), 5, "the default");
        assertEq(
            rebalancer.assetStepCap(IDX_WETH), capBefore, "the same cap as the initialized default"
        );
        assertGt(capBefore, 0, "non-zero");
    }

    /// @notice R-F5: a plan that sits inside tolerance of its end is Converged, even when the first call after it
    ///         lands past `endTime + maxOverrun`.
    function test_RF5_aConvergedPlanIsNotLabelledExpiredAtTheOverrunEdge() public fixtureCovered {
        uint16[5] memory v = assetVec(1_500, 1_500, 5_000, 2_000, 0);
        investFund(v);
        assertEq(
            uint8(fund.planStatus()), uint8(PlanStatus.Converged), "setup: the first plan converged"
        );
        setTargetViaTimelock(v, PlanParams(1 days, COST_BUDGET_BPS));
        vm.warp(uint256(fund.plan().endTime) + MAX_OVERRUN + 1);
        refreshFeeds();
        keeperStep();
        assertEq(
            uint8(fund.planStatus()),
            uint8(PlanStatus.Converged),
            "within tolerance: Converged, not Expired"
        );
    }

    /// @dev Make every depth read of `pool` revert (both the 2-point read of the code before the R-F2 fix and the
    ///      13-point read after it), leaving its TWAP reads (a 30-minute window) untouched.
    function _depthUnreadable(address pool) private {
        uint32 w = queue.flowParams().settleWindow;
        uint32[] memory two = new uint32[](2);
        two[0] = w;
        vm.mockCallRevert(pool, abi.encodeCall(IObservablePool.observe, (two)), "no history");
        uint32[] memory thirteen = new uint32[](13);
        for (uint256 j; j < 12; ++j) {
            thirteen[j] = w - uint32(j) * (w / 12);
        }
        vm.mockCallRevert(pool, abi.encodeCall(IObservablePool.observe, (thirteen)), "no history");
    }
}

/// @notice A pool whose in-range liquidity is `L` except for one stretch `[thinFrom, thinTo)` (seconds before now) at
///         liquidity 1, the way Uniswap V3 accumulates `secondsPerLiquidity` (`dt × 2^128 / max(1, L)`). Constant
///         tick 0.
contract ThinStretchPool {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable L;
    uint32 public immutable thinFrom;
    uint32 public immutable thinTo;

    constructor(address t0, address t1, uint256 l, uint32 from, uint32 to) {
        (token0, token1, L, thinFrom, thinTo) = (t0, t1, l, from, to);
    }

    /// @dev Cumulative at `a` seconds ago, counted from a reference point 1 day ago.
    function _spl(uint32 a) private view returns (uint160) {
        uint256 day = 1 days;
        uint256 thickSecs;
        uint256 thinSecs;
        // Seconds from 1 day ago to `a` ago, split into the thin stretch and the rest.
        uint256 thinStart = day - thinFrom; // seconds after the reference point
        uint256 thinEnd = day - thinTo;
        uint256 x = day - a;
        uint256 thinUpTo = x < thinStart ? 0 : (x < thinEnd ? x - thinStart : thinEnd - thinStart);
        thinSecs = thinUpTo;
        thickSecs = x - thinSecs;
        return uint160((thickSecs << 128) / L + (thinSecs << 128));
    }

    function observe(uint32[] calldata ago)
        external
        view
        returns (int56[] memory tc, uint160[] memory spl)
    {
        tc = new int56[](ago.length);
        spl = new uint160[](ago.length);
        for (uint256 i; i < ago.length; ++i) {
            spl[i] = _spl(ago[i]);
        }
    }
}

/// @title ReviewFixesDepthTest
/// @notice R-F2: a few seconds of near-zero in-range liquidity must not drive the depth (and every cap read from it)
///         to about 0 for a whole window; thinning held through a full slice still lowers it (the read stays
///         conservative).
contract ReviewFixesDepthTest is Test {
    address internal constant TOKEN = address(0xBEEF);
    address internal constant USDC_ = address(0xCAFE);
    uint256 internal constant L = 1e18;

    function setUp() public {
        vm.warp(10 days);
    }

    function test_RF2_twoSecondsOfThinLiquidityDoNotZeroTheDepth() public {
        // Two seconds at liquidity 1, straddling a slice boundary (1,800 s ago), inside a one-hour window.
        ThinStretchPool pool = new ThinStretchPool(TOKEN, USDC_, L, 1_801, 1_799);
        (bool ok, uint256 depth) = FundValuationLib.poolUsdcDepth(address(pool), USDC_, 1 hours);
        assertTrue(ok, "readable");
        assertApproxEqRel(depth, L, 1e15, "the depth stays at the pool's real liquidity");
    }

    function test_RF2_thinningHeldThroughASliceStillLowersTheDepth() public {
        // Fifteen minutes at liquidity 1: three full slices of five minutes.
        ThinStretchPool pool = new ThinStretchPool(TOKEN, USDC_, L, 2_700, 1_800);
        (bool ok, uint256 depth) = FundValuationLib.poolUsdcDepth(address(pool), USDC_, 1 hours);
        assertTrue(ok, "readable");
        assertLt(depth, 10, "held thinning lowers it (conservative)");
    }
}

/// @title ReviewFixesQueueTest
/// @notice One test per error the adversarial review of 2026-11-12 found in the queue, each failing on the code before
///         its fix.
contract ReviewFixesQueueTest is FlowQueueFixesBase {
    /// @dev Invested fund, bob a holder, a settlement as the reference, then bob's redemption request.
    function _redemptionAfterAReference() private returns (uint256 red) {
        _invest();
        uint256 bobShares = _holder(bob, 50_000e6);
        uint256 c = openDepositRequest(carol, 1_000e6, type(uint256).max);
        settleUntilFilled(c);
        red = openRedeemRequest(bob, bobShares / 2, 0);
    }

    /// @notice Q-F1: an excluded lending venue whose rate read fails does not hold the settlement (E13: redemptions
    ///         settle alone during an exclusion). Before the fix check 5 read every active venue: `LendRate`.
    function test_QF1_anExcludedVenueWithAFailingRateDoesNotHoldRedemptions()
        public
        fixtureCovered
    {
        uint256 red = _redemptionAfterAReference();
        timelockExecute(
            address(fund),
            abi.encodeCall(
                fund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, false)
            )
        );
        assertGt(fund.openExclusionOf(IDX_MOONWELL), 0, "Moonwell excluded");
        vm.mockCallRevert(
            address(moonwellAdapter), abi.encodeCall(ILendingRateAdapter.ratePerUnit, ()), "revoked"
        );
        warpToSettleable(red);
        refreshFeeds();
        (bool ok, bytes memory ret) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        if (!ok) emit log_named_bytes("settle reverted with", ret);
        assertTrue(ok, "check 5 skips the excluded venue");
        assertTrue(queue.getRequest(red).closed, "the redemption settled");
    }

    /// @notice Q-F2: a small call first in a block takes only its own part of the block's room; the keeper's call in
    ///         the same block still fills. Before the fix any trading call zeroed the block's room.
    function test_QF2_aSmallCallDoesNotTakeTheWholeBlocksRoom() public fixtureCovered {
        _invest();
        uint256 a = openDepositRequest(alice, 2_000e6, type(uint256).max);
        uint256 b = openDepositRequest(bob, 2_000e6, type(uint256).max);
        warpToSettleable(b);
        refreshFeeds();
        vm.roll(block.number + 1);
        vm.prank(keeper);
        assertGt(queue.settle(1, type(uint256).max), 0, "the first call fills alice");
        assertTrue(queue.getRequest(a).closed, "alice filled");
        vm.prank(keeper);
        uint256 id = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertGt(id, 0, "the same block still has room for bob");
        assertTrue(queue.getRequest(b).closed, "bob filled");
    }

    /// @notice Q-F3: a revoke then a re-allow of a lending venue between two settlements (the restore drains it
    ///         into its record) does not trip the share-price breaker. Before the fix the mask was the same at both
    ///         ends, nothing was re-based, and check 6 held both sides.
    function test_QF3_aRevokeThenReallowBetweenSettlementsDoesNotTripTheBreaker()
        public
        fixtureCovered
    {
        uint256 red = _redemptionAfterAReference();
        bytes32 h = address(moonwellAdapter).codehash;
        timelockExecute(address(fund), abi.encodeCall(fund.setAdapterCodeHashAllowed, (h, false)));
        timelockExecute(address(fund), abi.encodeCall(fund.setAdapterCodeHashAllowed, (h, true)));
        assertEq(fund.openExclusionOf(IDX_MOONWELL), 0, "the record cycled and closed");
        warpToSettleable(red);
        refreshFeeds();
        (bool ok, bytes memory ret) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        if (!ok) emit log_named_bytes("settle reverted with", ret);
        assertTrue(ok, "check 6 re-bases the cycled venue");
        assertTrue(queue.getRequest(red).closed, "the redemption settled");
    }

    /// @notice Q-F4: an allowed early return does not outlive a freeze that ran out by itself (RB-11).
    function test_QF4_anAllowedReturnEndsWithTheFreeze() public fixtureCovered {
        FlowParams memory p = queue.flowParams();
        p.maxFreeze = 1 hours;
        _setParams(p);
        uint256 id = openDepositRequest(alice, 5_000e6, type(uint256).max);
        warpToSettleable(id);
        refreshFeeds();
        uint256 sid = _keeperSettle();
        uint256 claimId = queue.claimCount();
        vm.prank(emergency);
        queue.freezeSettlement(sid);
        timelockExecute(address(queue), abi.encodeCall(queue.allowReturn, (sid)));
        vm.warp(queue.getSettlement(sid).frozenUntil + 1);
        assertLt(block.timestamp, queue.getSettlement(sid).holdEndsAt, "still inside the hold");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.ReturnNotAllowed.selector, sid));
        queue.takeReturn(claimId);
    }

    /// @notice Q-F5: a per-call basket cap below the minimum fill holds every request; the call says so.
    function test_QF5_aCallCapBelowTheMinimumFillIsVisible() public fixtureCovered {
        _invest();
        timelockExecute(address(queue), abi.encodeCall(queue.setFlowLevers, (FlowLevers(1, 0))));
        FlowParams memory p = queue.flowParams();
        p.minRequestUsdc = 1_000_000e6;
        _setParams(p);
        uint256 id = openDepositRequest(alice, 1_000_000e6, type(uint256).max);
        warpToSettleable(id);
        refreshFeeds();
        vm.roll(block.number + 1);
        vm.expectEmit(false, false, false, false, address(queue));
        emit IFlowEvents.SettleCallRoomBelowMinimum(0, 0);
        vm.prank(keeper);
        assertEq(queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max), 0, "nothing filled");
    }
}
