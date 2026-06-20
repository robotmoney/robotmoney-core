// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/smart-contract-holistic-review-20260618.md §2 —
// duplicated TWAP tick helpers across the swap adapters.
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IObservablePool} from "../interfaces/IObservablePool.sol";
import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";
import {TickMath} from "./TickMath.sol";

/// @title TwapTickMath
/// @notice Shared time-weighted-average-price tick helpers for the BasketVault
///         swap adapters. `AerodromeSwapAdapter` and `UniswapV4SwapAdapter`
///         previously carried byte-identical copies of pool-pair validation,
///         mean-tick computation, and price-from-tick conversion, differing only
///         in the concrete pool interface type. Both pool types expose the
///         Uniswap V3 `observe()` ABI, so the logic is consolidated here over
///         the minimal `IObservablePool` surface.
///
///         The arithmetic is unchanged from the prior inline implementations:
///         the mean tick rounds toward negative infinity when the cumulative
///         tick delta is negative and not an exact multiple of the window
///         (matching Uniswap's OracleLibrary), and the price conversion keeps
///         both the `uint128`-bounded `sqrtPrice` fast path and the wider
///         `Math.mulDiv` branch.
library TwapTickMath {
    using Math for uint256;

    /// @dev Raised when the pool's tokens do not match the requested base/quote pair.
    error PoolTokenMismatch();

    /// @dev ORA-4 / F-10: spot diverged from TWAP beyond the configured threshold.
    error NavMarketDeviationExceeded(address token, uint256 deviationBps, uint256 thresholdBps);

    /// @dev Validates that `pool` pairs exactly `baseToken` and `quoteToken`.
    function checkPoolPair(address pool, address baseToken, address quoteToken) internal view {
        address t0 = IObservablePool(pool).token0();
        address t1 = IObservablePool(pool).token1();
        bool validPair =
            (t0 == baseToken && t1 == quoteToken) || (t1 == baseToken && t0 == quoteToken);
        if (!validPair) revert PoolTokenMismatch();
    }

    /// @dev Compute arithmetic-mean tick over `[window, 0]` seconds via `observe()`.
    /// @dev `public` (not `internal`): the compiler deploys this library once and
    ///      DELEGATECALL-links it into every consumer (BasketVault + both swap
    ///      adapters), so the mean-tick + price math lives in a single deployed
    ///      contract instead of being inlined into each — keeping the
    ///      already-EIP-170-tight vault family under the 24_576-byte limit.
    function meanTick(address pool, uint32 window) public view returns (int24) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = IObservablePool(pool).observe(secondsAgos);
        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int24 tick = int24(delta / int56(uint56(window)));
        // Match Uniswap OracleLibrary rounding: negative-and-not-exact rounds toward -∞.
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) tick--;
        return tick;
    }

    /// @notice ORA-4 / F-10 — divergence (in bps) between a pool's executable
    ///         market (slot0 spot) price and its NAV-pricing TWAP, measured on a
    ///         fixed `probeAmount` of `token` priced into `quote`.
    /// @dev `public` for the same single-deploy/DELEGATECALL-link reason as the
    ///      other helpers, keeping the deviation math out of the already-EIP-170-
    ///      tight vault family. Returns `type(uint256).max` sentinel-free: a zero
    ///      TWAP value yields 0 (caller treats as "no priced exposure, skip").
    /// @param pool        The Uniswap V3 / observe-compatible pool.
    /// @param token       The basket asset (base) token.
    /// @param quote       The quote token (USDC).
    /// @param window      TWAP window in seconds.
    /// @param probeAmount Token amount to price both ways (decimals cancel in the ratio).
    /// @return bps Absolute |spot − twap| / twap in basis points (0 when twap value is 0).
    function deviationBps(
        address pool,
        address token,
        address quote,
        uint32 window,
        uint256 probeAmount
    ) public view returns (uint256 bps) {
        if (probeAmount == 0) return 0;
        uint256 twapVal = priceFromTick(meanTick(pool, window), token, quote, probeAmount);
        if (twapVal == 0) return 0;
        (, int24 spotTick,,,,,) = IUniswapV3Pool(pool).slot0();
        uint256 spotVal = priceFromTick(spotTick, token, quote, probeAmount);
        uint256 diff = twapVal > spotVal ? twapVal - spotVal : spotVal - twapVal;
        bps = diff.mulDiv(10_000, twapVal);
    }

    /// @notice ORA-4 / F-10 — revert when `token`'s spot price diverges from its
    ///         TWAP beyond `thresholdBps`. No-op when `threshold` is 0 (guard
    ///         disabled) or the TWAP value is 0 (no priced exposure). Carrying
    ///         the full check (compute + compare + revert) here keeps the loop
    ///         body in the EIP-170-tight vault to a single external call.
    function requireWithinDeviation(
        address pool,
        address token,
        address quote,
        uint32 window,
        uint256 probeAmount,
        uint256 thresholdBps
    ) public view {
        if (thresholdBps == 0 || probeAmount == 0) return;
        uint256 dev = deviationBps(pool, token, quote, window, probeAmount);
        if (dev > thresholdBps) revert NavMarketDeviationExceeded(token, dev, thresholdBps);
    }

    /// @dev Convert a TWAP mean tick to an output amount using sqrtPriceX96 math.
    function priceFromTick(int24 tick, address baseToken, address quoteToken, uint256 baseAmount)
        public
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
