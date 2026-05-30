# RobotMoneyVaultTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e30069c8df8fc8c637d65bc2f991adfaf60a1079/contracts/test/RobotMoneyVault.t.sol)

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

### test_depositCannotAllocateToAdapterAfterApprovalRevoked


```solidity
function test_depositCannotAllocateToAdapterAfterApprovalRevoked() public;
```

### test_rebalanceCannotAllocateToAdapterAfterApprovalRevoked


```solidity
function test_rebalanceCannotAllocateToAdapterAfterApprovalRevoked() public;
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

