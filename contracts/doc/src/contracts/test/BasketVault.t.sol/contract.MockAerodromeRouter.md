# MockAerodromeRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/b26f69ebc017ed65ec1995613224744c7754ee26/contracts/test/BasketVault.t.sol)

Mock Aerodrome Slipstream router and CL factory.


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


### pools

```solidity
mapping(bytes32 => address) public pools
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

### setPool


```solidity
function setPool(address tokenA, address tokenB, int24 tickSpacing, address pool) external;
```

### exactInputSingle


```solidity
function exactInputSingle(IAerodromeSlipstreamRouter.ExactInputSingleParams calldata params)
    external
    returns (uint256);
```

### getPool


```solidity
function getPool(address tokenA, address tokenB, int24 tickSpacing)
    external
    view
    returns (address);
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

