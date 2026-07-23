# IAerodromePool
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/d740448a2c3c14fa0c325f99c0cf5fb21593c110/contracts/interfaces/IAerodromePool.sol)

Minimal Aerodrome concentrated-liquidity (CL) pool interface for TWAP reads
and pool-token discovery.  Aerodrome CL pools (SlipstreamPool) follow the
Uniswap V3 `observe()` ABI, so `token0`/`token1`/`observe()` here are
structurally identical to `IUniswapV3Pool` and can be consumed by the
same TWAP math.
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

### tickSpacing


```solidity
function tickSpacing() external view returns (int24);
```

### slot0

Returns sqrtPriceX96 and tick from the pool's slot0.

Aerodrome Slipstream (`CLPool`) `slot0` is a 6-field public struct —
`(sqrtPriceX96, tick, observationIndex, observationCardinality,
observationCardinalityNext, unlocked)` — with NO `feeProtocol` member,
unlike the 7-field Uniswap V3 `slot0()` (issue #1125; verified
on-chain against the Base wETH/USDC Slipstream pool and the upstream
`aerodrome-finance/slipstream` `CLPool.sol` source). Declaring 7
fields here would decode past the actual 6-word return and revert on
every real call. `BasketAssetConfigGuard`/`TwapTickMath` read
cardinality/spot-tick through the venue-agnostic, further-truncated
`IObservablePool.slot0()` (4 leading fields) instead of this member.


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

