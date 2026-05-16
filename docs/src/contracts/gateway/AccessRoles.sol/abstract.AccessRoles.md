# AccessRoles
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/1421cc6201de54f6b9e3c222f9419f45c65b6f43/contracts/gateway/AccessRoles.sol)

**Inherits:**
AccessControl

**Title:**
AccessRoles

Role constants and AccessControl wiring for the RobotMoney gateway.

Three roles, all distinct keys (see `docs/implementation-plan.md` §2.1):
- `ADMIN_ROLE`  — grants/revokes other roles, sets policy, unpauses.
- `PAUSER_ROLE` — `pause()` only. Asymmetric with unpause by design:
pausing is a stop-the-world tool that must be fast and unilateral
(one compromised PAUSER can only DoS, not steal); unpause is
deliberate and restricted to ADMIN.
- `AGENT_ROLE`  — only role allowed to call `deposit()`.
Invariant. The three privileged roles `ADMIN_ROLE`, `PAUSER_ROLE`,
and `AGENT_ROLE` are pairwise disjoint — no account may hold any
two of them simultaneously. Pause is intentionally siloed from
admin so that a compromised pauser key cannot also grant or revoke
roles, and an admin compromise cannot also rapid-DoS the gateway.
Enforced by overriding `_grantRole` to revert on any overlap, and
exposed via `_assertRoleSeparation` for use in deploy scripts and
the gateway's `authorizeAgent`.


## Constants
### ADMIN_ROLE
Grants/revokes other roles, sets policy, unpauses.


```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


### PAUSER_ROLE
`pause()` only. Asymmetric with unpause by design.


```solidity
bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE")
```


### AGENT_ROLE
Only role allowed to call `deposit()`.


```solidity
bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE")
```


## Functions
### _grantRole

Override that enforces full pairwise separation among
{ADMIN, PAUSER, AGENT} before any grant takes effect.
Reverts on any overlap.


```solidity
function _grantRole(bytes32 role, address account) internal virtual override returns (bool);
```

### _assertRoleSeparation

Post-grant invariant check. Reverts if `account` holds any
two of {ADMIN, PAUSER, AGENT} simultaneously. Intended for
deploy scripts and the gateway's `authorizeAgent` to assert
state explicitly.


```solidity
function _assertRoleSeparation(address account) internal view;
```

## Errors
### RoleSeparationViolated
Reverts when granting a role would cause an account to hold
any two of {ADMIN, PAUSER, AGENT} simultaneously.


```solidity
error RoleSeparationViolated();
```

