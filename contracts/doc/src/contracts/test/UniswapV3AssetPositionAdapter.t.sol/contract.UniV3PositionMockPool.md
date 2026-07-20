# UniV3PositionMockPool
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/cd218849ca46daf6891cc2b350fd6bac2d9f644b/contracts/test/UniswapV3AssetPositionAdapter.t.sol)

Duck-typed Uniswap V3 pool for the constructor pool-usability check and
the ORA-4 NAV-deviation guard. `spotTick` (slot0) and `meanTickVal`
(observe cumulatives) are independently settable to synthesize a
spot-vs-TWAP divergence. TEST FIXTURE.


## Constants
### token0

```solidity
address public immutable token0
```


### token1

```solidity
address public immutable token1
```


### fee

```solidity
uint24 public immutable fee
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
constructor(address a, address b, uint24 fee_) ;
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

