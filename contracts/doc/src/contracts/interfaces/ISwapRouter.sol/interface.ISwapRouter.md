# ISwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d6ea170b5db4fe1e5559433d38b4563ca140fbfc/contracts/interfaces/ISwapRouter.sol)

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

