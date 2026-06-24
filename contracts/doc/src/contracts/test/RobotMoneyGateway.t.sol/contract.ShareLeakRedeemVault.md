# ShareLeakRedeemVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/e699d5af7edaf7c4c89b6772ee092727a36235c7/contracts/test/RobotMoneyGateway.t.sol)

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

