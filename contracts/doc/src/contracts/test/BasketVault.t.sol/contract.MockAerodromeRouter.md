# MockAerodromeRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/ea758b479e8ca22039bd13ec062ac539c6106ca4/contracts/test/BasketVault.t.sol)

Mock Aerodrome Router: records calls and disburses pre-set amounts.
Mimics the IAerodromeRouter.swapExactTokensForTokens signature.


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

