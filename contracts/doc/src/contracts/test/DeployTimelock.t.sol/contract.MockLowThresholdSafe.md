# MockLowThresholdSafe
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/965f0332a19461dd11d5d5acce5e2d9fe9b00bd3/contracts/test/DeployTimelock.t.sol)

Minimal stub that mimics a 1-of-N Safe — `getThreshold()` returns 1.
Used to prove DeployTimelock rejects low-threshold Safes.


## Functions
### getThreshold


```solidity
function getThreshold() external pure returns (uint256);
```

