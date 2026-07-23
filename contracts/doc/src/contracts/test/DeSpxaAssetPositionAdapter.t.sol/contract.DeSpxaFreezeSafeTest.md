# DeSpxaFreezeSafeTest
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
DeSpxaFreezableToken18 internal token
```


### chronicle

```solidity
DeSpxaPositionMockChronicle internal chronicle
```


### venue

```solidity
DeSpxaFreezeMockVenue internal venue
```


### vault

```solidity
DeSpxaPositionMockVault internal vault
```


### adapter

```solidity
DeSpxaAssetPositionAdapter internal adapter
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_totalAssets_reportsSafeValueWhileFrozen


```solidity
function test_totalAssets_reportsSafeValueWhileFrozen() public;
```

### test_totalAssets_zeroBalanceStillSafeWhileFrozen


```solidity
function test_totalAssets_zeroBalanceStillSafeWhileFrozen() public;
```

### test_deploy_revertsWhileFrozenButTotalAssetsSurvives


```solidity
function test_deploy_revertsWhileFrozenButTotalAssetsSurvives() public;
```

### test_withdraw_revertsWhileFrozenButTotalAssetsSurvives


```solidity
function test_withdraw_revertsWhileFrozenButTotalAssetsSurvives() public;
```

### test_withdraw_succeedsAfterFreezeIsLifted


```solidity
function test_withdraw_succeedsAfterFreezeIsLifted() public;
```

