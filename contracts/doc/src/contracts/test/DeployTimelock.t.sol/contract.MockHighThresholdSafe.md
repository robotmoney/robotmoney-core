# MockHighThresholdSafe
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/d4e061fc698a91b57b77eff38896e3a0f0dbbbdc/contracts/test/DeployTimelock.t.sol)

Minimal stub that mimics a compliant 2-of-3 Safe — `getThreshold()` returns 2.
Used as the SAFE_ADDRESS in setUp() so DeployTimelock's code-length and
threshold guards (issue #422) are satisfied without deploying a real Safe.


## Functions
### getThreshold


```solidity
function getThreshold() external pure returns (uint256);
```

