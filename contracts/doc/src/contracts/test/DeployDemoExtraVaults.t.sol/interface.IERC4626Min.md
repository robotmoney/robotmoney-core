# IERC4626Min
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/4b538399027636f20b316ae10f72d0d6c6960fb1/contracts/test/DeployDemoExtraVaults.t.sol)

Minimal ERC-4626 view surface shared by every PRD §11 vault
(RobotMoneyVault + BasketVault subclasses) used to read TVL in a
vault-type-agnostic way for the four-vault real-TVL assertion.


## Functions
### totalAssets


```solidity
function totalAssets() external view returns (uint256);
```

