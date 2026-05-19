# MockPool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/9261c12d1be5f94820a0955546db76c69aef496d/contracts/test/BasketVault.t.sol)


## Constants
### token0

```solidity
address public immutable token0
```


### token1

```solidity
address public immutable token1
```


### sqrtPriceX96

```solidity
uint160 internal immutable sqrtPriceX96
```


## Functions
### constructor


```solidity
constructor(address token0_, address token1_, uint160 sqrtPriceX96_) ;
```

### slot0


```solidity
function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
```

