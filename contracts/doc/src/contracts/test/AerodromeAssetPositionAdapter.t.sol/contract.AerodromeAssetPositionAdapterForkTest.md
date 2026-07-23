# AerodromeAssetPositionAdapterForkTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/d740448a2c3c14fa0c325f99c0cf5fb21593c110/contracts/test/AerodromeAssetPositionAdapter.t.sol)

**Inherits:**
Test


## Constants
### BASE_USDC

```solidity
address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```


### BASE_WETH

```solidity
address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006
```


### CL_FACTORY

```solidity
address internal constant CL_FACTORY = 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A
```


### SLIPSTREAM_ROUTER

```solidity
address internal constant SLIPSTREAM_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5
```


### WETH_USDC_POOL

```solidity
address internal constant WETH_USDC_POOL = 0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59
```


### TICK_SPACING

```solidity
int24 internal constant TICK_SPACING = 100
```


### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### DEPOSIT

```solidity
uint256 internal constant DEPOSIT = 10_000 * ONE_USDC
```


## State Variables
### vault

```solidity
AeroPositionMockVault internal vault
```


### venue

```solidity
AerodromeSwapAdapter internal venue
```


### adapter

```solidity
AerodromeAssetPositionAdapter internal adapter
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


## Functions
### _rpc

LOUD-SKIP: return the fork RPC, or REVERT when none is configured.
Never silently skips — the CI fork job sets FORK_RPC_URL (from the
`vars.RMPC_FORK_RPC_URL` repo variable, falling back to a public Base
RPC) so these tests execute with a non-zero count.


```solidity
function _rpc() internal view returns (string memory);
```

### setUp


```solidity
function setUp() public;
```

### test_fork_deploySwapsUsdcToWethAndPricesViaTwap


```solidity
function test_fork_deploySwapsUsdcToWethAndPricesViaTwap() public;
```

### test_fork_roundTripWithdrawAllReturnsUsdc


```solidity
function test_fork_roundTripWithdrawAllReturnsUsdc() public;
```

### test_fork_withdrawRevertsBelowSlippageFloor


```solidity
function test_fork_withdrawRevertsBelowSlippageFloor() public;
```

### test_fork_navDeviationGuardRevertsOnManipulatedSpot


```solidity
function test_fork_navDeviationGuardRevertsOnManipulatedSpot() public;
```

