# IERC4626Min
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e2c936763868ac281d428b1ab176ecdd042ef467/contracts/test/DeployDemoExtraVaults.t.sol)

Minimal ERC-4626 view surface shared by every PRD §11 vault
(RobotMoneyVault + BasketVault subclasses) used to read TVL in a
vault-type-agnostic way for the four-vault real-TVL assertion.


## Functions
### totalAssets


```solidity
function totalAssets() external view returns (uint256);
```

