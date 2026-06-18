# TwapTickMathHarness
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/64abc76af5e5cb6274bcad2a01525a762981c62c/contracts/test/TwapTickMath.t.sol)

External wrapper so library reverts cross a call boundary and can be
asserted with `vm.expectRevert` (internal library calls are inlined and
do not trip the cheatcode reliably).


## Functions
### checkPoolPair


```solidity
function checkPoolPair(address pool, address baseToken, address quoteToken) external view;
```

