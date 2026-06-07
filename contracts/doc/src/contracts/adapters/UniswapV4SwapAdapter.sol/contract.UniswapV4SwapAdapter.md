# UniswapV4SwapAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/fd1e1fc4dc2a5a456dd5a95f2ef21cdd86bf1dfa/contracts/adapters/UniswapV4SwapAdapter.sol)

**Inherits:**
[IBasketSwapAdapter](/contracts/interfaces/IBasketSwapAdapter.sol/interface.IBasketSwapAdapter.md)

**Title:**
UniswapV4SwapAdapter

BasketVault swap adapter for Uniswap V4 pools.
Swaps USDC↔asset via the Uniswap V4 Router (exactInputSingle);
prices NAV and slippage floors via a V4 pool TWAP (arithmetic-mean
tick over `window` seconds, identical ABI to the Uniswap V3 oracle
path per EIP-7680).
The tick-spacing is derived deterministically from the fee tier using
Uniswap V4's standard mapping (500→10, 3000→60, 10000→200). Custom
fee tiers with non-standard tick spacings are not supported by this
adapter; pools with such parameters must use a bespoke adapter.
The hook address is hard-coded to address(0) (no hook). Pools that
use a hook contract must use a bespoke adapter that encodes the
hook address into the PoolKey.


## Constants
### ROUTER
Uniswap V4 Router used for all swaps.


```solidity
IUniswapV4SwapRouter public immutable ROUTER
```


## Functions
### constructor


```solidity
constructor(address router_) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`router_`|`address`| Uniswap V4 Router address. Must not be address(0).|


### swap

Execute a single-hop swap.

Constructs a V4 PoolKey from the two tokens and the fee tier, then calls
`ROUTER.exactInputSingle`. The `zeroForOne` direction is derived from
token address ordering (token0 < token1). Tokens are pulled from
`msg.sender` (BasketVault) via `transferFrom`; BasketVault approves this
adapter before calling and clears the approval after.


```solidity
function swap(
    address tokenIn,
    address tokenOut,
    uint24 fee,
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
|`fee`|`uint24`|          Venue-specific fee parameter (fee tier for Uniswap V3, ignored for Aerodrome which derives fee from pool config).|
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

Reads the arithmetic-mean tick from the V4 pool's `observe()` over
`window` seconds and converts it to a price quote using the same
TickMath path as BasketVault's built-in Uniswap V3 TWAP. The pool
MUST implement `observe(uint32[])` (EIP-7680 compatible).


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

### _tickSpacingForFee

Maps standard Uniswap V4 fee tiers to their canonical tick spacings.
Reverts with `UnsupportedFeeTier` for non-standard fee tiers.
Standard mappings: 100→1, 500→10, 3000→60, 10000→200.


```solidity
function _tickSpacingForFee(uint24 fee) internal pure returns (int24);
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

### UnsupportedFeeTier
Raised when the fee tier has no standard tick spacing mapping.


```solidity
error UnsupportedFeeTier(uint24 fee);
```

