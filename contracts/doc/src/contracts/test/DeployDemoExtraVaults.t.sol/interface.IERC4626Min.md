# IERC4626Min
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/6972e43c539056c14fd6b78d1bee27347622bb81/contracts/test/DeployDemoExtraVaults.t.sol)

Minimal ERC-4626 view surface shared by every PRD §11 vault
(RobotMoneyVault + BasketVault subclasses) used to read TVL in a
vault-type-agnostic way for the four-vault real-TVL assertion.


## Functions
### totalAssets


```solidity
function totalAssets() external view returns (uint256);
```

