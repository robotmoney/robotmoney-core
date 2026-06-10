# MockLowThresholdSafe
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/75f0b4b6846ed0d886afdaede8205c3c2ab2177f/contracts/test/DeployTimelock.t.sol)

Minimal stub that mimics a 1-of-N Safe — `getThreshold()` returns 1.
Used to prove DeployTimelock rejects low-threshold Safes.


## Functions
### getThreshold


```solidity
function getThreshold() external pure returns (uint256);
```

