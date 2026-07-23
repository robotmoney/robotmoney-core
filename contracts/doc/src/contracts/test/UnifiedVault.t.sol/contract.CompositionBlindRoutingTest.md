# CompositionBlindRoutingTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/UnifiedVault.t.sol)

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

### test_deposit_givesOverweightAdapterItsEqualShare_exact

AC: a deposit into an imbalanced set gives the OVERWEIGHT adapter
its equal/capped share instead of skipping it in favor of the
deficit adapter.


```solidity
function test_deposit_givesOverweightAdapterItsEqualShare_exact() public;
```

### test_deposit_givesOverweightAdapterItsEqualShare_inexact

AC: the equal-share deposit routing is IDENTICAL on an inexact
set (deposit ordering is not gated on exactness).


```solidity
function test_deposit_givesOverweightAdapterItsEqualShare_inexact() public;
```

### test_withdraw_pullsProportionallyByBalance_exact

AC: an EXACT-mode withdrawal pulls proportionally to each
adapter's CURRENT balance — the underweight adapter is pulled
from too, not left untouched.


```solidity
function test_withdraw_pullsProportionallyByBalance_exact() public;
```

### test_redeem_sellsProportionallyByBalance_inexact

AC: an INEXACT-mode redemption sells proportionally to each
adapter's CURRENT balance, each leg bounded by the per-swap
slippage floor; the underweight adapter is sold from too.


```solidity
function test_redeem_sellsProportionallyByBalance_inexact() public;
```

