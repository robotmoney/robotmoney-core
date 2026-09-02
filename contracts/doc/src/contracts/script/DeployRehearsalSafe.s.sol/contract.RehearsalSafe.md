# RehearsalSafe
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/5e09613190caf40c6bcde5921567746bca14fa99/contracts/script/DeployRehearsalSafe.s.sol)

Minimal Safe stand-in for rehearsal ceremonies only.
Exposes exactly the `getThreshold()` surface DeployTimelock._validate
checks, returning a hard-coded threshold of 2.


## Functions
### getThreshold


```solidity
function getThreshold() external pure returns (uint256);
```

