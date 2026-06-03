# GuardHarness
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e3ee0bd75d52506549a0416bdd36e7e170b4b50b/contracts/test/AdapterDelegatecallGuard.t.sol)

Library-consumer harness so we can test `requireNoDelegatecall`
with `vm.expectRevert` against the library's custom error.


## Functions
### requireNoDelegatecall


```solidity
function requireNoDelegatecall(address adapter_) external view;
```

### containsDelegatecall


```solidity
function containsDelegatecall(bytes memory code) external pure returns (bool);
```

