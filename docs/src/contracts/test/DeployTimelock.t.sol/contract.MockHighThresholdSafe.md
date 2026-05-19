# MockHighThresholdSafe
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/86758bec5fa35d059fcb1a3f4a708912cfd4039d/contracts/test/DeployTimelock.t.sol)

Minimal stub that mimics a compliant 2-of-3 Safe — `getThreshold()` returns 2.
Used as the SAFE_ADDRESS in setUp() so DeployTimelock's code-length and
threshold guards (issue #422) are satisfied without deploying a real Safe.


## Functions
### getThreshold


```solidity
function getThreshold() external pure returns (uint256);
```

