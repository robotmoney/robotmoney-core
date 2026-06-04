# ShareLeakRedeemVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/23bb26853ebab25914ee89c1967707490ad65007/contracts/test/RobotMoneyGateway.t.sol)

**Inherits:**
[MockVault](/contracts/gateway/MockVault.sol/contract.MockVault.md)

Vault that, during redeem, re-mints 1 share to the caller after
burning the redeemed shares. The gateway must hold zero shares after
redeem; re-minting 1 trips the ShareCustodyInvariantViolated check.


## Functions
### constructor


```solidity
constructor(address asset_) MockVault(asset_);
```

### redeem


```solidity
function redeem(uint256 shares, address receiver, address owner)
    external
    override
    returns (uint256 assets);
```

