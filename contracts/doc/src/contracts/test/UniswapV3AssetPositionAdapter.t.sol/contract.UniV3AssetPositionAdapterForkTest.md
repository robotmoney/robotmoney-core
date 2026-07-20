# UniV3AssetPositionAdapterForkTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/cd218849ca46daf6891cc2b350fd6bac2d9f644b/contracts/test/UniswapV3AssetPositionAdapter.t.sol)

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


### V3_FACTORY

```solidity
address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD
```


### SWAP_ROUTER02

```solidity
address internal constant SWAP_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481
```


### FEE

```solidity
uint24 internal constant FEE = 500
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
UniV3PositionMockVault internal vault
```


### venue

```solidity
UniswapV3SwapAdapter internal venue
```


### adapter

```solidity
UniswapV3AssetPositionAdapter internal adapter
```


### pool

```solidity
address internal pool
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


## Functions
### _rpc

LOUD-SKIP: return the fork RPC, or REVERT when none is configured.
Never silently skips — the CI fork job sets RMPC_FORK_RPC_URL so these
tests execute with a non-zero count.


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

