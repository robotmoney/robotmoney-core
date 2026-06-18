# TwapTickMathHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a850937c469fed3e92eb9f004e12f595cf9f2447/contracts/test/TwapTickMath.t.sol)

External wrapper so library reverts cross a call boundary and can be
asserted with `vm.expectRevert` (internal library calls are inlined and
do not trip the cheatcode reliably).


## Functions
### checkPoolPair


```solidity
function checkPoolPair(address pool, address baseToken, address quoteToken) external view;
```

