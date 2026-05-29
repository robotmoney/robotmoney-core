# DeployPortfolioRouter
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/cf8a75c9169f98b8e30f0ad4e13af73b36f22bc7/contracts/script/DeployPortfolioRouter.s.sol)

**Inherits:**
Script

**Title:**
DeployPortfolioRouter

Foundry deploy script for the PortfolioRouter contract.
Deploys PortfolioRouter, sets initial weights (10 000 bps to
RobotMoneyVault — the sole active vault), and writes the router
address to a deployment JSON alongside the registry address.
The smoke-test devnet startup sequence runs this script so that
`rmpc get-router` and the dapp router view return real data in CI.
Required env vars:
ADMIN_ADDRESS      — receives ADMIN_ROLE on the router
REGISTRY_ADDRESS   — deployed VaultRegistry address
VAULT_ADDRESS      — RobotMoneyVault (sole active vault, 10 000 bps)
USDC_ADDRESS       — ERC-20 asset the router accepts
Optional env vars:
DEPLOYMENT_OUT     — path for the output JSON
(default: "deployments/router-<chain_id>.json")


## Constants
### INITIAL_VAULT_WEIGHT_BPS
BPS weight assigned to RobotMoneyVault as the sole active vault.


```solidity
uint256 public constant INITIAL_VAULT_WEIGHT_BPS = 10_000
```


## Functions
### run

Forge broadcast entrypoint. Reads env vars, deploys the router,
sets initial weights, and writes a deployment JSON.
In broadcast mode the broadcaster IS admin (the smoke-test devnet
runs the script with the admin private key), so msg.sender on
setWeights holds ADMIN_ROLE. No vm.prank is needed or allowed.


```solidity
function run() external returns (Deployed memory d);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing the deployed router and key parameters.|


### runInProcessWith

In-process variant for forge tests. No broadcast, no JSON written.
setWeights requires ADMIN_ROLE; this method pranks admin.


```solidity
function runInProcessWith(address admin_, address registry_, address vault_, address usdc_)
    external
    returns (Deployed memory d);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`admin_`|`address`|    Address to receive ADMIN_ROLE.|
|`registry_`|`address`| Deployed VaultRegistry address.|
|`vault_`|`address`|    RobotMoneyVault to seed with 10 000 bps.|
|`usdc_`|`address`|     ERC-20 asset the router accepts.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing the deployed router and key parameters.|


### _deploy

Deploy router and set initial weights. Caller must ensure ADMIN_ROLE
is active on the call context (broadcast or prank).


```solidity
function _deploy(address admin_, address registry_, address vault_, address usdc_)
    internal
    returns (Deployed memory d);
```

### _logResult


```solidity
function _logResult(Deployed memory d) internal view;
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
    PortfolioRouter router;
    VaultRegistry registry;
    address admin;
    address vault;
    address usdc;
}
```

