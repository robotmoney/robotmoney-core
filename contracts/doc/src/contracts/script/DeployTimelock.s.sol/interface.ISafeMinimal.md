# ISafeMinimal
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d46930cf8672ef941b507edf186b49886ff48c8a/contracts/script/DeployTimelock.s.sol)

Minimal Safe interface — only `getThreshold()` is required for the
deploy-time guard that rejects EOA or low-threshold Safe addresses.


## Functions
### getThreshold


```solidity
function getThreshold() external view returns (uint256);
```

