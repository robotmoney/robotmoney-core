# StubSwapRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/8fe82accd34499f358df165500b889c234fe064a/contracts/test/RwaVault.t.sol)

**Inherits:**
[ISwapRouter](/contracts/interfaces/ISwapRouter.sol/interface.ISwapRouter.md)

Stub Uniswap V3 SwapRouter (required by BasketVault constructor but never called
in the RWA vault since all swaps go through ChronicleOracleAdapter/Aerodrome).


## Functions
### exactInputSingle


```solidity
function exactInputSingle(ExactInputSingleParams calldata) external returns (uint256);
```

