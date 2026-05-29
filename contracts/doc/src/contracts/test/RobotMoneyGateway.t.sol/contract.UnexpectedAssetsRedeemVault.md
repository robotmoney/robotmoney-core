# UnexpectedAssetsRedeemVault
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/03e3eaf8da3896078274cb45e36fd811b4fed616/contracts/test/RobotMoneyGateway.t.sol)

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

