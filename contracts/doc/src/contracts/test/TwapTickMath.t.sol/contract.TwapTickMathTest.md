# TwapTickMathTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/b58df0d9705fd40d8110bd43d533f82a20b8ace3/contracts/test/TwapTickMath.t.sol)

**Inherits:**
Test

**Title:**
TwapTickMathTest

Pinning regression tests for the extracted TWAP tick helpers. Each
test pins the library output to a hard-coded reference value AND to a
standalone re-implementation of the prior inline body, proving the
extraction is behaviour-preserving across the documented edges:
negative non-exact mean-tick rounding toward -inf, the uint128
sqrtPrice high branch, both base<quote and base>quote orderings, and
pool-pair validation in both orderings plus the mismatch revert.


## Constants
### LO

```solidity
address internal constant LO = address(0x1111)
```


### HI

```solidity
address internal constant HI = address(0x2222)
```


### OTHER

```solidity
address internal constant OTHER = address(0x3333)
```


### WINDOW

```solidity
uint32 internal constant WINDOW = 1800
```


## Functions
### test_meanTick_negativeNonExact_roundsTowardNegInf

Negative, non-exact tickCumulative delta rounds toward -inf.
delta = -1801 over window 1800: -1801/1800 truncates to -1, and
because the remainder is non-zero the result is decremented to -2.


```solidity
function test_meanTick_negativeNonExact_roundsTowardNegInf() public;
```

### test_meanTick_negativeExact_noDecrement

Negative, EXACT multiple delta does NOT decrement.
delta = -3600 over window 1800: -2 exactly, no remainder.


```solidity
function test_meanTick_negativeExact_noDecrement() public;
```

### test_meanTick_positiveNonExact_truncates

Positive non-exact delta truncates toward zero (no -inf rule).
delta = 1801 over window 1800: 1.


```solidity
function test_meanTick_positiveNonExact_truncates() public;
```

### test_meanTick_zeroDelta

Zero delta yields tick 0.


```solidity
function test_meanTick_zeroDelta() public;
```

### test_priceFromTick_tickZero_bothOrderings

tick 0 (price 1:1) returns baseAmount for both orderings.


```solidity
function test_priceFromTick_tickZero_bothOrderings() public pure;
```

### test_priceFromTick_lowBranch_bothOrderings

Low-magnitude tick stays in the uint128 sqrtPrice fast path and
matches the reference implementation for both orderings.


```solidity
function test_priceFromTick_lowBranch_bothOrderings() public pure;
```

### test_priceFromTick_highBranch_bothOrderings

High tick pushes sqrtPrice above uint128 max, exercising the wide
`Math.mulDiv(sqrtP, sqrtP, 1<<64)` branch. Pins both orderings to
the reference implementation.


```solidity
function test_priceFromTick_highBranch_bothOrderings() public pure;
```

### test_checkPoolPair_validForwardOrdering

Valid when the requested (base, quote) matches (token0, token1).


```solidity
function test_checkPoolPair_validForwardOrdering() public;
```

### test_checkPoolPair_validReverseOrdering

Valid when the requested (base, quote) is the reverse of (token0, token1).


```solidity
function test_checkPoolPair_validReverseOrdering() public;
```

### test_checkPoolPair_revertsOnMismatch

Reverts when either requested token is absent from the pool.


```solidity
function test_checkPoolPair_revertsOnMismatch() public;
```

