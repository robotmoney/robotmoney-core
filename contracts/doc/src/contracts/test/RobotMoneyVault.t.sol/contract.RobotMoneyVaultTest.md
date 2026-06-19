# RobotMoneyVaultTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/09c1813279f1fa827a425df89836eb093cfa67e8/contracts/test/RobotMoneyVault.t.sol)

**Inherits:**
Test


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### TVL_CAP

```solidity
uint256 internal constant TVL_CAP = 1_000_000_000 * ONE_USDC
```


### PER_DEPOSIT_CAP

```solidity
uint256 internal constant PER_DEPOSIT_CAP = 100_000_000 * ONE_USDC
```


### OFFSET

```solidity
uint256 internal constant OFFSET = 18
```


### VIRTUAL_SHARES

```solidity
uint256 internal constant VIRTUAL_SHARES = 10 ** OFFSET
```


## State Variables
### usdc

```solidity
TestUSDC internal usdc
```


### vault

```solidity
VaultHarness internal vault
```


### adapter

```solidity
MockAdapter internal adapter
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### feeRecipient

```solidity
address internal feeRecipient = makeAddr("feeRecipient")
```


### alice

```solidity
address internal alice = makeAddr("alice")
```


### bob

```solidity
address internal bob = makeAddr("bob")
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

### _allowAdapter


```solidity
function _allowAdapter(RobotMoneyVault vault_, address adapter_) internal;
```

### test_addAdapter_revertsWhenAdapterAddressNotAllowed


```solidity
function test_addAdapter_revertsWhenAdapterAddressNotAllowed() public;
```

### test_addAdapter_revertsWhenAdapterCodeHashNotAllowed


```solidity
function test_addAdapter_revertsWhenAdapterCodeHashNotAllowed() public;
```

### test_addAdapter_revertsWhenAdapterAssetMismatchesVault


```solidity
function test_addAdapter_revertsWhenAdapterAssetMismatchesVault() public;
```

### test_addAdapter_revertsWhenAdapterVaultMismatchesVault


```solidity
function test_addAdapter_revertsWhenAdapterVaultMismatchesVault() public;
```

### test_approvedProductionAndDevnetAdapterTypesCanBeAdded


```solidity
function test_approvedProductionAndDevnetAdapterTypesCanBeAdded() public;
```

### test_deposit_skipsAdapterAfterApprovalRevoked_fundsStayIdle

Revoking an active adapter's allowlist entry must NOT brick deposits
(audit 2026-06-09, L-4): `_routeDeposit` skips the ineligible adapter
and the funds stay idle in the vault (UnroutedDeposit emitted).


```solidity
function test_deposit_skipsAdapterAfterApprovalRevoked_fundsStayIdle() public;
```

### test_deposit_routesToRemainingEligibleAdapterAfterRevocation

With two adapters, revoking one routes the full deposit into the
remaining eligible adapter instead of reverting (audit L-4).


```solidity
function test_deposit_routesToRemainingEligibleAdapterAfterRevocation() public;
```

### test_withdraw_revertsWithInsufficientAdapterLiquidity_onAdapterShortfall

`_pullProportional` reverts with the dedicated
`InsufficientAdapterLiquidity` error (instead of an opaque ERC-20
transfer revert) when the active adapters cannot deliver the
requested withdrawal (audit 2026-06-09, L-2).


```solidity
function test_withdraw_revertsWithInsufficientAdapterLiquidity_onAdapterShortfall() public;
```

### test_withdraw_sweepCoversLastAdapterShortfall

The leftover sweep distributes a shortfall across ALL active adapters
instead of dumping it on the last one: a withdrawal that the honest
adapter can cover succeeds even when the registry's last adapter
under-delivers (audit 2026-06-09, L-2).


```solidity
function test_withdraw_sweepCoversLastAdapterShortfall() public;
```

### test_rebalance_skipsAdapterAfterApprovalRevoked

Keeper `rebalance()` must NOT brick when an active adapter's allowlist
entry is revoked (audit L-4): the routing pass skips it; idle funds remain.


```solidity
function test_rebalance_skipsAdapterAfterApprovalRevoked() public;
```

### test_adminRebalanceCannotAllocateToAdapterAfterApprovalRevoked


```solidity
function test_adminRebalanceCannotAllocateToAdapterAfterApprovalRevoked() public;
```

### test_emergencyWithdrawStillWorksAfterApprovalRevoked


```solidity
function test_emergencyWithdrawStillWorksAfterApprovalRevoked() public;
```

### test_decimalsOffset_is18

Confirm the offset is exactly 18 (the value proven safe against inflation attacks).


```solidity
function test_decimalsOffset_is18() public view;
```

### test_shareDecimals_is6

Share token decimals remain 6 (USDC-matching, intentional override).


```solidity
function test_shareDecimals_is6() public view;
```

### test_previewDeposit_freshVault_rawShareScale

previewDeposit on a fresh vault: depositing 1 USDC returns 1e24 raw shares.
This is the expected raw-share scale with decimalsOffset=18 and decimals()=6.


```solidity
function test_previewDeposit_freshVault_rawShareScale() public view;
```

### test_previewDeposit_freshVault_largeAmount

previewDeposit scales linearly for larger amounts on fresh vault.


```solidity
function test_previewDeposit_freshVault_largeAmount() public view;
```

### test_previewMint_freshVault_rawShareScale

previewMint on a fresh vault: minting 1e24 raw shares costs 1 USDC.


```solidity
function test_previewMint_freshVault_rawShareScale() public view;
```

### test_previewWithdraw_freshVault_rawShareScale

previewWithdraw on a fresh vault: receiving 1 USDC requires 1e24 raw shares.


```solidity
function test_previewWithdraw_freshVault_rawShareScale() public view;
```

### test_previewRedeem_freshVault_rawShareScale

previewRedeem on a fresh vault: redeeming 1e24 raw shares yields 1 USDC.


```solidity
function test_previewRedeem_freshVault_rawShareScale() public view;
```

### test_previewDeposit_afterSeed_proportional

After the admin seeds 1000 USDC, previewDeposit is still proportional.


```solidity
function test_previewDeposit_afterSeed_proportional() public;
```

### test_inflationAttack_victimReceivesFairShares

Core attack scenario: attacker deposits 1 wei then donates 1M USDC to the
adapter directly (bypassing the vault). Victim deposits — must NOT receive
zero shares, and must receive economically fair shares.


```solidity
function test_inflationAttack_victimReceivesFairShares() public;
```

### test_inflationAttack_previewDepositNonZero

After a 1 wei first deposit + 1M USDC donation, previewDeposit for a
realistic victim amount (999_999 USDC) must NOT return zero shares.


```solidity
function test_inflationAttack_previewDepositNonZero() public;
```

### test_aaveStyleDonation_victimSharesNonZero

Verify that an Aave-style donation (to the adapter, bypassing the vault)
cannot force a realistic victim deposit to receive zero shares.


```solidity
function test_aaveStyleDonation_victimSharesNonZero() public;
```

### test_morphoStyleDonation_victimSharesNonZero

Verify that a Morpho-style donation (also to the adapter)
cannot force a realistic victim deposit to receive zero shares.


```solidity
function test_morphoStyleDonation_victimSharesNonZero() public;
```

### test_compoundStyleDonation_victimSharesNonZero

Verify that a Compound-style donation (also via adapter)
cannot force a realistic victim deposit to receive zero shares.


```solidity
function test_compoundStyleDonation_victimSharesNonZero() public;
```

### test_seedDeposit_adminCanSeed1000USDC

Admin can perform the recommended seed deposit immediately after deployment.
After seeding 1000 USDC, the vault is safe for public deposits.


```solidity
function test_seedDeposit_adminCanSeed1000USDC() public;
```

### test_seedDeposit_normalDepositProportional

After a 1000 USDC admin seed, a normal user deposit is proportional.


```solidity
function test_seedDeposit_normalDepositProportional() public;
```

### test_depositAndRedeem_roundTrip

Depositing then immediately redeeming returns (approximately) the same assets.


```solidity
function test_depositAndRedeem_roundTrip() public;
```

### test_totalAssets_includesIdleVaultBalance

A direct USDC transfer to the vault (not via deposit) must be
included in totalAssets().


```solidity
function test_totalAssets_includesIdleVaultBalance() public;
```

### test_tvlCap_enforcedIncludingIdleBalance

TVL cap must be enforced against the sum of adapter balances AND idle vault
balance, so that idle USDC cannot be used to bypass the cap.


```solidity
function test_tvlCap_enforcedIncludingIdleBalance() public;
```

### test_routeDeposit_emitsUnroutedDeposit_whenCapsExhausted

UnroutedDeposit event is emitted when routing cannot place all assets
(all adapter caps exhausted).


```solidity
function test_routeDeposit_emitsUnroutedDeposit_whenCapsExhausted() public;
```

### test_pause_allowedForEmergencyRole

EMERGENCY_ROLE holder can call pause().


```solidity
function test_pause_allowedForEmergencyRole() public;
```

### test_unpause_revertsForEmergencyRole

EMERGENCY_ROLE holder cannot call unpause() — must revert.
A compromised emergency key can halt the vault (DoS) but cannot restart it.


```solidity
function test_unpause_revertsForEmergencyRole() public;
```

### test_unpause_allowedForAdminRole

ADMIN_ROLE holder can call unpause() after the vault has been paused.


```solidity
function test_unpause_allowedForAdminRole() public;
```

### test_emergencyWithdraw_userCanRedeem_newDepositBlocked

After emergencyWithdraw(), users can redeem their shares (assets moved to idle USDC).
New deposits must be blocked.


```solidity
function test_emergencyWithdraw_userCanRedeem_newDepositBlocked() public;
```

### test_fullPause_blocksDepositsAndWithdrawals

full pause() blocks both deposits and withdrawals.


```solidity
function test_fullPause_blocksDepositsAndWithdrawals() public;
```

### test_emergencyWithdraw_thenUnpause_restoresFullFunctionality

After emergencyWithdraw, split-pause state is correctly set; full unpause restores both.


```solidity
function test_emergencyWithdraw_thenUnpause_restoresFullFunctionality() public;
```

### test_forceRemoveAdapter_deactivatesAdapterAndEmitsCorrectLoss

EMERGENCY_ROLE can force-remove an adapter with assets; active flag becomes false
and AdapterForceRemoved is emitted with the correct lossAmount.


```solidity
function test_forceRemoveAdapter_deactivatesAdapterAndEmitsCorrectLoss() public;
```

### test_forceRemoveAdapter_succeedsWhenTotalAssetsReverts


```solidity
function test_forceRemoveAdapter_succeedsWhenTotalAssetsReverts() public;
```

### test_forceRemoveAdapter_revertsWhenCallerLacksEmergencyRole

Calling forceRemoveAdapter without EMERGENCY_ROLE must revert with AccessControl error.


```solidity
function test_forceRemoveAdapter_revertsWhenCallerLacksEmergencyRole() public;
```

### test_forceRemoveAdapter_revertsOnOutOfRangeIndex

Calling forceRemoveAdapter with an out-of-range index must revert with AdapterNotFound.


```solidity
function test_forceRemoveAdapter_revertsOnOutOfRangeIndex() public;
```

### test_forceRemoveAdapter_revertsOnAlreadyInactiveAdapter

Calling forceRemoveAdapter on an already-inactive adapter must revert with AdapterNotFound.


```solidity
function test_forceRemoveAdapter_revertsOnAlreadyInactiveAdapter() public;
```

### test_forceRemoveAdapter_pausesDeposits

forceRemoveAdapter must pause deposits to close the share-price-crash arbitrage window.


```solidity
function test_forceRemoveAdapter_pausesDeposits() public;
```

### test_shutdownVault_isRecoverableByAdminNotEmergency

EMERGENCY_ROLE can shut the vault down (deposits blocked,
maxDeposit == 0) and the new ADMIN_ROLE-gated restoreVault
re-opens deposits (maxDeposit > 0 and a deposit succeeds), while
EMERGENCY_ROLE alone cannot restore (reverts). This proves a
compromised emergency hot key can DoS but not permanently brick
deposits — mirroring the documented pause/unpause asymmetry.


```solidity
function test_shutdownVault_isRecoverableByAdminNotEmergency() public;
```

### test_restoreVault_revertsWhenNotShutdownOrZeroCap

restoreVault reverts when the vault is not shut down (NotShutdown)
and when the supplied cap is zero (InvalidCap).


```solidity
function test_restoreVault_revertsWhenNotShutdownOrZeroCap() public;
```

### test_retire_haltsDirectDepositsButKeepsRedeemOpen

After the registry drives `retire()`, direct deposits/mints are
hard-stopped at the vault (maxDeposit == 0, deposit reverts), but
withdrawals/redemptions stay open. `retire()` is callable only by
the linked registry; a stranger (even ADMIN_ROLE) call reverts.


```solidity
function test_retire_haltsDirectDepositsButKeepsRedeemOpen() public;
```

### test_retire_isIndependentFromEmergencyShutdown

The vault `retire`/`unretire` lifecycle flag is distinct from the
emergency `shutdown` overlay: retiring does not set `shutdown`, and
`shutdownVault` continues to work independently after a retire.


```solidity
function test_retire_isIndependentFromEmergencyShutdown() public;
```

### test_unretire_reopensDirectDeposits

The registry can abort a deprecation via `unretire()`, re-opening
direct deposits. Only the linked registry may call it.


```solidity
function test_unretire_reopensDirectDeposits() public;
```

### test_setRegistry_isSetOnceAndAdminGated

`setRegistry` is set-once and ADMIN_ROLE-gated.


```solidity
function test_setRegistry_isSetOnceAndAdminGated() public;
```

### test_sweepForeignToken_revertsForVaultAsset

INV-1: the vault asset (USDC) can never be swept out — it is a
protocol/depositor asset counted in NAV and redeemable by holders.


```solidity
function test_sweepForeignToken_revertsForVaultAsset() public;
```

### test_sweepForeignToken_revertsForShareToken

INV-1: the vault share token can never be swept out.


```solidity
function test_sweepForeignToken_revertsForShareToken() public;
```

### test_sweepForeignToken_permissionlessToQuarantine

INV-2: a genuinely foreign token is permissionlessly swept to the
fixed quarantine address by ANY caller — no admin role, no
caller-supplied recipient (replaces deleted `rescueTokens`).


```solidity
function test_sweepForeignToken_permissionlessToQuarantine() public;
```

### test_donatingVaultAsset_raisesNavForAllHolders

INV-2: donating the vault asset (USDC) directly to the vault
strictly increases totalAssets and credits ALL holders pro-rata —
the donation is absorbed into NAV, not routable to any admin.


```solidity
function test_donatingVaultAsset_raisesNavForAllHolders() public;
```

