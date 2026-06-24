# DemoAerodromeRouter
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/5a164c31574dc88f5c31048af5cc49fb7a941a1f/contracts/script/DeployDemoExtraVaults.s.sol)

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

