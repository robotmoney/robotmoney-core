# IUniswapV3Pool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/5e0758d2049cf2770fbcc743d358f5172be4f30a/contracts/interfaces/IUniswapV3Pool.sol)

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

