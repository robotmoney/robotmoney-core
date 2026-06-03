# GuardHarness
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/fde825fa14af6eda7d4a1766f6f45e033e4f39a0/contracts/test/AdapterDelegatecallGuard.t.sol)

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

