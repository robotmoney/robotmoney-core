# EmergencySkipContinueTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/EmergencyModel.t.sol)

**Inherits:**
[EmergencyModelBase](/contracts/test/EmergencyModel.t.sol/abstract.EmergencyModelBase.md)


## Functions
### setUp


```solidity
function setUp() public;
```

### test_drainSet_skipsRevertingAdapter_processesRest

AC: draining a SET where one adapter's `withdraw` reverts still
EXCLUDES that adapter and PROCESSES the rest (skip-and-continue).


```solidity
function test_drainSet_skipsRevertingAdapter_processesRest() public;
```

### test_keeperRole_doesNotExist

AC: KEEPER_ROLE no longer exists — no address holds it and its
admin role is unconfigured (DEFAULT_ADMIN_ROLE == 0x00), i.e. the
role was never wired into the vault. Rebalancing is
`forceRebalance`-only (§5.6) — no keeper, scheduled, or flow-based
rebalance exists.


```solidity
function test_keeperRole_doesNotExist() public view;
```

