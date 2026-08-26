# CustodyMultiVaultTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/ae9ab040de96dcd5638644fcfb59f6387e80803a/contracts/test/fv/CustodyMultiVault.t.sol)

**Inherits:**
Test


## State Variables
### admin

```solidity
address internal admin = makeAddr("multiVaultAdmin")
```


## Functions
### _assertRedeemableLeqTotalAssets

Shared SUP-1 predicate: the sum of the given holders' redeemable
assets never exceeds totalAssets(). Reused by every per-family test so
the property is defined once and applied uniformly across vaults.


```solidity
function _assertRedeemableLeqTotalAssets(IERC4626 vault, address[] memory holders)
    internal
    view;
```

### assertRedeemableLeqTotalAssetsExternal

External boundary lets the negative test assert that the complete
shared predicate reverts, rather than merely one of its view calls.


```solidity
function assertRedeemableLeqTotalAssetsExternal(IERC4626 vault, address[] memory holders)
    external
    view;
```

### test_SUP1_robotMoneyVault_redeemableLeqTotalAssets

SUP-1 / CUST-4 / INV-2 (RobotMoneyVault, live). A single
deposit/redeem round trip keeps Σ redeemable ≤ totalAssets. The
exhaustive stateful-fuzz proof remains in CustodyInvariant.t.sol;
this asserts the shared predicate against the one family wired live
in the scout pass so the harness is not vacuous.


```solidity
function test_SUP1_robotMoneyVault_redeemableLeqTotalAssets() public;
```

### test_SUP1_basketFamily_redeemableLeqTotalAssets

SUP-1 (BasketVault family): a live V3-priced basket deposit keeps
its holder's redeemable value within NAV.


```solidity
function test_SUP1_basketFamily_redeemableLeqTotalAssets() public;
```

### test_SUP1_rwaVault_redeemableLeqTotalAssets

SUP-1 (RwaVault): a live Chronicle-priced RWA deposit keeps its
holder's redeemable value within NAV.


```solidity
function test_SUP1_rwaVault_redeemableLeqTotalAssets() public;
```

### test_SUP1_predicateRejectsOverpromisingVault

SUP-1's predicate rejects a vault that overstates redemption value.


```solidity
function test_SUP1_predicateRejectsOverpromisingVault() public;
```

