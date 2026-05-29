# DemoUsdcPool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d46930cf8672ef941b507edf186b49886ff48c8a/contracts/script/DeployDemoExtraVaults.s.sol)

Minimal Uniswap V3 pool stub exposing only `token0()`/`token1()`,
the two reads `BasketVault.addAsset` uses to verify a pool pairs the
basket token with USDC. Demo-only; no swap/observe liquidity.


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

