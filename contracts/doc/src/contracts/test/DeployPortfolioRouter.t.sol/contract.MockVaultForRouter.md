# MockVaultForRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/7d568c59b4026ccbeb96c8683b875a28e63a7d18/contracts/test/DeployPortfolioRouter.t.sol)

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

