# DemoRwaStubDeployer
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/fb9985be700340695a515ae6d42f97a508023e8d/contracts/script/DeployDemoExtraVaults.s.sol)

One-shot batch deployer for the RWA vault devnet stubs (PRD §11.4).
Deploys the deSPXA stand-in token, its USDC pool stub, the demo
Chronicle oracle stub, and the ChronicleOracleAdapter in a single
CREATE. Used by `DemoRwaBatchDeployer` to satisfy the RwaVault
`addAsset` gate (cardinality + liquidity) on the demo devnet.
Demo-only; never deployed on mainnet.


## Constants
### despxaToken

```solidity
DemoBasketToken public immutable despxaToken
```


### pool

```solidity
DemoUsdcPool public immutable pool
```


### chronicle

```solidity
DemoChronicleOracle public immutable chronicle
```


### aeroRouter

```solidity
DemoRwaAerodromeRouter public immutable aeroRouter
```


### chronicleAdapter

```solidity
ChronicleOracleAdapter public immutable chronicleAdapter
```


## Functions
### constructor


```solidity
constructor(address usdc) ;
```

