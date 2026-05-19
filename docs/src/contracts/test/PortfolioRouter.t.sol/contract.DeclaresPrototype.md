# DeclaresPrototype
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/86758bec5fa35d059fcb1a3f4a708912cfd4039d/contracts/test/PortfolioRouter.t.sol)

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

