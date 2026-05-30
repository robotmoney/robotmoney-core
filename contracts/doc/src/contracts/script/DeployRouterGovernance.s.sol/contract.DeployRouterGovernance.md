# DeployRouterGovernance
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/a9c23f29365b1a58869648c1ae96ac66c7ca191a/contracts/script/DeployRouterGovernance.s.sol)

**Inherits:**
Script

**Title:**
DeployRouterGovernance

Foundry deploy script for the RouterGovernance contract.
Deploys RouterGovernance with the deployer as ADMIN_ROLE and
writes a deployment JSON readable by the smoke-test fixture.
The smoke-test devnet startup sequence runs this script after
DeployPortfolioRouter so that the dapp's Governance tab reads
live on-chain data in CI.
Required env vars:
ADMIN_ADDRESS      — receives ADMIN_ROLE on the governance contract
ROUTER_ADDRESS     — deployed PortfolioRouter address
Optional env vars:
VOTING_PERIOD      — voting period in seconds (default: 3600 — 1 hour)
EXECUTION_DELAY    — delay from voting end to execution in seconds (default: 0)
QUORUM_THRESHOLD   — minimum FOR voting power for quorum (default: 1)
DEPLOYMENT_OUT     — path for the output JSON
(default: "deployments/governance-<chain_id>.json")


## Constants
### DEFAULT_VOTING_PERIOD
Default voting period: 1 hour in seconds.


```solidity
uint64 public constant DEFAULT_VOTING_PERIOD = 3600
```


### DEFAULT_EXECUTION_DELAY
Default execution delay: 0 seconds (immediate after quorum).


```solidity
uint64 public constant DEFAULT_EXECUTION_DELAY = 0
```


### DEFAULT_QUORUM_THRESHOLD
Default quorum threshold: 1 unit of voting power.


```solidity
uint256 public constant DEFAULT_QUORUM_THRESHOLD = 1
```


## Functions
### run

Forge broadcast entrypoint. Reads env vars, deploys
RouterGovernance, and writes a deployment JSON.


```solidity
function run() external returns (Deployed memory d);
```
**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing the deployed governance and key parameters.|


### runInProcessWith

In-process variant for forge tests. No broadcast, no JSON written.


```solidity
function runInProcessWith(
    address admin_,
    address router_,
    uint64 votingPeriod_,
    uint64 executionDelay_,
    uint256 quorumThreshold_
) external returns (Deployed memory d);
```
**Parameters**

|Name|Type|Description|
|----|----|-----------|
|`admin_`|`address`|          Address to receive ADMIN_ROLE.|
|`router_`|`address`|         Deployed PortfolioRouter address.|
|`votingPeriod_`|`uint64`|   Voting period in seconds.|
|`executionDelay_`|`uint64`| Delay from voting end to execution in seconds.|
|`quorumThreshold_`|`uint256`|Minimum FOR voting power for quorum.|

**Returns**

|Name|Type|Description|
|----|----|-----------|
|`d`|`Deployed`|Struct containing the deployed governance and key parameters.|


### _deploy


```solidity
function _deploy(
    address admin_,
    address router_,
    uint64 votingPeriod_,
    uint64 executionDelay_,
    uint256 quorumThreshold_
) internal returns (Deployed memory d);
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
    RouterGovernance governance;
    PortfolioRouter router;
    address admin;
    uint64 votingPeriod;
    uint64 executionDelay;
    uint256 quorumThreshold;
}
```

