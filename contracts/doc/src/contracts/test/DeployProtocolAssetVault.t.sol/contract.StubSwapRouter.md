# StubSwapRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/174c53454088cd318240a18aade465c225fdb078/contracts/test/DeployProtocolAssetVault.t.sol)

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

