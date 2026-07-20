# FlowRebalanceTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/1a7c54d73d4b5798ab7f0d00b005aecfb79f6376/contracts/test/UnifiedVault.t.sol)

**Inherits:**
[UnifiedVaultBase](/contracts/test/UnifiedVault.t.sol/abstract.UnifiedVaultBase.md)


## Constants
### HAIRCUT_BPS

```solidity
uint256 internal constant HAIRCUT_BPS = 100
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_deposit_fillsLargestDeficitFirst_exact

AC: a deposit routes entirely to the adapter furthest BELOW target
(largest deficit first); the overweight adapter receives none.


```solidity
function test_deposit_fillsLargestDeficitFirst_exact() public;
```

### test_deposit_fillsLargestDeficitFirst_inexact

AC: deficit-first routing is IDENTICAL on an inexact set (deposit
ordering is not gated on exactness).


```solidity
function test_deposit_fillsLargestDeficitFirst_inexact() public;
```

### test_withdraw_drawsLargestSurplusFirst_exact

AC: an EXACT-mode withdrawal draws from the adapter furthest ABOVE
target (largest surplus first); the underweight adapter is untouched.


```solidity
function test_withdraw_drawsLargestSurplusFirst_exact() public;
```

### test_redeem_drawsLargestSurplusFirst_inexact

AC: an INEXACT-mode redemption sources the redeemer's pro-rata
slice surplus-first, each leg bounded by the per-swap slippage
floor; the underweight adapter is left untouched.


```solidity
function test_redeem_drawsLargestSurplusFirst_inexact() public;
```

