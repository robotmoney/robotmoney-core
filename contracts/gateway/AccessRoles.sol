// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §6 — Roles
// (See also: docs/implementation-plan.md §3.1 — AccessRoles.sol)
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title AccessRoles
/// @notice Role constants and AccessControl wiring for the RobotMoney gateway.
/// @dev Three roles, all distinct keys (see `docs/implementation-plan.md` §2.1):
///      - `ADMIN_ROLE`  — grants/revokes other roles, sets policy, unpauses.
///      - `PAUSER_ROLE` — `pause()` only. Asymmetric with unpause by design:
///        pausing is a stop-the-world tool that must be fast and unilateral
///        (one compromised PAUSER can only DoS, not steal); unpause is
///        deliberate and restricted to ADMIN.
///      - `AGENT_ROLE`  — only role allowed to call `deposit()`.
///
/// Invariant. The three privileged roles `ADMIN_ROLE`, `PAUSER_ROLE`,
/// and `AGENT_ROLE` are pairwise disjoint — no account may hold any
/// two of them simultaneously. Pause is intentionally siloed from
/// admin so that a compromised pauser key cannot also grant or revoke
/// roles, and an admin compromise cannot also rapid-DoS the gateway.
/// Enforced by overriding `_grantRole` to revert on any overlap, and
/// exposed via `_assertRoleSeparation` for use in deploy scripts and
/// the gateway's `authorizeAgent`.
///
/// `DEFAULT_ADMIN_ROLE` is treated as part of the ADMIN tier
/// (audit 2026-06-09, L-14): it may coexist with `ADMIN_ROLE` (the gateway
/// constructor grants both to the same admin address), but never with
/// `PAUSER_ROLE` or `AGENT_ROLE`. Without this, a `DEFAULT_ADMIN_ROLE`
/// holder could renounce `ADMIN_ROLE` and then self-grant `AGENT_ROLE`,
/// silently bypassing the disjointness invariant.
abstract contract AccessRoles is AccessControl {
    /// @notice Reverts when granting a role would cause an account to hold
    ///         any two of {ADMIN, PAUSER, AGENT} simultaneously.
    error RoleSeparationViolated();

    /// @notice Grants/revokes other roles, sets policy, unpauses.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice `pause()` only. Asymmetric with unpause by design.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Only role allowed to call `deposit()`.
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    /// @dev Override that enforces full pairwise separation among the
    ///      {ADMIN-tier, PAUSER, AGENT} role tiers before any grant takes
    ///      effect, where the ADMIN tier is {ADMIN_ROLE, DEFAULT_ADMIN_ROLE}
    ///      (audit 2026-06-09, L-14). Reverts on any cross-tier overlap;
    ///      ADMIN_ROLE and DEFAULT_ADMIN_ROLE may coexist on one account.
    function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {
        if (role == AGENT_ROLE) {
            if (_isAdminTier(account) || hasRole(PAUSER_ROLE, account)) {
                revert RoleSeparationViolated();
            }
        } else if (role == ADMIN_ROLE || role == DEFAULT_ADMIN_ROLE) {
            if (hasRole(AGENT_ROLE, account) || hasRole(PAUSER_ROLE, account)) {
                revert RoleSeparationViolated();
            }
        } else if (role == PAUSER_ROLE) {
            if (hasRole(AGENT_ROLE, account) || _isAdminTier(account)) {
                revert RoleSeparationViolated();
            }
        }
        return super._grantRole(role, account);
    }

    /// @dev True when `account` holds either admin-tier role.
    function _isAdminTier(address account) internal view returns (bool) {
        return hasRole(ADMIN_ROLE, account) || hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    /// @dev Post-grant invariant check. Reverts if `account` holds roles
    ///      from any two of the {ADMIN-tier, PAUSER, AGENT} tiers
    ///      simultaneously (ADMIN_ROLE + DEFAULT_ADMIN_ROLE together count
    ///      as one tier). Intended for deploy scripts and the gateway's
    ///      `authorizeAgent` to assert state explicitly.
    function _assertRoleSeparation(address account) internal view {
        bool isAdmin = _isAdminTier(account);
        bool isPauser = hasRole(PAUSER_ROLE, account);
        bool isAgent = hasRole(AGENT_ROLE, account);
        // Pairwise disjointness: at most one of the three tiers may be held.
        uint256 count = (isAdmin ? 1 : 0) + (isPauser ? 1 : 0) + (isAgent ? 1 : 0);
        if (count > 1) {
            revert RoleSeparationViolated();
        }
    }
}
