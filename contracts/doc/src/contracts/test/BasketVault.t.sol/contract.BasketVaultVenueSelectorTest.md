# BasketVaultVenueSelectorTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/54c7918eefdea420a15bda61e204c809879c6e71/contracts/test/BasketVault.t.sol)

**Inherits:**
Test

**Title:**
BasketVaultVenueSelectorTest

Verifies that addAsset stores the Venue enum on AssetInfo and
dispatches swap + TWAP through the matching adapter for all three
venue types (V3, V4, Aerodrome).
Acceptance criteria (issue #555):
AC1 — addAsset accepts a venue selector and stores it on AssetInfo.
AC2 — Swap and TWAP dispatch to the correct adapter per venue,
including in emergency unwind.
AC3 — Tests cover adding assets on V3, V4, and Aerodrome.


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


### v3Router

```solidity
MockSwapRouter internal v3Router
```


### v4Router

```solidity
MockUniswapV4Router internal v4Router
```


### aeroRouter

```solidity
MockAerodromeRouter internal aeroRouter
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
address internal fakeFactory = makeAddr("fakeFactory")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_addAsset_venueV3_storedOnAssetInfo

addAsset with Venue.V3 stores Venue.V3 on AssetInfo and emits AssetAdded.


```solidity
function test_addAsset_venueV3_storedOnAssetInfo() public;
```

### test_addAsset_venueV4_storedOnAssetInfo

addAsset with Venue.V4 stores Venue.V4 on AssetInfo and emits AssetAdded.


```solidity
function test_addAsset_venueV4_storedOnAssetInfo() public;
```

### test_addAsset_venueAerodrome_storedOnAssetInfo

addAsset with Venue.Aerodrome stores Venue.Aerodrome on AssetInfo and emits AssetAdded.


```solidity
function test_addAsset_venueAerodrome_storedOnAssetInfo() public;
```

### test_venueV3_deposit_routesThroughV3Router

V3 asset (venue=V3, adapter=address(0)) deposits via the V3 router.


```solidity
function test_venueV3_deposit_routesThroughV3Router() public;
```

### test_venueV3_emergencyUnwind_routesThroughV3Router

V3 asset emergency unwind dispatches via the V3 router.


```solidity
function test_venueV3_emergencyUnwind_routesThroughV3Router() public;
```

### test_venueV4_deposit_routesThroughV4Adapter

V4 asset (venue=V4) deposits via the V4 adapter, not V3 router.


```solidity
function test_venueV4_deposit_routesThroughV4Adapter() public;
```

### test_venueV4_emergencyUnwind_routesThroughV4Adapter

V4 asset emergency unwind dispatches via the V4 adapter.


```solidity
function test_venueV4_emergencyUnwind_routesThroughV4Adapter() public;
```

### test_venueAerodrome_deposit_routesThroughAerodromeAdapter

Aerodrome asset (venue=Aerodrome) deposits via the Aerodrome adapter.


```solidity
function test_venueAerodrome_deposit_routesThroughAerodromeAdapter() public;
```

### test_venueAerodrome_emergencyUnwind_routesThroughAerodromeAdapter

Aerodrome asset emergency unwind dispatches via the Aerodrome adapter.


```solidity
function test_venueAerodrome_emergencyUnwind_routesThroughAerodromeAdapter() public;
```

### test_mixedVenue_allVenueValuesStoredCorrectly

A three-asset basket (V3 + V4 + Aerodrome) stores all three venue
values correctly on AssetInfo.


```solidity
function test_mixedVenue_allVenueValuesStoredCorrectly() public;
```

### test_mixedVenue_deposit_eachAssetDispatchedThroughCorrectRouter

A three-asset basket deposits each portion through the correct router.


```solidity
function test_mixedVenue_deposit_eachAssetDispatchedThroughCorrectRouter() public;
```

### _buildMixedVenueVault

Builds a fresh vault wired with V3 + V4 + Aerodrome assets.
Extracted to avoid stack-too-deep in the deposit test.


```solidity
function _buildMixedVenueVault() internal returns (BasketVaultHarness freshVault);
```

### _doMixedVenueDeposit

Performs a deposit on a mixed-venue vault, seeding all three routers,
and asserts each asset was received.


```solidity
function _doMixedVenueDeposit(BasketVaultHarness freshVault) internal;
```

## Events
### AssetAdded

```solidity
event AssetAdded(
    uint256 indexed index,
    address indexed token,
    address pool,
    uint24 swapFee,
    address adapter,
    BasketVault.Venue venue
);
```

