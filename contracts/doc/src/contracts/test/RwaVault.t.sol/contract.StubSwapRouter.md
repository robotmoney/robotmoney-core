# StubSwapRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/965f0332a19461dd11d5d5acce5e2d9fe9b00bd3/contracts/test/RwaVault.t.sol)

**Inherits:**
[ISwapRouter](/contracts/interfaces/ISwapRouter.sol/interface.ISwapRouter.md)

Stub Uniswap V3 SwapRouter (required by BasketVault constructor but never called
in the RWA vault since all swaps go through ChronicleOracleAdapter/Aerodrome).


## Functions
### exactInputSingle


```solidity
function exactInputSingle(ExactInputSingleParams calldata) external returns (uint256);
```

