# StubSwapRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/f6c8b468bb5448ecb94913113b3bd7ba124894db/contracts/test/DeployProtocolAssetVault.t.sol)

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

