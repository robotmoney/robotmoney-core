# MockAerodromePool
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/b26f69ebc017ed65ec1995613224744c7754ee26/contracts/test/BasketVault.t.sol)

Aerodrome-style CL pool mock: observe() returns tick cumulatives like MockPool.
Also implements token0/token1 and slot0 so addAsset cardinality check passes.


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
int24 public constant tickSpacing = 100
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
function observations(uint256) external view returns (uint32, int56, uint160, bool);
```

### liquidity

Return sufficient liquidity so addAsset's MIN_POOL_LIQUIDITY gate passes.


```solidity
function liquidity() external pure returns (uint128);
```

