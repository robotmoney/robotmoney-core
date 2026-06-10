# ProtocolVaultBatchDeployer
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d405ee0d62231186573c29a3046786860035c5e3/contracts/script/DeployDemoExtraVaults.s.sol)

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

