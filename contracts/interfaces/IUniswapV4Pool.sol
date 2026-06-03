// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md §3 — Uniswap V4 oracle source
pragma solidity ^0.8.24;

/// @title IUniswapV4Pool
/// @notice Minimal Uniswap V4 pool interface consumed by UniswapV4SwapAdapter.
///         V4 pools expose the same `observe(uint32[] secondsAgos)` TWAP interface
///         as V3 (EIP-7680 compatibility), so the arithmetic-mean tick computation
///         is identical to the V3 path in BasketVault._twapQuote().
interface IUniswapV4Pool {
    /// @notice Returns the addresses of the two tokens in the pool.
    function token0() external view returns (address);

    /// @notice Returns the addresses of the two tokens in the pool.
    function token1() external view returns (address);

    /// @notice Returns cumulative tick and seconds-per-liquidity values at each
    ///         `secondsAgos[i]` seconds in the past. Identical ABI to IUniswapV3Pool.observe().
    /// @param secondsAgos Array of elapsed seconds for each observation. `[window, 0]`
    ///        is the canonical two-point TWAP read pattern.
    /// @return tickCumulatives   Cumulative tick values at each requested time.
    /// @return secondsPerLiquidityCumulativeX128 Seconds-per-liquidity cumulatives (unused for TWAP).
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128);

    /// @notice Returns the pool's observation cardinality (number of stored snapshots).
    ///         Used by BasketVault.addAsset() to gate pool registration.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice Returns the current in-range liquidity of the pool.
    ///         Used by BasketVault.addAsset() to verify minimum pool depth.
    function liquidity() external view returns (uint128);
}
