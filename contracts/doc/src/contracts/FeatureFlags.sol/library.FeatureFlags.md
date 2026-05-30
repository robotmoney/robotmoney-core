# FeatureFlags
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e30069c8df8fc8c637d65bc2f991adfaf60a1079/contracts/FeatureFlags.sol)

**Title:**
FeatureFlags

Pure bitmap library for reading feature flags encoded in a uint256.
Each flag occupies one bit at the position equal to its `id` in the
registry (`config/feature-flags.json`).  The bitmap is stored
off-chain (e.g. in a deployment config or governance variable) and
passed in wherever a gate check is needed — no storage cost.
Flag IDs (stable — never renumber):
0  MULTI_VAULT_ENABLED       gates multi-vault UI + indexer paths
1  PORTFOLIO_ROUTER_ENABLED  gates router deposit path
2  INDEXER_MULTI_VAULT_EVENTS gates indexer VaultRegistry events


## Constants
### MULTI_VAULT_ENABLED
Gates multi-vault UI surfaces in the dapp and multi-vault event
indexing in the explorer-indexer.


```solidity
uint8 public constant MULTI_VAULT_ENABLED = 0
```


### PORTFOLIO_ROUTER_ENABLED
Gates the PortfolioRouter deposit path and the RouterGovernance
panel in the dapp.


```solidity
uint8 public constant PORTFOLIO_ROUTER_ENABLED = 1
```


### INDEXER_MULTI_VAULT_EVENTS
Gates VaultRegistered / VaultStatusChanged event ingestion in the
explorer-indexer.


```solidity
uint8 public constant INDEXER_MULTI_VAULT_EVENTS = 2
```


## Functions
### isEnabled

Returns true iff the flag at `flagId` is set in `bitmap`.


```solidity
function isEnabled(uint8 flagId, uint256 bitmap) internal pure returns (bool);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`flagId`|`uint8`| Bit position (0-255).  Must match an entry in the registry; unknown IDs simply return false.|
|`bitmap`|`uint256`| The packed uint256 feature-flag state.|


### set

Returns a bitmap with the flag at `flagId` set.
Convenience for tests and deployment scripts.


```solidity
function set(uint8 flagId, uint256 bitmap) internal pure returns (uint256);
```

### clear

Returns a bitmap with the flag at `flagId` cleared.


```solidity
function clear(uint8 flagId, uint256 bitmap) internal pure returns (uint256);
```

