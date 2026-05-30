# PortfolioRouterTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e30069c8df8fc8c637d65bc2f991adfaf60a1079/contracts/test/PortfolioRouter.t.sol)

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

### test_setWeights_revertsIfVaultAssetMismatch

Registered vault whose ERC-4626 `asset()` is not router USDC
cannot be added to the weight vector.


```solidity
function test_setWeights_revertsIfVaultAssetMismatch() public;
```

### test_setWeights_revertsIfVaultAssetUnreadable

A registered EOA-style "vault" (no code, asset() reverts) cannot
be added to the weight vector. This protects against an
attacker registering an arbitrary address with crafted metadata
and being able to weight it.


```solidity
function test_setWeights_revertsIfVaultAssetUnreadable() public;
```

### test_deposit_revertsIfVaultAssetMismatchAtRuntime

A malicious ERC-4626-shaped vault whose underlying asset is not
router USDC cannot receive USDC via PortfolioRouter.deposit even
if it were somehow present in the weight vector. The
setWeights guard normally blocks this; this test installs the
bad vault via direct storage manipulation (foundry `store`) on
a fresh router so we can prove the deposit-time check rejects
it as defence in depth.


```solidity
function test_deposit_revertsIfVaultAssetMismatchAtRuntime() public;
```

### test_depositFor_revertsIfVaultAssetMismatch

`depositFor` also enforces router eligibility at runtime.


```solidity
function test_depositFor_revertsIfVaultAssetMismatch() public;
```

### test_deposit_eligibleVaults_succeed

Eligible vaults retain their normal deposit behaviour — the
eligibility guard does not affect the happy path.


```solidity
function test_deposit_eligibleVaults_succeed() public;
```

### test_isRouterEligible_trueForUSDCVault

`isRouterEligible` returns true for a USDC-backed ERC-4626 vault.


```solidity
function test_isRouterEligible_trueForUSDCVault() public view;
```

### test_isRouterEligible_falseForNonUSDCVault

`isRouterEligible` returns false for a non-USDC-backed vault.


```solidity
function test_isRouterEligible_falseForNonUSDCVault() public;
```

### test_isRouterEligible_falseForEOA

`isRouterEligible` returns false for an EOA (no asset() view).


```solidity
function test_isRouterEligible_falseForEOA() public;
```

### test_isRouterEligible_falseForZeroAddress

`isRouterEligible` returns false for address(0).


```solidity
function test_isRouterEligible_falseForZeroAddress() public view;
```

### test_isRouterEligible_independentOfRegistryStatus

Router eligibility is distinct from registry status — a vault
that is Paused in the registry is still router-eligible from
an asset-compatibility standpoint. Clients must read both
signals to compose accurate UI state.


```solidity
function test_isRouterEligible_independentOfRegistryStatus() public;
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

### _registerIneligible

Helper: register a vault in the registry without marking it
router-eligible. Used to exercise the eligibility gate from
the un-opted-in default state.


```solidity
function _registerIneligible(address vault) internal;
```

### test_setWeights_revertsIfVaultNotRouterEligible

AC#4 (test-plan: fail-closed): a registered vault that has NOT
been marked router-eligible in the registry is rejected by
setWeights with `VaultNotRouterEligible`. The default
eligibility value is false for every registration, so a fresh
deployment is gated by construction.


```solidity
function test_setWeights_revertsIfVaultNotRouterEligible() public;
```

### test_setWeights_succeedsAfterRegistryOptIn

AC#3 (test-plan: configuration-only success): a vault becomes
router-eligible via a single registry call — no subclass, no
code override — and a USDC deposit through PortfolioRouter
succeeds end-to-end. This is the production weighting flow
that test, demo, and mainnet all share.


```solidity
function test_setWeights_succeedsAfterRegistryOptIn() public;
```

### test_deposit_revertsIfRegistryEligibilityRevoked

Defence-in-depth: revoking the registry eligibility flag after
a vault has been weighted prevents subsequent deposits from
routing through it.


```solidity
function test_deposit_revertsIfRegistryEligibilityRevoked() public;
```

### test_setRouterEligible_revertsForUnauthorized

`VaultRegistry.setRouterEligible` is admin-gated.


```solidity
function test_setRouterEligible_revertsForUnauthorized() public;
```

### test_setRouterEligible_revertsIfNotRegistered

`VaultRegistry.setRouterEligible` rejects unregistered vaults
— the flag cannot be set on an address that was never
registered.


```solidity
function test_setRouterEligible_revertsIfNotRegistered() public;
```

### test_setRouterEligible_emitsEvent

`VaultRegistry.setRouterEligible` emits the audit event with
old/new values so a registry indexer can track every flip.


```solidity
function test_setRouterEligible_emitsEvent() public;
```

### test_isRouterEligible_followsRegistryFlag

`PortfolioRouter.isRouterEligible` mirrors the gate enforced
at setWeights / deposit time: false for a registered but
un-opted-in vault, true once the registry flag is flipped.


```solidity
function test_isRouterEligible_followsRegistryFlag() public;
```

### _registerRwaPlaceholder

Register a fourth vault matching the demo's RWA/Thematic
placeholder shape: present in the registry but non-Active
(Paused) and never marked router-eligible. Returns the vault.


```solidity
function _registerRwaPlaceholder() internal returns (MockRouterVault rwa);
```

### test_previewDeposit_skipsRwaPlaceholder

AC (issue #479): with the RWA/Thematic placeholder present in
the registry as a non-Active, non-router-eligible entry,
`previewDeposit` returns only the weighted (Active, eligible)
legs and does not surface or revert on the RWA leg.


```solidity
function test_previewDeposit_skipsRwaPlaceholder() public;
```

### test_deposit_succeedsWithRwaPlaceholderPresent

AC (issue #479): `deposit` succeeds and splits across the
Active weighted vaults while the non-Active RWA placeholder
sits inertly in the registry — no revert, no flow to RWA.


```solidity
function test_deposit_succeedsWithRwaPlaceholderPresent() public;
```

### test_rwaPlaceholder_isNonActiveAndIneligible

AC (issue #479): the RWA placeholder reports the expected
non-Active status and stays router-ineligible — the two
signals the dapp and Router read to keep it out of flow.


```solidity
function test_rwaPlaceholder_isNonActiveAndIneligible() public;
```

### _setDefaultWeights

Set a default 60/40 vector over the two eligible vaults.


```solidity
function _setDefaultWeights() internal;
```

### test_setDefaultWeights_revertsIfLengthMismatch

setDefaultWeights rejects a length that does not match the
registry's router-eligible vault count.


```solidity
function test_setDefaultWeights_revertsIfLengthMismatch() public;
```

### test_previewDeposit_uses_defaultWeights_when_no_proposal

With no proposal ever passed (voted vector inactive), the router
previews and routes by the default weight vector. ADR-0002.


```solidity
function test_previewDeposit_uses_defaultWeights_when_no_proposal() public;
```

### test_previewDeposit_uses_defaultWeights_after_failed_quorum

After the voted vector is cleared (simulating a fall-back to
default after the most recent proposal failed quorum), the
router previews by the default vector again. ADR-0002.


```solidity
function test_previewDeposit_uses_defaultWeights_after_failed_quorum() public;
```

### test_voted_weights_override_defaults_then_revert_to_defaults

A passed vote overrides the default; defaultWeights storage is
unchanged; clearing the voted vector reverts to default. ADR-0002.


```solidity
function test_voted_weights_override_defaults_then_revert_to_defaults() public;
```

