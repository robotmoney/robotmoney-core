// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md §2–§4 — Uniswap V4 venue
// (See also: docs/architecture.md §4.1 — Vault Family; docs/prd.md §11 — vault catalog)
//
// Implements IBasketSwapAdapter for Uniswap V4 pools on Base. Swaps are routed
// through the Uniswap V4 Router using exactInputSingle; TWAP reads use the V4
// pool's observe() method (EIP-7680 compatible — identical ABI to V3) and the
// shared TickMath library.
//
// The `fee` parameter passed to swap() and twapPrice() is the V4 pool fee tier
// (in hundredths of a bip, e.g. 500 = 0.05%). It is used to derive the
// standard tick spacing and to construct the PoolKey for the router call.
//
// The pool address passed to twapPrice() must be the V4 pool that pairs
// baseToken with quoteToken. It is used exclusively for TWAP reads via
// observe(); the router uses the PoolKey (derived from tokens + fee + tickSpacing)
// to locate the pool for swaps.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {IUniswapV4SwapRouter} from "../interfaces/IUniswapV4SwapRouter.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";

/// @title UniswapV4SwapAdapter
/// @notice BasketVault swap adapter for Uniswap V4 pools.
///         Swaps USDC↔asset via the Uniswap V4 Router (exactInputSingle);
///         prices NAV and slippage floors via a V4 pool TWAP (arithmetic-mean
///         tick over `window` seconds, identical ABI to the Uniswap V3 oracle
///         path per EIP-7680).
///
///         The tick-spacing is derived deterministically from the fee tier using
///         Uniswap V4's standard mapping (500→10, 3000→60, 10000→200). Custom
///         fee tiers with non-standard tick spacings are not supported by this
///         adapter; pools with such parameters must use a bespoke adapter.
///
///         The hook address is hard-coded to address(0) (no hook). Pools that
///         use a hook contract must use a bespoke adapter that encodes the
///         hook address into the PoolKey.
contract UniswapV4SwapAdapter is IBasketSwapAdapter {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice Uniswap V4 Router used for all swaps.
    IUniswapV4SwapRouter public immutable ROUTER;

    // ─── Errors ───────────────────────────────────────────────────────

    /// @dev Raised when either token is the zero address.
    error ZeroAddress();
    /// @dev Raised when the TWAP window is zero.
    error ZeroWindow();
    /// @dev Raised when the pool's tokens do not match the requested base/quote pair.
    error PoolTokenMismatch();
    /// @dev Raised when the fee tier has no standard tick spacing mapping.
    error UnsupportedFeeTier(uint24 fee);
    /// @dev Raised when the caller-chosen swap deadline has already passed.
    ///      Enforced in the adapter because the V4 router params carry no
    ///      deadline field (audit 2026-06-09, L-5).
    error DeadlineExpired(uint256 deadline, uint256 blockTimestamp);

    // ─── Constructor ─────────────────────────────────────────────────

    /// @param router_  Uniswap V4 Router address. Must not be address(0).
    constructor(address router_) {
        if (router_ == address(0)) revert ZeroAddress();
        ROUTER = IUniswapV4SwapRouter(router_);
    }

    // ─── IBasketSwapAdapter ───────────────────────────────────────────

    /// @inheritdoc IBasketSwapAdapter
    /// @dev Constructs a V4 PoolKey from the two tokens and the fee tier, then calls
    ///      `ROUTER.exactInputSingle`. The `zeroForOne` direction is derived from
    ///      token address ordering (token0 < token1). Tokens are pulled from
    ///      `msg.sender` (BasketVault) via `transferFrom`; BasketVault approves this
    ///      adapter before calling and clears the approval after.
    ///      The caller-chosen `deadline` is enforced here (the V4 router params
    ///      carry no deadline field) — audit 2026-06-09, L-5. `amountIn` and
    ///      `minAmountOut` are range-checked via `SafeCast.toUint128` so
    ///      out-of-range inputs revert instead of silently wrapping and
    ///      weakening the slippage floor — audit 2026-06-09, L-6.
    function swap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        if (amountIn == 0) return 0;

        int24 tickSpacing = _tickSpacingForFee(fee);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(ROUTER), amountIn);

        // Sort tokens for PoolKey: currency0 is the lower address.
        bool zeroForOne = tokenIn < tokenOut;
        (address currency0, address currency1) =
            zeroForOne ? (tokenIn, tokenOut) : (tokenOut, tokenIn);

        amountOut = ROUTER.exactInputSingle(
            IUniswapV4SwapRouter.ExactInputSingleParams({
                poolKey: IUniswapV4SwapRouter.PoolKey({
                    currency0: currency0,
                    currency1: currency1,
                    fee: fee,
                    tickSpacing: tickSpacing,
                    hooks: address(0)
                }),
                zeroForOne: zeroForOne,
                amountIn: SafeCast.toUint128(amountIn),
                amountOutMinimum: SafeCast.toUint128(minAmountOut),
                sqrtPriceLimitX96: 0,
                hookData: ""
            })
        );

        IERC20(tokenIn).forceApprove(address(ROUTER), 0);

        // Forward output tokens to recipient (router delivers to this contract,
        // as V4 routers may not support arbitrary recipients on all deployments).
        if (recipient != address(this)) {
            IERC20(tokenOut).safeTransfer(recipient, amountOut);
        }
    }

    /// @inheritdoc IBasketSwapAdapter
    /// @dev Reads the arithmetic-mean tick from the V4 pool's `observe()` over
    ///      `window` seconds and converts it to a price quote using the same
    ///      TickMath path as BasketVault's built-in Uniswap V3 TWAP. The pool
    ///      MUST implement `observe(uint32[])` (EIP-7680 compatible).
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

    // ─── Internal helpers ─────────────────────────────────────────────

    /// @dev Maps standard Uniswap V4 fee tiers to their canonical tick spacings.
    ///      Reverts with `UnsupportedFeeTier` for non-standard fee tiers.
    ///      Standard mappings: 100→1, 500→10, 3000→60, 10000→200.
    function _tickSpacingForFee(uint24 fee) internal pure returns (int24) {
        if (fee == 100) return 1;
        if (fee == 500) return 10;
        if (fee == 3000) return 60;
        if (fee == 10_000) return 200;
        revert UnsupportedFeeTier(fee);
    }
}
