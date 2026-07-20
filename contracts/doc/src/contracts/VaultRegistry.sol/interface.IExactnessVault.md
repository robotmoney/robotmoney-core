# IExactnessVault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/01b59e20caa97f6392c68e2a81dce4c5d658f622/contracts/VaultRegistry.sol)

Minimal view the registry needs to surface a vault's vault-attested
exactness class (unified `Vault`, ADR-0010 §5.1 / C2). Declared as an
interface (not an import) to avoid a circular compile-time dependency
between the registry and the vault.


## Functions
### allExact

True iff every active adapter is vault-attested exact.


```solidity
function allExact() external view returns (bool);
```

