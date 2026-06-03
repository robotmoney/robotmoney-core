# MockLowThresholdSafe
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/96e73e7f201b20e754dab9ca2f28b150e1238e85/contracts/test/DeployTimelock.t.sol)

Minimal stub that mimics a 1-of-N Safe — `getThreshold()` returns 1.
Used to prove DeployTimelock rejects low-threshold Safes.


## Functions
### getThreshold


```solidity
function getThreshold() external pure returns (uint256);
```

