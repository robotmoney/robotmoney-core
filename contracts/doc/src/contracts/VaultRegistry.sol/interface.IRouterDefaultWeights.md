# IRouterDefaultWeights
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/1a25788704e847c258d9460b66a6534bffb0b77e/contracts/VaultRegistry.sol)

Minimal view the registry needs from `PortfolioRouter` to keep the
default weight vector's length consistent with router eligibility.
Declared as an interface (not an import) to avoid a circular
compile-time dependency between the two contracts.


## Functions
### defaultWeightsLength

Number of legs in the router's default weight vector.


```solidity
function defaultWeightsLength() external view returns (uint256);
```

### applyMigrationDefaultWeights

Registry-only entry point that sets the router's default-weight
vector. Called by `migrateEligibility` after this registry has
already updated `routerEligibleCount`, so the router's own
length check sees the new count and the eligibility flip + weight
write land in one transaction. ADR-0002 migration interlock fix
(H-A1, issue #1128).


```solidity
function applyMigrationDefaultWeights(address[] calldata vaults, uint256[] calldata bps)
    external;
```

