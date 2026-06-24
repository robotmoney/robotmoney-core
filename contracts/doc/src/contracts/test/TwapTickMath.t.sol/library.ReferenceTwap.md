# ReferenceTwap
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/5f3ed0a39e045bd3fe3f3f4a024d482bf1b89ff8/contracts/test/TwapTickMath.t.sol)

Re-implements the EXACT pre-extraction inline helper bodies that lived in
AerodromeSwapAdapter / UniswapV4SwapAdapter, so the library output can be
pinned against the prior implementation byte-for-byte.


## Functions
### meanTick


```solidity
function meanTick(address pool, uint32 window) internal view returns (int24);
```

### priceFromTick


```solidity
function priceFromTick(int24 tick, address baseToken, address quoteToken, uint256 baseAmount)
    internal
    pure
    returns (uint256 quoteAmount);
```

