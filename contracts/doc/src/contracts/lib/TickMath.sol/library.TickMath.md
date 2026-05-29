# TickMath
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cf8a75c9169f98b8e30f0ad4e13af73b36f22bc7/contracts/lib/TickMath.sol)

**Title:**
TickMath

Minimal port of Uniswap V3 `TickMath.getSqrtRatioAtTick`. The full
library exposes both directions (tick<->sqrtRatio); only the
tick → sqrtPriceX96 conversion is required to translate the
arithmetic-mean TWAP tick returned by `IUniswapV3Pool.observe()`
into the sqrtPriceX96 representation consumed by BasketVault's
existing `_quote()` math.
Source: Uniswap v3-core v1.0.0,
<https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol>.
The arithmetic is unchanged; only solidity version pragmas and the
absent inverse direction differ.


## Constants
### MIN_TICK
The minimum tick that may be passed to `getSqrtRatioAtTick`.


```solidity
int24 internal constant MIN_TICK = -887272
```


### MAX_TICK
The maximum tick that may be passed to `getSqrtRatioAtTick`.


```solidity
int24 internal constant MAX_TICK = -MIN_TICK
```


## Functions
### getSqrtRatioAtTick

Calculates sqrt(1.0001^tick) * 2^96 as a Q64.96.


```solidity
function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`tick`|`int24`|The input tick for the above formula.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`sqrtPriceX96`|`uint160`|A Fixed point Q64.96 number representing the sqrt of the ratio of the two assets (token1/token0) at the given tick.|


## Errors
### TickOutOfBounds
Raised when `tick` is outside the supported `[MIN_TICK, MAX_TICK]`
range. Mirrors Uniswap's `T` revert reason as a typed error.


```solidity
error TickOutOfBounds();
```

