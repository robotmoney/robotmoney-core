# RevertingRetireVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/565d7a4ab968179b6f0a1db9f9fe724a77abadce/contracts/test/VaultRegistry.t.sol)

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

