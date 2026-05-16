# IUniswapV3Pool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/1421cc6201de54f6b9e3c222f9419f45c65b6f43/contracts/interfaces/IUniswapV3Pool.sol)

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

