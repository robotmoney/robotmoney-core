# DeSpxaChronicleAdapterTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/20a28674ed248f52a2865a2d77d65dc7c7a00bed/contracts/test/DeSpxaAssetPositionAdapter.t.sol)

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


### token

```solidity
DeSpxaPositionMockToken18 internal token
```


### chronicle

```solidity
DeSpxaPositionMockChronicle internal chronicle
```


### venue

```solidity
DeSpxaPositionMockVenue internal venue
```


### vault

```solidity
DeSpxaPositionMockVault internal vault
```


### adapter

```solidity
DeSpxaAssetPositionAdapter internal adapter
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

### test_oracleHeartbeat_defaultsToDefaultHeartbeat


```solidity
function test_oracleHeartbeat_defaultsToDefaultHeartbeat() public view;
```

### test_totalAssets_zeroBalanceReturnsZeroWithoutOracleRead


```solidity
function test_totalAssets_zeroBalanceReturnsZeroWithoutOracleRead() public;
```

### test_totalAssets_pricesCorrectlyWithinHeartbeat


```solidity
function test_totalAssets_pricesCorrectlyWithinHeartbeat() public;
```

### test_totalAssets_revertsWhenChroniclePriceOlderThanHeartbeat


```solidity
function test_totalAssets_revertsWhenChroniclePriceOlderThanHeartbeat() public;
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

### test_deploy_revertsWhenChroniclePriceStale


```solidity
function test_deploy_revertsWhenChroniclePriceStale() public;
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

### test_withdraw_revertsWhenChroniclePriceStale


```solidity
function test_withdraw_revertsWhenChroniclePriceStale() public;
```

### test_withdraw_zeroBalanceReturnsZeroWithoutOracleRead


```solidity
function test_withdraw_zeroBalanceReturnsZeroWithoutOracleRead() public;
```

### test_setters_onlyVaultAdmin


```solidity
function test_setters_onlyVaultAdmin() public;
```

### test_setMaxSlippageBps_ceilingEnforced


```solidity
function test_setMaxSlippageBps_ceilingEnforced() public;
```

### test_setOracleHeartbeat_boundsEnforced


```solidity
function test_setOracleHeartbeat_boundsEnforced() public;
```

### test_setOracleHeartbeat_updatesEffectiveWindow


```solidity
function test_setOracleHeartbeat_updatesEffectiveWindow() public;
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

