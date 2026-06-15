# MockAerodromeRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/24e7da77de65b9ca589fead2c0c890d3c28f6cc4/contracts/test/RwaVault.t.sol)

Mock Aerodrome Router: records calls and disburses pre-set amounts.
Identical pattern to BasketVault.t.sol::MockAerodromeRouter.


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

### swapExactTokensForTokens


```solidity
function swapExactTokensForTokens(
    uint256 amountIn,
    uint256 amountOutMin,
    IAerodromeRouter.Route[] calldata routes,
    address to,
    uint256 /* deadline */
) external returns (uint256[] memory amounts);
```

### defaultFactory


```solidity
function defaultFactory() external pure returns (address);
```

## Errors
### TooLittleReceived

```solidity
error TooLittleReceived(uint256 amountOut, uint256 amountOutMin);
```

