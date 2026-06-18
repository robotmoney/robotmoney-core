# TwapTickMath
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a850937c469fed3e92eb9f004e12f595cf9f2447/contracts/lib/TwapTickMath.sol)

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


```solidity
function meanTick(address pool, uint32 window) internal view returns (int24);
```

### priceFromTick

Convert a TWAP mean tick to an output amount using sqrtPriceX96 math.


```solidity
function priceFromTick(int24 tick, address baseToken, address quoteToken, uint256 baseAmount)
    internal
    pure
    returns (uint256 quoteAmount);
```

## Errors
### PoolTokenMismatch
Raised when the pool's tokens do not match the requested base/quote pair.


```solidity
error PoolTokenMismatch();
```

