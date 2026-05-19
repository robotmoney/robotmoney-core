# BasketVaultTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e7a2933e057a3f91470ea3808b683595abe0b3d0/contracts/test/BasketVault.t.sol)

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


### basketToken

```solidity
TestERC20 internal basketToken
```


### router

```solidity
MockSwapRouter internal router
```


### pool

```solidity
MockPool internal pool
```


### vault

```solidity
BasketVaultHarness internal vault
```


### admin

```solidity
address internal admin = makeAddr("admin")
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

### test_emergencyUnwind_revertsWhenRouterOutputBelowConfiguredMinimum


```solidity
function test_emergencyUnwind_revertsWhenRouterOutputBelowConfiguredMinimum() public;
```

### test_emergencyUnwind_succeedsWhenRouterOutputSatisfiesConfiguredMinimum


```solidity
function test_emergencyUnwind_succeedsWhenRouterOutputSatisfiesConfiguredMinimum() public;
```

### test_emergencyUnwindWithOverride_emitsHighRiskEvent


```solidity
function test_emergencyUnwindWithOverride_emitsHighRiskEvent() public;
```

### test_emergencyUnwindWithOverride_requiresEmergencyRole


```solidity
function test_emergencyUnwindWithOverride_requiresEmergencyRole() public;
```

### test_addAsset_revertsWhenPoolDoesNotPairTokenWithUsdc


```solidity
function test_addAsset_revertsWhenPoolDoesNotPairTokenWithUsdc() public;
```

### test_rescueTokens_revertsWhenTokenIsActiveBasketAsset


```solidity
function test_rescueTokens_revertsWhenTokenIsActiveBasketAsset() public;
```

### test_rescueTokens_succeedsForNonBasketAsset


```solidity
function test_rescueTokens_succeedsForNonBasketAsset() public;
```

### test_emergencyUnwindWithOverride_revertsWhenBelowUpperLossCap


```solidity
function test_emergencyUnwindWithOverride_revertsWhenBelowUpperLossCap() public;
```

### test_emergencyUnwindWithOverride_succeedsWithinUpperLossCap


```solidity
function test_emergencyUnwindWithOverride_succeedsWithinUpperLossCap() public;
```

### test_setEmergencyUnwindGuard_requiresAdminRole


```solidity
function test_setEmergencyUnwindGuard_requiresAdminRole() public;
```

### test_setEmergencyUnwindGuard_rejectsMaxLossBpsAboveMaxBps


```solidity
function test_setEmergencyUnwindGuard_rejectsMaxLossBpsAboveMaxBps() public;
```

### test_pauseAndShutdownEmergencyControlsRemainFunctional


```solidity
function test_pauseAndShutdownEmergencyControlsRemainFunctional() public;
```

### test_totalAssets_usesTwapTickNotSlot0


```solidity
function test_totalAssets_usesTwapTickNotSlot0() public;
```

### test_totalAssets_revertsOnSpotPriceManipulationUsingSlot0


```solidity
function test_totalAssets_revertsOnSpotPriceManipulationUsingSlot0() public;
```

### test_setTwapWindow_requiresAdminRole


```solidity
function test_setTwapWindow_requiresAdminRole() public;
```

### test_setTwapWindow_rejectsBelowMinimum


```solidity
function test_setTwapWindow_rejectsBelowMinimum() public;
```

### test_setTwapWindow_rejectsAboveMaximum


```solidity
function test_setTwapWindow_rejectsAboveMaximum() public;
```

### test_setTwapWindow_acceptsBoundary


```solidity
function test_setTwapWindow_acceptsBoundary() public;
```

### test_effectiveTwapWindow_fallsBackToDefault


```solidity
function test_effectiveTwapWindow_fallsBackToDefault() public view;
```

### test_emergencyUnwindMinimum_derivedFromTwapNotSlot0


```solidity
function test_emergencyUnwindMinimum_derivedFromTwapNotSlot0() public;
```

### test_setTwapWindow_emitsEvent


```solidity
function test_setTwapWindow_emitsEvent() public;
```

## Events
### EmergencyUnwindOverrideUsed

```solidity
event EmergencyUnwindOverrideUsed(
    address indexed token,
    uint256 amountIn,
    uint256 minUsdcOut,
    uint256 appliedFloor,
    address indexed caller
);
```

### TwapWindowUpdated

```solidity
event TwapWindowUpdated(address indexed token, uint32 oldWindow, uint32 newWindow);
```

