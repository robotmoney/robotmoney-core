# MockLowThresholdSafe
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/60eddc5d5c695082281a4a0584160a58dfe2e50e/contracts/test/DeployTimelock.t.sol)

Minimal stub that mimics a 1-of-N Safe — `getThreshold()` returns 1.
Used to prove DeployTimelock rejects low-threshold Safes.


## Functions
### getThreshold


```solidity
function getThreshold() external pure returns (uint256);
```

