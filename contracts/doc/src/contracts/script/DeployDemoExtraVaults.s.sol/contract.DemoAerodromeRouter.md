# DemoAerodromeRouter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3da70a180fe71635ce61a9d127b7f2d7f7b3cbf5/contracts/script/DeployDemoExtraVaults.s.sol)

Minimal Aerodrome router stub for demo purposes. Records swaps at
a 1:1 rate, minting output token to the recipient. Demo-only.
Used by AgentTokenVault for its RM leg, where the pool TWAP
also returns 1:1 (DemoUsdcPool.observe returns zero ticks), so
totalAssets ≈ totalDeposits and no share inflation occurs.


## State Variables
### pools

```solidity
mapping(bytes32 => address) public pools
```


## Functions
### setPool


```solidity
function setPool(address tokenA, address tokenB, int24 tickSpacing, address pool) external;
```

### getPool


```solidity
function getPool(address tokenA, address tokenB, int24 tickSpacing)
    external
    view
    returns (address);
```

### exactInputSingle


```solidity
function exactInputSingle(IAerodromeSlipstreamRouter.ExactInputSingleParams calldata params)
    external
    returns (uint256);
```

