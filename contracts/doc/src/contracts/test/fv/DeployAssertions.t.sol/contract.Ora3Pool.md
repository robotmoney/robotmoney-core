# Ora3Pool
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/895f74f9a312639869e61e1d4ba3dfce78950c03/contracts/test/fv/DeployAssertions.t.sol)

Minimal pool mock exposing the surface `BasketVault.addAsset` reads:
token0/token1, slot0 cardinality, observe, liquidity, and the `fee()`
accessor the ORA-3 equality check asserts against `swapFee_`.


## Constants
### token0

```solidity
address public immutable token0
```


### token1

```solidity
address public immutable token1
```


### poolFee

```solidity
uint24 public immutable poolFee
```


## Functions
### constructor


```solidity
constructor(address token0_, address token1_, uint24 fee_) ;
```

### fee


```solidity
function fee() external view returns (uint24);
```

### liquidity


```solidity
function liquidity() external pure returns (uint128);
```

### slot0


```solidity
function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
```

### observe


```solidity
function observe(uint32[] calldata secondsAgos)
    external
    pure
    returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq);
```

