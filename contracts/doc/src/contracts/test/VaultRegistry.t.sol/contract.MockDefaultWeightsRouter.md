# MockDefaultWeightsRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e3ee0bd75d52506549a0416bdd36e7e170b4b50b/contracts/test/VaultRegistry.t.sol)

Minimal stand-in for `PortfolioRouter` exposing only the
`defaultWeightsLength()` view the registry's stale-length guard
reads. Lets the registry test exercise the guard without pulling in
the full router. ADR-0002.


## State Variables
### defaultWeightsLength

```solidity
uint256 public defaultWeightsLength
```


## Functions
### setDefaultWeightsLength


```solidity
function setDefaultWeightsLength(uint256 n) external;
```

