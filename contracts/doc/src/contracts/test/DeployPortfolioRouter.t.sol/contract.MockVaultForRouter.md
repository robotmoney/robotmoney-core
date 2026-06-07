# MockVaultForRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d751c1df87b9f345a0aca6169509add45cf2cb27/contracts/test/DeployPortfolioRouter.t.sol)

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

