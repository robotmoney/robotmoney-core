# DeployDemoExtraVaultsHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/b58df0d9705fd40d8110bd43d533f82a20b8ace3/contracts/test/Deploy.t.sol)

**Inherits:**
[DeployDemoExtraVaults](/contracts/script/DeployDemoExtraVaults.s.sol/contract.DeployDemoExtraVaults.md)

Test-only subclass exposing the internal TickMath link-integrity
assertion of `DeployDemoExtraVaults` so a deliberately wrong/zero
linked address can be shown to fail the deploy assertion (finding L3-D1).


## Functions
### assertTickMathLinkIntegrity


```solidity
function assertTickMathLinkIntegrity(
    address protocolVault,
    address rwaVault,
    address agentVault
) external view;
```

