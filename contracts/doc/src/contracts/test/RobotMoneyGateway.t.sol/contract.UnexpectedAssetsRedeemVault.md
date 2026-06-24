# UnexpectedAssetsRedeemVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/5a164c31574dc88f5c31048af5cc49fb7a941a1f/contracts/test/RobotMoneyGateway.t.sol)

**Inherits:**
[MockVault](/contracts/gateway/MockVault.sol/contract.MockVault.md)

Vault that, during redeem, routes USDC to the caller (the gateway)
instead of to the designated receiver. This trips the post-redeem
gateway-USDC-balance invariant (UnexpectedAssetsReceived).


## Functions
### constructor


```solidity
constructor(address asset_) MockVault(asset_);
```

### redeem


```solidity
function redeem(uint256 shares, address, address owner)
    external
    override
    returns (uint256 assets);
```

