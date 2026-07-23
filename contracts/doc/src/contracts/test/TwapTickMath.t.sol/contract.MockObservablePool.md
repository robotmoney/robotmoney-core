# MockObservablePool
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/d740448a2c3c14fa0c325f99c0cf5fb21593c110/contracts/test/TwapTickMath.t.sol)

**Inherits:**
[IObservablePool](/contracts/interfaces/IObservablePool.sol/interface.IObservablePool.md)

Minimal mock implementing the `IObservablePool` surface. `observe()`
returns a pre-set tickCumulatives pair so `meanTick` can be exercised
across boundary inputs without a live pool.


## State Variables
### _token0

```solidity
address private _token0
```


### _token1

```solidity
address private _token1
```


### _cum0

```solidity
int56 private _cum0
```


### _cum1

```solidity
int56 private _cum1
```


### _spotTick

```solidity
int24 private _spotTick
```


## Functions
### constructor


```solidity
constructor(address token0_, address token1_) ;
```

### setCumulatives


```solidity
function setCumulatives(int56 cum0, int56 cum1) external;
```

### setSpotTick


```solidity
function setSpotTick(int24 tick) external;
```

### token0


```solidity
function token0() external view returns (address);
```

### token1


```solidity
function token1() external view returns (address);
```

### slot0

Truncated to the 4-field `IObservablePool.slot0()` surface (issue
#1125) — unused here beyond satisfying the interface.


```solidity
function slot0() external view returns (uint160, int24, uint16, uint16);
```

### observe


```solidity
function observe(uint32[] calldata)
    external
    view
    returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidity);
```

