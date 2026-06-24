# ProtocolVaultBatchDeployer
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/b58df0d9705fd40d8110bd43d533f82a20b8ace3/contracts/script/DeployDemoExtraVaults.s.sol)

Batch deployer #1 — the canonical `ProtocolAssetVault` (PRD §11.2)
deployed inside a single broadcaster CREATE. Constructed with
admin = adminAddr (the script broadcaster) so subsequent
`addAsset` + registry calls remain on the broadcast key. Demo-only.


## Constants
### protocolVault

```solidity
ProtocolAssetVault public immutable protocolVault
```


## Functions
### constructor


```solidity
constructor(
    address usdc,
    address adminAddr,
    address emergencyResponder,
    address swapRouter,
    uint256 tvlCap,
    uint256 perDepositCap
) ;
```

