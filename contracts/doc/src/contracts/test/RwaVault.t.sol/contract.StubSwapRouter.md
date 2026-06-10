# StubSwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/dc0f1b358b0eb6ef80c7f6a43b09b85a3da49a21/contracts/test/RwaVault.t.sol)

**Inherits:**
[ISwapRouter](/contracts/interfaces/ISwapRouter.sol/interface.ISwapRouter.md)

Stub Uniswap V3 SwapRouter (required by BasketVault constructor but never called
in the RWA vault since all swaps go through ChronicleOracleAdapter/Aerodrome).


## Functions
### exactInputSingle


```solidity
function exactInputSingle(ExactInputSingleParams calldata) external returns (uint256);
```

