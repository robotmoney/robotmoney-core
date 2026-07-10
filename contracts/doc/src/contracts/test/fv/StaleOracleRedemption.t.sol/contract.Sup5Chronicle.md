# Sup5Chronicle
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3da70a180fe71635ce61a9d127b7f2d7f7b3cbf5/contracts/test/fv/StaleOracleRedemption.t.sol)

**Inherits:**
[IChronicleOracle](/contracts/interfaces/IChronicleOracle.sol/interface.IChronicleOracle.md)

Settable Chronicle NAV oracle.


## State Variables
### price

```solidity
uint256 public price
```


### timestamp

```solidity
uint256 public timestamp
```


## Functions
### constructor


```solidity
constructor(uint256 price_, uint256 ts_) ;
```

### setTimestamp


```solidity
function setTimestamp(uint256 ts_) external;
```

### latestAnswer


```solidity
function latestAnswer() external view returns (uint256);
```

### latestTimestamp


```solidity
function latestTimestamp() external view returns (uint256);
```

