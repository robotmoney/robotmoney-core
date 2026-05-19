# DeclaresPrototype
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/75c9d821b281975c99c1bcf5090a766acfe071b0/contracts/test/PortfolioRouter.t.sol)

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

