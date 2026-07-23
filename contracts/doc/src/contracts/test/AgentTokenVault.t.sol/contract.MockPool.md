# MockPool
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/AgentTokenVault.t.sol)

Uniswap V3 pool mock: token0/token1 reads for addAsset validation plus
a flat 1:1 TWAP via observe() (arithmetic-mean tick = 0). One unit of
basket token is worth one unit of USDC, which makes equal-weight
assertions exact and independent of slot0.
setCardinality() allows governance gate-rejection tests to simulate
a pool that has not yet grown its observation buffer.


## Constants
### token0

```solidity
address public immutable token0
```


### token1

```solidity
address public immutable token1
```


## State Variables
### cardinality

```solidity
uint16 public cardinality = 100
```


### poolLiquidity

```solidity
uint128 public poolLiquidity = 1e18
```


### feeTier

```solidity
uint24 public feeTier
```


## Functions
### constructor


```solidity
constructor(address token0_, address token1_, uint24 fee_) ;
```

### fee

ORA-3 / F-09: `addAsset` asserts the pool's `fee()` equals `swapFee_`.


```solidity
function fee() external view returns (uint24);
```

### setFee


```solidity
function setFee(uint24 fee_) external;
```

### liquidity


```solidity
function liquidity() external view returns (uint128);
```

### setCardinality


```solidity
function setCardinality(uint16 c) external;
```

### slot0


```solidity
function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
```

### observe


```solidity
function observe(uint32[] calldata secondsAgos)
    external
    pure
    returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq);
```

### observations


```solidity
function observations(uint256) external view returns (uint32, int56, uint160, bool);
```

