# AerodromeAssetPositionAdapterTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/d740448a2c3c14fa0c325f99c0cf5fb21593c110/contracts/test/AerodromeAssetPositionAdapter.t.sol)

**Inherits:**
Test


## Constants
### TICK_SPACING

```solidity
int24 internal constant TICK_SPACING = 100
```


### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### token

```solidity
AeroPositionMockToken18 internal token
```


### venue

```solidity
AeroPositionMockVenue internal venue
```


### pool

```solidity
AeroPositionMockPool internal pool
```


### vault

```solidity
AeroPositionMockVault internal vault
```


### adapter

```solidity
AerodromeAssetPositionAdapter internal adapter
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### attacker

```solidity
address internal attacker = makeAddr("attacker")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_identityViews_constructorBound


```solidity
function test_identityViews_constructorBound() public view;
```

### test_isExact_isFalse


```solidity
function test_isExact_isFalse() public view;
```

### test_effectiveTwapWindow_defaultsWhenUnset


```solidity
function test_effectiveTwapWindow_defaultsWhenUnset() public view;
```

### test_totalAssets_zeroBalanceReturnsZeroWithoutOracle


```solidity
function test_totalAssets_zeroBalanceReturnsZeroWithoutOracle() public;
```

### test_deploy_custodiesTokenAndCreditsRealizedValue


```solidity
function test_deploy_custodiesTokenAndCreditsRealizedValue() public;
```

### test_deploy_onlyVault


```solidity
function test_deploy_onlyVault() public;
```

### test_deploy_revertsWhenValueBelowMinValueOut


```solidity
function test_deploy_revertsWhenValueBelowMinValueOut() public;
```

### test_totalAssets_usesConfiguredTwapWindow


```solidity
function test_totalAssets_usesConfiguredTwapWindow() public;
```

### test_deploy_navDeviationGuardReverts_onOutOfWindowMark


```solidity
function test_deploy_navDeviationGuardReverts_onOutOfWindowMark() public;
```

### test_deploy_navDeviationGuardPasses_whenSpotTracksTwap


```solidity
function test_deploy_navDeviationGuardPasses_whenSpotTracksTwap() public;
```

### test_withdraw_deliversUsdcToVault


```solidity
function test_withdraw_deliversUsdcToVault() public;
```

### test_withdraw_onlyVault


```solidity
function test_withdraw_onlyVault() public;
```

### test_withdraw_revertsBelowComposedFloor


```solidity
function test_withdraw_revertsBelowComposedFloor() public;
```

### test_withdraw_clampsShortfallAboveFloor


```solidity
function test_withdraw_clampsShortfallAboveFloor() public;
```

### test_setters_onlyVaultAdmin


```solidity
function test_setters_onlyVaultAdmin() public;
```

### test_setTwapWindow_boundsEnforced


```solidity
function test_setTwapWindow_boundsEnforced() public;
```

### test_setMaxSlippageBps_ceilingEnforced


```solidity
function test_setMaxSlippageBps_ceilingEnforced() public;
```

### test_setNavDeviationGuardBps_ceilingEnforced


```solidity
function test_setNavDeviationGuardBps_ceilingEnforced() public;
```

### test_harvestRewards_isNoOpAndNeverReverts


```solidity
function test_harvestRewards_isNoOpAndNeverReverts() public;
```

### test_sweepForeignToken_revertsForProtectedUsdcAndToken


```solidity
function test_sweepForeignToken_revertsForProtectedUsdcAndToken() public;
```

### test_sweepForeignToken_quarantinesForeignToken


```solidity
function test_sweepForeignToken_quarantinesForeignToken() public;
```

