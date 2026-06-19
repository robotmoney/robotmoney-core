# AerodromeSwapAdapter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/9f4d89b73f3bc3e6fe6c5dd86696328d5a028502/contracts/adapters/AerodromeSwapAdapter.sol)

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
Aerodrome Slipstream router used for all swaps.


```solidity
IAerodromeSlipstreamRouter public immutable ROUTER
```


### FACTORY
Factory that resolves canonical Slipstream CL pools.


```solidity
IAerodromeCLFactory public immutable FACTORY
```


## Functions
### constructor


```solidity
constructor(address router_, address factory_) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`router_`|`address`| Aerodrome Router address. Must not be address(0).|
|`factory_`|`address`|Aerodrome Slipstream CL factory address.|


### swap

Execute a single-hop swap.

The `fee` parameter is ignored; Aerodrome derives the fee from the
pool configuration rather than the route struct. The caller (BasketVault)
still passes it for interface uniformity. The caller-chosen `deadline`
is forwarded to the Aerodrome Router, which reverts when expired
(audit 2026-06-09, L-5).


```solidity
function swap(
    address tokenIn,
    address tokenOut,
    uint24 fee,
    uint256 amountIn,
    uint256 minAmountOut,
    address recipient,
    uint256 deadline
) external returns (uint256 amountOut);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`tokenIn`|`address`|      Address of the token to sell.|
|`tokenOut`|`address`|     Address of the token to buy.|
|`fee`|`uint24`|          Venue-specific fee parameter (fee tier for Uniswap V3, ignored for Aerodrome which derives fee from pool config).|
|`amountIn`|`uint256`|     Exact amount of `tokenIn` to sell.|
|`minAmountOut`|`uint256`| Minimum amount of `tokenOut` required; reverts if not met.|
|`recipient`|`address`|    Recipient of `tokenOut`.|
|`deadline`|`uint256`|     Unix timestamp after which the swap must revert. Chosen by the caller — adapters must not substitute `block.timestamp` (audit 2026-06-09, L-5). Callers that execute synchronously within their own transaction (e.g. BasketVault) may pass `block.timestamp`.|

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

### PoolFactoryMismatch
Raised when the supplied pool was not produced by the configured
Slipstream CL factory for the resolved token pair / tick spacing.


```solidity
error PoolFactoryMismatch(address expected, address actual);
```

### InvalidTickSpacing
Raised when the `fee`-derived tick spacing is zero or out of int24 range.


```solidity
error InvalidTickSpacing();
```

### PoolNotFound
Raised when the factory has no canonical pool for the requested
token pair and tick spacing.


```solidity
error PoolNotFound(address tokenIn, address tokenOut, int24 tickSpacing);
```

