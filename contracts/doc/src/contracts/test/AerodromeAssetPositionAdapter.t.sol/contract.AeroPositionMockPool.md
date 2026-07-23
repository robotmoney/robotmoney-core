# AeroPositionMockPool
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/d740448a2c3c14fa0c325f99c0cf5fb21593c110/contracts/test/AerodromeAssetPositionAdapter.t.sol)

Duck-typed Aerodrome Slipstream CL pool for the constructor
pool-usability check and the ORA-4 NAV-deviation guard. Exposes the
identical `slot0`/`observe`/`liquidity`/`token0`/`token1` ABI as
Uniswap V3 (per `IAerodromePool`), plus `tickSpacing()`. `spotTick`
(slot0) and `meanTickVal` (observe cumulatives) are independently
settable to synthesize a spot-vs-TWAP divergence. TEST FIXTURE.


## Constants
### token0

```solidity
address public immutable token0
```


### token1

```solidity
address public immutable token1
```


### tickSpacing

```solidity
int24 public immutable tickSpacing
```


## State Variables
### liquidity

```solidity
uint128 public liquidity = 1e18
```


### cardinality

```solidity
uint16 public cardinality = 2
```


### spotTick

```solidity
int24 public spotTick
```


### meanTickVal

```solidity
int24 public meanTickVal
```


## Functions
### constructor


```solidity
constructor(address a, address b, int24 tickSpacing_) ;
```

### setSpotTick


```solidity
function setSpotTick(int24 t) external;
```

### setMeanTick


```solidity
function setMeanTick(int24 t) external;
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
    returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidity);
```

