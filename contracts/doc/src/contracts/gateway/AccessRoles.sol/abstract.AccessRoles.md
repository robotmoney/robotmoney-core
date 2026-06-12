# AccessRoles
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/2c36c8c1f505bf99870d94b72352925723aa9588/contracts/gateway/AccessRoles.sol)

**Inherits:**
AccessControl

**Title:**
AccessRoles

Role constants and AccessControl wiring for the RobotMoney gateway.

Three roles, all distinct keys (see `Plan tracking issue #109` §2.1):
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
`DEFAULT_ADMIN_ROLE` is treated as part of the ADMIN tier
(audit 2026-06-09, L-14): it may coexist with `ADMIN_ROLE` (the gateway
constructor grants both to the same admin address), but never with
`PAUSER_ROLE` or `AGENT_ROLE`. Without this, a `DEFAULT_ADMIN_ROLE`
holder could renounce `ADMIN_ROLE` and then self-grant `AGENT_ROLE`,
silently bypassing the disjointness invariant.


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

Override that enforces full pairwise separation among the
{ADMIN-tier, PAUSER, AGENT} role tiers before any grant takes
effect, where the ADMIN tier is {ADMIN_ROLE, DEFAULT_ADMIN_ROLE}
(audit 2026-06-09, L-14). Reverts on any cross-tier overlap;
ADMIN_ROLE and DEFAULT_ADMIN_ROLE may coexist on one account.


```solidity
function _grantRole(bytes32 role, address account) internal virtual override returns (bool);
```

### _isAdminTier

True when `account` holds either admin-tier role.


```solidity
function _isAdminTier(address account) internal view returns (bool);
```

### _assertRoleSeparation

Post-grant invariant check. Reverts if `account` holds roles
from any two of the {ADMIN-tier, PAUSER, AGENT} tiers
simultaneously (ADMIN_ROLE + DEFAULT_ADMIN_ROLE together count
as one tier). Intended for deploy scripts and the gateway's
`authorizeAgent` to assert state explicitly.


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

