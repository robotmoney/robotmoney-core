# RobotMoneyVault4626ConformanceWithFee
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/8fe82accd34499f358df165500b889c234fe064a/contracts/test/RobotMoneyVault4626Conformance.t.sol)

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

