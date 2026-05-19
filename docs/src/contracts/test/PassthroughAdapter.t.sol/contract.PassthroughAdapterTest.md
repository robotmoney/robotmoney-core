# PassthroughAdapterTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/9261c12d1be5f94820a0955546db76c69aef496d/contracts/test/PassthroughAdapter.t.sol)

**Inherits:**
Test

Tests for PassthroughAdapter and its integration with RobotMoneyVault.
Key invariants under test:
- PassthroughAdapter correctly holds USDC after deploy().
- PassthroughAdapter returns USDC on withdraw().
- totalAssets() reflects the held balance.
- Only VAULT can call mutating functions.
- rescueTokens reverts for USDC.
Integration (testPassthroughRoundTrip):
- Deposit 1e6 USDC into a fresh RobotMoneyVault + PassthroughAdapter.
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
PassthroughAdapter internal adapter
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

### test_rescueTokens_revertsForNonVault


```solidity
function test_rescueTokens_revertsForNonVault() public;
```

### test_rescueTokens_revertsForUsdc


```solidity
function test_rescueTokens_revertsForUsdc() public;
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

### testPassthroughRoundTrip

Issue #277 acceptance criterion: deposit 1e6 USDC into fresh
RobotMoneyVault + PassthroughAdapter, assert:
- balanceOf(user) >= 1e24 (decimalsOffset=18)
- previewRedeem(balanceOf) >= 999_000 (zero-fee, within rounding)


```solidity
function testPassthroughRoundTrip() public;
```

