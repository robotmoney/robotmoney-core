# MorphoAdapterTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/174c53454088cd318240a18aade465c225fdb078/contracts/test/MorphoAdapter.t.sol)

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


### morphoVault

```solidity
MockMorphoVault internal morphoVault
```


### adapter

```solidity
MorphoAdapter internal adapter
```


### vault

```solidity
address internal vault = makeAddr("vault")
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

### test_constructor_wiresImmutables


```solidity
function test_constructor_wiresImmutables() public view;
```

### test_constructor_revertsOnZeroAddress


```solidity
function test_constructor_revertsOnZeroAddress() public;
```

### test_deploy_movesUsdcIntoMorphoVault


```solidity
function test_deploy_movesUsdcIntoMorphoVault() public;
```

### test_ADP5_deployZeroesAllowance

ADP-5 / NC-12: `deploy` uses `forceApprove(_, amount)` then
`forceApprove(_, 0)`, so the adapter's USDC allowance to the Morpho
vault is exactly zero after the call — no residual approval lingers.


```solidity
function test_ADP5_deployZeroesAllowance() public;
```

### test_deploy_revertsForNonVault


```solidity
function test_deploy_revertsForNonVault() public;
```

### test_withdraw_happyPath_returnsActualAndCreditsVault


```solidity
function test_withdraw_happyPath_returnsActualAndCreditsVault() public;
```

### test_withdraw_revertsForNonVault


```solidity
function test_withdraw_revertsForNonVault() public;
```

### test_withdraw_revertsOnShortfall


```solidity
function test_withdraw_revertsOnShortfall() public;
```

### test_withdraw_typeMaxDoesNotRevertOnShortfall


```solidity
function test_withdraw_typeMaxDoesNotRevertOnShortfall() public;
```

### test_totalAssets_reflectsDeployedShares


```solidity
function test_totalAssets_reflectsDeployedShares() public;
```

### test_sweepForeignToken_revertsForProtectedUSDC


```solidity
function test_sweepForeignToken_revertsForProtectedUSDC() public;
```

### test_sweepForeignToken_revertsForProtectedMorphoShares


```solidity
function test_sweepForeignToken_revertsForProtectedMorphoShares() public;
```

### test_sweepForeignToken_zeroBalanceIsNoop


```solidity
function test_sweepForeignToken_zeroBalanceIsNoop() public;
```

### test_sweepForeignToken_permissionlessToQuarantine


```solidity
function test_sweepForeignToken_permissionlessToQuarantine() public;
```

### test_harvestRewards_isPermissionlessNoopForMorpho

AC5: harvestRewards() is a permissionless no-op for MorphoAdapter.
Morpho Gauntlet USDC Prime yield accrues automatically in the
ERC-4626 share price — there are no discrete claimable rewards.
Anyone may call; it must not revert and the vault asset is
never moved (no value leakage through harvest).


```solidity
function test_harvestRewards_isPermissionlessNoopForMorpho() public;
```

