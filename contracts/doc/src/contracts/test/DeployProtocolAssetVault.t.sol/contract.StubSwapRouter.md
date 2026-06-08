# StubSwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/7d2312dd62356bbc767599853c696d24039f091e/contracts/test/DeployProtocolAssetVault.t.sol)

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

