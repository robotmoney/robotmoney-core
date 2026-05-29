# GuardHarness
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/0e0f94d96bb3900f4fd22dd5ae7b5741099dfdba/contracts/test/AdapterDelegatecallGuard.t.sol)

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

