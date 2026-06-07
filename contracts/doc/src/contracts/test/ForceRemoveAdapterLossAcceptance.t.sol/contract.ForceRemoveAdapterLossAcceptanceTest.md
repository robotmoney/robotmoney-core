# ForceRemoveAdapterLossAcceptanceTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/fd1e1fc4dc2a5a456dd5a95f2ef21cdd86bf1dfa/contracts/test/ForceRemoveAdapterLossAcceptance.t.sol)

**Inherits:**
Test

**Title:**
ForceRemoveAdapterLossAcceptanceTest

Scout stub scaffold for issue #677.
Each test below is a compile-safe placeholder that verifies the skeleton
compiles and the helpers work. Issue #677 replaces the stub bodies with
real assertions that cover the full loss-acceptance behaviour required by
docs/technical/security-model.md §9.
Tests that #677 must implement (replace TODO_STUB bodies):
1. `test_forceRemoveAdapter_recordsLoss`
Assert `AdapterForceRemoved` is emitted with the exact `lossAmount`
equal to `adapter.totalAssets()` at the time of the call.
2. `test_forceRemoveAdapter_deactivatesAdapter`
Assert `adapters[index].active == false` after the call; the adapter
is excluded from future `totalAssets()` tallies.
3. `test_forceRemoveAdapter_reducesTotalAssets`
Assert that `vault.totalAssets()` decreases by exactly the insolvent
adapter's reported value — proving the share price reflects the loss.
4. `test_forceRemoveAdapter_revertsForInvalidIndex`
Assert the call reverts with `AdapterNotFound` for an out-of-bounds
or already-inactive adapter index.
5. `test_forceRemoveAdapter_revertsIfNotEmergencyRole`
Assert the call reverts when the caller lacks `EMERGENCY_ROLE`.
6. `test_forceRemoveAdapter_survivingAdaptersUnaffected`
Assert that `totalAssets()` from non-removed adapters is unchanged and
depositors who have not triggered a withdrawal retain their pro-rata claim.


## Constants
### INITIAL_DEPOSIT

```solidity
uint256 internal constant INITIAL_DEPOSIT = 1_000e6
```


## State Variables
### usdc

```solidity
LossAcceptanceUSDC internal usdc
```


### vault

```solidity
RobotMoneyVault internal vault
```


### insolventAdapter

```solidity
InsolventMockAdapter internal insolventAdapter
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### emergency

```solidity
address internal emergency = makeAddr("emergency")
```


### depositor

```solidity
address internal depositor = makeAddr("depositor")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_forceRemoveAdapter_recordsLoss

Scout stub — no-op skeleton. Issue #677 adds real assertions.
TODO_STUB (#677): verify `AdapterForceRemoved` is emitted with the
correct `lossAmount` equal to `insolventAdapter.totalAssets()`.


```solidity
function test_forceRemoveAdapter_recordsLoss() public;
```

### test_forceRemoveAdapter_deactivatesAdapter

Scout stub — no-op skeleton. Issue #677 adds real assertions.
TODO_STUB (#677): assert `adapters[0].active == false` after the call.


```solidity
function test_forceRemoveAdapter_deactivatesAdapter() public;
```

### test_forceRemoveAdapter_reducesTotalAssets

Scout stub — no-op skeleton. Issue #677 adds real assertions.
TODO_STUB (#677): deposit USDC, record pre-forceRemove totalAssets,
then assert that post-forceRemove totalAssets == pre - lossAmount.


```solidity
function test_forceRemoveAdapter_reducesTotalAssets() public;
```

### test_forceRemoveAdapter_revertsForInvalidIndex

Scout stub — no-op skeleton. Issue #677 adds real assertions.
TODO_STUB (#677): expect `vm.expectRevert(RobotMoneyVault.AdapterNotFound.selector)`
for an out-of-bounds index and for an already-inactive adapter.


```solidity
function test_forceRemoveAdapter_revertsForInvalidIndex() public;
```

### test_forceRemoveAdapter_revertsIfNotEmergencyRole

Scout stub — no-op skeleton. Issue #677 adds real assertions.
TODO_STUB (#677): expect an AccessControl revert when caller lacks
`EMERGENCY_ROLE`.


```solidity
function test_forceRemoveAdapter_revertsIfNotEmergencyRole() public;
```

### test_forceRemoveAdapter_survivingAdaptersUnaffected

Scout stub — no-op skeleton. Issue #677 adds real assertions.
TODO_STUB (#677): add a second PassthroughAdapter with real USDC,
forceRemove only the insolvent adapter, and assert the surviving
adapter's totalAssets contribution is unchanged.


```solidity
function test_forceRemoveAdapter_survivingAdaptersUnaffected() public;
```

