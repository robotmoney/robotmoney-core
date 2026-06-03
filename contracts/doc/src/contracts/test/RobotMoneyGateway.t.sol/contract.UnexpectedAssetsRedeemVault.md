# UnexpectedAssetsRedeemVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e1a131c0c2ecf9334ca951298cb03794be5b1ef2/contracts/test/RobotMoneyGateway.t.sol)

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

