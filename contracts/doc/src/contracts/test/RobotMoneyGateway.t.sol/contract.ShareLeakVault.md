# ShareLeakVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/174c53454088cd318240a18aade465c225fdb078/contracts/test/RobotMoneyGateway.t.sol)

**Inherits:**
[MockVault](/contracts/gateway/MockVault.sol/contract.MockVault.md)

Vault that mints an extra share to `msg.sender` (the gateway) on
deposit, simulating a malicious / buggy 4626 implementation that
re-routes shares to the caller. Trips the post-call rmUSDC custody
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

