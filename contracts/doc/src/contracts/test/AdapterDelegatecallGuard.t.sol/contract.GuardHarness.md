# GuardHarness
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d46930cf8672ef941b507edf186b49886ff48c8a/contracts/test/AdapterDelegatecallGuard.t.sol)

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

