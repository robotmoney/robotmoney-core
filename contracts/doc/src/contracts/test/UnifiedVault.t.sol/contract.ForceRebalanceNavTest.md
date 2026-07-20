# ForceRebalanceNavTest
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

