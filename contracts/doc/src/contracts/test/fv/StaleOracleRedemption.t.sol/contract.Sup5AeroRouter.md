# Sup5AeroRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/b58df0d9705fd40d8110bd43d533f82a20b8ace3/contracts/test/fv/StaleOracleRedemption.t.sol)

Aerodrome router stub that disburses a pre-set output.


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

### swapExactTokensForTokens


```solidity
function swapExactTokensForTokens(
    uint256 amountIn,
    uint256 amountOutMin,
    IAerodromeRouter.Route[] calldata routes,
    address to,
    uint256
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

