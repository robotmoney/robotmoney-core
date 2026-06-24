# IRetirableVaultLink
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/fb9985be700340695a515ae6d42f97a508023e8d/contracts/script/DeployTimelock.s.sol)

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

