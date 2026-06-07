# MockSwapRouterForGuards
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/6531b5859f4c88c630d0d699af15b2c577fd7227/contracts/test/ConfusedDeputyGuards.t.sol)

**Inherits:**
[ISwapRouter](/contracts/interfaces/ISwapRouter.sol/interface.ISwapRouter.md)

Swap router stub. Returns a configurable amountOut and respects
amountOutMinimum, reverting when output would be below the floor.


## State Variables
### amountOut

```solidity
uint256 public amountOut
```


## Functions
### setAmountOut


```solidity
function setAmountOut(uint256 v) external;
```

### exactInputSingle


```solidity
function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256);
```

## Errors
### TooLittleReceived

```solidity
error TooLittleReceived(uint256 got, uint256 minimum);
```

