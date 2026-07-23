# IExactnessVault
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/VaultRegistry.sol)

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

