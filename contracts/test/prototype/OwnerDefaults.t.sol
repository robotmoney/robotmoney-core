// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.6 (governed parameters), §5.9.5 (flow working
//            defaults), §5.10 (step 3e), §14 (owner defaults of 2026-11-12: the 5 bps per-call basket cap,
//            `refBandBps` 90, each basket asset's step cap from 5 bps of time-weighted in-range liquidity)
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PrototypeHarness} from "./PrototypeHarness.sol";
import {
    IFundEvents,
    PlanParams,
    PlanStatus,
    SkipReason,
    BPS,
    IDLE_INDEX,
    DEFAULT_STEP_DEPTH_BPS,
    MAX_STEP_DEPTH_BPS
} from "./src/FundTypes.sol";
import {FlowLevers, DEFAULT_BASKET_CALL_BPS, LEG_PRICE_STRICTER} from "./src/FlowTypes.sol";
import {FundValuationLib} from "./src/lib/FundValuationLib.sol";

/// @title OwnerDefaultsTest
/// @notice The owner's decided defaults of 2026-11-12 are what a freshly deployed fund runs with, not an opt-in:
///         - the queue starts with the 5 bps per-call basket cap and stricter-of-both leg prices (`initialize`);
///         - the working flow parameters carry `refBandBps` 90;
///         - the rebalancer caps each basket leg at 5 bps of its pool's time-weighted USDC depth over one
///           settlement window, beside the governed `maxStepUsdc`, and the cap cannot be switched off.
contract OwnerDefaultsTest is PrototypeHarness {
    function test_defaults_queueStartsWithTheFiveBpsCallCap() public fixtureCovered {
        FlowLevers memory l = queue.flowLevers();
        assertEq(l.basketCallBps, DEFAULT_BASKET_CALL_BPS, "per-call basket cap from initialize");
        assertEq(DEFAULT_BASKET_CALL_BPS, 5, "the decided value");
        assertEq(l.legPriceMode, LEG_PRICE_STRICTER, "limits from the stricter of TWAP and feed");
    }

    function test_defaults_refBandIs90() public fixtureCovered {
        assertEq(queue.flowParams().refBandBps, 90, "refBandBps working default");
    }

    function test_defaults_rebalancerStartsWithTheFiveBpsDepthCap() public fixtureCovered {
        assertEq(rebalancer.stepDepthBps(), DEFAULT_STEP_DEPTH_BPS, "depth cap from initialize");
        assertEq(DEFAULT_STEP_DEPTH_BPS, 5, "the decided value");
    }

    /// @notice A basket asset's cap is the smaller of its `maxStepUsdc` and 5 bps of its pool's USDC depth over one
    ///         settlement window; a lending asset keeps its `maxStepUsdc`.
    function test_defaults_assetStepCapIsTheSmallerOfMaxStepAndDepth() public fixtureCovered {
        uint32 w = queue.flowParams().settleWindow;
        _assertCap(IDX_WETH, WETH_POOL, w);
        _assertCap(IDX_CBBTC, CBBTC_POOL, w);
        assertEq(rebalancer.assetStepCap(IDX_AAVE), LENDING_MAX_STEP_USDC, "lending: maxStepUsdc only");
    }

    /// @notice The setter refuses 0 (the cap cannot be switched off) and anything above `MAX_STEP_DEPTH_BPS`, and
    ///         only ADMIN (the timelock) may call it.
    function test_defaults_stepDepthSetterBounds() public fixtureCovered {
        vm.prank(address(timelock));
        vm.expectRevert(IFundEvents.StepParamOutOfBounds.selector);
        rebalancer.setStepDepthBps(0);
        vm.prank(address(timelock));
        vm.expectRevert(IFundEvents.StepParamOutOfBounds.selector);
        rebalancer.setStepDepthBps(MAX_STEP_DEPTH_BPS + 1);
        vm.expectRevert();
        rebalancer.setStepDepthBps(10);
        vm.prank(address(timelock));
        rebalancer.setStepDepthBps(10);
        assertEq(rebalancer.stepDepthBps(), 10, "set by the timelock");
    }

    /// @notice Every executed step of an investing plan stays inside the depth cap of each basket leg it trades.
    function test_defaults_everyStepStaysInsideTheDepthCap() public fixtureCovered {
        // A fund of about 200,000 USDC: half of it in wETH is several depth caps wide.
        deposit(makeAddr("alice"), 200_000e6);
        setTargetViaTimelock(assetVec(1_500, 1_500, 5_000, 2_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        uint256 executed;
        uint256 bound;
        for (uint256 k; k < 120 && fund.planStatus() == PlanStatus.Open; ++k) {
            vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            refreshFeeds();
            (SkipReason r, uint256 s, uint256 b, uint256 notional) = rebalancer.previewStep();
            if (r == SkipReason.None) {
                uint256 cap = type(uint256).max;
                if (s != IDLE_INDEX && isBasketIndex(s)) cap = Math.min(cap, rebalancer.assetStepCap(s));
                if (b != IDLE_INDEX && isBasketIndex(b)) cap = Math.min(cap, rebalancer.assetStepCap(b));
                assertLe(notional, cap, "notional inside the leg's depth cap");
                if (notional == cap) ++bound;
            }
            (bool did,) = keeperStep();
            if (did) ++executed;
            if (k % 8 == 7) coverageCheckpoint();
        }
        assertGt(executed, 0, "the plan traded");
        assertGt(bound, 0, "the depth cap bound at least one step (non-vacuous)");
        emit log_named_uint("executed steps", executed);
        emit log_named_uint("steps sized by the depth cap", bound);
    }

    function _assertCap(uint256 index, address pool, uint32 w) private {
        (bool ok, uint256 depth) = FundValuationLib.poolUsdcDepth(pool, USDC, w);
        assertTrue(ok, "depth readable at the pin");
        uint256 want = Math.min(uint256(MAJOR_MAX_STEP_USDC), Math.mulDiv(depth, DEFAULT_STEP_DEPTH_BPS, BPS));
        assertEq(rebalancer.assetStepCap(index), want, "cap = min(maxStepUsdc, 5 bps of depth)");
        emit log_named_uint("pool USDC depth", depth);
        emit log_named_uint("step cap", want);
    }
}
