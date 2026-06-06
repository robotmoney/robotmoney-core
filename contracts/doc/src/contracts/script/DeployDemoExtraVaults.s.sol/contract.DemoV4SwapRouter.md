# DemoV4SwapRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/9e808f2f7800c85e3ff24c369198d3b25293db1f/contracts/script/DeployDemoExtraVaults.s.sol)

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

