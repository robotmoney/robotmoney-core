# IUniswapV3Pool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/b447b3c942571522a243df98942e1c4f5c32d4e3/contracts/interfaces/IUniswapV3Pool.sol)

Minimal Uniswap V3 Pool interface used for slot0 pricing.


## Functions
### token0


```solidity
function token0() external view returns (address);
```

### token1


```solidity
function token1() external view returns (address);
```

### slot0


```solidity
function slot0()
    external
    view
    returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );
```

