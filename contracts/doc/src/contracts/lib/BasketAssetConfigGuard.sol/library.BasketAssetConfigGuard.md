# BasketAssetConfigGuard
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0d868fe02e5cf19ce075213817ca84416ca13c09/contracts/lib/BasketAssetConfigGuard.sol)

**Title:**
BasketAssetConfigGuard

The config-validation interface the 2026-06-19 audit recommended for
`BasketVault.addAsset`: it enforces the ADP-2 adapter codehash
allowlist and the ORA-3 execution-pool == TWAP-pool equality (F-09).

Declared `public` (external, DELEGATECALL-linked) so the checks live in a
single deployed library instead of being inlined into every vault in the
already-EIP-170-tight basket family.


## Functions
### requirePoolUsable

Assert `pool` is usable as an `addAsset` venue: it pairs `token`
with `usdc`, has enough observation cardinality and history to serve
a `twapWindow`-second TWAP, and has at least `minLiquidity` in-range
liquidity. Extracted from `BasketVault.addAsset` into this
delegatecall-linked guard to keep the EIP-170-tight basket-vault
bytecode small. Behaviour-identical to the prior inline checks.


```solidity
function requirePoolUsable(
    address pool,
    address token,
    address usdc,
    uint32 twapWindow,
    uint16 minCardinality,
    uint128 minLiquidity
) public view;
```

### reuseOrRejectDuplicate

NC-8 (no duplicate AssetInfo): if `token` already has an entry in
`assets`, reuse it instead of letting the caller append a second
one. An ACTIVE duplicate is rejected; an INACTIVE (removed) entry is
refreshed to the new config and re-activated in place. Lives in this
delegatecall-linked library so the scan/write logic stays out of the
EIP-170-tight basket-vault bytecode.


```solidity
function reuseOrRejectDuplicate(
    AssetInfo[] storage assets,
    address token,
    address pool,
    uint24 swapFee,
    address adapter,
    Venue venue
) public returns (uint256 reusedIndex);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`reusedIndex`|`uint256`|The registry index of the inactive entry that was reactivated in place (the caller must NOT push); or `type(uint256).max` when the token is new and the caller must push.|


### requireAllowedAdapter

Vet a non-zero adapter's codehash against the allowlist (ADP-2 / NC-2).
The default Uniswap V3 path (adapter == 0) needs no vetting.


```solidity
function requireAllowedAdapter(address adapter, bool allowed) public pure;
```

### requireExecutionPoolMatchesTwap

Assert the execution pool resolved from `swapFee` is the SAME pool
the NAV TWAP reads from (ORA-3 / F-09): fee tier for V3/V4, tick
spacing for Aerodrome. `swapFee == 0` is the pool-independent-pricing
sentinel (e.g. the Chronicle NAV adapter) and is exempt.


```solidity
function requireExecutionPoolMatchesTwap(address pool, uint24 swapFee, Venue venue)
    public
    view;
```

## Errors
### AdapterCodeHashNotAllowed
Adapter runtime-bytecode hash not on the ADMIN-approved allowlist (ADP-2).


```solidity
error AdapterCodeHashNotAllowed();
```

### ExecutionPoolMismatch
Execution pool (resolved from swapFee) != registered TWAP pool (ORA-3).


```solidity
error ExecutionPoolMismatch();
```

### AssetAlreadyActive
`addAsset` re-add of a token that already has an ACTIVE entry (NC-8).


```solidity
error AssetAlreadyActive();
```

### PoolTokenMismatch
Pool does not pair `token` with USDC.


```solidity
error PoolTokenMismatch();
```

### InsufficientPoolCardinality
Pool observation cardinality below the minimum required for TWAP.


```solidity
error InsufficientPoolCardinality(address pool, uint16 required, uint16 actual);
```

### InsufficientObservationHistory
Pool lacks the observation history to service a full TWAP window.


```solidity
error InsufficientObservationHistory(address pool, uint32 requiredWindow);
```

### InsufficientPoolLiquidity
Pool in-range liquidity below the synchronous-redemption minimum.


```solidity
error InsufficientPoolLiquidity(address pool, uint128 required, uint128 actual);
```

## Structs
### AssetInfo
Layout-compatible mirror of `BasketVault.AssetInfo`. Field order and
types MUST match exactly so the delegatecall-linked dedup scan below
reads/writes the vault's `assets` storage correctly.


```solidity
struct AssetInfo {
    address token;
    address pool;
    uint24 swapFee;
    bool active;
    address adapter;
    Venue venue;
}
```

## Enums
### Venue
Mirror of `BasketVault.Venue`. Kept value-compatible (same ordinals).


```solidity
enum Venue {
    V3,
    V4,
    Aerodrome
}
```

