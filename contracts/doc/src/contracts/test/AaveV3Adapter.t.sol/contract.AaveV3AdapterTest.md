# AaveV3AdapterTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0d868fe02e5cf19ce075213817ca84416ca13c09/contracts/test/AaveV3Adapter.t.sol)

**Inherits:**
Test


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### aToken

```solidity
TestERC20 internal aToken
```


### pool

```solidity
MockAavePool internal pool
```


### adapter

```solidity
AaveV3Adapter internal adapter
```


### vault

```solidity
address internal vault = makeAddr("vault")
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_deploy_movesUsdcIntoPool


```solidity
function test_deploy_movesUsdcIntoPool() public;
```

### test_ADP5_deployZeroesAllowance

ADP-5 / NC-12: `deploy` uses `forceApprove(_, amount)` then
`forceApprove(_, 0)`, so the adapter's USDC allowance to the Aave
pool is exactly zero after the call — no residual approval lingers.


```solidity
function test_ADP5_deployZeroesAllowance() public;
```

### test_deploy_revertsForNonVault


```solidity
function test_deploy_revertsForNonVault() public;
```

