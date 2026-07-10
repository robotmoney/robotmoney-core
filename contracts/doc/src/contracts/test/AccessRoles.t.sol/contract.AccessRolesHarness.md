# AccessRolesHarness
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3da70a180fe71635ce61a9d127b7f2d7f7b3cbf5/contracts/test/AccessRoles.t.sol)

**Inherits:**
[AccessRoles](/contracts/gateway/AccessRoles.sol/abstract.AccessRoles.md)

Concrete harness exposing AccessRoles internals for test purposes.


## Functions
### constructor


```solidity
constructor(address admin) ;
```

### exposed_assertRoleSeparation


```solidity
function exposed_assertRoleSeparation(address account) external view;
```

### unsafe_forgeRole

Test-only escape hatch that forges a role assignment without
going through the `_grantRole` override. Used to verify that
`_assertRoleSeparation` still catches an overlap that somehow
slipped past the grant-time check (defense-in-depth).
OZ AccessControl stores `mapping(bytes32 => RoleData) _roles`
at slot 0; `RoleData.hasRole[address]` lives at
`keccak256(account || keccak256(role || 0))`.


```solidity
function unsafe_forgeRole(bytes32 role, address account) external;
```

