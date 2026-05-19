# DeclaresPrototype
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e7a2933e057a3f91470ea3808b683595abe0b3d0/contracts/test/PortfolioRouter.t.sol)

Smallest possible contract that re-exports the same `isPrototype()`
signature `BasketVault` ships with, so the router gate can be
exercised against a true/false declaration without dragging in
the full BasketVault deployment surface (Uniswap router, USDC
immutable, AccessControl, etc.).


## Functions
### isPrototype


```solidity
function isPrototype() external pure returns (bool);
```

