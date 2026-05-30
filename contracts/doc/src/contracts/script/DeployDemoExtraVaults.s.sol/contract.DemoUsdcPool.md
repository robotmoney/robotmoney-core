# DemoUsdcPool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/17d3c27bc19dd2e7dd9dd09c12e0fb0b8179d593/contracts/script/DeployDemoExtraVaults.s.sol)

Minimal Uniswap V3 pool stub exposing `token0()`/`token1()` and
`slot0()`. `BasketVault.addAsset` verifies that the pool pairs the
basket token with USDC and that `slot0().observationCardinality >= 2`.
Demo-only; no swap/observe liquidity.


## Constants
### token0

```solidity
address public immutable token0
```


### token1

```solidity
address public immutable token1
```


## Functions
### constructor


```solidity
constructor(address tokenA, address tokenB) ;
```

### slot0

Stub slot0 — returns observationCardinality = 2 so that
`BasketVault.addAsset` passes the MIN_POOL_CARDINALITY check.
All other fields are zeroed (unused by addAsset).


```solidity
function slot0()
    external
    pure
    returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );
```

