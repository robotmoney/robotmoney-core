# MockHighThresholdSafe
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a850937c469fed3e92eb9f004e12f595cf9f2447/contracts/test/DeployTimelock.t.sol)

Minimal stub that mimics a compliant 2-of-3 Safe — `getThreshold()` returns 2.
Used as the SAFE_ADDRESS in setUp() so DeployTimelock's code-length and
threshold guards (issue #422) are satisfied without deploying a real Safe.


## Functions
### getThreshold


```solidity
function getThreshold() external pure returns (uint256);
```

