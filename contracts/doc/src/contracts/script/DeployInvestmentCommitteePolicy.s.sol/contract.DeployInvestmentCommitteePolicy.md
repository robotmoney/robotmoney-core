# DeployInvestmentCommitteePolicy
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/0d868fe02e5cf19ce075213817ca84416ca13c09/contracts/script/DeployInvestmentCommitteePolicy.s.sol)

**Inherits:**
Script

**Title:**
DeployInvestmentCommitteePolicy

Foundry deploy script for the InvestmentCommitteePolicy contract.
Deploys InvestmentCommitteePolicy with the given admin and gateway
addresses, wires the IC policy into the gateway (`setICPolicy`),
and grants the gateway IC's `ADMIN_ROLE` so it can forward
`committeeRegister` calls to the IC contract on behalf of the admin.
Writes a deployment JSON readable by the smoke-test fixture and
off-chain tooling.
Required env vars:
ADMIN_ADDRESS    — receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE on IC;
must also hold ADMIN_ROLE on the gateway (for
setICPolicy and gateway grantRole).
GATEWAY_ADDRESS  — deployed RobotMoneyGateway address; all committee
writes (register, voteSubmit) must originate here.
Optional env vars:
DEPLOYMENT_OUT   — path for the output JSON
(default: "deployments/ic-policy-<chain_id>.json")


## Functions
### run

Forge broadcast entrypoint. Reads env vars, deploys the
InvestmentCommitteePolicy contract, wires it into the gateway,
and writes a deployment JSON.


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
|`admin_`|`address`|  Address to receive DEFAULT_ADMIN_ROLE and ADMIN_ROLE on IC. Must also hold ADMIN_ROLE on the gateway.|
|`gateway_`|`address`|Deployed RobotMoneyGateway address.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing the deployed contract and key parameters.|


### _deploy


```solidity
function _deploy(address admin_, address gateway_) internal returns (Deployed memory d);
```

### _wireGateway

Wire the deployed IC policy into the gateway.
1. Call `gateway.setICPolicy(policy)` — requires ADMIN_ROLE on gateway.
2. Grant IC's `ADMIN_ROLE` to the gateway so it can forward
`committeeRegister` calls — requires DEFAULT_ADMIN_ROLE on IC
(held by the admin set at IC construction time).
Must be called in a context where `msg.sender` holds ADMIN_ROLE on
the gateway AND DEFAULT_ADMIN_ROLE on the IC contract (i.e. the
same admin address supplied to both constructors).


```solidity
function _wireGateway(Deployed memory d) internal;
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

