# ProtocolBasketStubDeployer
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/895f74f9a312639869e61e1d4ba3dfce78950c03/contracts/script/DeployDemoExtraVaults.s.sol)

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

