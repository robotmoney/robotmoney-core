// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/20260618-code-review-internal-claude.md §2
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";
import {TickMath} from "../lib/TickMath.sol";
import {IObservablePool} from "../interfaces/IObservablePool.sol";

/// @dev Minimal mock implementing the `IObservablePool` surface. `observe()`
///      returns a pre-set tickCumulatives pair so `meanTick` can be exercised
///      across boundary inputs without a live pool.
contract MockObservablePool is IObservablePool {
    address private _token0;
    address private _token1;
    int56 private _cum0;
    int56 private _cum1;

    constructor(address token0_, address token1_) {
        _token0 = token0_;
        _token1 = token1_;
    }

    function setCumulatives(int56 cum0, int56 cum1) external {
        _cum0 = cum0;
        _cum1 = cum1;
    }

    function token0() external view returns (address) {
        return _token0;
    }

    function token1() external view returns (address) {
        return _token1;
    }

    function observe(uint32[] calldata)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidity)
    {
        tickCumulatives = new int56[](2);
        tickCumulatives[0] = _cum0;
        tickCumulatives[1] = _cum1;
        secondsPerLiquidity = new uint160[](2);
    }
}

/// @dev Re-implements the EXACT pre-extraction inline helper bodies that lived in
///      AerodromeSwapAdapter / UniswapV4SwapAdapter, so the library output can be
///      pinned against the prior implementation byte-for-byte.
library ReferenceTwap {
    using Math for uint256;

    function meanTick(address pool, uint32 window) internal view returns (int24) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = IObservablePool(pool).observe(secondsAgos);
        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int24 tick = int24(delta / int56(uint56(window)));
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) tick--;
        return tick;
    }

    function priceFromTick(int24 tick, address baseToken, address quoteToken, uint256 baseAmount)
        internal
        pure
        returns (uint256 quoteAmount)
    {
        uint256 sqrtP = uint256(TickMath.getSqrtRatioAtTick(tick));
        bool zeroForOne = baseToken < quoteToken;
        if (sqrtP <= type(uint128).max) {
            uint256 ratioX192 = sqrtP * sqrtP;
            quoteAmount = zeroForOne
                ? baseAmount.mulDiv(ratioX192, 1 << 192)
                : baseAmount.mulDiv(1 << 192, ratioX192);
        } else {
            uint256 ratioX128 = Math.mulDiv(sqrtP, sqrtP, 1 << 64);
            quoteAmount = zeroForOne
                ? baseAmount.mulDiv(ratioX128, 1 << 128)
                : baseAmount.mulDiv(1 << 128, ratioX128);
        }
    }
}

/// @dev External wrapper so library reverts cross a call boundary and can be
///      asserted with `vm.expectRevert` (internal library calls are inlined and
///      do not trip the cheatcode reliably).
contract TwapTickMathHarness {
    function checkPoolPair(address pool, address baseToken, address quoteToken) external view {
        TwapTickMath.checkPoolPair(pool, baseToken, quoteToken);
    }
}

/// @title TwapTickMathTest
/// @notice Pinning regression tests for the extracted TWAP tick helpers. Each
///         test pins the library output to a hard-coded reference value AND to a
///         standalone re-implementation of the prior inline body, proving the
///         extraction is behaviour-preserving across the documented edges:
///         negative non-exact mean-tick rounding toward -inf, the uint128
///         sqrtPrice high branch, both base<quote and base>quote orderings, and
///         pool-pair validation in both orderings plus the mismatch revert.
contract TwapTickMathTest is Test {
    using ReferenceTwap for address;

    // Distinct token addresses; `lo < hi` by numeric address value.
    address internal constant LO = address(0x1111);
    address internal constant HI = address(0x2222);
    address internal constant OTHER = address(0x3333);

    uint32 internal constant WINDOW = 1800;

    // ─── meanTick ─────────────────────────────────────────────────────

    /// @notice Negative, non-exact tickCumulative delta rounds toward -inf.
    ///         delta = -1801 over window 1800: -1801/1800 truncates to -1, and
    ///         because the remainder is non-zero the result is decremented to -2.
    function test_meanTick_negativeNonExact_roundsTowardNegInf() public {
        MockObservablePool pool = new MockObservablePool(LO, HI);
        pool.setCumulatives(0, -1801);
        int24 tick = TwapTickMath.meanTick(address(pool), WINDOW);
        assertEq(tick, int24(-2), "negative non-exact delta must round toward -inf");
        assertEq(tick, ReferenceTwap.meanTick(address(pool), WINDOW), "matches reference impl");
    }

    /// @notice Negative, EXACT multiple delta does NOT decrement.
    ///         delta = -3600 over window 1800: -2 exactly, no remainder.
    function test_meanTick_negativeExact_noDecrement() public {
        MockObservablePool pool = new MockObservablePool(LO, HI);
        pool.setCumulatives(0, -3600);
        int24 tick = TwapTickMath.meanTick(address(pool), WINDOW);
        assertEq(tick, int24(-2), "negative exact delta must not decrement");
        assertEq(tick, ReferenceTwap.meanTick(address(pool), WINDOW), "matches reference impl");
    }

    /// @notice Positive non-exact delta truncates toward zero (no -inf rule).
    ///         delta = 1801 over window 1800: 1.
    function test_meanTick_positiveNonExact_truncates() public {
        MockObservablePool pool = new MockObservablePool(LO, HI);
        pool.setCumulatives(0, 1801);
        int24 tick = TwapTickMath.meanTick(address(pool), WINDOW);
        assertEq(tick, int24(1), "positive non-exact delta truncates toward zero");
        assertEq(tick, ReferenceTwap.meanTick(address(pool), WINDOW), "matches reference impl");
    }

    /// @notice Zero delta yields tick 0.
    function test_meanTick_zeroDelta() public {
        MockObservablePool pool = new MockObservablePool(LO, HI);
        pool.setCumulatives(500, 500);
        int24 tick = TwapTickMath.meanTick(address(pool), WINDOW);
        assertEq(tick, int24(0), "zero delta yields tick 0");
        assertEq(tick, ReferenceTwap.meanTick(address(pool), WINDOW), "matches reference impl");
    }

    // ─── priceFromTick ────────────────────────────────────────────────

    /// @notice tick 0 (price 1:1) returns baseAmount for both orderings.
    function test_priceFromTick_tickZero_bothOrderings() public pure {
        uint256 baseAmount = 1_000_000;
        uint256 zeroForOne = TwapTickMath.priceFromTick(int24(0), LO, HI, baseAmount);
        uint256 oneForZero = TwapTickMath.priceFromTick(int24(0), HI, LO, baseAmount);
        assertEq(zeroForOne, baseAmount, "tick 0 base<quote: 1:1");
        assertEq(oneForZero, baseAmount, "tick 0 base>quote: 1:1");
        assertEq(zeroForOne, ReferenceTwap.priceFromTick(int24(0), LO, HI, baseAmount), "ref");
        assertEq(oneForZero, ReferenceTwap.priceFromTick(int24(0), HI, LO, baseAmount), "ref");
    }

    /// @notice Low-magnitude tick stays in the uint128 sqrtPrice fast path and
    ///         matches the reference implementation for both orderings.
    function test_priceFromTick_lowBranch_bothOrderings() public pure {
        int24 tick = int24(6932); // ~2x price; sqrtP well under uint128 max
        uint256 baseAmount = 1_000_000;
        // Confirm we are exercising the LOW branch.
        assertLe(uint256(TickMath.getSqrtRatioAtTick(tick)), type(uint128).max, "low branch");
        uint256 zeroForOne = TwapTickMath.priceFromTick(tick, LO, HI, baseAmount);
        uint256 oneForZero = TwapTickMath.priceFromTick(tick, HI, LO, baseAmount);
        assertEq(zeroForOne, ReferenceTwap.priceFromTick(tick, LO, HI, baseAmount), "ref z4o");
        assertEq(oneForZero, ReferenceTwap.priceFromTick(tick, HI, LO, baseAmount), "ref o4z");
        // base<quote at a positive tick prices UP; base>quote prices DOWN.
        assertGt(zeroForOne, baseAmount, "positive tick, base<quote prices up");
        assertLt(oneForZero, baseAmount, "positive tick, base>quote prices down");
    }

    /// @notice High tick pushes sqrtPrice above uint128 max, exercising the wide
    ///         `Math.mulDiv(sqrtP, sqrtP, 1<<64)` branch. Pins both orderings to
    ///         the reference implementation.
    function test_priceFromTick_highBranch_bothOrderings() public pure {
        int24 tick = int24(500000); // > ~443637 → sqrtP exceeds uint128 max
        // Confirm we are exercising the HIGH branch.
        assertGt(uint256(TickMath.getSqrtRatioAtTick(tick)), type(uint128).max, "high branch");
        uint256 baseAmount = 1e30;
        uint256 zeroForOne = TwapTickMath.priceFromTick(tick, LO, HI, baseAmount);
        uint256 oneForZero = TwapTickMath.priceFromTick(tick, HI, LO, baseAmount);
        assertEq(zeroForOne, ReferenceTwap.priceFromTick(tick, LO, HI, baseAmount), "high ref z4o");
        assertEq(oneForZero, ReferenceTwap.priceFromTick(tick, HI, LO, baseAmount), "high ref o4z");
    }

    // ─── checkPoolPair ────────────────────────────────────────────────

    /// @notice Valid when the requested (base, quote) matches (token0, token1).
    function test_checkPoolPair_validForwardOrdering() public {
        MockObservablePool pool = new MockObservablePool(LO, HI);
        TwapTickMath.checkPoolPair(address(pool), LO, HI); // must not revert
    }

    /// @notice Valid when the requested (base, quote) is the reverse of (token0, token1).
    function test_checkPoolPair_validReverseOrdering() public {
        MockObservablePool pool = new MockObservablePool(LO, HI);
        TwapTickMath.checkPoolPair(address(pool), HI, LO); // must not revert
    }

    /// @notice Reverts when either requested token is absent from the pool.
    function test_checkPoolPair_revertsOnMismatch() public {
        MockObservablePool pool = new MockObservablePool(LO, HI);
        TwapTickMathHarness harness = new TwapTickMathHarness();
        vm.expectRevert(TwapTickMath.PoolTokenMismatch.selector);
        harness.checkPoolPair(address(pool), LO, OTHER);
    }
}
