// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.3 check 9 (per-swap limit of the pro-rata purchase),
//            §6 (adapter row: exact-output swap with a price limit); docs/technical/one-vault-timed-flows-eng-plan.md
//            E3, §3.2
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AerodromeSwapAdapter} from "../../../../adapters/AerodromeSwapAdapter.sol";
import {IExactOutSwapAdapter} from "../interfaces/IFlowAdapters.sol";

/// @notice Aerodrome Slipstream (Velodrome Slipstream periphery `ISwapRouter`) exact-output entry point.
interface IAerodromeSlipstreamRouterExactOut {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);
}

/// @title AerodromeExactOutSwapAdapter
/// @notice Test copy of the production `AerodromeSwapAdapter` (step 3d): the production `swap` and `twapPrice`
///         are inherited unchanged; `swapExactOut` is added (check 9). `fee` is the pool's tick spacing, as in
///         the production `swap`. The production adapter does not change (eng plan §3.3).
contract AerodromeExactOutSwapAdapter is AerodromeSwapAdapter, IExactOutSwapAdapter {
    using SafeERC20 for IERC20;

    constructor(address router_, address factory_) AerodromeSwapAdapter(router_, factory_) {}

    /// @inheritdoc IExactOutSwapAdapter
    /// @dev Same choreography as the production `swap`: the tick spacing must resolve to a factory pool
    ///      (`PoolNotFound`), the router enforces `deadline` and `amountInMaximum`. Pulls `maxAmountIn`, resets the
    ///      allowance to 0 after the call, returns the unused input to the caller.
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
        if (amountOut == 0) return 0;
        if (fee == 0 || fee > uint24(type(int24).max)) revert InvalidTickSpacing();
        int24 tickSpacing = int24(fee);
        if (FACTORY.getPool(tokenIn, tokenOut, tickSpacing) == address(0)) {
            revert PoolNotFound(tokenIn, tokenOut, tickSpacing);
        }

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), maxAmountIn);
        IERC20(tokenIn).forceApprove(address(ROUTER), maxAmountIn);
        amountIn = IAerodromeSlipstreamRouterExactOut(address(ROUTER)).exactOutputSingle(
            IAerodromeSlipstreamRouterExactOut.ExactOutputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                tickSpacing: tickSpacing,
                recipient: recipient,
                deadline: deadline,
                amountOut: amountOut,
                amountInMaximum: maxAmountIn,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(ROUTER), 0);
        if (amountIn < maxAmountIn) IERC20(tokenIn).safeTransfer(msg.sender, maxAmountIn - amountIn);
    }
}
