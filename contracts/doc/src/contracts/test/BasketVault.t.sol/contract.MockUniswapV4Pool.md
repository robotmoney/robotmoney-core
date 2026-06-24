# MockUniswapV4Pool
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/4b9f1e53ce2923a3a2346fb7de25157672f7633c/contracts/test/BasketVault.t.sol)

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

### fee

ORA-3 / F-09: `addAsset` asserts the pool's `fee()` equals `swapFee_`
(V4 resolves the execution pool from the fee tier). The V4 tests
register with `swapFee_ == 3000`.


```solidity
function fee() external pure returns (uint24);
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

