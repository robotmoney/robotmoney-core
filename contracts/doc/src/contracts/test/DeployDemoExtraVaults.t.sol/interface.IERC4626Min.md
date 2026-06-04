# IERC4626Min
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/409d003e7840e5cca4a5a03ebbc053080a81a5b7/contracts/test/DeployDemoExtraVaults.t.sol)

Minimal ERC-4626 view surface shared by every PRD §11 vault
(RobotMoneyVault + BasketVault subclasses) used to read TVL in a
vault-type-agnostic way for the four-vault real-TVL assertion.


## Functions
### totalAssets


```solidity
function totalAssets() external view returns (uint256);
```

