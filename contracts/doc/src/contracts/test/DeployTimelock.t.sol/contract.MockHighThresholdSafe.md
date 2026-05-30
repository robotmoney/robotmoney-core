# MockHighThresholdSafe
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/a9c23f29365b1a58869648c1ae96ac66c7ca191a/contracts/test/DeployTimelock.t.sol)

Minimal stub that mimics a compliant 2-of-3 Safe — `getThreshold()` returns 2.
Used as the SAFE_ADDRESS in setUp() so DeployTimelock's code-length and
threshold guards (issue #422) are satisfied without deploying a real Safe.


## Functions
### getThreshold


```solidity
function getThreshold() external pure returns (uint256);
```

