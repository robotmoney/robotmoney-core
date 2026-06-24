# VaultHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0d868fe02e5cf19ce075213817ca84416ca13c09/contracts/test/RobotMoneyVault.t.sol)

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
    address admin_,
    address emergencyResponder_
)
    RobotMoneyVault(
        asset_, tvlCap_, perDepositCap_, exitFeeBps_, feeRecipient_, admin_, emergencyResponder_
    );
```

### exposed_decimalsOffset


```solidity
function exposed_decimalsOffset() external pure returns (uint8);
```

