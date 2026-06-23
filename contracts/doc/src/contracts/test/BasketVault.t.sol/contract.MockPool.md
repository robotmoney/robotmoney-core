# MockPool
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c9e141ffcd1c066f8ea8438f58e57b245c4556f8/contracts/test/BasketVault.t.sol)

Minimal mock supporting both slot0 (legacy spot read) and observe()
(TWAP read). `setTickCumulativeRate` controls the per-second tick
growth: the TWAP arithmetic-mean tick equals exactly this value,
independent of the slot0 spot, which lets tests separate manipulation
of slot0 from the TWAP-bounded price the vault actually consumes.


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
### sqrtPriceX96Spot

```solidity
uint160 public sqrtPriceX96Spot
```


### spotTick

```solidity
int24 public spotTick
```


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


### revertObserve

```solidity
bool public revertObserve
```


### feeTier

```solidity
uint24 public feeTier
```


## Functions
### constructor


```solidity
constructor(address token0_, address token1_, uint160 sqrtPriceX96_) ;
```

### fee

ORA-3 / F-09: `addAsset` asserts the pool's `fee()` equals `swapFee_`.


```solidity
function fee() external view returns (uint24);
```

### setFee


```solidity
function setFee(uint24 fee_) external;
```

### setSpot


```solidity
function setSpot(uint160 sqrtPriceX96_) external;
```

### setSpotTick

Set the slot0 spot tick the ORA-4 deviation guard reads. The TWAP
mean tick is governed separately by `tickCumulativeRate`, so a test
can drive spot ≠ TWAP to exercise the deviation guard.


```solidity
function setSpotTick(int24 tick_) external;
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

### setRevertObserve


```solidity
function setRevertObserve(bool value) external;
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

### observations


```solidity
function observations(uint256)
    external
    view
    returns (
        uint32 blockTimestamp,
        int56 tickCumulative,
        uint160 secondsPerLiquidity,
        bool initialized
    );
```

