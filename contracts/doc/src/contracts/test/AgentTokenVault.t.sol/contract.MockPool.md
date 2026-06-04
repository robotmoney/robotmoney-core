# MockPool
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e3ee0bd75d52506549a0416bdd36e7e170b4b50b/contracts/test/AgentTokenVault.t.sol)

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


## Functions
### constructor


```solidity
constructor(address token0_, address token1_) ;
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

