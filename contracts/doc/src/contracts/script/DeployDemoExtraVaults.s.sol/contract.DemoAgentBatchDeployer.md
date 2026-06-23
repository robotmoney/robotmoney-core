# DemoAgentBatchDeployer
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a7ac64337cc2843fe9fad5c808ffb035e51d4697/contracts/script/DeployDemoExtraVaults.s.sol)

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

