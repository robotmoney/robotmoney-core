# RevertingRetireVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/829e61766b365e1704d8f027d8ca3d18f7ce4b26/contracts/test/VaultRegistry.t.sol)

Vault whose retire() always reverts — used to assert that
VaultRegistry.setVaultStatus propagates the revert (AZ-REG-1 fix).


## Functions
### retire


```solidity
function retire() external pure;
```

### unretire


```solidity
function unretire() external pure;
```

## Errors
### RetireHookFailed

```solidity
error RetireHookFailed();
```

