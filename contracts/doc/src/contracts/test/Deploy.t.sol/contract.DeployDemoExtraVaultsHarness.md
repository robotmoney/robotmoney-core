# DeployDemoExtraVaultsHarness
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/Deploy.t.sol)

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

