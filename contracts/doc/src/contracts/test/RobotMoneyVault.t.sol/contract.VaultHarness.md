# VaultHarness
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/a9c23f29365b1a58869648c1ae96ac66c7ca191a/contracts/test/RobotMoneyVault.t.sol)

**Inherits:**
[RobotMoneyVault](/contracts/RobotMoneyVault.sol/contract.RobotMoneyVault.md)

Exposes internal helpers for tests.


## Functions
### constructor


```solidity
constructor(
    IERC20 asset_,
    uint256 tvlCap_,
    uint256 perDepositCap_,
    uint256 exitFeeBps_,
    address feeRecipient_,
    address admin_
) RobotMoneyVault(asset_, tvlCap_, perDepositCap_, exitFeeBps_, feeRecipient_, admin_);
```

### exposed_decimalsOffset


```solidity
function exposed_decimalsOffset() external pure returns (uint8);
```

