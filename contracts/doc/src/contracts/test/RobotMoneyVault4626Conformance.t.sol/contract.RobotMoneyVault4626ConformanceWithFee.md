# RobotMoneyVault4626ConformanceWithFee
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/2c36c8c1f505bf99870d94b72352925723aa9588/contracts/test/RobotMoneyVault4626Conformance.t.sol)

**Inherits:**
ERC4626Test

**Title:**
RobotMoneyVault4626ConformanceWithFee

ERC-4626 conformance for RobotMoneyVault with `exitFeeBps = 100` (1 %).
Validates that `maxWithdraw` round-trip does not revert under a non-zero exit fee.


## Functions
### setUp


```solidity
function setUp() public override;
```

