# UnderPullVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/17d3c27bc19dd2e7dd9dd09c12e0fb0b8179d593/contracts/test/RobotMoneyGateway.t.sol)

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

