# PosConfAavePool
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/1a62dd56cbffd67a73d39db63c0ae20c0a7cc71f/contracts/test/AdapterPositionConformance.t.sol)

1:1 Aave V3 Pool mock. `supply` pulls USDC and mints aTokens; `withdraw`
supports the type(uint256).max full-balance sentinel and returns actual.


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

