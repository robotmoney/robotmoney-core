# IChronicleOracle
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/b26f69ebc017ed65ec1995613224744c7754ee26/contracts/interfaces/IChronicleOracle.sol)

**Title:**
IChronicleOracle

Minimal interface for Chronicle Protocol's on-chain push oracles.
Chronicle oracles are push-updated by a network of authorised attestors
("Validators"). Each feed stores the latest signed price and the timestamp
at which it was written on-chain. Consumers call `latestAnswer()` to read
the price and `latestTimestamp()` to check freshness.
Note on access control: Chronicle feeds on Base are "self-kissed" for the
RwaVault contract address at deployment time via Chronicle's `kiss()` API.
Calls from non-kissed addresses revert; the vault's address must be
whitelisted before it can read the feed.
Chronicle deSPXA NAV feed on Base (mainnet):
0xc9Bc046d3a832f5Fb5cf24e8cb7Bb15Fe6F1b9e
Heartbeat: 24 hours (feed is pushed at least once every 24 h by Chronicle).

The Chronicle IChronicle interface is defined in the Chronicle Solidity SDK:
https://github.com/chronicleprotocol/chronicle-std
We use a minimal subset — `latestAnswer` + `latestTimestamp` — to avoid
pulling in the full Chronicle SDK as a dependency.


## Functions
### latestAnswer

Returns the latest pushed price, scaled to 18 decimals.

Reverts if the caller is not whitelisted ("kissed") by Chronicle.
Reverts if no price has been pushed yet.


```solidity
function latestAnswer() external view returns (uint256 price);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`price`|`uint256`|Latest NAV price, 18-decimal fixed-point (WAD).|


### latestTimestamp

Returns the Unix timestamp of the last price push.

Used by the vault to enforce the staleness heartbeat check.


```solidity
function latestTimestamp() external view returns (uint256 timestamp);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`timestamp`|`uint256`|Unix timestamp (seconds) when `latestAnswer` was last updated.|


