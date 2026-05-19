# IPrototypeAware
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/60eddc5d5c695082281a4a0584160a58dfe2e50e/contracts/PortfolioRouter.sol)

Minimal introspection interface used to detect vaults that
self-declare prototype status via `isPrototype()`. Implemented by
`contracts/vaults/BasketVault.sol` and inherited by every
`BasketVault` subclass. Defined here as a local interface so
`PortfolioRouter` has no compile-time dependency on the prototype
vaults themselves — any contract that exposes `isPrototype()
returns (bool)` participates in the production-readiness gate.


## Functions
### isPrototype


```solidity
function isPrototype() external view returns (bool);
```

