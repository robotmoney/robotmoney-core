# MockAavePool
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/895f74f9a312639869e61e1d4ba3dfce78950c03/contracts/test/AaveV3Adapter.t.sol)

Minimal Aave V3 Pool mock. `supply` pulls USDC from the caller via
`transferFrom` (consuming the adapter's allowance, like the real pool)
and credits the caller's aToken balance 1:1. `withdraw` burns aTokens
and returns USDC to `to`.


## Constants
### usdc

```solidity
IERC20 public immutable usdc
```


### aToken

```solidity
TestERC20 public immutable aToken
```


## Functions
### constructor


```solidity
constructor(address usdc_, address aToken_) ;
```

### supply


```solidity
function supply(address asset, uint256 amount, address onBehalfOf, uint16) external;
```

### withdraw


```solidity
function withdraw(address asset, uint256 amount, address to) external returns (uint256);
```

