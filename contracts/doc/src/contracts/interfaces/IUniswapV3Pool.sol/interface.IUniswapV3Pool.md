# IUniswapV3Pool
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/829e61766b365e1704d8f027d8ca3d18f7ce4b26/contracts/interfaces/IUniswapV3Pool.sol)

Minimal Uniswap V3 Pool interface used for slot0 pricing and
TWAP reads via `observe()`.


## Functions
### token0


```solidity
function token0() external view returns (address);
```

### token1


```solidity
function token1() external view returns (address);
```

### fee

The pool's fee tier in hundredths of a bip (e.g. 3000 = 0.30%).

Used by `BasketVault.addAsset` to assert that the execution pool
resolved from the configured `swapFee` is the SAME pool the NAV TWAP
is read from (invariant ORA-3 / finding F-09). Uniswap V3 and
observe-compatible Uniswap V4 pools both expose this accessor.


```solidity
function fee() external view returns (uint24);
```

### liquidity

The in-range liquidity available to the pool.

This value does not include out-of-range concentrated liquidity
positions. Used by `BasketVault.addAsset` to enforce a minimum-
liquidity floor before activating an asset.


```solidity
function liquidity() external view returns (uint128);
```

### slot0


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

### observe

Returns the cumulative tick and liquidity as of each timestamp
`secondsAgos` from the current block timestamp.

`secondsAgos[i]` is the number of seconds in the past to compute
the cumulative against. The first cumulative is at `secondsAgos[0]`
seconds in the past, the second at `secondsAgos[1]`, and so on.


```solidity
function observe(uint32[] calldata secondsAgos)
    external
    view
    returns (
        int56[] memory tickCumulatives,
        uint160[] memory secondsPerLiquidityCumulativeX128s
    );
```

### observations

Returns observation cardinality (number of slots available for
historical price storage). Required to verify that a TWAP
window of `W` seconds has sufficient observations to be
manipulation-resistant.


```solidity
function observations(uint256 index)
    external
    view
    returns (
        uint32 blockTimestamp,
        int56 tickCumulative,
        uint160 secondsPerLiquidityCumulativeX128,
        bool initialized
    );
```

