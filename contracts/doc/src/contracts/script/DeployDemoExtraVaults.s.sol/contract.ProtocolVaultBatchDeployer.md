# ProtocolVaultBatchDeployer
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/2def9f9874e376c42240f560498ed7a0ea248d0e/contracts/script/DeployDemoExtraVaults.s.sol)

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

