# MockVaultForRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c9e141ffcd1c066f8ea8438f58e57b245c4556f8/contracts/test/DeployPortfolioRouter.t.sol)

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

