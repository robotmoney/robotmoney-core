# ISwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cf8a75c9169f98b8e30f0ad4e13af73b36f22bc7/contracts/interfaces/ISwapRouter.sol)

Minimal Uniswap V3 SwapRouter02 interface.

Base mainnet: 0x2626664c2603336E57B271c5C0b26F421741e481


## Functions
### exactInputSingle


```solidity
function exactInputSingle(ExactInputSingleParams calldata params)
    external
    returns (uint256 amountOut);
```

## Structs
### ExactInputSingleParams

```solidity
struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}
```

