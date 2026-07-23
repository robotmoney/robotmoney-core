# ForceRebalanceNavTest
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

### _imbalancedExact


```solidity
function _imbalancedExact() internal returns (ExactHoldAdapter a, ExactHoldAdapter b);
```

### _imbalancedInexact


```solidity
function _imbalancedInexact() internal returns (InexactSellAdapter a, InexactSellAdapter b);
```

### test_forceRebalance_exactSet_freeAndNavNonDecreasing

On an exact set the top-up is ~zero: `forceRebalance(0)` succeeds,
leaves NAV EXACTLY unchanged (1:1 moves, no realized cost), and
converges composition toward the equal-weight target.


```solidity
function test_forceRebalance_exactSet_freeAndNavNonDecreasing() public;
```

### test_forceRebalance_inexactSet_revertsWithoutTopUp

On an inexact set with NO top-up the realized swap slippage would
drop NAV, so the whole call REVERTS (holders never lose value) and
composition is left untouched.


```solidity
function test_forceRebalance_inexactSet_revertsWithoutTopUp() public;
```

### test_forceRebalance_inexactSet_selfFundedTopUp_holderNoLoss

With a self-funded top-up covering realized slippage the inexact
`forceRebalance` succeeds: NAV is non-decreasing, the holder's
pro-rata value cannot fall, and composition moves toward target.


```solidity
function test_forceRebalance_inexactSet_selfFundedTopUp_holderNoLoss() public;
```

### test_forceRebalance_reRoute_fillsLargestDeficitFirst

AC: forceRebalance's re-route leg fills the LARGEST deficit first
via `_fillDeficitFirst` — after drawing the surplus adapter down
to target, the recovered USDC lands on the deficit adapters in
proportion to how far EACH is from target, converging every
adapter (including the formerly-overweight one) to the SAME
equal-weight balance. A flat/equal split of the recovered USDC
across all three adapters — the ordinary `_routeDeposit` behavior
— would instead overshoot the formerly-overweight adapter and
leave the two deficit adapters at unequal, still-below-target
balances, since it never looks at deficits at all.


```solidity
function test_forceRebalance_reRoute_fillsLargestDeficitFirst() public;
```

### test_forceRebalance_onlyAdmin

`forceRebalance` is ADMIN-gated — a non-admin caller reverts.


```solidity
function test_forceRebalance_onlyAdmin() public;
```

### test_socializedRebalanceAndThrottlesRemoved

AC: the socialized `rebalance()` / `adminRebalance()` pair and the
keeper throttles no longer exist — `forceRebalance` is the sole
rebalance entry point (§5.6). Non-existent selectors revert.


```solidity
function test_socializedRebalanceAndThrottlesRemoved() public;
```

