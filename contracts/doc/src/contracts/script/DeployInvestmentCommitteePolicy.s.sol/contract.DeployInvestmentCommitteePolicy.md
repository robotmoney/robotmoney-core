# DeployInvestmentCommitteePolicy
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/a7ac64337cc2843fe9fad5c808ffb035e51d4697/contracts/script/DeployInvestmentCommitteePolicy.s.sol)

**Inherits:**
Script

**Title:**
DeployInvestmentCommitteePolicy

Foundry deploy script for the InvestmentCommitteePolicy contract.
Deploys InvestmentCommitteePolicy with the given admin and gateway
addresses and writes a deployment JSON readable by the smoke-test
fixture and off-chain tooling.
Required env vars:
ADMIN_ADDRESS    — receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE;
may then call registerAgent / revokeAgent.
GATEWAY_ADDRESS  — deployed RobotMoneyGateway address; all
committee writes (register, voteSubmit) must
originate from this address.
Optional env vars:
DEPLOYMENT_OUT   — path for the output JSON
(default: "deployments/ic-policy-<chain_id>.json")


## Functions
### run

Forge broadcast entrypoint. Reads env vars, deploys the
InvestmentCommitteePolicy contract, and writes a deployment JSON.


```solidity
function run() external returns (Deployed memory d);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing the deployed contract and key parameters.|


### runInProcessWith

In-process variant for forge tests. No broadcast, no JSON written.


```solidity
function runInProcessWith(address admin_, address gateway_)
    external
    returns (Deployed memory d);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`admin_`|`address`|  Address to receive DEFAULT_ADMIN_ROLE and ADMIN_ROLE.|
|`gateway_`|`address`|Deployed RobotMoneyGateway address.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing the deployed contract and key parameters.|


### _deploy


```solidity
function _deploy(address admin_, address gateway_) internal returns (Deployed memory d);
```

### _logResult


```solidity
function _logResult(Deployed memory d) internal pure;
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
    InvestmentCommitteePolicy policy;
    address admin;
    address gateway;
}
```

