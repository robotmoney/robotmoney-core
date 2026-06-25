# MockVaultForRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/ff7f6357fae66fafd4ea43a7ad5248daf223b17f/contracts/test/DeployPortfolioRouter.t.sol)

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

