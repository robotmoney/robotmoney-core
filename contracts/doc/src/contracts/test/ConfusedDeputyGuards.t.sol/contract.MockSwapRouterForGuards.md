# MockSwapRouterForGuards
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/d4e061fc698a91b57b77eff38896e3a0f0dbbbdc/contracts/test/ConfusedDeputyGuards.t.sol)

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

