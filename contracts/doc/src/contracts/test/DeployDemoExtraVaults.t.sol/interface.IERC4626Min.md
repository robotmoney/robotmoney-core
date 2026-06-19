# IERC4626Min
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/9f4d89b73f3bc3e6fe6c5dd86696328d5a028502/contracts/test/DeployDemoExtraVaults.t.sol)

Minimal ERC-4626 view surface shared by every PRD §11 vault
(RobotMoneyVault + BasketVault subclasses) used to read TVL in a
vault-type-agnostic way for the four-vault real-TVL assertion.


## Functions
### totalAssets


```solidity
function totalAssets() external view returns (uint256);
```

