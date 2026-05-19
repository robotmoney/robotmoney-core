# GuardHarness
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/60eddc5d5c695082281a4a0584160a58dfe2e50e/contracts/test/AdapterDelegatecallGuard.t.sol)

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

