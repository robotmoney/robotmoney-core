# UniV3AssetPositionAdapterForkTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/c78b94387a5128aec495ab38ade8279dbb45f9d6/contracts/test/UniswapV3AssetPositionAdapter.t.sol)

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


### NAV_GUARD_BPS
Guard threshold the NAV-deviation test configures (0.20%).


```solidity
uint256 internal constant NAV_GUARD_BPS = 20
```


### NAV_MANIPULATION_TICKS
How far past the TWAP the NAV-deviation test drives spot, in ticks
(1 tick ≈ 1bps). 100 ticks ≈ 100bps is a 5x margin over
`NAV_GUARD_BPS`. Measured from the TWAP, not from spot, so the
margin holds for any live drift; the swap therefore crosses
|spot − twap| + 100 ticks, bounded and independent of pool depth.


```solidity
int24 internal constant NAV_MANIPULATION_TICKS = 100
```


### NAV_DEVIATION_PROBE
`UniswapV3AssetPositionAdapter.NAV_DEVIATION_PROBE` (internal there).
Decimals cancel in the |spot − twap|/twap ratio.


```solidity
uint256 internal constant NAV_DEVIATION_PROBE = 1e18
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

