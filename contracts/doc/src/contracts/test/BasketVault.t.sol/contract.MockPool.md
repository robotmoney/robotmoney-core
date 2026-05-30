# MockPool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/5e0758d2049cf2770fbcc743d358f5172be4f30a/contracts/test/BasketVault.t.sol)

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


### tickCumulativeRate

```solidity
int56 public tickCumulativeRate
```


### cardinality

```solidity
uint16 public cardinality
```


## Functions
### constructor


```solidity
constructor(address token0_, address token1_, uint160 sqrtPriceX96_) ;
```

### setSpot


```solidity
function setSpot(uint160 sqrtPriceX96_) external;
```

### setTickCumulativeRate


```solidity
function setTickCumulativeRate(int56 rate) external;
```

### setCardinality


```solidity
function setCardinality(uint16 cardinality_) external;
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

