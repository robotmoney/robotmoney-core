# MockAerodromeRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e7f8d434b5251917b3fb5672139a21537b84392f/contracts/test/RwaVault.t.sol)

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

