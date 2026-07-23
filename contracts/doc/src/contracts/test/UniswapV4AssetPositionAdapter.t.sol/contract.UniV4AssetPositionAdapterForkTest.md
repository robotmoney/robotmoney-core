# UniV4AssetPositionAdapterForkTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/590a2c3bf7bb1b2abde217714163eb9576c910c7/contracts/test/UniswapV4AssetPositionAdapter.t.sol)

**Inherits:**
Test


## Constants
### BASE_USDC

```solidity
address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```


### FEE

```solidity
uint24 internal constant FEE = 3000
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
### v4Token

```solidity
UniV4PositionMockToken18 internal v4Token
```


### router

```solidity
UniV4PositionForkMockRouter internal router
```


### pool

```solidity
UniV4PositionForkMockPool internal pool
```


### vault

```solidity
UniV4PositionMockVault internal vault
```


### venue

```solidity
UniswapV4SwapAdapter internal venue
```


### adapter

```solidity
UniswapV4AssetPositionAdapter internal adapter
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

### test_fork_deploySwapsUsdcToTokenAndPricesViaTwap


```solidity
function test_fork_deploySwapsUsdcToTokenAndPricesViaTwap() public;
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

