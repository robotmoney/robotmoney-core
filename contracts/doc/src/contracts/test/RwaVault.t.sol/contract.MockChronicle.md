# MockChronicle
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/690ce3eb1d770c8624dfe2b7c8dc1fb69a34bcd3/contracts/test/RwaVault.t.sol)

**Inherits:**
[IChronicleOracle](/contracts/interfaces/IChronicleOracle.sol/interface.IChronicleOracle.md)

Mock Chronicle oracle: configurable price and timestamp.


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
constructor(uint256 price_, uint256 timestamp_) ;
```

### setPrice


```solidity
function setPrice(uint256 price_) external;
```

### setTimestamp


```solidity
function setTimestamp(uint256 timestamp_) external;
```

### latestAnswer


```solidity
function latestAnswer() external view returns (uint256);
```

### latestTimestamp


```solidity
function latestTimestamp() external view returns (uint256);
```

