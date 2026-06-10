# MockPoolForGuards
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/4b538399027636f20b316ae10f72d0d6c6960fb1/contracts/test/ConfusedDeputyGuards.t.sol)

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

