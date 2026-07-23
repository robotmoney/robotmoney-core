# PosConfComet
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/AdapterPositionConformance.t.sol)

1:1 Compound V3 Comet mock: supply/withdraw credit/debit msg.sender and
route USDC to/from msg.sender; supports the max full-balance sentinel.


## Constants
### usdc

```solidity
IERC20 public immutable usdc
```


## State Variables
### balanceOf

```solidity
mapping(address => uint256) public balanceOf
```


## Functions
### constructor


```solidity
constructor(address usdc_) ;
```

### supply


```solidity
function supply(address asset, uint256 amount) external;
```

### withdraw


```solidity
function withdraw(address asset, uint256 amount) external;
```

