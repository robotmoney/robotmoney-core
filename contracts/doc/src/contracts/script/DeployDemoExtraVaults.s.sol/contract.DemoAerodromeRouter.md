# DemoAerodromeRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/690ce3eb1d770c8624dfe2b7c8dc1fb69a34bcd3/contracts/script/DeployDemoExtraVaults.s.sol)

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

