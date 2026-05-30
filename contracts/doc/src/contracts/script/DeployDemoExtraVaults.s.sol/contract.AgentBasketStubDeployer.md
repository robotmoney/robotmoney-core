# AgentBasketStubDeployer
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/f8cc494733d881fe168b95aea3df5da6400c759b/contracts/script/DeployDemoExtraVaults.s.sol)

One-shot batch deployer for the AgentTokenVault devnet basket
stand-ins (PRD §11.3). Its constructor performs all 12 sub-`CREATE`s
(six `DemoBasketToken` + six `DemoUsdcPool`) in a single broadcaster
transaction. The script then makes one `vault.addAsset(...)` call
per token. Collapses the per-symbol broadcast loop from 18 tx
(6 × token + pool + addAsset) down to 7, keeping smoke-test
chain-boot inside the dapp-e2e `globalSetup` budget on GH-hosted
runners. Demo-only.


## State Variables
### tokens

```solidity
DemoBasketToken[6] public tokens
```


### pools

```solidity
DemoUsdcPool[6] public pools
```


## Functions
### constructor


```solidity
constructor(string[6] memory symbols, address usdc) ;
```

