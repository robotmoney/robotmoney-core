# PortfolioRouterTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/b447b3c942571522a243df98942e1c4f5c32d4e3/contracts/test/PortfolioRouter.t.sol)

**Inherits:**
Test


## Constants
### ONE_USDC

```solidity
uint256 constant ONE_USDC = 1e6
```


## State Variables
### usdc

```solidity
MockUSDC internal usdc
```


### registry

```solidity
VaultRegistry internal registry
```


### router

```solidity
PortfolioRouter internal router
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### depositor

```solidity
address internal depositor = makeAddr("depositor")
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


### vaultA

```solidity
MockRouterVault internal vaultA
```


### vaultB

```solidity
MockRouterVault internal vaultB
```


### vaultC

```solidity
MockRouterVault internal vaultC
```


### metaA

```solidity
VaultRegistry.VaultMetadata internal metaA
```


### metaB

```solidity
VaultRegistry.VaultMetadata internal metaB
```


### metaC

```solidity
VaultRegistry.VaultMetadata internal metaC
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _setEqualWeights


```solidity
function _setEqualWeights() internal;
```

### _fundAndApprove


```solidity
function _fundAndApprove(address user, uint256 amount) internal;
```

### test_constructor_revertsOnZeroUsdc


```solidity
function test_constructor_revertsOnZeroUsdc() public;
```

### test_constructor_revertsOnZeroRegistry


```solidity
function test_constructor_revertsOnZeroRegistry() public;
```

### test_constructor_revertsOnZeroAdmin


```solidity
function test_constructor_revertsOnZeroAdmin() public;
```

### test_constructor_grantsAdminRole


```solidity
function test_constructor_grantsAdminRole() public view;
```

### test_setWeights_revertsIfSumNot10000


```solidity
function test_setWeights_revertsIfSumNot10000() public;
```

### test_setWeights_revertsIfVaultNotRegistered


```solidity
function test_setWeights_revertsIfVaultNotRegistered() public;
```

### test_setWeights_revertsIfLengthMismatch


```solidity
function test_setWeights_revertsIfLengthMismatch() public;
```

### test_setWeights_revertsForUnauthorized


```solidity
function test_setWeights_revertsForUnauthorized() public;
```

### test_setWeights_happyPath_emitsEvent


```solidity
function test_setWeights_happyPath_emitsEvent() public;
```

### test_deposit_splitsUSDCProportionally


```solidity
function test_deposit_splitsUSDCProportionally() public;
```

### test_deposit_emitsRouterDepositPerLeg


```solidity
function test_deposit_emitsRouterDepositPerLeg() public;
```

### test_deposit_asymmetricWeights


```solidity
function test_deposit_asymmetricWeights() public;
```

### test_deposit_revertsIfAnyLegReverts


```solidity
function test_deposit_revertsIfAnyLegReverts() public;
```

### test_deposit_revertsIfRouterCapExceeded


```solidity
function test_deposit_revertsIfRouterCapExceeded() public;
```

### test_deposit_revertsIfVaultCapExceeded


```solidity
function test_deposit_revertsIfVaultCapExceeded() public;
```

### test_deposit_succeedsWhenBelowAllCaps


```solidity
function test_deposit_succeedsWhenBelowAllCaps() public;
```

### test_deposit_revertsIfSlippageExceeded


```solidity
function test_deposit_revertsIfSlippageExceeded() public;
```

### test_deposit_revertsIfMinSharesLengthMismatch


```solidity
function test_deposit_revertsIfMinSharesLengthMismatch() public;
```

### test_deposit_revertsIfNoWeightsSet


```solidity
function test_deposit_revertsIfNoWeightsSet() public;
```

### test_previewDeposit_returnsCorrectLegAmounts


```solidity
function test_previewDeposit_returnsCorrectLegAmounts() public;
```

### test_previewDeposit_marksUnavailableForPausedVault


```solidity
function test_previewDeposit_marksUnavailableForPausedVault() public;
```

### test_previewDeposit_marksUnavailableForRetiredVault


```solidity
function test_previewDeposit_marksUnavailableForRetiredVault() public;
```

### test_previewDeposit_doesNotRevertForUnavailableVault


```solidity
function test_previewDeposit_doesNotRevertForUnavailableVault() public;
```

### test_setRouterCap_emitsEvent


```solidity
function test_setRouterCap_emitsEvent() public;
```

### test_setVaultCap_emitsEvent


```solidity
function test_setVaultCap_emitsEvent() public;
```

### test_setRouterCap_revertsForUnauthorized


```solidity
function test_setRouterCap_revertsForUnauthorized() public;
```

### test_setVaultCap_revertsOnZeroAddress


```solidity
function test_setVaultCap_revertsOnZeroAddress() public;
```

### test_deposit_revertsIfRegistryVaultIsPaused

Deposit reverts when a vault in the weight list is Paused in the
registry, even if the vault contract itself would still accept
deposits.


```solidity
function test_deposit_revertsIfRegistryVaultIsPaused() public;
```

### test_deposit_revertsIfRegistryVaultIsRetired

Deposit reverts when a vault in the weight list is Retired in the
registry, even if the vault contract itself would still accept
deposits.


```solidity
function test_deposit_revertsIfRegistryVaultIsRetired() public;
```

### testFuzz_setWeights_singleVaultInvalidSum

Any single-vault weight that is not 10000 must revert.


```solidity
function testFuzz_setWeights_singleVaultInvalidSum(uint256 bps) public;
```

### testFuzz_deposit_proportionalSplit

A two-vault deposit always splits proportionally (capped to avoid overflow).
The first leg receives the floored BPS allocation; the final leg receives
the floored allocation plus any rounding remainder so the router holds zero.


```solidity
function testFuzz_deposit_proportionalSplit(uint256 amount, uint256 bpsA) public;
```

### test_deposit_noRouterDustOnUnevenSplit

Deposit with an amount not divisible by leg count leaves zero
USDC in the router (remainder is assigned to the final leg).


```solidity
function test_deposit_noRouterDustOnUnevenSplit() public;
```

### testFuzz_deposit_routerBalanceAlwaysZero

Fuzz: arbitrary deposit amounts and two-leg weights — router
balance is always zero after a successful deposit.


```solidity
function testFuzz_deposit_routerBalanceAlwaysZero(uint256 amount, uint256 bpsA) public;
```

