# VaultRegistry
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/VaultRegistry.sol)

**Inherits:**
[AdminFloorAccessControl](/contracts/lib/AdminFloorAccessControl.sol/abstract.AdminFloorAccessControl.md)

**Title:**
VaultRegistry

On-chain registry of authorised Robot Money vaults.
Protocol operators call `registerVault` once per vault; all downstream
clients (rmpc, dapp, indexer) discover vaults via `listVaults()`.
`VaultRegistered` and `VaultStatusChanged` events let the explorer
indexer stay current without manual config updates.
Access model: `ADMIN_ROLE` is required for `registerVault` and
`setVaultStatus`. This role is self-administered (its own role-admin)
so the deployer is the sole initial admin, matching the gateway's
access-control pattern.


## Constants
### ADMIN_ROLE
Grants/revokes other roles, registers vaults, changes vault status.


```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


## State Variables
### _metadata
Full metadata per vault address.


```solidity
mapping(address => VaultMetadata) private _metadata
```


### _status
Current lifecycle status per vault address.


```solidity
mapping(address => VaultStatus) private _status
```


### _vaults
Ordered list of all registered vault addresses (registration order preserved).


```solidity
address[] private _vaults
```


### _registered
Quick existence check to avoid scanning `_vaults` on duplicate-register guard.


```solidity
mapping(address => bool) private _registered
```


### _routerEligible
Per-vault router-eligibility flag. False by default. Toggled by
`ADMIN_ROLE` via `setRouterEligible` to express that a registered
vault has cleared production-readiness gating (audit, oracle
hardening, etc.) and may be weighted by `PortfolioRouter`.
Router eligibility is registry **state** — it is the single,
operator-set signal `PortfolioRouter` consults to decide whether
a vault can enter the weight vector and receive USDC. Expressing
readiness as state (not as a code variant such as a
test/demo-only subclass that overrides a hard-coded flag) is the
single-production-codebase principle in
`docs/development/single-production-codebase.md`: the same
contracts deploy unchanged into every environment; environments
differ only by configuration and seeded state.


```solidity
mapping(address => bool) private _routerEligible
```


### routerEligibleCount
Count of vaults currently marked router-eligible. Mirrors the
number of `true` entries in `_routerEligible`. The
`PortfolioRouter` default weight vector must span exactly this
many legs (see `setRouterEligible`). ADR-0002.


```solidity
uint256 public routerEligibleCount
```


### router
Optional `PortfolioRouter` whose default weight vector length is
kept consistent with `routerEligibleCount`. When set (non-zero)
and the router already carries a non-empty default vector,
`setRouterEligible` reverts on any change that would leave that
vector with a stale length. Set once by ADMIN_ROLE after both
contracts are deployed. ADR-0002.


```solidity
IRouterDefaultWeights public router
```


## Functions
### constructor


```solidity
constructor(address admin) ;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`admin`|`address`|Address that receives `ADMIN_ROLE` at deploy time.|


### registerVault

Register a new vault. The vault is set to `Active` status immediately.
Restricted to `ADMIN_ROLE`.


```solidity
function registerVault(address vault, VaultMetadata calldata metadata)
    external
    onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|   Address of the vault contract to register (must not be zero or already registered).|
|`metadata`|`VaultMetadata`|Human-readable name and asset address for the vault.|


### retire

Unified governance retire: atomically set the vault's registry
status to `Retired` AND halt the vault's direct deposits in a
single call. Restricted to `ADMIN_ROLE` (held by the
TimelockController in production — DeployTimelock, INV-3), so a
direct hot-key call reverts. This is the deliberate, governance
lifecycle decision (decision #925); the emergency
`RobotMoneyVault.shutdownVault` overlay is unaffected.
Withdrawals/redemptions stay open at the vault throughout
(ERC-4626 `redeem` is never revoked; ADR-0009).


```solidity
function retire(address vault) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|Address of an already-registered vault.|


### reactivate

Abort a deprecation: atomically set the vault's registry status
back to `Active` AND re-open the vault's direct deposits. The
governance counterpart to `retire`, mirroring the
`Retired → Active` abort in docs/architecture.md §4.7. Restricted
to `ADMIN_ROLE` (TimelockController in production).


```solidity
function reactivate(address vault) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|Address of an already-registered vault.|


### setVaultStatus

Update a vault's lifecycle status, driving the vault's own
deposit-halt flag in the same call so registry status and the vault
flag never drift (LIFE-1; finding F-04 residual / AZ-REG-1).
Restricted to `ADMIN_ROLE`.
Closing the back-door: previously this set only registry `_status`,
leaving the vault's `retired` deposit-halt flag untouched — so
`setVaultStatus(_, Retired)` recorded "Retired" in the registry
while the vault still accepted direct deposits, and
`setVaultStatus(_, Paused)` halted nothing on the vault. Now any
non-`Active` status drives `IRetirableVault.retire()` (hard-stop
direct deposits) and `Active` drives `unretire()`, mirroring the
atomic `retire()` / `reactivate()` paths. Both vault legs are
idempotent and registry-gated.
AZ-REG-1 fix: vault calls are no longer wrapped in try/catch. A
failed retire hook propagates to the caller so the registry never
records a vault as `Retired` while its deposit-halt leg is
unset — deposits would otherwise continue against a supposedly-
retired vault. Every vault type in the protocol implements
`IRetirableVault`; a registered address that lacks the hook
fails the call intentionally.


```solidity
function setVaultStatus(address vault, VaultStatus newStatus) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|     Address of an already-registered vault.|
|`newStatus`|`VaultStatus`| New lifecycle status (Active, Paused, or Retired).|


### setRouterEligible

Mark `vault` as router-eligible (`eligible = true`) or
ineligible (`eligible = false`). `PortfolioRouter` refuses to
weight or deposit into a vault whose flag is `false` — the
default for every freshly registered vault. ADMIN_ROLE flips
the flag once production-readiness gating (audit, oracle
hardening, etc.) is complete.
This is the single, registry-backed expression of
production-readiness called for by the
single-production-codebase principle
(`docs/development/single-production-codebase.md`). The same
contracts ship into test, demo, and production environments;
only this flag's value differs.


```solidity
function setRouterEligible(address vault, bool eligible) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|   Address of an already-registered vault.|
|`eligible`|`bool`|New router-eligibility value.|


### migrateEligibility

Atomically flip `vault`'s router-eligibility **and** re-set the
linked router's default-weight vector in one transaction. This is
the ADR-0002 migration interlock fix (H-A1, issue #1128).
The non-atomic path deadlocks once the router carries a
full-length default vector: `setRouterEligible` reverts
`StaleDefaultWeightsLength` because the vector length no longer
matches the new count, while `PortfolioRouter.setDefaultWeights`
reverts `LengthMismatch` because the count has not moved yet —
each half is blocked on the other. This call breaks the deadlock
by moving the count and the vector together, so the
`routerEligibleCount == defaultWeights.length` invariant is never
observed in an inconsistent state.
The eligibility flip is applied to this registry's state first,
then the router's registry-only
`applyMigrationDefaultWeights` re-runs the full default-vector
validation against the updated count. A default vector whose
length disagrees with the new count is rejected there and reverts
this whole transaction, so no partial update can persist. Requires
a linked router. Restricted to `ADMIN_ROLE`.


```solidity
function migrateEligibility(
    address vault,
    bool eligible,
    address[] calldata defaultVaults,
    uint256[] calldata defaultBps
) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|        Address of an already-registered vault.|
|`eligible`|`bool`|     New router-eligibility value for `vault`.|
|`defaultVaults`|`address[]`|Ordered vault list for the new default vector; its length must equal the post-flip eligible count.|
|`defaultBps`|`uint256[]`|   Parallel bps weights (must sum to BPS_DENOMINATOR).|


### setRouter

Link the `PortfolioRouter` whose default weight vector length is
kept consistent with `routerEligibleCount`. Pass `address(0)` to
unlink. Restricted to `ADMIN_ROLE`. ADR-0002.
Unlinking (passing `address(0)`) is blocked while the currently-
linked router still carries a non-empty default weight vector.
Clear or re-set `defaultWeights` on the router first. This
prevents the bypass sequence: unlink → revoke eligibility → re-link
which would otherwise leave the vector pointing to an ineligible
vault without tripping the stale-length guard.


```solidity
function setRouter(address newRouter) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`newRouter`|`address`|Address of the `PortfolioRouter` (or 0 to unlink).|


### getVault

Return full metadata and current status for a registered vault.


```solidity
function getVault(address vault)
    external
    view
    returns (VaultMetadata memory metadata, VaultStatus status);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|Address of the vault to query.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`metadata`|`VaultMetadata`|Stored `VaultMetadata` (name, asset, registeredAt).|
|`status`|`VaultStatus`|  Current `VaultStatus`.|


### listVaults

Return all registered vault addresses in registration order.


```solidity
function listVaults() external view returns (address[] memory addresses);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`addresses`|`address[]`|Ordered array of every vault ever registered.|


### vaultCount

Number of registered vaults. Always equals `listVaults().length`.


```solidity
function vaultCount() external view returns (uint256);
```

### isRouterEligible

Return the current router-eligibility flag for `vault`.
Returns `false` for unregistered vaults and for registered
vaults that have not been opted in by `setRouterEligible`.


```solidity
function isRouterEligible(address vault) external view returns (bool eligible);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|Address of the vault to query.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`eligible`|`bool`|True iff governance has marked the vault as router-eligible.|


### isVaultAllExact

Registry-visible exactness flag for `vault` (ADR-0010 §5.1 / C2).
Reads the vault's vault-attested `allExact()` through the
registry so the gateway, router, and dapp can gate
`withdraw`-shaped flows STATICALLY from a single registry endpoint
without holding a direct vault reference. This is the "read
through a registry view" surfacing option the spec sanctions
(§5.1): no mirrored state, so it can never drift from the vault's
live composition class — the flip announced by the vault's
`ExactnessTransition` event is reflected here on the next read.
Reverts `NotRegistered` for an unknown vault, and propagates the
underlying call's revert for a registered address that is not a
unified exactness `Vault` (does not implement `allExact()`) — the
caller learns the address is not an exactness-gated vault rather
than receiving a misleading `true`/`false`.


```solidity
function isVaultAllExact(address vault) external view returns (bool exact);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|Address of an already-registered vault.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`exact`|`bool`|True iff every active adapter is vault-attested exact.|


## Events
### VaultRegistered
Emitted when a new vault is registered.


```solidity
event VaultRegistered(address indexed vault, string name, address indexed asset);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|  Address of the registered vault contract.|
|`name`|`string`|   Human-readable vault name.|
|`asset`|`address`|  ERC-20 asset the vault denominates in.|

### VaultStatusChanged
Emitted when a vault's lifecycle status is changed.


```solidity
event VaultStatusChanged(
    address indexed vault, VaultStatus indexed newStatus, uint256 timestamp
);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|     Address of the vault whose status changed.|
|`newStatus`|`VaultStatus`| New lifecycle status.|
|`timestamp`|`uint256`| Block timestamp at the moment of the status change.|

### RouterEligibilityChanged
Emitted when the router-eligibility flag for `vault` changes.
`PortfolioRouter` reads this flag (via `isRouterEligible`) to
decide whether the vault may be weighted and receive USDC.


```solidity
event RouterEligibilityChanged(address indexed vault, bool oldValue, bool newValue);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|   Address of the vault whose flag changed.|
|`oldValue`|`bool`|Previous eligibility value.|
|`newValue`|`bool`|New eligibility value.|

### RouterSet
Emitted when the linked `PortfolioRouter` reference is set.


```solidity
event RouterSet(address indexed oldRouter, address indexed newRouter);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`oldRouter`|`address`|Previous router address (0 = unset).|
|`newRouter`|`address`|New router address (0 = unset).|

## Errors
### ZeroAddress
Vault address argument is `address(0)`.


```solidity
error ZeroAddress();
```

### AlreadyRegistered
Vault address is already registered.


```solidity
error AlreadyRegistered();
```

### NotRegistered
Vault address is not registered; `getVault` and `setVaultStatus`
revert with this error when the address is unknown.


```solidity
error NotRegistered();
```

### StaleDefaultWeightsLength
A `setRouterEligible` change would leave the linked router's
non-empty default weight vector with a length that no longer
matches `routerEligibleCount`. Re-set `defaultWeights` to the new
eligible set first (or clear it), then change eligibility.


```solidity
error StaleDefaultWeightsLength(uint256 expectedLength, uint256 defaultLength);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`expectedLength`|`uint256`|New router-eligible count after the change.|
|`defaultLength`|`uint256`| Current default weight vector length.|

### RouterUnlinkBlocked
`setRouter(address(0))` was called while the currently-linked
router still carries a non-empty default weight vector. Clear or
re-set `defaultWeights` on the router first, then unlink.


```solidity
error RouterUnlinkBlocked(uint256 defaultLength);
```

**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`defaultLength`|`uint256`| Current default weight vector length on the router.|

### RouterNotLinked
`migrateEligibility` was called while no `PortfolioRouter` is
linked. The atomic eligibility+weights entry point only makes
sense against a linked router whose default vector it re-sets in
the same call; with no router, use plain `setRouterEligible`.


```solidity
error RouterNotLinked();
```

## Structs
### VaultMetadata
Metadata stored on-chain for every registered vault.


```solidity
struct VaultMetadata {
    string name;
    address asset;
    uint256 registeredAt;
}
```

**Properties**

|Name|Type|Description|
|----|----|-----------|
|`name`|`string`|         Human-readable name (e.g. "Robot Money USDC").|
|`asset`|`address`|        ERC-20 asset address the vault denominates in.|
|`registeredAt`|`uint256`| Block timestamp when `registerVault` was called.|

## Enums
### VaultStatus
Lifecycle status of a registered vault.


```solidity
enum VaultStatus {
    Active,
    Paused,
    /// @dev Retired: withdraw-only. Existing depositors keep standard
    ///      ERC-4626 `redeem` at any time and `PortfolioRouter` routes no
    ///      new deposits here. There is deliberately NO on-chain migration:
    ///      the protocol never force- or admin-migrates depositor funds to a
    ///      successor vault. Any migration is user-initiated and user-signed
    ///      at the app layer (redeem, then deposit). See
    ///      docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md.
    Retired
}
```

