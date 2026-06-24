# DemoRwaBatchDeployer
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/fb9985be700340695a515ae6d42f97a508023e8d/contracts/script/DeployDemoExtraVaults.s.sol)

Batch deployer #2a — the real `RwaVault` (PRD §11.4, deSPXA) alone.
Split from `DemoAgentBatchDeployer` to keep each batch deployer's
initcode under EIP-3860's 49152-byte limit (geth enforces this on
the smoke-test devnet). `RwaVault` initcode is ~25KB; combining it
with `AgentTokenVault` (~24KB) would push combined initcode to ~51KB,
which exceeds the geth limit. Demo-only.


## Constants
### rwaVault

```solidity
RwaVault public immutable rwaVault
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

