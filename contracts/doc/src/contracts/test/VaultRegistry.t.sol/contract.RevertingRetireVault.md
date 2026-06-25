# RevertingRetireVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/ff7f6357fae66fafd4ea43a7ad5248daf223b17f/contracts/test/VaultRegistry.t.sol)

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

