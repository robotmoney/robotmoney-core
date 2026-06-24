# MockPoolForGuards
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/f6c8b468bb5448ecb94913113b3bd7ba124894db/contracts/test/ConfusedDeputyGuards.t.sol)

Uniswap V3 pool stub. token0/token1 are set at construction.
observe() returns linear tick cumulative (tick rate 0 → 1:1 price).
cardinality is settable so addAsset cardinality checks can be tested.


## Constants
### token0

```solidity
address public immutable token0
```


### token1

```solidity
address public immutable token1
```


## State Variables
### cardinality

```solidity
uint16 public cardinality
```


### poolLiquidity

```solidity
uint128 public poolLiquidity
```


## Functions
### constructor


```solidity
constructor(address token0_, address token1_) ;
```

### fee

ORA-3 / F-09: `addAsset` asserts `fee()` equals `swapFee_`. Every
addAsset call in this suite uses swapFee_ = 500.


```solidity
function fee() external pure returns (uint24);
```

### setCardinality


```solidity
function setCardinality(uint16 c) external;
```

### setLiquidity


```solidity
function setLiquidity(uint128 l) external;
```

### liquidity


```solidity
function liquidity() external view returns (uint128);
```

### slot0


```solidity
function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
```

### observe


```solidity
function observe(uint32[] calldata secondsAgos)
    external
    view
    returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq);
```

