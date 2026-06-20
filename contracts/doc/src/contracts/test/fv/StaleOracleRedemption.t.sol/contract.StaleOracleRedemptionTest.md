# StaleOracleRedemptionTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/9912e66cc064941cf391031069c85d740fd52944/contracts/test/fv/StaleOracleRedemption.t.sol)

**Inherits:**
Test


## Constants
### HEARTBEAT

```solidity
uint256 internal constant HEARTBEAT = 1 hours
```


## State Variables
### feed

```solidity
MockChronicleFeed internal feed
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_ORA2_feedOlderThanHeartbeatIsStale

ORA-2 (HOLDS): the freshness predicate the vault enforces — a feed
older than the heartbeat is stale (fail-closed). Asserts the mock's
staleness arithmetic so the SUP-5 harness builds on a verified
notion of "stale". The behavioural revert proof on a live RwaVault
lives in RwaVault.t.sol (deposit halts on stale feed).


```solidity
function test_ORA2_feedOlderThanHeartbeatIsStale() public;
```

### test_SUP5_idleUsdcRedeemSurvivesStaleFeed

SUP-5 (RED, NC-1): a user `redeem` succeeds when the vault holds
zero priced RWA tokens (already unwound to idle USDC), even while
the Chronicle feed is stale. On current HEAD redeem reverts
StalePriceFeed unconditionally, trapping safe funds. When #966 lands
the freshness short-circuit, remove the skip and assert the redeem
returns the holder's idle USDC.


```solidity
function test_SUP5_idleUsdcRedeemSurvivesStaleFeed() public;
```

### _isStale

Mirror of RwaVault._checkOracleFreshness's staleness condition:
`block.timestamp > updatedAt + heartbeat`.


```solidity
function _isStale(uint256 updatedAt, uint256 heartbeat) internal view returns (bool);
```

