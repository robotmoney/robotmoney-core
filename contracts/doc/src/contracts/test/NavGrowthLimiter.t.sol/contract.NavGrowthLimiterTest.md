# NavGrowthLimiterTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/NavGrowthLimiter.t.sol)

**Inherits:**
Test

Suite for the global NAV-growth-rate limiter (§4.3a). One vault, one
mis-marking adapter, an explicit `maxNavGrowthRateBps` chosen so the
per-hour budget is easy to reason about.


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1_000_000
```


### MAX_BPS

```solidity
uint256 internal constant MAX_BPS = 10_000
```


### MAX_SLIPPAGE_BPS

```solidity
uint256 internal constant MAX_SLIPPAGE_BPS = 200
```


### RATE_BPS_PER_HOUR

```solidity
uint256 internal constant RATE_BPS_PER_HOUR = 100
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### vault

```solidity
Vault internal vault
```


### adapter

```solidity
MarkSpikeAdapter internal adapter
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### emergency

```solidity
address internal emergency = makeAddr("emergency")
```


### feeRecipient

```solidity
address internal feeRecipient = makeAddr("feeRecipient")
```


### alice

```solidity
address internal alice = makeAddr("alice")
```


### bob

```solidity
address internal bob = makeAddr("bob")
```


### outsider

```solidity
address internal outsider = makeAddr("outsider")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _deposit


```solidity
function _deposit(address who, uint256 assets) internal returns (uint256 shares);
```

### test_deposit_revertsOnImplausibleNavJump


```solidity
function test_deposit_revertsOnImplausibleNavJump() public;
```

### test_deposit_allowsGrowthWithinBudget


```solidity
function test_deposit_allowsGrowthWithinBudget() public;
```

### test_deposit_longerElapsedWidensBudget

The budget scales with elapsed time: the SAME 50% jump that reverts
after 1 hour is ALLOWED once enough time has passed (50h ⇒ 5000 bps
budget ≥ the 5000 bps jump). Demonstrates the rate is per-time.


```solidity
function test_deposit_longerElapsedWidensBudget() public;
```

### test_redeem_isNeverGatedByLimiter


```solidity
function test_redeem_isNeverGatedByLimiter() public;
```

### test_checkpoint_isSingleSlotUpdatedPerDeposit


```solidity
function test_checkpoint_isSingleSlotUpdatedPerDeposit() public;
```

### test_constructor_rejectsZeroRate


```solidity
function test_constructor_rejectsZeroRate() public;
```

### test_setMaxNavGrowthRateBps_roleGatedAndRejectsZero


```solidity
function test_setMaxNavGrowthRateBps_roleGatedAndRejectsZero() public;
```

### test_setter_loosensTheGate

Loosening the rate via the setter lets a previously-blocked deposit
through — the setter is wired into the live gate.


```solidity
function test_setter_loosensTheGate() public;
```

