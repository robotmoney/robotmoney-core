# DeployTimelock
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c9e141ffcd1c066f8ea8438f58e57b245c4556f8/contracts/script/DeployTimelock.s.sol)

**Inherits:**
Script

**Title:**
DeployTimelock

Deploy an OZ TimelockController and complete the privileged-role
handover on all five Robot Money contracts (RobotMoneyVault,
RobotMoneyGateway, VaultRegistry, PortfolioRouter, RouterGovernance)
from the deployer EOA to the TimelockController + an independent
emergency hot key.
After this script runs (ACL-1 / F-01):
- TimelockController holds ADMIN_ROLE on all five contracts AND the
Gateway DEFAULT_ADMIN_ROLE (so it can rotate roles / authorizeAgent).
- The deployer EOA holds NO privileged role of any kind:
no ADMIN_ROLE on any contract, no Gateway DEFAULT_ADMIN_ROLE, and
no vault EMERGENCY_ROLE.
- The vault EMERGENCY_ROLE is held by the independent EMERGENCY_ADDRESS
hot key, not the deployer.
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
EMERGENCY_ADDRESS      — independent hot key that receives the vault
EMERGENCY_ROLE (must differ from the deployer
EOA; ACL-1 / F-01)
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


### EMERGENCY_ROLE

```solidity
bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE")
```


### PAUSER_ROLE

```solidity
bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE")
```


### AGENT_ROLE

```solidity
bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE")
```


### DEFAULT_ADMIN_ROLE
OZ `AccessControl.DEFAULT_ADMIN_ROLE` is `bytes32(0)`.


```solidity
bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00
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
    address emergency_,
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
    address emergency;
    uint256 minDelay;
}
```

