// SPDX-License-Identifier: MIT
// Canonical: docs/technical/real-four-vault-demo-seams.md §3 — BasketVault swap seam
pragma solidity ^0.8.24;

/// @title IBasketSwapAdapter
/// @notice Venue-agnostic swap + TWAP interface consumed by BasketVault.
///         Each concrete adapter (Uniswap V3, Aerodrome, Uniswap V4) implements
///         this interface so BasketVault can route per-asset swaps and TWAP reads
///         through the correct DEX without hardcoding venue mechanics.
///
///         The `pool` address passed to `twapPrice` is the venue-specific pool that
///         pairs `token` with USDC. The adapter is responsible for interpreting
///         `pool` correctly for its own oracle mechanics (e.g. tick-based TWAP for
///         Uniswap V3/V4, or `currentPeriodObservation` for Aerodrome stable pools).
interface IBasketSwapAdapter {
    /// @notice Execute a single-hop swap.
    /// @param tokenIn       Address of the token to sell.
    /// @param tokenOut      Address of the token to buy.
    /// @param fee           Venue-specific fee parameter (fee tier for Uniswap V3,
    ///                      ignored for Aerodrome which derives fee from pool config).
    /// @param amountIn      Exact amount of `tokenIn` to sell.
    /// @param minAmountOut  Minimum amount of `tokenOut` required; reverts if not met.
    /// @param recipient     Recipient of `tokenOut`.
    /// @return amountOut    Actual amount of `tokenOut` received.
    function swap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut);

    /// @notice Compute a TWAP-based price quote: how many `quoteToken` for `baseAmount`
    ///         of `baseToken`, reading the oracle from `pool` over `window` seconds.
    /// @param pool        Venue-specific pool address pairing `baseToken` with `quoteToken`.
    /// @param baseToken   Token whose amount is the input to the quote.
    /// @param quoteToken  Token whose amount is the output of the quote.
    /// @param baseAmount  Amount of `baseToken` to price.
    /// @param window      TWAP lookback window in seconds.
    /// @return quoteAmount Estimated amount of `quoteToken` for `baseAmount` of `baseToken`.
    function twapPrice(
        address pool,
        address baseToken,
        address quoteToken,
        uint256 baseAmount,
        uint32 window
    ) external view returns (uint256 quoteAmount);
}
