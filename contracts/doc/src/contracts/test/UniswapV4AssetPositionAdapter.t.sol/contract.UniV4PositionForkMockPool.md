# UniV4PositionForkMockPool
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/590a2c3bf7bb1b2abde217714163eb9576c910c7/contracts/test/UniswapV4AssetPositionAdapter.t.sol)

V4-style pool mock for TWAP + NAV-deviation-guard reads. Independently
settable spot/mean ticks, same shape as `UniV4PositionMockPool` above
and `MockUniswapV4Pool` in BasketVault.t.sol. TEST FIXTURE.


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
uint16 public cardinality = 100
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

