# TwapTickMathHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/43d1c2f83429ede507d6169930f712ee7dbb8993/contracts/test/TwapTickMath.t.sol)

External wrapper so library reverts cross a call boundary and can be
asserted with `vm.expectRevert` (internal library calls are inlined and
do not trip the cheatcode reliably).


## Functions
### checkPoolPair


```solidity
function checkPoolPair(address pool, address baseToken, address quoteToken) external view;
```

