# ISafeMinimal
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/bf1c7761f8915541f9704694084c37ff757fe82d/contracts/script/DeployTimelock.s.sol)

Minimal Safe interface — only `getThreshold()` is required for the
deploy-time guard that rejects EOA or low-threshold Safe addresses.


## Functions
### getThreshold


```solidity
function getThreshold() external view returns (uint256);
```

