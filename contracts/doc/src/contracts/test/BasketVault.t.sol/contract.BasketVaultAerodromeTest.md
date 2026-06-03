# BasketVaultAerodromeTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/fde825fa14af6eda7d4a1766f6f45e033e4f39a0/contracts/test/BasketVault.t.sol)

**Inherits:**
Test

**Title:**
BasketVaultAerodromeTest

Verifies the Aerodrome swap + TWAP adapter path in BasketVault.
All tests use a mock AerodromeRouter and mock Aerodrome CL pool;
no mainnet fork is required (issue #553 acceptance criterion: mocked/forked).


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


### aeroToken

```solidity
TestERC20 internal aeroToken
```


### aeroRouter

```solidity
MockAerodromeRouter internal aeroRouter
```


### aeroPool

```solidity
MockAerodromePool internal aeroPool
```


### v3Router

```solidity
MockSwapRouter internal v3Router
```


### aeroAdapter

```solidity
AerodromeSwapAdapter internal aeroAdapter
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


### fakeFactory

```solidity
address internal fakeFactory = address(0xF00D)
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_aerodrome_deposit_routesThroughAerodromeAdapter

Deposit routes USDC→aeroToken through the Aerodrome adapter, not V3.


```solidity
function test_aerodrome_deposit_routesThroughAerodromeAdapter() public;
```

### test_aerodrome_withdrawal_routesThroughAerodromeAdapter

Withdrawal routes aeroToken→USDC through the Aerodrome adapter.


```solidity
function test_aerodrome_withdrawal_routesThroughAerodromeAdapter() public;
```

### test_aerodrome_v3DefaultPathUnchanged

A V3-registered asset (adapter=address(0)) still swaps via V3 router.


```solidity
function test_aerodrome_v3DefaultPathUnchanged() public;
```

### test_aerodrome_totalAssets_usesAdapterTwap

totalAssets() prices aeroToken via the Aerodrome adapter's twapPrice().
tick=0 → 1:1 price → 1000 aeroTokens == 1000 USDC in NAV.


```solidity
function test_aerodrome_totalAssets_usesAdapterTwap() public;
```

### test_aerodrome_deposit_slippageFloorFromAdapterTwap

The Aerodrome TWAP drives slippage floors: a deposit that can only
receive zero output (router mock set to 0) reverts, proving the floor is active.


```solidity
function test_aerodrome_deposit_slippageFloorFromAdapterTwap() public;
```

### test_aerodrome_emergencyUnwind_routesThroughAdapter

emergencyUnwind uses the Aerodrome adapter path for aeroToken assets.


```solidity
function test_aerodrome_emergencyUnwind_routesThroughAdapter() public;
```

### test_AerodromeSwapAdapter_swap_revertsOnSlippage

AerodromeSwapAdapter.swap() reverts when minAmountOut is not met.


```solidity
function test_AerodromeSwapAdapter_swap_revertsOnSlippage() public;
```

### test_AerodromeSwapAdapter_twapPrice_returnsCorrectAtTickZero

AerodromeSwapAdapter.twapPrice() returns 1:1 at tick=0.


```solidity
function test_AerodromeSwapAdapter_twapPrice_returnsCorrectAtTickZero() public;
```

### test_AerodromeSwapAdapter_twapPrice_revertsOnPoolTokenMismatch

AerodromeSwapAdapter.twapPrice() reverts on pool token mismatch.


```solidity
function test_AerodromeSwapAdapter_twapPrice_revertsOnPoolTokenMismatch() public;
```

### test_AerodromeSwapAdapter_twapPrice_revertsOnZeroWindow

AerodromeSwapAdapter.twapPrice() reverts on zero window.


```solidity
function test_AerodromeSwapAdapter_twapPrice_revertsOnZeroWindow() public;
```

### test_AerodromeSwapAdapter_constructor_revertsOnZeroRouter

AerodromeSwapAdapter constructor reverts on zero router address.


```solidity
function test_AerodromeSwapAdapter_constructor_revertsOnZeroRouter() public;
```

### test_AerodromeSwapAdapter_constructor_revertsOnZeroFactory

AerodromeSwapAdapter constructor reverts on zero factory address.


```solidity
function test_AerodromeSwapAdapter_constructor_revertsOnZeroFactory() public;
```

