# StubSwapRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/43d1c2f83429ede507d6169930f712ee7dbb8993/contracts/test/RwaVault.t.sol)

**Inherits:**
[ISwapRouter](/contracts/interfaces/ISwapRouter.sol/interface.ISwapRouter.md)

Stub Uniswap V3 SwapRouter (required by BasketVault constructor but never called
in the RWA vault since all swaps go through ChronicleOracleAdapter/Aerodrome).


## Functions
### exactInputSingle


```solidity
function exactInputSingle(ExactInputSingleParams calldata) external returns (uint256);
```

