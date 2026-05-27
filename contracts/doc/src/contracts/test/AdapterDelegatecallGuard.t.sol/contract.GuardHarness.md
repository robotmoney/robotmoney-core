# GuardHarness
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/715cd4b73a878654e7e004c208f153b328046fcf/contracts/test/AdapterDelegatecallGuard.t.sol)

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

