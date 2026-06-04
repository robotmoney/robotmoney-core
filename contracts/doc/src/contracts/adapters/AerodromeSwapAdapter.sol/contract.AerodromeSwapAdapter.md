# AerodromeSwapAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/39467bf9ff113c7821b3343e7468c20f3d3ee5af/contracts/adapters/AerodromeSwapAdapter.sol)

**Inherits:**
[IBasketSwapAdapter](/contracts/interfaces/IBasketSwapAdapter.sol/interface.IBasketSwapAdapter.md)

**Title:**
AerodromeSwapAdapter

BasketVault swap adapter for Aerodrome Finance CL pools.
Swaps USDC↔asset via the Aerodrome Router; prices NAV and slippage
floors via an Aerodrome CL pool TWAP (arithmetic-mean tick over
`window` seconds, identical to the Uniswap V3 oracle path).
The `stable` flag controls whether the Aerodrome Router uses the
stable-swap (constant-sum-like) or volatile-swap (constant-product)
AMM curve for the route. It is fixed at construction time per
the pool's invariant type.
The `factory` address is the Aerodrome pool factory that produced
the target pool; it is embedded in the Route struct so the router
can resolve the pool deterministically.


## Constants
### ROUTER
Aerodrome Router used for all swaps.


```solidity
IAerodromeRouter public immutable ROUTER
```


### FACTORY
Pool factory embedded in route structs. Must match the factory
that created the target CL pool.


```solidity
address public immutable FACTORY
```


### STABLE
Whether the route uses Aerodrome's stable-swap curve.
`true` for stable pools (e.g. USDC/USDT), `false` for volatile.


```solidity
bool public immutable STABLE
```


## Functions
### constructor


```solidity
constructor(address router_, address factory_, bool stable_) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`router_`|`address`| Aerodrome Router address. Must not be address(0).|
|`factory_`|`address`|Pool factory address embedded in route structs.|
|`stable_`|`bool`| Whether to use the stable-swap AMM curve for this adapter.|


### swap

Execute a single-hop swap.

The `fee` parameter is ignored; Aerodrome derives the fee from the
pool configuration rather than the route struct. The caller (BasketVault)
still passes it for interface uniformity.


```solidity
function swap(
    address tokenIn,
    address tokenOut,
    uint24, /* fee — unused by Aerodrome */
    uint256 amountIn,
    uint256 minAmountOut,
    address recipient
) external returns (uint256 amountOut);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`tokenIn`|`address`|      Address of the token to sell.|
|`tokenOut`|`address`|     Address of the token to buy.|
|`<none>`|`uint24`||
|`amountIn`|`uint256`|     Exact amount of `tokenIn` to sell.|
|`minAmountOut`|`uint256`| Minimum amount of `tokenOut` required; reverts if not met.|
|`recipient`|`address`|    Recipient of `tokenOut`.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`amountOut`|`uint256`|   Actual amount of `tokenOut` received.|


### twapPrice

Compute a TWAP-based price quote: how many `quoteToken` for `baseAmount`
of `baseToken`, reading the oracle from `pool` over `window` seconds.

Reads the arithmetic-mean tick from the Aerodrome CL pool's `observe()`
over `window` seconds and converts it to a price quote using the same
TickMath path as BasketVault's built-in Uniswap V3 TWAP.
The pool MUST be an Aerodrome CL (Slipstream) pool — classic v2 pools
do not expose `observe()` and will revert.


```solidity
function twapPrice(
    address pool,
    address baseToken,
    address quoteToken,
    uint256 baseAmount,
    uint32 window
) external view returns (uint256 quoteAmount);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`pool`|`address`|       Venue-specific pool address pairing `baseToken` with `quoteToken`.|
|`baseToken`|`address`|  Token whose amount is the input to the quote.|
|`quoteToken`|`address`| Token whose amount is the output of the quote.|
|`baseAmount`|`uint256`| Amount of `baseToken` to price.|
|`window`|`uint32`|     TWAP lookback window in seconds.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`quoteAmount`|`uint256`|Estimated amount of `quoteToken` for `baseAmount` of `baseToken`.|


### _checkPoolPair

Validates that `pool` pairs exactly `baseToken` and `quoteToken`.


```solidity
function _checkPoolPair(address pool, address baseToken, address quoteToken) internal view;
```

### _meanTick

Compute arithmetic-mean tick over `[window, 0]` seconds via `observe()`.


```solidity
function _meanTick(address pool, uint32 window) internal view returns (int24);
```

### _priceFromTick

Convert a TWAP mean tick to an output amount using sqrtPriceX96 math.


```solidity
function _priceFromTick(
    int24 meanTick,
    address baseToken,
    address quoteToken,
    uint256 baseAmount
) internal pure returns (uint256 quoteAmount);
```

## Errors
### ZeroAddress
Raised when either token is the zero address.


```solidity
error ZeroAddress();
```

### ZeroWindow
Raised when the TWAP window is zero.


```solidity
error ZeroWindow();
```

### PoolTokenMismatch
Raised when the pool's tokens do not match the requested base/quote pair.


```solidity
error PoolTokenMismatch();
```

