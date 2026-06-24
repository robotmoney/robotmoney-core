# NoYieldTestAdapterTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a2a6d8e4e2a61d93030482a63145fd865f67cc02/contracts/test/NoYieldTestAdapter.t.sol)

**Inherits:**
Test

Tests for NoYieldTestAdapter and its integration with RobotMoneyVault.
Key invariants under test:
- NoYieldTestAdapter correctly holds USDC after deploy().
- NoYieldTestAdapter returns USDC on withdraw().
- totalAssets() reflects the held balance.
- Only VAULT can call mutating functions.
- rescueTokens reverts for USDC.
Integration (testNoYieldRoundTrip):
- Deposit 1e6 USDC into a fresh RobotMoneyVault + NoYieldTestAdapter.
- Assert balanceOf >= 1e24 raw shares (decimalsOffset=18).
- Assert previewRedeem returns >= 999_000 (zero-fee, within rounding).


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1_000_000
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### vault

```solidity
RobotMoneyVault internal vault
```


### adapter

```solidity
NoYieldTestAdapter internal adapter
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### user

```solidity
address internal user = makeAddr("user")
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

### test_constructor_setsImmutables


```solidity
function test_constructor_setsImmutables() public view;
```

### test_constructor_revertsOnZeroUsdc


```solidity
function test_constructor_revertsOnZeroUsdc() public;
```

### test_constructor_revertsOnZeroVault


```solidity
function test_constructor_revertsOnZeroVault() public;
```

### test_deploy_revertsForNonVault


```solidity
function test_deploy_revertsForNonVault() public;
```

### test_withdraw_revertsForNonVault


```solidity
function test_withdraw_revertsForNonVault() public;
```

### test_sweepForeignToken_permissionlessToQuarantine


```solidity
function test_sweepForeignToken_permissionlessToQuarantine() public;
```

### test_sweepForeignToken_revertsForUsdc


```solidity
function test_sweepForeignToken_revertsForUsdc() public;
```

### test_totalAssets_zeroWhenEmpty


```solidity
function test_totalAssets_zeroWhenEmpty() public view;
```

### test_totalAssets_reflectsBalance


```solidity
function test_totalAssets_reflectsBalance() public;
```

### test_withdraw_fullBalance


```solidity
function test_withdraw_fullBalance() public;
```

### test_withdraw_partialBalance


```solidity
function test_withdraw_partialBalance() public;
```

### test_withdraw_overBalance_returnsActual


```solidity
function test_withdraw_overBalance_returnsActual() public;
```

### test_withdraw_zeroBalance_returnsZero


```solidity
function test_withdraw_zeroBalance_returnsZero() public;
```

### testNoYieldRoundTrip

Issue #277 acceptance criterion: deposit 1e6 USDC into fresh
RobotMoneyVault + NoYieldTestAdapter, assert:
- balanceOf(user) >= 1e24 (decimalsOffset=18)
- previewRedeem(balanceOf) >= 999_000 (zero-fee, within rounding)


```solidity
function testNoYieldRoundTrip() public;
```

