# IObservablePool
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/d740448a2c3c14fa0c325f99c0cf5fb21593c110/contracts/interfaces/IObservablePool.sol)

**Title:**
IObservablePool

Minimal pool surface required by the shared TWAP tick math: the two
pool tokens, the Uniswap V3 `observe()` ABI, and the leading fields
of `slot0()`. Both Aerodrome CL (Slipstream) pools and Uniswap V4
pools expose `token0`/`token1`/`observe()` identically to Uniswap
V3, so the arithmetic-mean tick computation in `TwapTickMath` can be
shared across adapters without depending on either concrete pool
interface.
`slot0()` here is intentionally TRUNCATED to its first four fields
(`sqrtPriceX96`, `tick`, `observationIndex`, `observationCardinality`)
rather than the full 7-field Uniswap V3 tuple (issue #1125): a real
Aerodrome Slipstream `CLPool.slot0` is a 6-field public struct with
NO `feeProtocol` member (`sqrtPriceX96, tick, observationIndex,
observationCardinality, observationCardinalityNext, unlocked` —
verified on-chain against the Base wETH/USDC Slipstream pool and the
upstream `aerodrome-finance/slipstream` `CLPool.sol` source, 2026-07).
Decoding a longer return type than the callee actually returns
reverts (buffer underrun); decoding a SHORTER prefix than the callee
returns is safe (trailing bytes are simply unread). Truncating to
the 4 leading fields both venues share in the same positions makes
this interface's `slot0()` ABI-compatible with genuine Uniswap V3
pools (7 fields), genuine Aerodrome Slipstream pools (6 fields), and
Uniswap V4 pools, so `BasketAssetConfigGuard.requirePoolUsable` and
`TwapTickMath.deviationBps` can read cardinality/spot-tick through a
single venue-agnostic call site instead of branching per venue.
`liquidity()` and the other members of `IAerodromePool` /
`IUniswapV4Pool` remain on the venue-specific interfaces and are
unrelated to mean-tick pricing.


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

### slot0

Truncated `slot0()` read: only the 4 leading fields common to
Uniswap V3 (7 fields) and Aerodrome Slipstream (6 fields, no
`feeProtocol`) `slot0` layouts. See the interface NatSpec for
why decoding a shorter prefix is the venue-agnostic fix.


```solidity
function slot0()
    external
    view
    returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality
    );
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`sqrtPriceX96`|`uint160`|Current sqrt price.|
|`tick`|`int24`|Current spot tick.|
|`observationIndex`|`uint16`|Most-recently-updated observations index.|
|`observationCardinality`|`uint16`|Current number of stored observation slots.|


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


