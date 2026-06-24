# DeployDemoExtraVaultsHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/4b9f1e53ce2923a3a2346fb7de25157672f7633c/contracts/test/Deploy.t.sol)

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

