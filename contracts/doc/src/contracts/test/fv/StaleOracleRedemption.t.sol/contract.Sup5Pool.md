# Sup5Pool
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/895f74f9a312639869e61e1d4ba3dfce78950c03/contracts/test/fv/StaleOracleRedemption.t.sol)

deSPXA pool stub: satisfies addAsset cardinality/liquidity gates.


## Constants
### token0

```solidity
address public immutable token0
```


### token1

```solidity
address public immutable token1
```


## Functions
### constructor


```solidity
constructor(address t0, address t1) ;
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

### liquidity


```solidity
function liquidity() external pure returns (uint128);
```

