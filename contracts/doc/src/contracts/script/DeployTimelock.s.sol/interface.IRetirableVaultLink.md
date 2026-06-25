# IRetirableVaultLink
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/565d7a4ab968179b6f0a1db9f9fe724a77abadce/contracts/script/DeployTimelock.s.sol)

Minimal vault interface used to link the registry into the vault so the
unified governance `retire()` action (DI-2) can drive the vault's
deposit-halt leg. `setRegistry` is set-once and ADMIN_ROLE-gated.


## Functions
### setRegistry


```solidity
function setRegistry(address newRegistry) external;
```

### registry


```solidity
function registry() external view returns (address);
```

