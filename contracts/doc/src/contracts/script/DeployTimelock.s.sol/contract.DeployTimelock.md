# DeployTimelock
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/c43fbb392825b11d010cdb5df06c784303c7dcd7/contracts/script/DeployTimelock.s.sol)

**Inherits:**
Script

**Title:**
DeployTimelock

Deploy an OZ TimelockController and transfer ADMIN_ROLE on all five
Robot Money contracts (RobotMoneyVault, RobotMoneyGateway,
VaultRegistry, PortfolioRouter, RouterGovernance) from the current
admin EOA to the TimelockController.
After this script runs:
- TimelockController holds ADMIN_ROLE on all five contracts.
- The Safe multisig (SAFE_ADDRESS) holds PROPOSER_ROLE and
EXECUTOR_ROLE on the TimelockController.
- Direct ADMIN_ROLE calls from any EOA revert with
AccessControlUnauthorizedAccount.
- Admin operations must be routed through
TimelockController.schedule → delay → execute.
Required env vars:
VAULT_ADDRESS          — RobotMoneyVault
GATEWAY_ADDRESS        — RobotMoneyGateway
REGISTRY_ADDRESS       — VaultRegistry
ROUTER_ADDRESS         — PortfolioRouter
GOVERNANCE_ADDRESS     — RouterGovernance
SAFE_ADDRESS           — Safe multisig (becomes PROPOSER + EXECUTOR)
TIMELOCK_MIN_DELAY     — minimum delay in seconds (e.g. 172800 = 2 days)
Optional env vars:
DEPLOYMENT_OUT         — output JSON path; default artifacts/timelock.json

After deploying, the broadcaster (current ADMIN_ROLE holder) is no
longer the admin on any contract. Verify with:
cast call <vault> "hasRole(bytes32,address)" $(cast keccak "ADMIN_ROLE") <timelock>


## Constants
### ADMIN_ROLE

```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


## Functions
### run

Broadcast entrypoint. Reads env vars, deploys timelock, and
transfers ADMIN_ROLE on all five contracts.


```solidity
function run() external returns (Deployed memory d);
```

### runInProcess

In-process variant for Forge tests. Caller sets up prank context.
No JSON is written; no env vars are read.


```solidity
function runInProcess(
    address vault_,
    address gateway_,
    address registry_,
    address router_,
    address governance_,
    address safe_,
    uint256 minDelay_
) external returns (Deployed memory d);
```

### _validate


```solidity
function _validate(Deployed memory d) internal view;
```

### _deployAndWire


```solidity
function _deployAndWire(Deployed memory d) internal returns (TimelockController timelock);
```

### _logResult


```solidity
function _logResult(Deployed memory d) internal pure;
```

### _writeJson


```solidity
function _writeJson(Deployed memory d) internal;
```

## Structs
### Deployed

```solidity
struct Deployed {
    TimelockController timelock;
    address vault;
    address gateway;
    address registry;
    address router;
    address governance;
    address safe;
    uint256 minDelay;
}
```

