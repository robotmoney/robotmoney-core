# EmergencyArmExecuteTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/EmergencyModel.t.sol)

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

