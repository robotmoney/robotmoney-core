# MockVaultForRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d46930cf8672ef941b507edf186b49886ff48c8a/contracts/test/DeployPortfolioRouter.t.sol)

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

