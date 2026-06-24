# IRetirableVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c509d0100d3df416d312069339974e56f8ecce75/contracts/VaultRegistry.sol)

Minimal view the registry needs to drive the vault deposit-halt leg of
the unified governance `retire()` action (DI-2). Declared as an
interface (not an import) to avoid a circular compile-time dependency
between the registry and the vault. The vault gates both calls to its
linked registry, so the registry's authority over the vault is narrow
(deposit-halt only, not full `ADMIN_ROLE`).


## Functions
### retire

Hard-stop direct deposits on the vault.


```solidity
function retire() external;
```

### unretire

Re-open direct deposits on the vault (governance abort).


```solidity
function unretire() external;
```

