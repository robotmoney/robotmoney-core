# RecordingSwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/75f0b4b6846ed0d886afdaede8205c3c2ab2177f/contracts/test/AgentTokenVault.t.sol)

**Inherits:**
[ISwapRouter](/contracts/interfaces/ISwapRouter.sol/interface.ISwapRouter.md)

Swap router mock that records the USDC `amountIn` of every USDC->token
deposit swap, keyed by output token, so equal-weight allocation can be
asserted directly. Returns `amountIn` 1:1 to the recipient.


## State Variables
### usdcInForToken

```solidity
mapping(address => uint256) public usdcInForToken
```


## Functions
### exactInputSingle


```solidity
function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256);
```

