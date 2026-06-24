# IAerodromeRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/e699d5af7edaf7c4c89b6772ee092727a36235c7/contracts/interfaces/IAerodromeRouter.sol)

Minimal Aerodrome Router interface for single-hop token swaps.
Aerodrome uses (tokenA, tokenB, stable, factory) route tuples
instead of Uniswap V3 fee-tier paths.


## Functions
### swapExactTokensForTokens

Swap an exact amount of tokens for as many output tokens as possible,
using the given route sequence.


```solidity
function swapExactTokensForTokens(
    uint256 amountIn,
    uint256 amountOutMin,
    Route[] calldata routes,
    address to,
    uint256 deadline
) external returns (uint256[] memory amounts);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`amountIn`|`uint256`|     Exact input amount.|
|`amountOutMin`|`uint256`| Minimum output; reverts if not met.|
|`routes`|`Route[]`|       Ordered array of swap hops.|
|`to`|`address`|           Recipient of output tokens.|
|`deadline`|`uint256`|     Unix timestamp after which the swap reverts.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`amounts`|`uint256[]`|     Array of amounts swapped at each hop.|


### defaultFactory

Returns the canonical pool factory address.


```solidity
function defaultFactory() external view returns (address);
```

## Structs
### Route

```solidity
struct Route {
    address from;
    address to;
    bool stable;
    address factory;
}
```

