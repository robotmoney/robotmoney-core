# DemoAgentBatchDeployer
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/2c36c8c1f505bf99870d94b72352925723aa9588/contracts/script/DeployDemoExtraVaults.s.sol)

Batch deployer #2b — the `AgentTokenVault` (PRD §11.3) alone.
Split from the former `DemoAgentRwaBatchDeployer` to keep each
batch deployer's initcode under EIP-3860's 49152-byte limit.
All vaults constructed with admin = adminAddr. Demo-only.


## Constants
### agentVault

```solidity
AgentTokenVault public immutable agentVault
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

