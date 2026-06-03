# MockUniswapV4Pool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/0f44df6c1ea9643363189d9e52250db5bd47a617/contracts/test/BasketVault.t.sol)

V4-style pool mock: observe() returns tick cumulatives identical to MockPool.
Also implements token0/token1, slot0, and liquidity for addAsset checks.


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
### tickCumulativeRate

```solidity
int56 public tickCumulativeRate
```


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

### setTickCumulativeRate


```solidity
function setTickCumulativeRate(int56 rate) external;
```

### setCardinality


```solidity
function setCardinality(uint16 cardinality_) external;
```

### setLiquidity


```solidity
function setLiquidity(uint128 liquidity_) external;
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

