# AdminFloorAccessControl
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/c9e141ffcd1c066f8ea8438f58e57b245c4556f8/contracts/lib/AdminFloorAccessControl.sol)

**Inherits:**
AccessControlEnumerable

**Title:**
AdminFloorAccessControl

`AccessControlEnumerable` with a "last-admin floor": the final
holder of the contract's self-administered `ADMIN_ROLE` cannot be
revoked or renounced down to zero holders.
Finding L-10 (2026-06-18 holistic review): these contracts use a
single self-administered `ADMIN_ROLE` as their own role-admin. OZ's
`renounceRole`/`revokeRole` are public, so the sole admin dropping
itself would brick all configuration and governance forever. This
base forbids that one transition while leaving every other
role-management path (granting more admins first, then revoking the
old one; managing non-admin roles) unchanged.
Implementation: both `revokeRole` and `renounceRole` funnel through
the internal `_revokeRole` in OZ v5, so a single override here closes
both vectors. `_revokeRole` is invoked *before* the membership set is
mutated, so when an `ADMIN_ROLE` revoke is in flight the current
member count still includes the account being removed; a count of
exactly 1 therefore means this is the last admin.


## Constants
### FLOOR_ADMIN_ROLE
The role subject to the last-admin floor. Concrete contracts
declare their own public `ADMIN_ROLE` constant with the same
value; this internal mirror is what the floor checks against.


```solidity
bytes32 internal constant FLOOR_ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


## Functions
### _revokeRole

Reverts when the revoke would remove the final `ADMIN_ROLE` holder.
Covers both `revokeRole` and `renounceRole`, which both route here.


```solidity
function _revokeRole(bytes32 role, address account) internal virtual override returns (bool);
```

## Errors
### LastAdminFloor
Revoking the sole `ADMIN_ROLE` holder is forbidden — it would
leave the contract with zero admins and brick all admin paths.


```solidity
error LastAdminFloor();
```

