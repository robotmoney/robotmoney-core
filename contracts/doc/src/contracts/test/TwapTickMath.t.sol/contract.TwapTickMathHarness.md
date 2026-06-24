# TwapTickMathHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/e699d5af7edaf7c4c89b6772ee092727a36235c7/contracts/test/TwapTickMath.t.sol)

External wrapper so library reverts cross a call boundary and can be
asserted with `vm.expectRevert` (internal library calls are inlined and
do not trip the cheatcode reliably).


## Functions
### checkPoolPair


```solidity
function checkPoolPair(address pool, address baseToken, address quoteToken) external view;
```

