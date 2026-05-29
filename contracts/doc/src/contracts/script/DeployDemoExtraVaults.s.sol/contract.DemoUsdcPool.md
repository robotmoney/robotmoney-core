# DemoUsdcPool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cf8a75c9169f98b8e30f0ad4e13af73b36f22bc7/contracts/script/DeployDemoExtraVaults.s.sol)

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

