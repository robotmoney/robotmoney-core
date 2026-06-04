# IBasketSwapAdapter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/39467bf9ff113c7821b3343e7468c20f3d3ee5af/contracts/interfaces/IBasketSwapAdapter.sol)

**Title:**
IBasketSwapAdapter

Venue-agnostic swap + TWAP interface consumed by BasketVault.
Each concrete adapter (Uniswap V3, Aerodrome, Uniswap V4) implements
this interface so BasketVault can route per-asset swaps and TWAP reads
through the correct DEX without hardcoding venue mechanics.
The `pool` address passed to `twapPrice` is the venue-specific pool that
pairs `token` with USDC. The adapter is responsible for interpreting
`pool` correctly for its own oracle mechanics (e.g. tick-based TWAP for
Uniswap V3/V4, or `currentPeriodObservation` for Aerodrome stable pools).


## Functions
### swap

Execute a single-hop swap.


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


