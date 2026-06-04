# DemoRwaStubDeployer
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/f39b06a56217d7376251b1403dc50b5a82486455/contracts/script/DeployDemoExtraVaults.s.sol)

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
DemoAerodromeRouter public immutable aeroRouter
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

