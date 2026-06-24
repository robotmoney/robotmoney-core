# IObservablePool
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/5a164c31574dc88f5c31048af5cc49fb7a941a1f/contracts/interfaces/IObservablePool.sol)

**Title:**
IObservablePool

Minimal pool surface required by the shared TWAP tick math: the two
pool tokens plus the Uniswap V3 `observe()` ABI. Both Aerodrome CL
(Slipstream) pools and Uniswap V4 pools expose this ABI, so the
arithmetic-mean tick computation in `TwapTickMath` can be shared
across adapters without depending on either concrete pool interface.
This interface intentionally omits `slot0()`, `liquidity()`, and the
other members of `IAerodromePool` / `IUniswapV4Pool`; those remain on
the venue-specific interfaces and are unrelated to mean-tick pricing.


## Functions
### token0

Returns the address of token0 in the pool.


```solidity
function token0() external view returns (address);
```

### token1

Returns the address of token1 in the pool.


```solidity
function token1() external view returns (address);
```

### observe

Returns cumulative tick and seconds-per-liquidity values at each
`secondsAgos[i]` seconds in the past. Identical ABI to
`IUniswapV3Pool.observe()`.


```solidity
function observe(uint32[] calldata secondsAgos)
    external
    view
    returns (
        int56[] memory tickCumulatives,
        uint160[] memory secondsPerLiquidityCumulativeX128s
    );
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`secondsAgos`|`uint32[]`|Array of elapsed seconds for each observation. `[window, 0]` is the canonical two-point TWAP read pattern.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`tickCumulatives`|`int56[]`|Cumulative tick values at each requested time.|
|`secondsPerLiquidityCumulativeX128s`|`uint160[]`|Seconds-per-liquidity cumulatives (unused for TWAP).|


