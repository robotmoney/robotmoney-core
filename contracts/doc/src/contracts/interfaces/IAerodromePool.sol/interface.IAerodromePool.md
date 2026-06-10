# IAerodromePool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/4b538399027636f20b316ae10f72d0d6c6960fb1/contracts/interfaces/IAerodromePool.sol)

Minimal Aerodrome concentrated-liquidity (CL) pool interface for TWAP reads
and pool-token discovery.  Aerodrome CL pools (SlipstreamPool) follow the
Uniswap V3 observe() / slot0() ABI, so this interface is structurally
identical to IUniswapV3Pool and can be consumed by the same TWAP math.
Classic (v2-style) Aerodrome stable/volatile pools do NOT expose observe();
for TWAP-based pricing those pools must use a separate oracle path.
The AerodromeSwapAdapter only supports CL pools for TWAP reads.


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

Returns sqrtPriceX96 and tick from the pool's slot0.
Aerodrome Slipstream (CL) pools use the same slot0 ABI as Uniswap V3.
Also returns observationCardinality to verify TWAP feasibility.


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

Returns tick cumulatives and seconds-per-liquidity cumulatives
as of each `secondsAgos` timestamp.  Used to compute a
time-weighted arithmetic-mean tick for NAV and slippage floors.


```solidity
function observe(uint32[] calldata secondsAgos)
    external
    view
    returns (
        int56[] memory tickCumulatives,
        uint160[] memory secondsPerLiquidityCumulativeX128s
    );
```

