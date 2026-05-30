# RecordingSwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/d6ea170b5db4fe1e5559433d38b4563ca140fbfc/contracts/test/AgentTokenVault.t.sol)

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

