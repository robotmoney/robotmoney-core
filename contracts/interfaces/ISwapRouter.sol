// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap V3 SwapRouter02 interface.
/// @dev Base mainnet: 0x2626664c2603336E57B271c5C0b26F421741e481
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut);
}
