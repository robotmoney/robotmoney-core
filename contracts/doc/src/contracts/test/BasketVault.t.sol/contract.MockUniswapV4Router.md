# MockUniswapV4Router
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/e87e3c25f878d584d0de1f966dcf456f62dad87a/contracts/test/BasketVault.t.sol)

Mock Uniswap V4 Router: records calls and disburses pre-set output amounts.
Mimics IUniswapV4SwapRouter.exactInputSingle.


## State Variables
### amountOut

```solidity
uint256 public amountOut
```


## Functions
### setAmountOut


```solidity
function setAmountOut(uint256 amountOut_) external;
```

### exactInputSingle


```solidity
function exactInputSingle(IUniswapV4SwapRouter.ExactInputSingleParams calldata params)
    external
    payable
    returns (uint256);
```

## Errors
### TooLittleReceived

```solidity
error TooLittleReceived(uint256 amountOut, uint256 amountOutMinimum);
```

