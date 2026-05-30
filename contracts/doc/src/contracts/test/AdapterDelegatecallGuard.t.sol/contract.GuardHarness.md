# GuardHarness
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d6ea170b5db4fe1e5559433d38b4563ca140fbfc/contracts/test/AdapterDelegatecallGuard.t.sol)

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

