// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0010-unified-vault-architecture.md §4 (AssetPositionAdapter);
//            docs/technical/unified-vault-spec.md §4.3;
//            docs/technical/unified-vault-seam-map.json (contracts/adapters/ +
//            contracts/interfaces/IBasketSwapAdapter.sol entries).
//
// Concrete Uniswap V3 venue executor behind the IBasketSwapAdapter seam. It
// replaces BasketVault's inline `adapter == address(0)` special case
// (`_executeSwap` / `_twapQuote`): every venue now routes through the seam via a
// concrete executor rather than the vault carrying an inline V3 branch (seam-map
// contracts/vaults/BasketVault.sol → contracts/adapters/, M-A3). Swaps use the
// audited Uniswap V3 SwapRouter02 (`exactInputSingle`); TWAP reads use the V3
// pool's `observe()` ABI via the shared, delegatecall-linked `TwapTickMath`
// library (identical arithmetic to the prior inline path).
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";

/// @title UniswapV3SwapAdapter
/// @notice BasketVault / AssetPositionAdapter swap adapter for Uniswap V3 pools.
///         Swaps USDC↔asset via the Uniswap V3 SwapRouter02 (`exactInputSingle`);
///         prices NAV and slippage floors via a V3 pool TWAP (arithmetic-mean
///         tick over `window` seconds).
///
///         The `fee` parameter passed to `swap()` is the V3 pool fee tier (in
///         hundredths of a bip, e.g. 500 = 0.05%). The `pool` address passed to
///         `twapPrice()` must be the V3 pool that pairs `baseToken` with
///         `quoteToken`; it is used exclusively for TWAP `observe()` reads, while
///         the router resolves the execution pool from the token pair + fee tier
///         (ORA-3: callers pin both to the SAME pool).
contract UniswapV3SwapAdapter is IBasketSwapAdapter {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice Uniswap V3 SwapRouter02 used for all swaps.
    /// @dev Base mainnet: 0x2626664c2603336E57B271c5C0b26F421741e481.
    ISwapRouter public immutable ROUTER;

    // ─── Errors ───────────────────────────────────────────────────────

    /// @dev Raised when either token or the router is the zero address.
    error ZeroAddress();
    /// @dev Raised when the TWAP window is zero.
    error ZeroWindow();
    /// @dev Raised when the caller-chosen swap deadline has already passed.
    error DeadlineExpired(uint256 deadline, uint256 nowTs);

    // ─── Constructor ─────────────────────────────────────────────────

    /// @param router_ Uniswap V3 SwapRouter02 address. Must not be address(0).
    constructor(address router_) {
        if (router_ == address(0)) revert ZeroAddress();
        ROUTER = ISwapRouter(router_);
    }

    // ─── IBasketSwapAdapter ───────────────────────────────────────────

    /// @inheritdoc IBasketSwapAdapter
    /// @dev Pulls `amountIn` of `tokenIn` from `msg.sender` (the caller must have
    ///      approved this adapter, mirroring BasketVault's `forceApprove(adapter,
    ///      amountIn)` choreography), then swaps via SwapRouter02 with the caller-
    ///      chosen `deadline` (audit 2026-06-09, L-5). Approval hygiene: exact
    ///      `forceApprove` before the call, unconditional reset to 0 after (ADP-5).
    ///      SwapRouter02 delivers `tokenOut` straight to `recipient`.
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

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(ROUTER), amountIn);

        amountOut = ROUTER.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(tokenIn).forceApprove(address(ROUTER), 0);
    }

    /// @inheritdoc IBasketSwapAdapter
    /// @dev Arithmetic-mean tick over `[window, 0]` seconds, converted to an
    ///      output amount via the shared `TwapTickMath` library (identical to the
    ///      Uniswap OracleLibrary rounding). Reverts `PoolTokenMismatch` when
    ///      `pool` does not pair exactly `baseToken`/`quoteToken`.
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
