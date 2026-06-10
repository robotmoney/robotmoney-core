# MockAerodromeRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/39e1ef6f3c3c12310bb1f076d49c99097546b91c/contracts/test/BasketVault.t.sol)

Mock Aerodrome Router: records calls and disburses pre-set amounts.
Mimics the IAerodromeRouter.swapExactTokensForTokens signature.


## State Variables
### amountOut

```solidity
uint256 public amountOut
```


### enforceDeadline
When set, the deadline forwarded by the adapter is enforced
(mirrors the real Aerodrome Router's "Expired" check).


```solidity
bool public enforceDeadline
```


### returnEmptyAmounts
When set, return an empty amounts array (malformed router response,
audit 2026-06-09 L-7 regression input).


```solidity
bool public returnEmptyAmounts
```


## Functions
### setAmountOut


```solidity
function setAmountOut(uint256 amountOut_) external;
```

### setEnforceDeadline


```solidity
function setEnforceDeadline(bool enforce_) external;
```

### setReturnEmptyAmounts


```solidity
function setReturnEmptyAmounts(bool empty_) external;
```

### swapExactTokensForTokens


```solidity
function swapExactTokensForTokens(
    uint256 amountIn,
    uint256 amountOutMin,
    IAerodromeRouter.Route[] calldata routes,
    address to,
    uint256 deadline
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

### Expired

```solidity
error Expired(uint256 deadline, uint256 blockTimestamp);
```

