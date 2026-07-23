# MockChronicleFeed
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/fv/StaleOracleRedemption.t.sol)

Minimal Chronicle-feed mock: a settable latest-update timestamp so a test
can age the feed past any heartbeat. Mirrors the IChronicleOracle surface
RwaVault._checkOracleFreshness reads (`latestTimestamp()`).


## State Variables
### latestTimestamp

```solidity
uint256 public latestTimestamp
```


### latestValue

```solidity
uint256 public latestValue
```


## Functions
### set


```solidity
function set(uint256 value, uint256 updatedAt) external;
```

### age

Age the feed so it is `staleness` seconds older than `now`.


```solidity
function age(uint256 staleness) external;
```

