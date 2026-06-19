# IERC4626Min
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0323a6a1933c28f78d86d11fe930ae7c01c96ef8/contracts/test/DeployDemoExtraVaults.t.sol)

Minimal ERC-4626 view surface shared by every PRD §11 vault
(RobotMoneyVault + BasketVault subclasses) used to read TVL in a
vault-type-agnostic way for the four-vault real-TVL assertion.


## Functions
### totalAssets


```solidity
function totalAssets() external view returns (uint256);
```

