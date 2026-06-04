# DemoAerodromeRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/3c1ea74f579328e8c58a74fd2216e9554654d471/contracts/script/DeployDemoExtraVaults.s.sol)

Minimal Aerodrome router stub for demo purposes. Records swaps at
a 1:1 rate, minting output token to the recipient. Demo-only.


## Functions
### swapExactTokensForTokens


```solidity
function swapExactTokensForTokens(
    uint256 amountIn,
    uint256, /* amountOutMin */
    IAerodromeRouter.Route[] calldata routes,
    address to,
    uint256 /* deadline */
) external returns (uint256[] memory amounts);
```

### defaultFactory


```solidity
function defaultFactory() external pure returns (address);
```

