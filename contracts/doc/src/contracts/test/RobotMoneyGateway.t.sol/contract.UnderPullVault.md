# UnderPullVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/4b9f1e53ce2923a3a2346fb7de25157672f7633c/contracts/test/RobotMoneyGateway.t.sol)

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

