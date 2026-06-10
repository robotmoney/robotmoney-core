# RobotMoneyVault4626ConformanceWithFee
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/75f0b4b6846ed0d886afdaede8205c3c2ab2177f/contracts/test/RobotMoneyVault4626Conformance.t.sol)

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

