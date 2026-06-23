// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/20260618-code-review-internal-claude.md §2 —
// duplicated TWAP tick helpers.
pragma solidity ^0.8.24;

/// @title IObservablePool
/// @notice Minimal pool surface required by the shared TWAP tick math: the two
///         pool tokens plus the Uniswap V3 `observe()` ABI. Both Aerodrome CL
///         (Slipstream) pools and Uniswap V4 pools expose this ABI, so the
///         arithmetic-mean tick computation in `TwapTickMath` can be shared
///         across adapters without depending on either concrete pool interface.
///
///         This interface intentionally omits `slot0()`, `liquidity()`, and the
///         other members of `IAerodromePool` / `IUniswapV4Pool`; those remain on
///         the venue-specific interfaces and are unrelated to mean-tick pricing.
interface IObservablePool {
    /// @notice Returns the address of token0 in the pool.
    function token0() external view returns (address);

    /// @notice Returns the address of token1 in the pool.
    function token1() external view returns (address);

    /// @notice Returns cumulative tick and seconds-per-liquidity values at each
    ///         `secondsAgos[i]` seconds in the past. Identical ABI to
    ///         `IUniswapV3Pool.observe()`.
    /// @param secondsAgos Array of elapsed seconds for each observation. `[window, 0]`
    ///        is the canonical two-point TWAP read pattern.
    /// @return tickCumulatives Cumulative tick values at each requested time.
    /// @return secondsPerLiquidityCumulativeX128s Seconds-per-liquidity cumulatives (unused for TWAP).
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        );
}
