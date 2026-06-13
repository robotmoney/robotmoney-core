# StubSwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/eddfc6a75fd5558f18f4c48ae13aa1c3278c17e6/contracts/test/DeployProtocolAssetVault.t.sol)

**Inherits:**
[ISwapRouter](/contracts/interfaces/ISwapRouter.sol/interface.ISwapRouter.md)

Minimal ISwapRouter stub for deploy tests. ProtocolAssetVault's
constructor only stores the router address and does not call any
router methods, so a zero-implementation stub is sufficient.


## Functions
### exactInputSingle


```solidity
function exactInputSingle(ExactInputSingleParams calldata) external pure returns (uint256);
```

