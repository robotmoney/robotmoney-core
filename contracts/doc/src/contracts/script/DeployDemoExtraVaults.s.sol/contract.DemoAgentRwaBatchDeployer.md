# DemoAgentRwaBatchDeployer
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e510165068242bce9f66644554c06e4b10fa3775/contracts/script/DeployDemoExtraVaults.s.sol)

Batch deployer #2 — the RWA/Thematic placeholder vault (PRD §11.4)
plus the `AgentTokenVault` (PRD §11.3). Performs two direct
sub-CREATEs inside a single broadcaster CREATE. Kept separate
from `ProtocolVaultBatchDeployer` so combined initcode stays under
EIP-3860's 49152-byte limit (geth enforces this on the smoke-test
devnet). All vaults constructed with admin = adminAddr. Demo-only.


## Constants
### rwaVault

```solidity
RobotMoneyVault public immutable rwaVault
```


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

