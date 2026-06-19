# TwapTickMathHarness
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/b26f69ebc017ed65ec1995613224744c7754ee26/contracts/test/TwapTickMath.t.sol)

External wrapper so library reverts cross a call boundary and can be
asserted with `vm.expectRevert` (internal library calls are inlined and
do not trip the cheatcode reliably).


## Functions
### checkPoolPair


```solidity
function checkPoolPair(address pool, address baseToken, address quoteToken) external view;
```

