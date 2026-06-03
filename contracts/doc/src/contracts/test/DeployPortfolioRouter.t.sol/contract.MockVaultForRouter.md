# MockVaultForRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/dd2b70b308807d48418288c918e3bb6256623fb2/contracts/test/DeployPortfolioRouter.t.sol)

Minimal ERC-4626-shaped mock vault for router weight tests.
Implements `asset()` because PortfolioRouter.setWeights validates
router eligibility by checking `IERC4626(vault).asset() == usdc`.


## Constants
### asset

```solidity
address public immutable asset
```


## Functions
### constructor


```solidity
constructor(address asset_) ;
```

