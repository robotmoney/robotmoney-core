# ISafeMinimal
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/03e3eaf8da3896078274cb45e36fd811b4fed616/contracts/script/DeployTimelock.s.sol)

Minimal Safe interface — only `getThreshold()` is required for the
deploy-time guard that rejects EOA or low-threshold Safe addresses.


## Functions
### getThreshold


```solidity
function getThreshold() external view returns (uint256);
```

