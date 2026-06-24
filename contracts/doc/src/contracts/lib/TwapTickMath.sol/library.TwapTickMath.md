# TwapTickMath
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/4b9f1e53ce2923a3a2346fb7de25157672f7633c/contracts/lib/TwapTickMath.sol)

**Title:**
TwapTickMath

Shared time-weighted-average-price tick helpers for the BasketVault
swap adapters. `AerodromeSwapAdapter` and `UniswapV4SwapAdapter`
previously carried byte-identical copies of pool-pair validation,
mean-tick computation, and price-from-tick conversion, differing only
in the concrete pool interface type. Both pool types expose the
Uniswap V3 `observe()` ABI, so the logic is consolidated here over
the minimal `IObservablePool` surface.
The arithmetic is unchanged from the prior inline implementations:
the mean tick rounds toward negative infinity when the cumulative
tick delta is negative and not an exact multiple of the window
(matching Uniswap's OracleLibrary), and the price conversion keeps
both the `uint128`-bounded `sqrtPrice` fast path and the wider
`Math.mulDiv` branch.


## Functions
### checkPoolPair

Validates that `pool` pairs exactly `baseToken` and `quoteToken`.


```solidity
function checkPoolPair(address pool, address baseToken, address quoteToken) internal view;
```

### meanTick

Compute arithmetic-mean tick over `[window, 0]` seconds via `observe()`.

`public` (not `internal`): the compiler deploys this library once and
DELEGATECALL-links it into every consumer (BasketVault + both swap
adapters), so the mean-tick + price math lives in a single deployed
contract instead of being inlined into each — keeping the
already-EIP-170-tight vault family under the 24_576-byte limit.


```solidity
function meanTick(address pool, uint32 window) public view returns (int24);
```

### deviationBps

ORA-4 / F-10 — divergence (in bps) between a pool's executable
market (slot0 spot) price and its NAV-pricing TWAP, measured on a
fixed `probeAmount` of `token` priced into `quote`.

`public` for the same single-deploy/DELEGATECALL-link reason as the
other helpers, keeping the deviation math out of the already-EIP-170-
tight vault family. Returns `type(uint256).max` sentinel-free: a zero
TWAP value yields 0 (caller treats as "no priced exposure, skip").


```solidity
function deviationBps(
    address pool,
    address token,
    address quote,
    uint32 window,
    uint256 probeAmount
) public view returns (uint256 bps);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`pool`|`address`|       The Uniswap V3 / observe-compatible pool.|
|`token`|`address`|      The basket asset (base) token.|
|`quote`|`address`|      The quote token (USDC).|
|`window`|`uint32`|     TWAP window in seconds.|
|`probeAmount`|`uint256`|Token amount to price both ways (decimals cancel in the ratio).|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`bps`|`uint256`|Absolute |spot − twap| / twap in basis points (0 when twap value is 0).|


### requireWithinDeviation

ORA-4 / F-10 — revert when `token`'s spot price diverges from its
TWAP beyond `thresholdBps`. No-op when `threshold` is 0 (guard
disabled) or the TWAP value is 0 (no priced exposure). Carrying
the full check (compute + compare + revert) here keeps the loop
body in the EIP-170-tight vault to a single external call.


```solidity
function requireWithinDeviation(
    address pool,
    address token,
    address quote,
    uint32 window,
    uint256 probeAmount,
    uint256 thresholdBps
) public view;
```

### priceFromTick

Convert a TWAP mean tick to an output amount using sqrtPriceX96 math.


```solidity
function priceFromTick(int24 tick, address baseToken, address quoteToken, uint256 baseAmount)
    public
    pure
    returns (uint256 quoteAmount);
```

## Errors
### PoolTokenMismatch
Raised when the pool's tokens do not match the requested base/quote pair.


```solidity
error PoolTokenMismatch();
```

### NavMarketDeviationExceeded
ORA-4 / F-10: spot diverged from TWAP beyond the configured threshold.


```solidity
error NavMarketDeviationExceeded(address token, uint256 deviationBps, uint256 thresholdBps);
```

