# StaleOracleRedemptionTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0d868fe02e5cf19ce075213817ca84416ca13c09/contracts/test/fv/StaleOracleRedemption.t.sol)

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


### sup5Vault
SUP-5 (RED, NC-1): a user `redeem` succeeds when the vault holds
zero priced RWA tokens (already unwound to idle USDC), even while
the Chronicle feed is stale. On current HEAD redeem reverts
StalePriceFeed unconditionally, trapping safe funds. When #966 lands
the freshness short-circuit, remove the skip and assert the redeem
returns the holder's idle USDC.


```solidity
RwaVault internal sup5Vault
```


### sup5Usdc_

```solidity
Sup5Usdc internal sup5Usdc_
```


### sup5Despxa

```solidity
Sup5Token internal sup5Despxa
```


### sup5Chronicle

```solidity
Sup5Chronicle internal sup5Chronicle
```


### sup5Aero

```solidity
Sup5AeroRouter internal sup5Aero
```


### sup5Admin

```solidity
address internal sup5Admin = makeAddr("sup5Admin")
```


### sup5Emergency

```solidity
address internal sup5Emergency = makeAddr("sup5Emergency")
```


### sup5Holder

```solidity
address internal sup5Holder = makeAddr("sup5Holder")
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

### _deploySup5Rig

Deploy + wire the RwaVault rig into storage (keeps the test body small
enough to avoid stack-too-deep without viaIR).


```solidity
function _deploySup5Rig() internal;
```

### test_SUP5_idleUsdcRedeemSurvivesStaleFeed


```solidity
function test_SUP5_idleUsdcRedeemSurvivesStaleFeed() public;
```

### _isStale

Mirror of RwaVault._checkOracleFreshness's staleness condition:
`block.timestamp > updatedAt + heartbeat`.


```solidity
function _isStale(uint256 updatedAt, uint256 heartbeat) internal view returns (bool);
```

