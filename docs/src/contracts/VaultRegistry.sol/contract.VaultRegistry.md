# VaultRegistry
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/5f3c3bfe955810832b34a58296a18cb976126c6d/contracts/VaultRegistry.sol)

**Inherits:**
AccessControl

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


### setVaultStatus

Update a vault's lifecycle status. Restricted to `ADMIN_ROLE`.


```solidity
function setVaultStatus(address vault, VaultStatus newStatus) external onlyRole(ADMIN_ROLE);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`vault`|`address`|     Address of an already-registered vault.|
|`newStatus`|`VaultStatus`| New lifecycle status (Active, Paused, or Retired).|


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
    Retired
}
```

