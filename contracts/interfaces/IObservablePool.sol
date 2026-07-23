// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/20260618-code-review-internal-claude.md §2 —
// duplicated TWAP tick helpers.
pragma solidity ^0.8.24;

/// @title IObservablePool
/// @notice Minimal pool surface required by the shared TWAP tick math: the two
///         pool tokens, the Uniswap V3 `observe()` ABI, and the leading fields
///         of `slot0()`. Both Aerodrome CL (Slipstream) pools and Uniswap V4
///         pools expose `token0`/`token1`/`observe()` identically to Uniswap
///         V3, so the arithmetic-mean tick computation in `TwapTickMath` can be
///         shared across adapters without depending on either concrete pool
///         interface.
///
///         `slot0()` here is intentionally TRUNCATED to its first four fields
///         (`sqrtPriceX96`, `tick`, `observationIndex`, `observationCardinality`)
///         rather than the full 7-field Uniswap V3 tuple (issue #1125): a real
///         Aerodrome Slipstream `CLPool.slot0` is a 6-field public struct with
///         NO `feeProtocol` member (`sqrtPriceX96, tick, observationIndex,
///         observationCardinality, observationCardinalityNext, unlocked` —
///         verified on-chain against the Base wETH/USDC Slipstream pool and the
///         upstream `aerodrome-finance/slipstream` `CLPool.sol` source, 2026-07).
///         Decoding a longer return type than the callee actually returns
///         reverts (buffer underrun); decoding a SHORTER prefix than the callee
///         returns is safe (trailing bytes are simply unread). Truncating to
///         the 4 leading fields both venues share in the same positions makes
///         this interface's `slot0()` ABI-compatible with genuine Uniswap V3
///         pools (7 fields), genuine Aerodrome Slipstream pools (6 fields), and
///         Uniswap V4 pools, so `BasketAssetConfigGuard.requirePoolUsable` and
///         `TwapTickMath.deviationBps` can read cardinality/spot-tick through a
///         single venue-agnostic call site instead of branching per venue.
///         `liquidity()` and the other members of `IAerodromePool` /
///         `IUniswapV4Pool` remain on the venue-specific interfaces and are
///         unrelated to mean-tick pricing.
interface IObservablePool {
    /// @notice Returns the address of token0 in the pool.
    function token0() external view returns (address);

    /// @notice Returns the address of token1 in the pool.
    function token1() external view returns (address);

    /// @notice Truncated `slot0()` read: only the 4 leading fields common to
    ///         Uniswap V3 (7 fields) and Aerodrome Slipstream (6 fields, no
    ///         `feeProtocol`) `slot0` layouts. See the interface NatSpec for
    ///         why decoding a shorter prefix is the venue-agnostic fix.
    /// @return sqrtPriceX96 Current sqrt price.
    /// @return tick Current spot tick.
    /// @return observationIndex Most-recently-updated observations index.
    /// @return observationCardinality Current number of stored observation slots.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality
        );

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
