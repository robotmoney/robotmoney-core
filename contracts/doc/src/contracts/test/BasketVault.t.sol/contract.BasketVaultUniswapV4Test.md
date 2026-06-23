# BasketVaultUniswapV4Test
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/43d1c2f83429ede507d6169930f712ee7dbb8993/contracts/test/BasketVault.t.sol)

**Inherits:**
Test

**Title:**
BasketVaultUniswapV4Test

Verifies the Uniswap V4 swap + TWAP adapter path in BasketVault.
All tests use mock V4 Router and mock V4 pool; no mainnet fork is required.
Acceptance criteria (issue #554):
AC1 — BasketVault routes a configured asset's swap through Uniswap V4.
AC2 — The Uniswap V3 default path is unchanged (existing V3 tests still pass).
AC3 — forge tests cover the V4 swap and TWAP paths.


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


### v4Token

```solidity
TestERC20 internal v4Token
```


### v4Router

```solidity
MockUniswapV4Router internal v4Router
```


### v4Pool

```solidity
MockUniswapV4Pool internal v4Pool
```


### v3Router

```solidity
MockSwapRouter internal v3Router
```


### v4Adapter

```solidity
UniswapV4SwapAdapter internal v4Adapter
```


### vault

```solidity
BasketVaultHarness internal vault
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### emergencyResponder

```solidity
address internal emergencyResponder = makeAddr("emergencyResponder")
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

### test_V4_deposit_routesThroughUniswapV4Adapter

Deposit routes USDC→v4Token through the V4 adapter, not V3.


```solidity
function test_V4_deposit_routesThroughUniswapV4Adapter() public;
```

### test_V4_withdrawal_routesThroughUniswapV4Adapter

Withdrawal routes v4Token→USDC through the V4 adapter.


```solidity
function test_V4_withdrawal_routesThroughUniswapV4Adapter() public;
```

### test_V4_deposit_slippageFloorFromV4Twap

Deposit slippage floor is derived from the V4 TWAP: a router returning
zero output triggers the floor and reverts.


```solidity
function test_V4_deposit_slippageFloorFromV4Twap() public;
```

### test_UniswapV4_totalAssets_usesAdapterTwap

totalAssets() prices v4Token via the V4 adapter's twapPrice().
tick=0 → 1:1 price → 1000 v4Tokens == 1000 USDC in NAV.


```solidity
function test_UniswapV4_totalAssets_usesAdapterTwap() public;
```

### test_UniswapV4_totalAssets_reflectsPositiveTick

A positive tick (token appreciates vs USDC) yields NAV > tokenAmount.


```solidity
function test_UniswapV4_totalAssets_reflectsPositiveTick() public;
```

### test_UniswapV4_v3DefaultPathUnchanged

A V3-registered asset (adapter=address(0)) still swaps via V3 router
when a V4 asset is also registered.


```solidity
function test_UniswapV4_v3DefaultPathUnchanged() public;
```

### test_UniswapV4_emergencyUnwind_routesThroughAdapter

emergencyUnwind uses the V4 adapter path for V4-registered assets.


```solidity
function test_UniswapV4_emergencyUnwind_routesThroughAdapter() public;
```

### test_UniswapV4SwapAdapter_swap_revertsOnSlippage

UniswapV4SwapAdapter.swap() reverts when amountOutMinimum is not met.


```solidity
function test_UniswapV4SwapAdapter_swap_revertsOnSlippage() public;
```

### test_UniswapV4SwapAdapter_swap_succeedsAboveMinimum

UniswapV4SwapAdapter.swap() succeeds and returns correct amountOut.


```solidity
function test_UniswapV4SwapAdapter_swap_succeedsAboveMinimum() public;
```

### test_UniswapV4SwapAdapter_swap_zeroAmountInReturnsZero

UniswapV4SwapAdapter.swap() returns 0 for zero amountIn (no revert).


```solidity
function test_UniswapV4SwapAdapter_swap_zeroAmountInReturnsZero() public;
```

### test_UniswapV4SwapAdapter_swap_revertsOnExpiredDeadline

UniswapV4SwapAdapter.swap() enforces the caller-chosen deadline in the
adapter (the V4 router params carry none) — audit 2026-06-09, L-5.


```solidity
function test_UniswapV4SwapAdapter_swap_revertsOnExpiredDeadline() public;
```

### test_UniswapV4SwapAdapter_swap_revertsOnUint128MinAmountOutOverflow

UniswapV4SwapAdapter.swap() reverts (SafeCast) instead of silently
truncating a minAmountOut above uint128 max, which would have
weakened the slippage floor — audit 2026-06-09, L-6.


```solidity
function test_UniswapV4SwapAdapter_swap_revertsOnUint128MinAmountOutOverflow() public;
```

### test_UniswapV4SwapAdapter_swap_revertsOnUint128AmountInOverflow

UniswapV4SwapAdapter.swap() reverts (SafeCast) for amountIn above
uint128 max instead of wrapping — audit 2026-06-09, L-6.


```solidity
function test_UniswapV4SwapAdapter_swap_revertsOnUint128AmountInOverflow() public;
```

### test_UniswapV4SwapAdapter_twapPrice_returnsCorrectAtTickZero

UniswapV4SwapAdapter.twapPrice() returns 1:1 at tick=0.


```solidity
function test_UniswapV4SwapAdapter_twapPrice_returnsCorrectAtTickZero() public;
```

### test_UniswapV4SwapAdapter_twapPrice_revertsOnPoolTokenMismatch

UniswapV4SwapAdapter.twapPrice() reverts on pool token mismatch.


```solidity
function test_UniswapV4SwapAdapter_twapPrice_revertsOnPoolTokenMismatch() public;
```

### test_UniswapV4SwapAdapter_twapPrice_revertsOnZeroWindow

UniswapV4SwapAdapter.twapPrice() reverts on zero window.


```solidity
function test_UniswapV4SwapAdapter_twapPrice_revertsOnZeroWindow() public;
```

### test_UniswapV4SwapAdapter_twapPrice_revertsOnZeroPoolAddress

UniswapV4SwapAdapter.twapPrice() reverts on zero pool address.


```solidity
function test_UniswapV4SwapAdapter_twapPrice_revertsOnZeroPoolAddress() public;
```

### test_UniswapV4SwapAdapter_constructor_revertsOnZeroRouter

UniswapV4SwapAdapter constructor reverts on zero router address.


```solidity
function test_UniswapV4SwapAdapter_constructor_revertsOnZeroRouter() public;
```

### test_UniswapV4SwapAdapter_swap_revertsOnUnsupportedFeeTier

UniswapV4SwapAdapter reverts for unsupported fee tiers.


```solidity
function test_UniswapV4SwapAdapter_swap_revertsOnUnsupportedFeeTier() public;
```

### test_UniswapV4SwapAdapter_standardFeeTiersAccepted

All standard fee tiers (100, 500, 3000, 10000) are accepted.


```solidity
function test_UniswapV4SwapAdapter_standardFeeTiersAccepted() public;
```

