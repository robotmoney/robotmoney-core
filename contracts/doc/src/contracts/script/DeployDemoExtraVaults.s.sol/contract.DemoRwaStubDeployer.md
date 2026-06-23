# DemoRwaStubDeployer
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a7ac64337cc2843fe9fad5c808ffb035e51d4697/contracts/script/DeployDemoExtraVaults.s.sol)

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

