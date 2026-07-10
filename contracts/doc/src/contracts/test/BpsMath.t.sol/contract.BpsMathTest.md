# BpsMathTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3da70a180fe71635ce61a9d127b7f2d7f7b3cbf5/contracts/test/BpsMath.t.sol)

**Inherits:**
Test

**Title:**
BpsMathTest

Pinning regression tests for the extracted basis-points denominator.
Asserts the shared constant equals the pre-extraction literal 10000
and that representative fee / slippage / weight arithmetic produces
the same results when computed against `BpsMath.BPS_DENOMINATOR` as
it did against the per-file `BPS_DENOMINATOR` / `MAX_BPS` literals.


## Constants
### REFERENCE_BPS
Hard-coded reference value from the prior inline literals.


```solidity
uint256 internal constant REFERENCE_BPS = 10_000
```


## Functions
### test_denominator_equals10000

The shared denominator equals the pre-extraction literal.


```solidity
function test_denominator_equals10000() public pure;
```

### test_uint16Narrowing_isExact

The narrowing `uint16` cast used by RobotMoneyVault.MAX_BPS is
exact: `uint16(BpsMath.BPS_DENOMINATOR)` round-trips to 10000 with
no truncation, so the vault's public constant is unchanged.


```solidity
function test_uint16Narrowing_isExact() public pure;
```

### test_feeMath_matchesLiteral

Fee math: a 50 bps exit fee on 1,000,000 units yields 5,000 units,
identical whether the denominator is the literal or the shared constant.


```solidity
function test_feeMath_matchesLiteral() public pure;
```

### test_slippageMath_matchesLiteral

Slippage floor: net = gross * (BPS - slippageBps) / BPS.


```solidity
function test_slippageMath_matchesLiteral() public pure;
```

### test_weightMath_matchesLiteral

Weight math: equal-weight split of N assets uses BPS / N with the
remainder folded back, exactly as the vaults compute target weights.


```solidity
function test_weightMath_matchesLiteral() public pure;
```

### test_grossUpMath_matchesLiteral

Gross-up math (BasketVault/RobotMoneyVault redeem path):
net.mulDiv(BPS, BPS - feeBps, Ceil) must match the literal.


```solidity
function test_grossUpMath_matchesLiteral() public pure;
```

