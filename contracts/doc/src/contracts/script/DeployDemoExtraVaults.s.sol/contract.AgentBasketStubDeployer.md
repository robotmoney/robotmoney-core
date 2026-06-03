# AgentBasketStubDeployer
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/51bc4e0872e897b6ac297f478bbafc344398550d/contracts/script/DeployDemoExtraVaults.s.sol)

One-shot batch deployer for the AgentTokenVault devnet basket
stand-ins (PRD §11.3). Its constructor performs all 6 sub-`CREATE`s
(three `DemoBasketToken` + three `DemoUsdcPool`) in a single broadcaster
transaction. The script then makes one `vault.addAsset(...)` call
per token. Revised from six to three tokens per ADR-0001 (2026-06-02):
Base-liquid set {BNKR, JUNO, ROBOTMONEY}. Demo-only.


## State Variables
### tokens

```solidity
DemoBasketToken[3] public tokens
```


### pools

```solidity
DemoUsdcPool[3] public pools
```


## Functions
### constructor


```solidity
constructor(string[3] memory symbols, address usdc) ;
```

