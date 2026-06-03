# DemoUsdcPool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/0f44df6c1ea9643363189d9e52250db5bd47a617/contracts/script/DeployDemoExtraVaults.s.sol)

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

### liquidity

Stub liquidity — returns a value above MIN_POOL_LIQUIDITY (1e6)
so that `BasketVault.addAsset` passes the minimum-liquidity gate.
Demo pools are not real Uniswap V3 pools; this value is purely
a stub to satisfy the gate check without forking mainnet.


```solidity
function liquidity() external pure returns (uint128);
```

### observe

Stub observe — returns zero tick cumulatives (1:1 price, tick=0)
over any requested window. BasketVault._twapQuote uses this to
compute the TWAP minimum swap output: at tick=0 the price is 1:1
(1 basket token = 1 USDC). Demo-only; no real TWAP data.


```solidity
function observe(uint32[] calldata secondsAgos)
    external
    pure
    returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq);
```

