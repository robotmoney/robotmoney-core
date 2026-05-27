# ISafeMinimal
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/715cd4b73a878654e7e004c208f153b328046fcf/contracts/script/DeployTimelock.s.sol)

Minimal Safe interface — only `getThreshold()` is required for the
deploy-time guard that rejects EOA or low-threshold Safe addresses.


## Functions
### getThreshold


```solidity
function getThreshold() external view returns (uint256);
```

