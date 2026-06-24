# BasketVaultTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/7d568c59b4026ccbeb96c8683b875a28e63a7d18/contracts/test/BasketVault.t.sol)

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


### emergencyResponder

```solidity
address internal emergencyResponder = makeAddr("emergencyResponder")
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

### test_addAsset_revertsForUnvettedAdapter

ADP-2 / NC-2: addAsset rejects a non-zero adapter whose codehash is
not on the ADMIN-approved allowlist.


```solidity
function test_addAsset_revertsForUnvettedAdapter() public;
```

### test_addAsset_acceptsVettedAdapterAfterApproval

ADP-2 / NC-2: once ADMIN approves the adapter's codehash, addAsset
accepts it.


```solidity
function test_addAsset_acceptsVettedAdapterAfterApproval() public;
```

### test_addAsset_revertsOnExecutionPoolMismatch

ORA-3 / F-09: addAsset reverts when the registered pool's fee tier
(the execution pool resolved from swapFee_) does not match swapFee_.


```solidity
function test_addAsset_revertsOnExecutionPoolMismatch() public;
```

### test_lastAdminFloor_revokeRevertsForSoleAdmin

ACL-3 / F-06: revoking the last ADMIN_ROLE holder reverts
(last-admin floor), so vault governance can never be bricked.


```solidity
function test_lastAdminFloor_revokeRevertsForSoleAdmin() public;
```

### test_lastAdminFloor_renounceRevertsForSoleAdmin

ACL-3 / F-06: renouncing the last ADMIN_ROLE holder reverts.


```solidity
function test_lastAdminFloor_renounceRevertsForSoleAdmin() public;
```

### test_lastAdminFloor_revokeSucceedsWithTwoAdmins

ACL-3 / F-06: with a second admin granted, the original may be
revoked — the floor only blocks dropping the FINAL admin.


```solidity
function test_lastAdminFloor_revokeSucceedsWithTwoAdmins() public;
```

### test_pause_doesNotFreezeWithdrawals

LIFE-3 / NC-3 / F-06: pause() freezes deposits but NOT withdrawals;
a holder can still redeem while the vault is paused.


```solidity
function test_pause_doesNotFreezeWithdrawals() public;
```

### test_sweepForeignToken_revertsForActiveBasketAsset

INV-1: an ACTIVE basket asset may never be swept to quarantine —
it is a protocol/depositor asset counted in NAV.


```solidity
function test_sweepForeignToken_revertsForActiveBasketAsset() public;
```

### test_sweepForeignToken_revertsForUsdcAndShareToken

INV-1: USDC (the vault asset) and the share token may never be swept.


```solidity
function test_sweepForeignToken_revertsForUsdcAndShareToken() public;
```

### test_sweepForeignToken_permissionlessForNonBasketAsset

INV-2: a genuinely foreign token is permissionlessly swept to the
fixed quarantine address — no admin role, no caller-supplied
recipient.


```solidity
function test_sweepForeignToken_permissionlessForNonBasketAsset() public;
```

### test_sweepForeignToken_revertsForInactiveBasketAsset

INV-1: a removed (inactive) basket asset is STILL protected from the
quarantine sweep — it is re-absorbed into NAV instead, never routed
away (replaces the audit 2026-06-09 L-15 admin rescue path).


```solidity
function test_sweepForeignToken_revertsForInactiveBasketAsset() public;
```

### test_reabsorbRemovedAsset_creditsNavPermissionlessly

INV-2: a balance reappearing on a removed basket asset is
permissionlessly re-absorbed — swapped to USDC into NAV — so it
stays redeemable by holders, with no admin-routable path.


```solidity
function test_reabsorbRemovedAsset_creditsNavPermissionlessly() public;
```

### test_reabsorbRemovedAsset_revertsForActiveAsset

An active asset cannot be re-absorbed (it is sold proportionally on
withdrawal, not swept).


```solidity
function test_reabsorbRemovedAsset_revertsForActiveAsset() public;
```

### test_LIFE6_reabsorbSurvivesDegradedPool

LIFE-6 / NC-8 (FLIPPED GREEN by #970): re-absorbing a removed asset
whose pool is DEGRADED (TWAP `observe()` reverts "OLD") never
reverts-and-strands. Pre-fix, the swap-floor read reverted and the
reappeared balance was stuck on the vault forever; post-fix the
quarantine fallback sweeps it to the governed quarantine address, so
the balance is always actionable (the reversible safety valve).
Deep proof referenced by FvInvariants.t.sol::test_LIFE6_*.


```solidity
function test_LIFE6_reabsorbSurvivesDegradedPool() public;
```

### test_LIFE6_reabsorbZeroBalanceIsNoOp

LIFE-6 / NC-8: a zero reappeared balance is an idempotent no-op,
never a revert, even on a degraded pool.


```solidity
function test_LIFE6_reabsorbZeroBalanceIsNoOp() public;
```

### test_NC8_addAsset_rejectsActiveDuplicate

NC-8: re-adding a token that already has an ACTIVE registry entry
reverts rather than creating a duplicate AssetInfo (which would
double-count it in NAV and corrupt the equal-weight split).


```solidity
function test_NC8_addAsset_rejectsActiveDuplicate() public;
```

### test_NC8_addAsset_reusesInactiveSlotOnReAdd

NC-8: re-adding a previously REMOVED token reuses its inactive
registry slot in place (refreshing config + re-activating) instead
of appending a second AssetInfo, so `assets` never holds two entries
for one token.


```solidity
function test_NC8_addAsset_reusesInactiveSlotOnReAdd() public;
```

### _assetsLen

Count the BasketVault `assets` registry by probing the public getter
until it reverts (no dedicated length getter on-chain — kept off the
EIP-170-tight basket bytecode).


```solidity
function _assetsLen() internal view returns (uint256 n);
```

### test_INV3_setFeeRecipient_revertsForHotEmergencyKey


```solidity
function test_INV3_setFeeRecipient_revertsForHotEmergencyKey() public;
```

### test_INV3_setExitFeeBps_revertsForHotEmergencyKey


```solidity
function test_INV3_setExitFeeBps_revertsForHotEmergencyKey() public;
```

### test_INV3_feeSetters_succeedForAdminRole


```solidity
function test_INV3_feeSetters_succeedForAdminRole() public;
```

### test_maxDeposit_reflectsPerDepositCap


```solidity
function test_maxDeposit_reflectsPerDepositCap() public view;
```

### test_maxDeposit_zeroWhenPaused


```solidity
function test_maxDeposit_zeroWhenPaused() public;
```

### test_maxDeposit_zeroWhenShutdown


```solidity
function test_maxDeposit_zeroWhenShutdown() public;
```

### test_F07_restoreVaultReopensDeposits

LIFE-4 / F-07: an EMERGENCY-triggered `shutdownVault` permanently
blocks deposits with no reverse path UNLESS the higher-trust
ADMIN_ROLE can `restoreVault`. Proof: shutdown blocks deposits;
ADMIN restore with a fresh cap re-opens them; a redeem in between
confirms withdrawals were never frozen (LIFE-3).


```solidity
function test_F07_restoreVaultReopensDeposits() public;
```

### test_F07_restoreVault_emergencyCannotRestore

F-07: only ADMIN_ROLE may restore; the EMERGENCY hot key that can
shut the vault down cannot reverse it (trust asymmetry, like unpause).


```solidity
function test_F07_restoreVault_emergencyCannotRestore() public;
```

### test_F07_restoreVault_revertsOnInvalidInputs

F-07: `restoreVault` rejects incoherent inputs — not-shut-down,
zero cap, or a cap below `perDepositCap`.


```solidity
function test_F07_restoreVault_revertsOnInvalidInputs() public;
```

### test_maxDeposit_zeroWhenNoActiveAssets


```solidity
function test_maxDeposit_zeroWhenNoActiveAssets() public;
```

### test_maxDeposit_reflectsTvlHeadroom


```solidity
function test_maxDeposit_reflectsTvlHeadroom() public;
```

### test_setMaxSlippageBps_revertsBelowPoolFeeFloor


```solidity
function test_setMaxSlippageBps_revertsBelowPoolFeeFloor() public;
```

### test_setMaxSlippageBps_acceptsValuesAtOrAboveFloor


```solidity
function test_setMaxSlippageBps_acceptsValuesAtOrAboveFloor() public;
```

### test_setMaxSlippageBps_zeroAllowedWhenNoActiveAssets


```solidity
function test_setMaxSlippageBps_zeroAllowedWhenNoActiveAssets() public;
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

### test_emergencyUnwind_staleFloor_usesTwapFloor

When minUsdcOut is stale (far below TWAP), emergencyUnwind uses the
live TWAP-derived floor and rejects a swap that only satisfies the
stale configured floor.


```solidity
function test_emergencyUnwind_staleFloor_usesTwapFloor() public;
```

### test_emergencyUnwind_configuredFloorAboveTwap_configuredFloorWins

When minUsdcOut is above the TWAP-derived floor, the configured floor wins
(max semantics). Attempting a swap at the TWAP-only level must revert.


```solidity
function test_emergencyUnwind_configuredFloorAboveTwap_configuredFloorWins() public;
```

### test_emergencyUnwind_bothFloorsSatisfied_succeeds

When a swap satisfies both the TWAP floor and the configured floor, the
emergency unwind completes successfully.


```solidity
function test_emergencyUnwind_bothFloorsSatisfied_succeeds() public;
```

### test_emergencyUnwindWithOverride_isOracleIndependent

Override execution remains available when the TWAP oracle is unavailable.


```solidity
function test_emergencyUnwindWithOverride_isOracleIndependent() public;
```

### test_setTwapWindow_emitsEvent


```solidity
function test_setTwapWindow_emitsEvent() public;
```

### test_constructor_grantsAdminRoleToAdminOnly

Constructor with distinct addresses grants each role to the
correct address and does NOT cross-assign.


```solidity
function test_constructor_grantsAdminRoleToAdminOnly() public view;
```

### test_constructor_grantsEmergencyRoleToEmergencyResponderOnly


```solidity
function test_constructor_grantsEmergencyRoleToEmergencyResponderOnly() public view;
```

### test_constructor_revertsWhenAdminIsZero

Constructor reverts when admin_ is address(0).


```solidity
function test_constructor_revertsWhenAdminIsZero() public;
```

### test_constructor_revertsWhenEmergencyResponderIsZero

Constructor reverts when emergencyResponder_ is address(0).


```solidity
function test_constructor_revertsWhenEmergencyResponderIsZero() public;
```

### test_setMaxSlippageBps_requiresAdminRole

ADMIN_ROLE holder can call setMaxSlippageBps; EMERGENCY_ROLE-only holder cannot.


```solidity
function test_setMaxSlippageBps_requiresAdminRole() public;
```

### test_emergencyUnwind_succeedsWhenAlreadyPaused

emergencyUnwind succeeds when vault is already paused.


```solidity
function test_emergencyUnwind_succeedsWhenAlreadyPaused() public;
```

### test_emergencyUnwindWithOverride_succeedsWhenAlreadyPaused

emergencyUnwindWithOverride succeeds when vault is already paused.


```solidity
function test_emergencyUnwindWithOverride_succeedsWhenAlreadyPaused() public;
```

### test_emergencyUnwind_pausesDepositsWhenNotAlreadyPaused

emergencyUnwind on an unpaused vault pauses deposits only.


```solidity
function test_emergencyUnwind_pausesDepositsWhenNotAlreadyPaused() public;
```

### test_emergencyUnwindWithOverride_pausesDepositsWhenNotAlreadyPaused

emergencyUnwindWithOverride on an unpaused vault pauses deposits only.


```solidity
function test_emergencyUnwindWithOverride_pausesDepositsWhenNotAlreadyPaused() public;
```

### test_emergencyUnwind_requiresEmergencyRole_adminOnlyReverts

EMERGENCY_ROLE holder can call emergencyUnwind; ADMIN_ROLE-only holder cannot.


```solidity
function test_emergencyUnwind_requiresEmergencyRole_adminOnlyReverts() public;
```

### test_addAsset_revertsWhenPoolCardinalityIsOne

addAsset() reverts with InsufficientPoolCardinality when the
pool's observationCardinality is 1 (Uniswap deployment default).


```solidity
function test_addAsset_revertsWhenPoolCardinalityIsOne() public;
```

### test_addAsset_revertsWithoutFullTwapHistory


```solidity
function test_addAsset_revertsWithoutFullTwapHistory() public;
```

### test_emergencyUnwind_usesConfiguredFloorWhenOracleUnavailable


```solidity
function test_emergencyUnwind_usesConfiguredFloorWhenOracleUnavailable() public;
```

### test_emergencyUnwind_blocksDepositsButAllowsRedemption


```solidity
function test_emergencyUnwind_blocksDepositsButAllowsRedemption() public;
```

### test_addAsset_succeedsWhenCardinalityMeetsMinimum

addAsset() succeeds when pool cardinality equals MIN_POOL_CARDINALITY (2).


```solidity
function test_addAsset_succeedsWhenCardinalityMeetsMinimum() public;
```

### test_totalAssets_doesNotRevertAfterValidAddAsset

totalAssets() does not revert after a successful addAsset() call
when cardinality satisfies the minimum.


```solidity
function test_totalAssets_doesNotRevertAfterValidAddAsset() public;
```

### test_addAsset_revertsWhenPoolLiquidityBelowMinimum

addAsset() reverts with InsufficientPoolLiquidity when the
pool's in-range liquidity is below MIN_POOL_LIQUIDITY.


```solidity
function test_addAsset_revertsWhenPoolLiquidityBelowMinimum() public;
```

### test_addAsset_succeedsWhenPoolLiquidityMeetsMinimum

addAsset() succeeds when pool liquidity meets MIN_POOL_LIQUIDITY.


```solidity
function test_addAsset_succeedsWhenPoolLiquidityMeetsMinimum() public;
```

### testFuzz_addAsset_cardinalityBoundary

Fuzz: addAsset() reverts exactly when pool cardinality is below
MIN_POOL_CARDINALITY and succeeds at or above it.


```solidity
function testFuzz_addAsset_cardinalityBoundary(uint16 cardinality_) public;
```

### test_routeDeposit_zeroResidualAllowanceAfterSwap

After _routeDeposit, residual USDC allowance on the router is zero.


```solidity
function test_routeDeposit_zeroResidualAllowanceAfterSwap() public;
```

### test_sellProportional_zeroResidualAllowanceAfterSwap

After _sellProportional (withdrawal), residual token allowance on the router is zero.


```solidity
function test_sellProportional_zeroResidualAllowanceAfterSwap() public;
```

### test_emergencyUnwindAsset_zeroResidualAllowanceAfterSwap

After emergencyUnwindAsset, residual token allowance on the router is zero.


```solidity
function test_emergencyUnwindAsset_zeroResidualAllowanceAfterSwap() public;
```

### test_emergencyUnwindAssetWithCap_zeroResidualAllowanceAfterSwap

After emergencyUnwindAssetWithCap, residual token allowance on the router is zero.


```solidity
function test_emergencyUnwindAssetWithCap_zeroResidualAllowanceAfterSwap() public;
```

### test_previewRedeem_returnsSlippageAndFeeAdjustedFloor

previewRedeem returns TWAP-minus-slippage-minus-exitFee floor.
With tick=0 (1:1 price), 1 000 USDC of vault NAV, 1% maxSlippage, 0% fee:
floor = 1 000 * 9 900/10 000 = 990 USDC.


```solidity
function test_previewRedeem_returnsSlippageAndFeeAdjustedFloor() public;
```

### test_previewRedeem_floorLeqActualSwapProceeds_underSlippage

Actual redeem proceeds are >= previewRedeem when slippage < maxSlippageBps.
This is the ERC-4626 guarantee: redeem must return at least previewRedeem.


```solidity
function test_previewRedeem_floorLeqActualSwapProceeds_underSlippage() public;
```

### test_previewRedeem_appliesExitFeeOnSlippageAdjustedProceeds

previewRedeem with a non-zero exit fee applies fee on top of slippage.


```solidity
function test_previewRedeem_appliesExitFeeOnSlippageAdjustedProceeds() public;
```

### test_previewDeposit_returnsSlippageAdjustedShareFloor

previewDeposit returns fewer shares than without slippage discount.
With 1% maxSlippage, depositing 1 000 USDC should preview fewer
shares than the raw convertToShares(1 000).


```solidity
function test_previewDeposit_returnsSlippageAdjustedShareFloor() public;
```

### test_depositWithdrawRoundTrip_correctBalancesAndZeroAllowances

Deposit + withdrawal round-trip preserves correct token balances and zero allowances.


```solidity
function test_depositWithdrawRoundTrip_correctBalancesAndZeroAllowances() public;
```

### test_previewMint_grossesUpBySlippage

previewMint grosses up raw NAV by the slippage factor so mint()
charges the same haircut as deposit(). Without this override, mint()
would undercharge relative to deposit(), enabling a value leak.


```solidity
function test_previewMint_grossesUpBySlippage() public;
```

### test_previewMint_notCheaperThanDeposit_dilutionPrevented

Mint is not cheaper than deposit for the same share count.
Depositing the assets that previewMint requires must yield at
least targetShares (ERC-4626 symmetry with slippage haircut).


```solidity
function test_previewMint_notCheaperThanDeposit_dilutionPrevented() public;
```

### test_withdrawAndPreviewWithdraw_revertRedeemOnly

withdraw() and previewWithdraw() revert with RedeemOnly because
BasketVault proportional-swap exits cannot guarantee the ERC-4626
exactness guarantee. Users must use redeem() instead.


```solidity
function test_withdrawAndPreviewWithdraw_revertRedeemOnly() public;
```

### _depositAt1to1

Deposit `amount` USDC into `vault`, executing the swap at 1:1
(spot == TWAP) so the basket token received equals the USDC in.


```solidity
function _depositAt1to1(address who, uint256 amount) internal returns (uint256 shares);
```

### test_SUP3_roundTripNeverProfits_fuzz

SUP-3 (pure-view floor): `previewRedeem(previewDeposit(x)) <= x`
holds across fuzzed slippage params and deposit sizes. The two
floor-discounted previews compose to strictly below the deposit,
so a round trip can never preview a profit.


```solidity
function test_SUP3_roundTripNeverProfits_fuzz(uint256 x, uint16 slip) public;
```

### test_SUP3_statefulDepositRedeemNeverProfits

SUP-3 (stateful): a real deposit → immediate redeem within the
deviation band returns no more than was deposited. Exercises the
mint-on-realized-proceeds accounting (F-16/NC-6): shares are minted
on the realized post-swap NAV delta, not a pre-swap TWAP mark.


```solidity
function test_SUP3_statefulDepositRedeemNeverProfits() public;
```

### test_ORA4_deviationGuardBlocksSettlement

ORA-4: when the executable market (slot0 spot) price diverges from
the NAV-pricing TWAP beyond `navDeviationGuardBps`, a deposit
reverts `NavMarketDeviationExceeded` rather than minting at the
stale/manipulated mark. With the guard disabled (0) the same
deposit succeeds — proving the guard, not some other check, blocks.


```solidity
function test_ORA4_deviationGuardBlocksSettlement() public;
```

### test_ORA4_withinBandSettles

ORA-4: a deposit within the deviation band settles normally — the
guard does not block ordinary, market-consistent settlement.


```solidity
function test_ORA4_withinBandSettles() public;
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

