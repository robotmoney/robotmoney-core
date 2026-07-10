# IRetirableVaultLink
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3da70a180fe71635ce61a9d127b7f2d7f7b3cbf5/contracts/script/DeployTimelock.s.sol)

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

