# RevertingRetireVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/174c53454088cd318240a18aade465c225fdb078/contracts/test/VaultRegistry.t.sol)

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

