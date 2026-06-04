# MockChronicle
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/3c1ea74f579328e8c58a74fd2216e9554654d471/contracts/test/RwaVault.t.sol)

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

