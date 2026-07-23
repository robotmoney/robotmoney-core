# DeSpxaAssetPositionAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/20a28674ed248f52a2865a2d77d65dc7c7a00bed/contracts/adapters/DeSpxaAssetPositionAdapter.sol)

**Inherits:**
[IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

**Title:**
DeSpxaAssetPositionAdapter

The Chronicle-priced `IPositionAdapter` for rmRWA (ADR-0010 §4,
unified-vault-spec §4.3/§4.4): it custodies deSPXA and prices it via
a Chronicle on-chain push oracle instead of a DEX TWAP — Aerodrome
liquidity for deSPXA is too thin for a manipulation-resistant TWAP
(ADR-0006 §2). `deploy`/`withdraw` convert USDC<->deSPXA through the
`SWAP_ADAPTER` venue seam (a `ChronicleOracleAdapter` instance, which
itself routes execution through Aerodrome and reads Chronicle for
pricing — see unified-vault-seam-map.json's "ChronicleOracleAdapter
remain stateless executors" row). This adapter is the ONE place that
enforces the Chronicle heartbeat-staleness gate: `ChronicleOracleAdapter`
is deliberately stateless and does not check staleness itself.

## Heartbeat staleness (ORA-2 fail-closed)
Every price-dependent path (`deploy`, `withdraw`, and `totalAssets`
when the position is non-empty) reverts `StalePriceFeed` when the
Chronicle feed's `latestTimestamp()` is older than `oracleHeartbeat`
seconds. A stale price is REJECTED, never silently used. Mirrors
`RwaVault.oracleHeartbeat` / `MAX_HEARTBEAT` / `StalePriceFeed`
(spec §4.4: "default 24h, cap MAX_HEARTBEAT 48h").
## Freeze-safety (deSPXA issuer freeze-control risk, ADR-0006 §3)
The deSPXA issuer may freeze token transfers at any time. A freeze
makes `deploy`/`withdraw` revert (the underlying Aerodrome swap
cannot move a frozen token) — existing custody is neither lost nor
mis-marked. `totalAssets()` NEVER attempts a transfer: it is a pure
`balanceOf` read (unaffected by a transfer freeze) combined with a
view-only Chronicle price read, so a freeze cannot brick vault NAV
summation. This is the adapter half of "excluded-not-confiscated":
a frozen position keeps accruing/reporting its last-known-good NAV
mark instead of reverting the whole vault's `totalAssets()`.
## Zero-balance short-circuit (SUP-5)
`totalAssets()` returns 0 on an empty position WITHOUT touching the
oracle — matches `RwaVault._holdsPricedRwa()` / `UniswapV3AssetPositionAdapter`.
`isExact()` is hardcoded `false`: like the DEX-TWAP asset adapters,
`deploy`/`withdraw` are slippage-priced swaps and `totalAssets()` is
an oracle mark, not a 1:1 redemption claim.


## Constants
### MAX_BPS

```solidity
uint256 internal constant MAX_BPS = 10_000
```


### MAX_SLIPPAGE_BPS
Hard ceiling for the per-swap slippage tolerance (5%). Mirrors
`UniswapV3AssetPositionAdapter.MAX_SLIPPAGE_BPS`.


```solidity
uint256 public constant MAX_SLIPPAGE_BPS = 500
```


### DEFAULT_SLIPPAGE_BPS
Default per-swap slippage tolerance (0.5%), tighter than the DEX-TWAP
adapters because slippage is anchored to the Chronicle NAV price,
not an Aerodrome TWAP. Mirrors `RwaVault._DEFAULT_SLIPPAGE_BPS`.


```solidity
uint256 public constant DEFAULT_SLIPPAGE_BPS = 50
```


### MIN_HEARTBEAT
Minimum permitted heartbeat (1 hour). Prevents ADMIN from setting
an unreasonably tight window that would halt operations on normal
Chronicle push cadence.


```solidity
uint256 public constant MIN_HEARTBEAT = 1 hours
```


### MAX_HEARTBEAT
Maximum permitted heartbeat (48 hours). Prevents ADMIN from setting
an arbitrarily long window that would allow a stale price to be
used for days. Mirrors `RwaVault.MAX_HEARTBEAT`.


```solidity
uint256 public constant MAX_HEARTBEAT = 48 hours
```


### DEFAULT_HEARTBEAT
Default Chronicle heartbeat window (24 hours). Mirrors
`RwaVault.DEFAULT_HEARTBEAT`.


```solidity
uint256 public constant DEFAULT_HEARTBEAT = 24 hours
```


### ADMIN_ROLE
The `ADMIN_ROLE` bytes32 queried on `VAULT` for config setters.

Matches `BasketVault.ADMIN_ROLE` / `RobotMoneyVault.ADMIN_ROLE`.


```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### USDC
The USDC token address this adapter denominates in. Consumed
unchanged by the vault's `_isAdapterEligible` asset-match probe.


```solidity
address public immutable USDC
```


### VAULT
The single vault this adapter is bound to. Load-bearing identity
binding that prevents cross-vault authority substitution; MUST NOT
be relaxed for adapter reuse (spec §2, ADR-0010 §2).


```solidity
address public immutable VAULT
```


### TOKEN
The deSPXA token this adapter custodies and prices.


```solidity
address public immutable TOKEN
```


### CHRONICLE
Chronicle NAV oracle for `TOKEN`. Must be "kissed" (whitelisted)
for this adapter's address before `latestAnswer`/`latestTimestamp`
can be read — see `IChronicleOracle`.


```solidity
IChronicleOracle public immutable CHRONICLE
```


### SWAP_ADAPTER
Venue executor implementing the `IBasketSwapAdapter` swap+price
seam. Expected to be a `ChronicleOracleAdapter` instance (Aerodrome
execution, Chronicle pricing) bound to the same `CHRONICLE` feed.


```solidity
IBasketSwapAdapter public immutable SWAP_ADAPTER
```


## State Variables
### maxSlippageBps
Per-swap slippage tolerance in bps (the min-out floor). Bounded
above by `MAX_SLIPPAGE_BPS`.


```solidity
uint256 public maxSlippageBps
```


### oracleHeartbeat
Staleness heartbeat window in seconds. Price-dependent operations
revert `StalePriceFeed` when the Chronicle feed age exceeds this
value. Admin-settable within `[MIN_HEARTBEAT, MAX_HEARTBEAT]`.


```solidity
uint256 public oracleHeartbeat
```


## Functions
### onlyVault

Every mutating position path is `onlyVault` (INV-1 authority binding).


```solidity
modifier onlyVault() ;
```

### onlyVaultAdmin

Config setters are gated by the VAULT's transitive `ADMIN_ROLE`; the
adapter carries no independent role tree (seam-map contracts/adapters/).


```solidity
modifier onlyVaultAdmin() ;
```

### constructor


```solidity
constructor(
    address usdc_,
    address vault_,
    address token_,
    address chronicle_,
    address swapAdapter_
) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdc_`|`address`|       USDC token this adapter denominates in.|
|`vault_`|`address`|      The single vault this adapter is bound to (INV-1).|
|`token_`|`address`|      The deSPXA token custodied and priced.|
|`chronicle_`|`address`|  Chronicle NAV oracle for `token_`.|
|`swapAdapter_`|`address`|Venue executor implementing `IBasketSwapAdapter` (Aerodrome execution + Chronicle pricing).|


### deploy

Convert `usdcIn` USDC (transferred to the adapter first, same
choreography as v1 `_allocateTo`) into the adapter's position.

Choreography: the vault has already `safeTransfer`ed `usdcIn` USDC to
this adapter. Fails closed on a stale Chronicle price (ORA-2), swaps
USDC→TOKEN through the venue seam with a Chronicle-derived min-out,
and credits the realized USDC-denominated increase in `totalAssets()`.
Reverts `SlippageExceeded` when `valueAdded < minValueOut` (no clamp).
Reverts (bubbling the venue's revert) if deSPXA transfers are frozen —
this is expected fail-closed behavior on the mutating path (ADR-0006
§3); it does NOT brick `totalAssets()` (see contract-level NatSpec).


```solidity
function deploy(uint256 usdcIn, uint256 minValueOut)
    external
    onlyVault
    returns (uint256 valueAdded);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdcIn`|`uint256`|USDC (6-decimal units) the vault has already `safeTransfer`ed.|
|`minValueOut`|`uint256`|Slippage floor; the adapter MUST revert `SlippageExceeded` when the realized USDC-denominated value added is below this (no clamp on the deploy path).|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`valueAdded`|`uint256`|USDC-denominated increase in `totalAssets()` from this call. Exact adapters MUST return exactly `usdcIn`.|


### withdraw

Liquidate position back to USDC and deliver it to the vault.

Liquidates enough TOKEN to raise `usdcWanted` USDC (Chronicle-estimated),
clamped at the held balance (`type(uint256).max` ⇒ sell all). The
effective floor is `max(minUsdcOut, adapterInternalFloor)` where the
internal floor is the slippage-haircut Chronicle value of the tokens
sold; shortfall against the floor reverts `SlippageExceeded`, shortfall
against `usdcWanted` above the floor clamps. Proceeds are delivered
straight to `VAULT`. Fails closed on a stale Chronicle price (ORA-2)
whenever the position is non-empty. Reverts (bubbling the venue's
revert) if deSPXA transfers are frozen — expected fail-closed
behavior on the mutating path; does NOT brick `totalAssets()`.


```solidity
function withdraw(uint256 usdcWanted, uint256 minUsdcOut)
    external
    onlyVault
    returns (uint256 usdcOut);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`usdcWanted`|`uint256`|Target USDC; `type(uint256).max` means "withdraw all" (emergency drains, adapter retirement). Clamped at liquidatable balance — shortfall against `usdcWanted` clamps.|
|`minUsdcOut`|`uint256`|Effective floor is `max(minUsdcOut, adapterInternalFloor)`; shortfall against the floor REVERTS `SlippageExceeded`. `0` means "adapter's own floor" (not "no floor"). Shortfall against `usdcWanted` above the floor CLAMPS (returns the realized `usdcOut`).|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`usdcOut`|`uint256`|Realized USDC delivered to the vault.|


### totalAssets

Live USDC-denominated value of the position (principal + accrued
interest for lending; TWAP/oracle-priced balance for assets).
Spot (`slot0`) is never read here (ORA-1). MAY revert fail-closed
when the price source is unusable; MUST return 0 (without touching
the oracle) on a zero balance (SUP-5).

Chronicle-priced USDC value of the held TOKEN. Returns 0 on a zero
balance WITHOUT touching the oracle (SUP-5). Fails closed with
`StalePriceFeed` when the Chronicle feed is stale AND the position is
non-empty (ORA-2) — matches `RwaVault.totalAssets`/`_holdsPricedRwa`.
Freeze-safe: this is a pure `balanceOf` + view-only oracle read, never
a token transfer, so a deSPXA transfer freeze cannot brick this value
(contract-level NatSpec).


```solidity
function totalAssets() public view returns (uint256);
```

### isExact

Bytecode-level exactness declaration: `true` iff `deploy`/`withdraw`
are 1:1 and `totalAssets()` is a hard redemption claim (lending),
`false` for slippage-priced asset adapters.

Always `false`: oracle-priced asset custody swapped through a venue
is never a 1:1 redemption claim.


```solidity
function isExact() external pure returns (bool);
```

### harvestRewards

Permissionlessly claim venue rewards, convert to USDC, and credit
the vault (never a caller-supplied address, INV-1; never stranded,
INV-2). MUST NOT revert when there is nothing to claim.

Spot deSPXA custody has no discrete claimable reward tokens — this is
a no-op and MUST NOT revert (INV-2). NAV appreciation accrues in the
held TOKEN balance / Chronicle mark and is already reflected in
`totalAssets()`.


```solidity
function harvestRewards() external;
```

### sweepForeignToken

Permissionlessly sweep a NON-protected foreign token to the fixed
quarantine address (INV-1/INV-2). Protected set: USDC, the venue
receipt/share token, and the custodied basket token — reverts on
those; they stay in NAV and accrue pro-rata.

Protected set: USDC and the custodied `TOKEN` (both stay in NAV and
accrue pro-rata) — reverts on those (INV-2). Everything else is swept
permissionlessly to the fixed quarantine sink (never caller-supplied,
INV-1).


```solidity
function sweepForeignToken(address token) external;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`token`|`address`|Foreign ERC-20 to quarantine.|


### _checkOracleFreshness

Reverts with `StalePriceFeed` if the Chronicle feed has not been
updated within `oracleHeartbeat` seconds.

Called by `deploy`, `withdraw` (unconditionally — both are
price-dependent regardless of current custody), and `totalAssets`
(gated on non-zero balance, SUP-5). Any price-sensitive operation
halts when the feed is stale, consistent with the "fail closed"
philosophy in ADR-0006 §2 / unified-vault-spec §4.4 ORA-2.


```solidity
function _checkOracleFreshness() internal view;
```

### setMaxSlippageBps

Set the per-swap slippage tolerance (min-out floor). Bounded above
by `MAX_SLIPPAGE_BPS`.


```solidity
function setMaxSlippageBps(uint256 newBps) external onlyVaultAdmin;
```

### setOracleHeartbeat

Update the Chronicle staleness heartbeat. Restricted to
`onlyVaultAdmin`. Must fall in `[MIN_HEARTBEAT, MAX_HEARTBEAT]`.


```solidity
function setOracleHeartbeat(uint256 newHeartbeat) external onlyVaultAdmin;
```

## Events
### MaxSlippageUpdated

```solidity
event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);
```

### OracleHeartbeatUpdated

```solidity
event OracleHeartbeatUpdated(uint256 oldHeartbeat, uint256 newHeartbeat);
```

### Deployed

```solidity
event Deployed(uint256 usdcIn, uint256 valueAdded);
```

### Withdrawn

```solidity
event Withdrawn(uint256 usdcWanted, uint256 usdcOut);
```

## Errors
### ZeroAddress
A constructor immutable was the zero address.


```solidity
error ZeroAddress();
```

### InvalidParam
A config setter received an out-of-range value.


```solidity
error InvalidParam();
```

### OnlyVaultAdmin
The caller is not the `VAULT`'s ADMIN_ROLE holder (config setters).


```solidity
error OnlyVaultAdmin();
```

### StalePriceFeed
Raised when the Chronicle feed has not been updated within
`oracleHeartbeat` seconds. Rejects a stale price rather than using it
(ORA-2 fail-closed) — see `RwaVault.StalePriceFeed`.


```solidity
error StalePriceFeed(uint256 updatedAt, uint256 heartbeat);
```

