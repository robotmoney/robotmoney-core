# DemoAgentRwaBatchDeployer
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/f39b06a56217d7376251b1403dc50b5a82486455/contracts/script/DeployDemoExtraVaults.s.sol)

Batch deployer #2 — the real `RwaVault` (PRD §11.4, deSPXA) plus the
`AgentTokenVault` (PRD §11.3). Performs two direct sub-CREATEs inside
a single broadcaster CREATE. Kept separate from
`ProtocolVaultBatchDeployer` so combined initcode stays under
EIP-3860's 49152-byte limit (geth enforces this on the smoke-test
devnet). All vaults constructed with admin = adminAddr. Demo-only.


## Constants
### rwaVault

```solidity
RwaVault public immutable rwaVault
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
    address chronicle,
    uint256 tvlCap,
    uint256 perDepositCap
) ;
```

