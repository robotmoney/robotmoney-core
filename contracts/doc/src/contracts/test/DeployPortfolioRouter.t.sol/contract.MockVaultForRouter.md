# MockVaultForRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/dc0f1b358b0eb6ef80c7f6a43b09b85a3da49a21/contracts/test/DeployPortfolioRouter.t.sol)

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

