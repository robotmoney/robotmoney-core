# IAerodromeSlipstreamRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/24e7da77de65b9ca589fead2c0c890d3c28f6cc4/contracts/interfaces/IAerodromeSlipstreamRouter.sol)


## Functions
### exactInputSingle


```solidity
function exactInputSingle(ExactInputSingleParams calldata params)
    external
    payable
    returns (uint256 amountOut);
```

## Structs
### ExactInputSingleParams

```solidity
struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    int24 tickSpacing;
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}
```

