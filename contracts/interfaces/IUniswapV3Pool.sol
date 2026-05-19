// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap V3 Pool interface used for slot0 pricing and
///         TWAP reads via `observe()`.
interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);

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

    /// @notice Returns the cumulative tick and liquidity as of each timestamp
    ///         `secondsAgos` from the current block timestamp.
    /// @dev `secondsAgos[i]` is the number of seconds in the past to compute
    ///      the cumulative against. The first cumulative is at `secondsAgos[0]`
    ///      seconds in the past, the second at `secondsAgos[1]`, and so on.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        );

    /// @notice Returns observation cardinality (number of slots available for
    ///         historical price storage). Required to verify that a TWAP
    ///         window of `W` seconds has sufficient observations to be
    ///         manipulation-resistant.
    function observations(uint256 index)
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidityCumulativeX128,
            bool initialized
        );
}
