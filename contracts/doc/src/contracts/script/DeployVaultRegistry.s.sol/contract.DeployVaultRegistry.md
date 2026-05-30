# DeployVaultRegistry
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/8e58630207799c10307586432e49cdc81ca6ac74/contracts/script/DeployVaultRegistry.s.sol)

**Inherits:**
Script

**Title:**
DeployVaultRegistry

Foundry deploy script for the VaultRegistry contract.
Deploys VaultRegistry and registers RobotMoneyVault as an Active vault.
Idempotent: if the vault is already registered the registration step
is skipped without reverting.
The deployed registry address is appended to the shared devnet
deployment JSON so rmpc and the dapp can discover it without
manual editing.
Required env vars:
ADMIN_ADDRESS    — receives ADMIN_ROLE on the registry
VAULT_ADDRESS    — RobotMoneyVault to register
USDC_ADDRESS     — ERC-20 asset the vault denominates in
Optional env vars:
VAULT_NAME       — human-readable vault name
(default: "Robot Money USDC")
DEPLOYMENT_OUT   — path for the output JSON
(default: "deployments/registry-<chain_id>.json")


## Constants
### DEFAULT_VAULT_NAME
Default vault name used when VAULT_NAME env var is unset.


```solidity
string public constant DEFAULT_VAULT_NAME = "Robot Money USDC"
```


## Functions
### run

Forge broadcast entrypoint. Reads env vars, deploys registry,
registers the vault (idempotently), and writes a deployment JSON.
In broadcast mode the broadcaster IS admin (the smoke-test devnet
runs the script with the admin private key), so msg.sender on
registerVault holds ADMIN_ROLE. No vm.prank is needed or allowed.


```solidity
function run() external returns (Deployed memory d);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing the deployed registry and key parameters.|


### runInProcessWith

In-process variant for forge tests. No broadcast, no JSON written.
registerVault requires ADMIN_ROLE; this method pranks admin.


```solidity
function runInProcessWith(
    address admin_,
    address vault_,
    address asset_,
    string memory vaultName_
) external returns (Deployed memory d);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`admin_`|`address`|    Address to receive ADMIN_ROLE.|
|`vault_`|`address`|    RobotMoneyVault to register.|
|`asset_`|`address`|    ERC-20 asset the vault denominates in.|
|`vaultName_`|`string`|Human-readable vault name.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing the deployed registry and key parameters.|


### _registerIfAbsent

Register `vault` if it is not already in the registry.
Returns true if registration happened, false if already present.
Caller must ensure the call context holds ADMIN_ROLE.


```solidity
function _registerIfAbsent(
    VaultRegistry registry,
    address vault,
    address asset,
    string memory vaultName
) internal returns (bool registered);
```

### _logResult


```solidity
function _logResult(Deployed memory d) internal view;
```

### _envStringOrDefault


```solidity
function _envStringOrDefault(string memory key, string memory fallback_)
    internal
    view
    returns (string memory);
```

### _writeDeploymentJson


```solidity
function _writeDeploymentJson(Deployed memory d) internal;
```

## Structs
### Deployed
Result struct returned to in-process callers (e.g. forge tests).


```solidity
struct Deployed {
    VaultRegistry registry;
    address admin;
    address vault;
    address asset;
    bool registered;
}
```

