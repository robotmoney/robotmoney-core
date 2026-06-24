# CustodyMultiVaultTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/d4e061fc698a91b57b77eff38896e3a0f0dbbbdc/contracts/test/fv/CustodyMultiVault.t.sol)

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

SUP-1 (BasketVault family, seam). Extending the custody
stateful-invariant handler to BasketVault/AgentTokenVault/
ProtocolAssetVault requires a TWAP-pool + vetted-adapter test rig;
the adapter-vetting gap is ADP-2 (#966). Build the basket custody
handler here once that lands, then remove this skip.


```solidity
function test_SUP1_basketFamily_redeemableLeqTotalAssets() public;
```

### test_SUP1_rwaVault_redeemableLeqTotalAssets

SUP-5 (RwaVault, seam). The RWA family's redeemability under a
stale feed is the subject of StaleOracleRedemption.t.sol; the live
custody handler for RwaVault depends on the freshness short-circuit
landing (NC-1).


```solidity
function test_SUP1_rwaVault_redeemableLeqTotalAssets() public;
```

