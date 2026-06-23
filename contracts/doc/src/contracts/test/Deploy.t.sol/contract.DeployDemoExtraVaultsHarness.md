# DeployDemoExtraVaultsHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a7ac64337cc2843fe9fad5c808ffb035e51d4697/contracts/test/Deploy.t.sol)

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

