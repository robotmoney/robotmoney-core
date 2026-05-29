# IRouterDefaultWeights
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/03e3eaf8da3896078274cb45e36fd811b4fed616/contracts/VaultRegistry.sol)

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

