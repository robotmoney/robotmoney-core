# ISafeMinimal
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c509d0100d3df416d312069339974e56f8ecce75/contracts/script/DeployTimelock.s.sol)

Minimal Safe interface — only `getThreshold()` is required for the
deploy-time guard that rejects EOA or low-threshold Safe addresses.


## Functions
### getThreshold


```solidity
function getThreshold() external view returns (uint256);
```

