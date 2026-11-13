// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.3 check 9 (per-swap limit of the pro-rata purchase),
//            §6 (adapter row: exact-output swap with a price limit); docs/technical/one-vault-timed-flows-eng-plan.md
//            E3, §3.2 ("exact-output swaps need a call on the swap adapters ... the prototype adds it to the adapter's
//            test copy")
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UniswapV3SwapAdapter} from "../../../../adapters/UniswapV3SwapAdapter.sol";
import {IExactOutSwapAdapter} from "../interfaces/IFlowAdapters.sol";

/// @notice Uniswap V3 SwapRouter02 exact-output entry point (not in the production `ISwapRouter`, which the
///         production adapter does not need). SwapRouter02's struct has no deadline; the adapter enforces it.
interface ISwapRouterExactOut {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        returns (uint256 amountIn);
}

/// @title UniswapV3ExactOutSwapAdapter
/// @notice Test copy of the production `UniswapV3SwapAdapter` (step 3d): it inherits the production exact-input
///         `swap` and `twapPrice` unchanged and adds `swapExactOut`, whose `maxAmountIn` is the per-swap price limit
///         of the fund's pro-rata purchase (check 9). The production adapter does not change (eng plan §3.3).
///         Inheriting instead of copying keeps the production code paths byte-identical in behaviour; the runtime
///         code hash differs, so the harness allowlists this copy's hash.
contract UniswapV3ExactOutSwapAdapter is UniswapV3SwapAdapter, IExactOutSwapAdapter {
    using SafeERC20 for IERC20;

    constructor(address router_) UniswapV3SwapAdapter(router_) {}

    /// @inheritdoc IExactOutSwapAdapter
    /// @dev Pulls `maxAmountIn` from the caller, approves the router for exactly that, calls `exactOutputSingle`
    ///      (no sqrt price limit, so the router delivers exactly `amountOut` or reverts), resets the allowance to 0
    ///      (ADP-5), and returns `maxAmountIn − amountIn` to the caller. The router itself reverts when it needs more
    ///      than `amountInMaximum` ("STF"/"Too much requested"), so no input above the limit is ever spent.
    function swapExactOut(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountOut,
        uint256 maxAmountIn,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountIn) {
        if (tokenIn == address(0) || tokenOut == address(0) || recipient == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        if (amountOut == 0) return 0;

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), maxAmountIn);
        IERC20(tokenIn).forceApprove(address(ROUTER), maxAmountIn);
        amountIn = ISwapRouterExactOut(address(ROUTER))
            .exactOutputSingle(
                ISwapRouterExactOut.ExactOutputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: recipient,
                    amountOut: amountOut,
                    amountInMaximum: maxAmountIn,
                    sqrtPriceLimitX96: 0
                })
            );
        IERC20(tokenIn).forceApprove(address(ROUTER), 0);
        if (amountIn < maxAmountIn) {
            IERC20(tokenIn).safeTransfer(msg.sender, maxAmountIn - amountIn);
        }
    }
}
