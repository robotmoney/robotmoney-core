# MockChronicleFeed
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a2a6d8e4e2a61d93030482a63145fd865f67cc02/contracts/test/fv/StaleOracleRedemption.t.sol)

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

