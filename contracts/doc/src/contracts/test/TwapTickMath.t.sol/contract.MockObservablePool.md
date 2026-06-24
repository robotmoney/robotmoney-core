# MockObservablePool
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a2a6d8e4e2a61d93030482a63145fd865f67cc02/contracts/test/TwapTickMath.t.sol)

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


## Functions
### constructor


```solidity
constructor(address token0_, address token1_) ;
```

### setCumulatives


```solidity
function setCumulatives(int56 cum0, int56 cum1) external;
```

### token0


```solidity
function token0() external view returns (address);
```

### token1


```solidity
function token1() external view returns (address);
```

### observe


```solidity
function observe(uint32[] calldata)
    external
    view
    returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidity);
```

