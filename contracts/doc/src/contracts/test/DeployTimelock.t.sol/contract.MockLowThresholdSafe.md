# MockLowThresholdSafe
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/bf1c7761f8915541f9704694084c37ff757fe82d/contracts/test/DeployTimelock.t.sol)

Minimal stub that mimics a 1-of-N Safe — `getThreshold()` returns 1.
Used to prove DeployTimelock rejects low-threshold Safes.


## Functions
### getThreshold


```solidity
function getThreshold() external pure returns (uint256);
```

