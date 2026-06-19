# IRouterDefaultWeights
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/9f4d89b73f3bc3e6fe6c5dd86696328d5a028502/contracts/VaultRegistry.sol)

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

