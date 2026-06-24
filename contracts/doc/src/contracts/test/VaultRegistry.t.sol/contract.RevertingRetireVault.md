# RevertingRetireVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/5a164c31574dc88f5c31048af5cc49fb7a941a1f/contracts/test/VaultRegistry.t.sol)

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

