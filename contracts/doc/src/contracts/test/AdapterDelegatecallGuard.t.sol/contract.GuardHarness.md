# GuardHarness
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/f472e86b1dbfd5373d4ad4db0a93939bfff1d557/contracts/test/AdapterDelegatecallGuard.t.sol)

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

