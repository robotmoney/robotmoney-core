# BasketVaultTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a850937c469fed3e92eb9f004e12f595cf9f2447/contracts/test/BasketVault.t.sol)

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

### test_rescueTokens_revertsWhenTokenIsActiveBasketAsset


```solidity
function test_rescueTokens_revertsWhenTokenIsActiveBasketAsset() public;
```

### test_rescueTokens_succeedsForNonBasketAsset


```solidity
function test_rescueTokens_succeedsForNonBasketAsset() public;
```

### test_rescueTokens_succeedsForInactiveBasketAsset

A removed (inactive) basket asset's token is rescuable when a balance
reappears later — `totalAssets`/`_sellProportional` skip inactive
entries, so the balance would otherwise be stranded forever
(audit 2026-06-09, L-15).


```solidity
function test_rescueTokens_succeedsForInactiveBasketAsset() public;
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

