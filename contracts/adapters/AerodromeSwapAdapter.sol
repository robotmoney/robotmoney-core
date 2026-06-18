// SPDX-License-Identifier: MIT
// Canonical: docs/technical/real-four-vault-demo-seams.md §3 — BasketVault swap seam
// (See also: docs/architecture.md §4.1 — Vault Family; docs/prd.md §11 — vault catalog)
//
// Implements IBasketSwapAdapter for Aerodrome Finance CL (concentrated-liquidity)
// pools on Base. Swaps are routed through the Aerodrome Router; TWAP reads use
// the CL pool's `observe()` method (identical ABI to Uniswap V3 pools) and the
// shared TickMath library.
//
// Only Aerodrome CL pools are supported for TWAP pricing. Classic (v2-style)
// stable/volatile pools do not expose `observe()` and cannot be used here.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {IAerodromeRouter} from "../interfaces/IAerodromeRouter.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";

/// @title AerodromeSwapAdapter
/// @notice BasketVault swap adapter for Aerodrome Finance CL pools.
///         Swaps USDC↔asset via the Aerodrome Router; prices NAV and slippage
///         floors via an Aerodrome CL pool TWAP (arithmetic-mean tick over
///         `window` seconds, identical to the Uniswap V3 oracle path).
///
///         The `stable` flag controls whether the Aerodrome Router uses the
///         stable-swap (constant-sum-like) or volatile-swap (constant-product)
///         AMM curve for the route. It is fixed at construction time per
///         the pool's invariant type.
///
///         The `factory` address is the Aerodrome pool factory that produced
///         the target pool; it is embedded in the Route struct so the router
///         can resolve the pool deterministically.
contract AerodromeSwapAdapter is IBasketSwapAdapter {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice Aerodrome Router used for all swaps.
    IAerodromeRouter public immutable ROUTER;

    /// @notice Pool factory embedded in route structs. Must match the factory
    ///         that created the target CL pool.
    address public immutable FACTORY;

    /// @notice Whether the route uses Aerodrome's stable-swap curve.
    ///         `true` for stable pools (e.g. USDC/USDT), `false` for volatile.
    bool public immutable STABLE;

    // ─── Errors ───────────────────────────────────────────────────────

    /// @dev Raised when either token is the zero address.
    error ZeroAddress();
    /// @dev Raised when the TWAP window is zero.
    error ZeroWindow();
    /// @dev Raised when the pool's tokens do not match the requested base/quote pair.
    error PoolTokenMismatch();
    /// @dev Raised when the Aerodrome Router returns an empty amounts array,
    ///      which would otherwise underflow the output-index read
    ///      (audit 2026-06-09, L-7).
    error EmptyRouterAmounts();

    // ─── Constructor ─────────────────────────────────────────────────

    /// @param router_  Aerodrome Router address. Must not be address(0).
    /// @param factory_ Pool factory address embedded in route structs.
    /// @param stable_  Whether to use the stable-swap AMM curve for this adapter.
    constructor(address router_, address factory_, bool stable_) {
        if (router_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        ROUTER = IAerodromeRouter(router_);
        FACTORY = factory_;
        STABLE = stable_;
    }

    // ─── IBasketSwapAdapter ───────────────────────────────────────────

    /// @inheritdoc IBasketSwapAdapter
    /// @dev The `fee` parameter is ignored; Aerodrome derives the fee from the
    ///      pool configuration rather than the route struct. The caller (BasketVault)
    ///      still passes it for interface uniformity. The caller-chosen `deadline`
    ///      is forwarded to the Aerodrome Router, which reverts when expired
    ///      (audit 2026-06-09, L-5).
    function swap(
        address tokenIn,
        address tokenOut,
        uint24, /* fee — unused by Aerodrome */
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (amountIn == 0) return 0;

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(ROUTER), amountIn);

        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] =
            IAerodromeRouter.Route({from: tokenIn, to: tokenOut, stable: STABLE, factory: FACTORY});

        uint256[] memory amounts =
            ROUTER.swapExactTokensForTokens(amountIn, minAmountOut, routes, recipient, deadline);

        IERC20(tokenIn).forceApprove(address(ROUTER), 0);

        // The router returns one amount per hop; the last element is the output.
        // Guard the index read against a malformed empty return (audit L-7).
        if (amounts.length == 0) revert EmptyRouterAmounts();
        amountOut = amounts[amounts.length - 1];
    }

    /// @inheritdoc IBasketSwapAdapter
    /// @dev Reads the arithmetic-mean tick from the Aerodrome CL pool's `observe()`
    ///      over `window` seconds and converts it to a price quote using the same
    ///      TickMath path as BasketVault's built-in Uniswap V3 TWAP.
    ///      The pool MUST be an Aerodrome CL (Slipstream) pool — classic v2 pools
    ///      do not expose `observe()` and will revert.
    function twapPrice(
        address pool,
        address baseToken,
        address quoteToken,
        uint256 baseAmount,
        uint32 window
    ) external view returns (uint256 quoteAmount) {
        if (pool == address(0) || baseToken == address(0) || quoteToken == address(0)) {
            revert ZeroAddress();
        }
        if (window == 0) revert ZeroWindow();
        if (baseAmount == 0) return 0;

        TwapTickMath.checkPoolPair(pool, baseToken, quoteToken);

        int24 meanTick = TwapTickMath.meanTick(pool, window);
        quoteAmount = TwapTickMath.priceFromTick(meanTick, baseToken, quoteToken, baseAmount);
    }
}
