// SPDX-License-Identifier: MIT
// Canonical: none — third-party ABI surface (Aerodrome Finance Router on Base)
// Base mainnet: 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
pragma solidity ^0.8.24;

/// @notice Minimal Aerodrome Router interface for single-hop token swaps.
///         Aerodrome uses (tokenA, tokenB, stable, factory) route tuples
///         instead of Uniswap V3 fee-tier paths.
interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    /// @notice Swap an exact amount of tokens for as many output tokens as possible,
    ///         using the given route sequence.
    /// @param amountIn      Exact input amount.
    /// @param amountOutMin  Minimum output; reverts if not met.
    /// @param routes        Ordered array of swap hops.
    /// @param to            Recipient of output tokens.
    /// @param deadline      Unix timestamp after which the swap reverts.
    /// @return amounts      Array of amounts swapped at each hop.
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /// @notice Returns the canonical pool factory address.
    function defaultFactory() external view returns (address);
}
