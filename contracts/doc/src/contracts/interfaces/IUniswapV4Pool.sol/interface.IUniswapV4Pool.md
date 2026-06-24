# IUniswapV4Pool
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/fb9985be700340695a515ae6d42f97a508023e8d/contracts/interfaces/IUniswapV4Pool.sol)

**Title:**
IUniswapV4Pool

Minimal Uniswap V4 pool interface consumed by UniswapV4SwapAdapter.
V4 pools expose the same `observe(uint32[] secondsAgos)` TWAP interface
as V3 (EIP-7680 compatibility), so the arithmetic-mean tick computation
is identical to the V3 path in BasketVault._twapQuote().


## Functions
### token0

Returns the addresses of the two tokens in the pool.


```solidity
function token0() external view returns (address);
```

### token1

Returns the addresses of the two tokens in the pool.


```solidity
function token1() external view returns (address);
```

### observe

Returns cumulative tick and seconds-per-liquidity values at each
`secondsAgos[i]` seconds in the past. Identical ABI to IUniswapV3Pool.observe().


```solidity
function observe(uint32[] calldata secondsAgos)
    external
    view
    returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`secondsAgos`|`uint32[]`|Array of elapsed seconds for each observation. `[window, 0]` is the canonical two-point TWAP read pattern.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`tickCumulatives`|`int56[]`|  Cumulative tick values at each requested time.|
|`secondsPerLiquidityCumulativeX128`|`uint160[]`|Seconds-per-liquidity cumulatives (unused for TWAP).|


### slot0

Returns the pool's observation cardinality (number of stored snapshots).
Used by BasketVault.addAsset() to gate pool registration.


```solidity
function slot0()
    external
    view
    returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );
```

### liquidity

Returns the current in-range liquidity of the pool.
Used by BasketVault.addAsset() to verify minimum pool depth.


```solidity
function liquidity() external view returns (uint128);
```

