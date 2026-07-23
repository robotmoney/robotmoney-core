# UniswapV3SwapAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/cd218849ca46daf6891cc2b350fd6bac2d9f644b/contracts/adapters/UniswapV3SwapAdapter.sol)

**Inherits:**
[IBasketSwapAdapter](/contracts/interfaces/IBasketSwapAdapter.sol/interface.IBasketSwapAdapter.md)

**Title:**
UniswapV3SwapAdapter

BasketVault / AssetPositionAdapter swap adapter for Uniswap V3 pools.
Swaps USDC↔asset via the Uniswap V3 SwapRouter02 (`exactInputSingle`);
prices NAV and slippage floors via a V3 pool TWAP (arithmetic-mean
tick over `window` seconds).
The `fee` parameter passed to `swap()` is the V3 pool fee tier (in
hundredths of a bip, e.g. 500 = 0.05%). The `pool` address passed to
`twapPrice()` must be the V3 pool that pairs `baseToken` with
`quoteToken`; it is used exclusively for TWAP `observe()` reads, while
the router resolves the execution pool from the token pair + fee tier
(ORA-3: callers pin both to the SAME pool).


## Constants
### ROUTER
Uniswap V3 SwapRouter02 used for all swaps.

Base mainnet: 0x2626664c2603336E57B271c5C0b26F421741e481.


```solidity
ISwapRouter public immutable ROUTER
```


## Functions
### constructor


```solidity
constructor(address router_) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`router_`|`address`|Uniswap V3 SwapRouter02 address. Must not be address(0).|


### swap

Execute a single-hop swap.

Pulls `amountIn` of `tokenIn` from `msg.sender` (the caller must have
approved this adapter, mirroring BasketVault's `forceApprove(adapter,
amountIn)` choreography), then swaps via SwapRouter02 with the caller-
chosen `deadline` (audit 2026-06-09, L-5). Approval hygiene: exact
`forceApprove` before the call, unconditional reset to 0 after (ADP-5).
SwapRouter02 delivers `tokenOut` straight to `recipient`.


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

Arithmetic-mean tick over `[window, 0]` seconds, converted to an
output amount via the shared `TwapTickMath` library (identical to the
Uniswap OracleLibrary rounding). Reverts `PoolTokenMismatch` when
`pool` does not pair exactly `baseToken`/`quoteToken`.


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
Raised when either token or the router is the zero address.


```solidity
error ZeroAddress();
```

### ZeroWindow
Raised when the TWAP window is zero.


```solidity
error ZeroWindow();
```

### DeadlineExpired
Raised when the caller-chosen swap deadline has already passed.


```solidity
error DeadlineExpired(uint256 deadline, uint256 nowTs);
```

