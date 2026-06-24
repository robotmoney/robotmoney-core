# ProtocolBasketStubDeployer
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/829e61766b365e1704d8f027d8ca3d18f7ce4b26/contracts/script/DeployDemoExtraVaults.s.sol)

One-shot batch deployer for the ProtocolAssetVault devnet basket
stand-ins (PRD §11.2 — wETH, cbBTC, wSOL). Mirrors the
`AgentBasketStubDeployer` shape: 6 sub-CREATEs (3 stand-in tokens
+ 3 USDC pool stubs) in a single broadcaster CREATE. Demo-only.


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

