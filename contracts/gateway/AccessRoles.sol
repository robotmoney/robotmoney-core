// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title AccessRoles
/// @notice Role constants and AccessControl wiring for the RobotMoney gateway.
/// @dev Three roles, all distinct keys (see `docs/implementation-plan-mvp.md` §2.1):
///      - `ADMIN_ROLE`  — grants/revokes other roles, sets policy, unpauses.
///      - `PAUSER_ROLE` — `pause()` only. Asymmetric with unpause by design:
///        pausing is a stop-the-world tool that must be fast and unilateral
///        (one compromised PAUSER can only DoS, not steal); unpause is
///        deliberate and restricted to ADMIN.
///      - `AGENT_ROLE`  — only role allowed to call `deposit()`.
///
/// Invariant. An `AGENT_ROLE` holder must not also hold `ADMIN_ROLE` or
/// `PAUSER_ROLE`. Enforced by overriding `_grantRole` to revert on overlap,
/// and exposed via `_assertRoleSeparation` for use in deploy scripts and
/// the gateway's `authorizeAgent`.
abstract contract AccessRoles is AccessControl {
    /// @dev Reverts when granting a role would cause an account to hold
    ///      AGENT plus ADMIN or PAUSER (or vice versa).
    error RoleSeparationViolated();

    /// @notice Grants/revokes other roles, sets policy, unpauses.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice `pause()` only. Asymmetric with unpause by design.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Only role allowed to call `deposit()`.
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    /// @dev Override that enforces the AGENT-vs-{ADMIN,PAUSER} separation
    ///      invariant before any grant takes effect. Reverts on overlap.
    function _grantRole(bytes32 role, address account)
        internal
        virtual
        override
        returns (bool)
    {
        if (role == AGENT_ROLE) {
            if (hasRole(ADMIN_ROLE, account) || hasRole(PAUSER_ROLE, account)) {
                revert RoleSeparationViolated();
            }
        } else if (role == ADMIN_ROLE || role == PAUSER_ROLE) {
            if (hasRole(AGENT_ROLE, account)) {
                revert RoleSeparationViolated();
            }
        }
        return super._grantRole(role, account);
    }

    /// @dev Post-grant invariant check. Reverts if `account` violates
    ///      role separation. Intended for deploy scripts and the gateway's
    ///      `authorizeAgent` to assert state explicitly.
    function _assertRoleSeparation(address account) internal view {
        bool isAgent = hasRole(AGENT_ROLE, account);
        bool isPriv = hasRole(ADMIN_ROLE, account) || hasRole(PAUSER_ROLE, account);
        if (isAgent && isPriv) {
            revert RoleSeparationViolated();
        }
    }
}
