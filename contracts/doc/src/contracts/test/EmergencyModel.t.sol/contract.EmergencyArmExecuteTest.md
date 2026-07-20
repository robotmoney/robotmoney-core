# EmergencyArmExecuteTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3dcd5dd028ae8ed6525d5aefde4cddc6dea610c0/contracts/test/EmergencyModel.t.sol)

**Inherits:**
[EmergencyModelBase](/contracts/test/EmergencyModel.t.sol/abstract.EmergencyModelBase.md)


## Functions
### setUp


```solidity
function setUp() public;
```

### test_emergencyRole_drainsAndExcludesInOneCall

AC: an EMERGENCY_ROLE holder ARMS and EXECUTES an adapter
drain+exclusion in a SINGLE transaction — no two-step, no ADMIN
timelock wait in between. After the one call the adapter is both
drained (its USDC recovered to the vault) AND excluded (deactivated,
out of NAV counting).


```solidity
function test_emergencyRole_drainsAndExcludesInOneCall() public;
```

### test_nonEmergencyCaller_reverts

AC: a non-EMERGENCY caller CANNOT arm+execute — it reverts. Even the
ADMIN (timelock) key, which does NOT hold EMERGENCY_ROLE, is refused:
the fast path is EMERGENCY-gated, not ADMIN-gated.


```solidity
function test_nonEmergencyCaller_reverts() public;
```

