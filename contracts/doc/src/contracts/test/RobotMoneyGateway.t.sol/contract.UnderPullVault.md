# UnderPullVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/829e61766b365e1704d8f027d8ca3d18f7ce4b26/contracts/test/RobotMoneyGateway.t.sol)

**Inherits:**
[MockVault](/contracts/gateway/MockVault.sol/contract.MockVault.md)

Vault that under-pulls USDC on deposit so the gateway is left holding
leftover stablecoin after the call — trips the post-call USDC custody
invariant.


## Functions
### constructor


```solidity
constructor(address asset_) MockVault(asset_);
```

### deposit


```solidity
function deposit(uint256 assets, address receiver) external override returns (uint256 shares);
```

