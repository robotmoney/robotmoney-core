# MockVaultForRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/298fe53d078e3114670e9c65d370bad82c79d34b/contracts/test/DeployPortfolioRouter.t.sol)

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

