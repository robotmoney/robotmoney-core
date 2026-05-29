# IRouterDefaultWeights
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d46930cf8672ef941b507edf186b49886ff48c8a/contracts/VaultRegistry.sol)

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

