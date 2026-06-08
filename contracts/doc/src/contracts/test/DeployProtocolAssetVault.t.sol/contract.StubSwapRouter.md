# StubSwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/41d10069f3131869b5f2aee11bc920913e4ab3a6/contracts/test/DeployProtocolAssetVault.t.sol)

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

