# UnifiedVaultConformanceTestRedeemOnly
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/98e21fa6ee5c881534f0ec43b14cc042ef89ab9c/contracts/test/UnifiedVaultConformance.t.sol)

**Inherits:**
[UnifiedVaultConformanceBase](/contracts/test/UnifiedVaultConformance.t.sol/abstract.UnifiedVaultConformanceBase.md)


## Constants
### EXIT_FEE_BPS

```solidity
uint256 internal constant EXIT_FEE_BPS = 50
```


### HAIRCUT_BPS

```solidity
uint256 internal constant HAIRCUT_BPS = 100
```


## State Variables
### adapter

```solidity
ConformanceInexactAdapter internal adapter
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_composition_isRedeemOnlyMode


```solidity
function test_composition_isRedeemOnlyMode() public;
```

### test_previewWithdraw_revertsRedeemOnly


```solidity
function test_previewWithdraw_revertsRedeemOnly() public;
```

### test_withdraw_revertsRedeemOnly


```solidity
function test_withdraw_revertsRedeemOnly() public;
```

### test_withdrawZero_isNoOp

E-4: `withdraw(maxWithdraw(owner)) == withdraw(0)` is a safe no-op
(never `RedeemOnly`), because `maxWithdraw` is 0 in this mode.


```solidity
function test_withdrawZero_isNoOp() public;
```

### test_maxViews_areZero


```solidity
function test_maxViews_areZero() public;
```

### test_redeem_isLive_feeOnRealized


```solidity
function test_redeem_isLive_feeOnRealized() public;
```

### test_previewRedeem_navHaircutFloor

`previewRedeem` is the ADR-0007 NAV-haircut floor
`gross × (1 − maxSlippageBps) × (1 − exitFeeBps)`.


```solidity
function test_previewRedeem_navHaircutFloor() public;
```

### test_previewDeposit_slippageFloor

`previewDeposit` is the slippage-discounted floor (< OZ par).


```solidity
function test_previewDeposit_slippageFloor() public;
```

### test_previewMint_ceilGrossUp

`previewMint` ceil-grosses-up the slippage haircut so `mint`
cannot undercharge relative to `deposit` (H-1).


```solidity
function test_previewMint_ceilGrossUp() public;
```

### testFuzz_redeem_realizesBelowPar_noProfit


```solidity
function testFuzz_redeem_realizesBelowPar_noProfit(uint256 assets) public;
```

