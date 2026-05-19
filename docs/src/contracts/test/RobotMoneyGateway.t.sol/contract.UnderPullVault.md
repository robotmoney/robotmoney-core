# UnderPullVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e7a2933e057a3f91470ea3808b683595abe0b3d0/contracts/test/RobotMoneyGateway.t.sol)

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

