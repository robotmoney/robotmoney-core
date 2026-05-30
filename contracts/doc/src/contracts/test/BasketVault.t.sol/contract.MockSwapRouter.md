# MockSwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/8e58630207799c10307586432e49cdc81ca6ac74/contracts/test/BasketVault.t.sol)

**Inherits:**
[ISwapRouter](/contracts/interfaces/ISwapRouter.sol/interface.ISwapRouter.md)


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
function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256);
```

## Errors
### TooLittleReceived

```solidity
error TooLittleReceived(uint256 amountOut, uint256 amountOutMinimum);
```

