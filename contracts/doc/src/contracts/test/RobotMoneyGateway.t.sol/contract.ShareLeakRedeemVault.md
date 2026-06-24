# ShareLeakRedeemVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/b58df0d9705fd40d8110bd43d533f82a20b8ace3/contracts/test/RobotMoneyGateway.t.sol)

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

