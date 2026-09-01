# DeployInvestmentCommitteePolicy
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/2a9fcb34331b03f9e13845e26eac35a6f0cc7642/contracts/script/DeployInvestmentCommitteePolicy.s.sol)

**Inherits:**
Script

**Title:**
DeployInvestmentCommitteePolicy

Foundry deploy script for the InvestmentCommitteePolicy contract.
Deploys InvestmentCommitteePolicy AND ConsensusRecommendationReceipt in
one ceremony (issue #1247 AC10 — one greenfield rollout, no
migration, no registered agent to preserve), wires both into the
gateway (`setICPolicy`, `setConsensusReceipt`), and grants the
gateway IC's `ADMIN_ROLE` so it can forward `committeeRegister`
calls on behalf of the admin. Writes a deployment JSON readable by
the smoke-test fixture and off-chain tooling.
**The receipt contract's `ADMIN_ROLE` goes to `RECEIPT_ADMIN_ADDRESS`
and nowhere else.** In production that is the `TimelockController`
(INV-3). The gateway is deliberately NOT granted it: routing
`releaseReceipt` through the gateway would need a second holder and
defeat INV-3, so the timelock calls the receipt contract directly.
See `docs/architecture.md` §4.9.
Required env vars:
ADMIN_ADDRESS    — receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE on IC;
must also hold ADMIN_ROLE on the gateway (for
setICPolicy and gateway grantRole).
GATEWAY_ADDRESS  — deployed RobotMoneyGateway address; all committee
writes (register, voteSubmit, receipt record)
must originate here.
Optional env vars:
RECEIPT_ADMIN_ADDRESS — sole holder of ADMIN_ROLE on the receipt
contract; the TimelockController in production.
Defaults to ADMIN_ADDRESS for devnet ceremonies.
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


### runInProcessWith

In-process variant that separates the IC admin from the receipt
contract's `ADMIN_ROLE` holder (the timelock). No broadcast, no
JSON written.


```solidity
function runInProcessWith(address admin_, address receiptAdmin_, address gateway_)
    public
    returns (Deployed memory d);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`admin_`|`address`|       Address to receive DEFAULT_ADMIN_ROLE and ADMIN_ROLE on IC.|
|`receiptAdmin_`|`address`|Sole holder of ADMIN_ROLE on the receipt contract.|
|`gateway_`|`address`|     Deployed RobotMoneyGateway address.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing the deployed contracts and key parameters.|


### wireGatewayInProcess

In-process gateway wiring for forge tests. `msg.sender` must
hold `ADMIN_ROLE` on the gateway AND `DEFAULT_ADMIN_ROLE` on the
IC contract, exactly as the broadcast path requires.


```solidity
function wireGatewayInProcess(Deployed memory d) public;
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Result of `runInProcessWith`.|


### _deploy


```solidity
function _deploy(address admin_, address receiptAdmin_, address gateway_)
    internal
    returns (Deployed memory d);
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
    ConsensusRecommendationReceipt receipts;
    address admin;
    address receiptAdmin;
    address gateway;
}
```

