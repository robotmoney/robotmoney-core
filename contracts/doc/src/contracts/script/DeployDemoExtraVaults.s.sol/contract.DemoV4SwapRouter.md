# DemoV4SwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/ea758b479e8ca22039bd13ec062ac539c6106ca4/contracts/script/DeployDemoExtraVaults.s.sol)

Minimal Uniswap V4 router stub for demo purposes. Records swaps
(USDC in → token out) at a 1:1 rate, minting the output token to the
recipient. The devnet has no real V4 router; this stub satisfies the
UniswapV4SwapAdapter's exactInputSingle call during demo deposit tests.
Demo-only; never deployed on mainnet.


## Functions
### exactInputSingle


```solidity
function exactInputSingle(IUniswapV4SwapRouter.ExactInputSingleParams calldata params)
    external
    payable
    returns (uint256 amountOut);
```

