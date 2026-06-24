# GuardHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0d868fe02e5cf19ce075213817ca84416ca13c09/contracts/test/AdapterDelegatecallGuard.t.sol)

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

