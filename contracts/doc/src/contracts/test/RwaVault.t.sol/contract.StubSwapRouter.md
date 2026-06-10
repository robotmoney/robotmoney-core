# StubSwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/75f0b4b6846ed0d886afdaede8205c3c2ab2177f/contracts/test/RwaVault.t.sol)

**Inherits:**
[ISwapRouter](/contracts/interfaces/ISwapRouter.sol/interface.ISwapRouter.md)

Stub Uniswap V3 SwapRouter (required by BasketVault constructor but never called
in the RWA vault since all swaps go through ChronicleOracleAdapter/Aerodrome).


## Functions
### exactInputSingle


```solidity
function exactInputSingle(ExactInputSingleParams calldata) external returns (uint256);
```

