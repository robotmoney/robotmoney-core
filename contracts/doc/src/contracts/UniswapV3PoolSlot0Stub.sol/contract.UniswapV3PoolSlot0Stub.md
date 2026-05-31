# UniswapV3PoolSlot0Stub
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cfe094f56f7148155d6999efbd87ac66367ad208/contracts/UniswapV3PoolSlot0Stub.sol)

**Title:**
UniswapV3PoolSlot0Stub

Minimal IUniswapV3Pool stub for the smoke-test devnet price strip.
Implements only `slot0()`.  Full Uniswap V3 semantics (swap,
mint, burn, observe, flash) are intentionally absent — the dapp
only calls `slot0` to derive a mid-price.
One instance is deployed per price-strip pair:
- ETH/USD   (sqrtPriceX96 ≈ $2 500)
- wETH/USDC (same price, separate address per dex-pools.json entry)
- cbBTC/USDC (sqrtPriceX96 ≈ $60 000)
- wSOL/USDC  (sqrtPriceX96 ≈ $150)
Constructor arguments follow the ABI used by `DeployDemoUniswapV3Stubs`:
uint160 sqrtPriceX96 — the fixed square-root price (Q64.96)
NEVER deploy on a real chain.  Demo/devnet only.


## Constants
### _sqrtPriceX96

```solidity
uint160 private immutable _sqrtPriceX96
```


## Functions
### constructor


```solidity
constructor(uint160 sqrtPriceX96) ;
```

### slot0

Returns the fixed slot0 for this stub pool.
- `sqrtPriceX96`              — set at construction (fixed seed price)
- `tick`                      — 0 (unused by the dapp price strip)
- `observationIndex`          — 0
- `observationCardinality`    — 1 (minimum valid value)
- `observationCardinalityNext`— 1
- `feeProtocol`               — 0
- `unlocked`                  — true


```solidity
function slot0()
    external
    view
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

