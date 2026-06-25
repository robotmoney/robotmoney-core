# BadTickMathVault
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/565d7a4ab968179b6f0a1db9f9fe724a77abadce/contracts/test/Deploy.t.sol)

Mimics the per-vault `tickMathLibrary()` accessor the deploy assertion
reads, but returns a caller-chosen address — used to prove the deploy
assertion fails on a wrong/zero linked library (finding L3-D1).


## Constants
### _lib

```solidity
address private immutable _lib
```


## Functions
### constructor


```solidity
constructor(address lib_) ;
```

### tickMathLibrary


```solidity
function tickMathLibrary() external view returns (address);
```

### totalAssets

BasketVault(addr).totalAssets() is also probed by the assertion;
return 0 so a passing codehash would still be exercised in range.


```solidity
function totalAssets() external pure returns (uint256);
```

