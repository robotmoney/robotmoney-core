# MockDefaultWeightsRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/6aebcae7361098e1770e9b79c53f0125f87edaa3/contracts/test/VaultRegistry.t.sol)

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

