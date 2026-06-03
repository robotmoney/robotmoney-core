# IRouterDefaultWeights
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/2def9f9874e376c42240f560498ed7a0ea248d0e/contracts/VaultRegistry.sol)

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

