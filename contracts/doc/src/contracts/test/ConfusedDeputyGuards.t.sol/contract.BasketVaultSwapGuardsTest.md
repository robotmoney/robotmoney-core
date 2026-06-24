# BasketVaultSwapGuardsTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/d4e061fc698a91b57b77eff38896e3a0f0dbbbdc/contracts/test/ConfusedDeputyGuards.t.sol)

**Inherits:**
Test

**Title:**
BasketVaultSwapGuardsTest

Pins invariants 8–10 from the confused-deputy audit.


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


### swapRouter

```solidity
MockSwapRouterForGuards internal swapRouter
```


### pool

```solidity
MockPoolForGuards internal pool
```


### vault

```solidity
BasketVaultHarnessForGuards internal vault
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### emergency

```solidity
address internal emergency = makeAddr("emergency")
```


### user

```solidity
address internal user = makeAddr("user")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_invariant8_addAsset_rejectsPoolWithoutUsdcPairing

addAsset reverts PoolTokenMismatch when the supplied pool does not
pair the basket token with USDC. An attacker-controlled pool that
pairs a worthless token against the basket token cannot be registered.


```solidity
function test_invariant8_addAsset_rejectsPoolWithoutUsdcPairing() public;
```

### test_invariant8b_addAsset_rejectsPoolWithWrongSecondToken

addAsset also rejects a pool that pairs the basket token with the
wrong second token (not USDC). Prevents substituting a worthless
token for USDC in the value-extraction rail.


```solidity
function test_invariant8b_addAsset_rejectsPoolWithWrongSecondToken() public;
```

### test_invariant8c_addAsset_rejectsLowCardinalityPool

addAsset rejects a pool with cardinality < MIN_POOL_CARDINALITY (2).
A cardinality-1 pool would cause observe() to revert with "OLD",
permanently breaking TWAP reads and thus all deposits/withdrawals.


```solidity
function test_invariant8c_addAsset_rejectsLowCardinalityPool() public;
```

### test_invariant9_deposit_slippageFloorIsNonZero

Every deposit swap sets amountOutMinimum > 0 (derived from TWAP).
A router that returns 0 tokens must cause the deposit to revert.
This pins that there is no zero-slippage deposit path.


```solidity
function test_invariant9_deposit_slippageFloorIsNonZero() public;
```

### test_invariant9b_deposit_revertsWhenRouterOutputIsZero

When the router would return 0 tokens (zero amountOut), the deposit
must revert because amountOutMinimum from the TWAP is > 0.


```solidity
function test_invariant9b_deposit_revertsWhenRouterOutputIsZero() public;
```

### test_invariant10_withdraw_slippageFloorIsNonZero

Every withdrawal swap sets amountOutMinimum > 0 (from TWAP).
A router returning 0 must revert the redeem.


```solidity
function test_invariant10_withdraw_slippageFloorIsNonZero() public;
```

### test_invariant10b_withdraw_succeedsAboveTwapFloor

Withdrawal succeeds when router output satisfies the TWAP-derived
floor, confirming the floor calculation is correct at non-zero levels.


```solidity
function test_invariant10b_withdraw_succeedsAboveTwapFloor() public;
```

