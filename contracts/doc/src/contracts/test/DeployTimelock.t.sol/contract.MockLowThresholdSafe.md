# MockLowThresholdSafe
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/565d7a4ab968179b6f0a1db9f9fe724a77abadce/contracts/test/DeployTimelock.t.sol)

Minimal stub that mimics a 1-of-N Safe — `getThreshold()` returns 1.
Used to prove DeployTimelock rejects low-threshold Safes.


## Functions
### getThreshold


```solidity
function getThreshold() external pure returns (uint256);
```

