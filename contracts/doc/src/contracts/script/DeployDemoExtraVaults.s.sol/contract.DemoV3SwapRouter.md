# DemoV3SwapRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/895f74f9a312639869e61e1d4ba3dfce78950c03/contracts/script/DeployDemoExtraVaults.s.sol)

Minimal Uniswap V3 router stub for demo purposes. Swaps USDC ↔ token
at a 1:1 rate by minting the output token (DemoBasketToken) to the
recipient. The devnet has no real Uniswap V3 SwapRouter02; this stub
is used as the `swapRouter` parameter so V3-venue assets (BNKR) can
execute deposit swaps in the demo harness. Demo-only.


## Functions
### exactInputSingle


```solidity
function exactInputSingle(ISwapRouter.ExactInputSingleParams calldata params)
    external
    returns (uint256 amountOut);
```

