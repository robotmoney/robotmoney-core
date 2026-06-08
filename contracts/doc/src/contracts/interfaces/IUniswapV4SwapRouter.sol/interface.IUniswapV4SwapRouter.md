# IUniswapV4SwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/7d2312dd62356bbc767599853c696d24039f091e/contracts/interfaces/IUniswapV4SwapRouter.sol)

**Title:**
IUniswapV4SwapRouter

Minimal Uniswap V4 swap-router interface consumed by UniswapV4SwapAdapter.
V4 uses a single-hop `exactInputSingle` call analogous to V3, but parameterised
with a `PoolKey` struct instead of a pool address + fee tier.


## Functions
### exactInputSingle

Execute a single-hop exact-input swap.


```solidity
function exactInputSingle(ExactInputSingleParams calldata params)
    external
    payable
    returns (uint256 amountOut);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`params`|`ExactInputSingleParams`| Swap parameters (see `ExactInputSingleParams`).|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`amountOut`|`uint256`|Amount of the output token received.|


## Structs
### PoolKey
Identifies a Uniswap V4 pool uniquely.


```solidity
struct PoolKey {
    /// @dev The lower-sorted token of the pair.
    address currency0;
    /// @dev The higher-sorted token of the pair.
    address currency1;
    /// @dev LP fee in hundredths of a bip (same scale as V3 fee tiers).
    uint24 fee;
    /// @dev Tick spacing for the pool (derived from fee tier for standard pools).
    int24 tickSpacing;
    /// @dev Hook contract address; `address(0)` for pools with no hook.
    address hooks;
}
```

### ExactInputSingleParams
Parameters for a single-hop exact-input swap through a V4 pool.


```solidity
struct ExactInputSingleParams {
    /// @dev Pool key identifying the V4 pool.
    PoolKey poolKey;
    /// @dev Whether to swap currency0 for currency1.
    bool zeroForOne;
    /// @dev Exact amount of the input token to sell.
    uint128 amountIn;
    /// @dev Minimum amount of the output token required; reverts if not met.
    uint128 amountOutMinimum;
    /// @dev Sqrt price limit; `0` means no price limit (execute at any price).
    uint160 sqrtPriceLimitX96;
    /// @dev Arbitrary hook data forwarded to the pool's hook on execution.
    bytes hookData;
}
```

