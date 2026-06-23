# ISafeMinimal
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c9e141ffcd1c066f8ea8438f58e57b245c4556f8/contracts/script/DeployTimelock.s.sol)

Minimal Safe interface — only `getThreshold()` is required for the
deploy-time guard that rejects EOA or low-threshold Safe addresses.


## Functions
### getThreshold


```solidity
function getThreshold() external view returns (uint256);
```

