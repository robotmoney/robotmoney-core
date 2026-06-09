# MockDeSPXAPool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/ea758b479e8ca22039bd13ec062ac539c6106ca4/contracts/test/RwaVault.t.sol)

Mock pool for addAsset() cardinality and liquidity gate checks.
Chronicle (not pool TWAP) is used for pricing, so observe() is never
called on hot paths. However addAsset() checks slot0.observationCardinality
and pool.liquidity(), so we implement both.


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
### cardinality

```solidity
uint16 public cardinality = 100
```


## Functions
### constructor


```solidity
constructor(address token0_, address token1_) ;
```

### setCardinality


```solidity
function setCardinality(uint16 c) external;
```

### slot0


```solidity
function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
```

### observe

observe() is not called by RwaVault (Chronicle is the price source),
but it must not revert since BasketVault has no way to skip it.
Return flat zero-tick cumulatives (tick=0 → 1:1 price ratio).


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


```solidity
function liquidity() external pure returns (uint128);
```

