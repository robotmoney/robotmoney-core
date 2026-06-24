# MockVaultForRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0d868fe02e5cf19ce075213817ca84416ca13c09/contracts/test/DeployPortfolioRouter.t.sol)

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

