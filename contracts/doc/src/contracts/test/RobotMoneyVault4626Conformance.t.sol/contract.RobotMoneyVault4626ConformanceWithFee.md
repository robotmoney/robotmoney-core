# RobotMoneyVault4626ConformanceWithFee
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c9e141ffcd1c066f8ea8438f58e57b245c4556f8/contracts/test/RobotMoneyVault4626Conformance.t.sol)

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

