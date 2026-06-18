# DeployDemoExtraVaultsHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/8fe82accd34499f358df165500b889c234fe064a/contracts/test/Deploy.t.sol)

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

