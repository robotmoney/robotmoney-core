# AgentBasketStubDeployer
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/0f44df6c1ea9643363189d9e52250db5bd47a617/contracts/script/DeployDemoExtraVaults.s.sol)

One-shot batch deployer for the AgentTokenVault devnet basket
stand-ins (PRD §11.3 — BNKR/JUNO/ROBOTMONEY, three real-asset demo tokens).
Its constructor performs all 6 sub-`CREATE`s (three `DemoBasketToken` +
three `DemoUsdcPool`) in a single broadcaster transaction. The script
then makes one `vault.addAsset(...)` call per token with the per-asset
venue selection (BNKR→V3, JUNO→V4, ROBOTMONEY→Aerodrome). Demo-only.


## State Variables
### tokens

```solidity
DemoBasketToken[3] public tokens
```


### pools

```solidity
DemoUsdcPool[3] public pools
```


### AGENT_SYMBOLS_3

```solidity
string[3] internal AGENT_SYMBOLS_3 = ["BNKR", "JUNO", "ROBOTMONEY"]
```


## Functions
### constructor


```solidity
constructor(address usdc) ;
```

