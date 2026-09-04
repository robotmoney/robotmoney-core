// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/20260618-code-review-internal-claude.md (L-10)
// (See also: docs/architecture.md §2.3 — Governance Boundary;
//            contracts/lib/AdminFloorAccessControl.sol — the
//            AccessControlEnumerable-based sibling used by
//            RouterGovernance/PortfolioRouter/VaultRegistry, where bytecode
//            size is not EIP-170-constrained. This contract exists because
//            that one is not usable here: AccessControlEnumerable's role
//            membership set pushes the EIP-170-tight vault family past the
//            24_576-byte runtime code-size cap.)
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title AdminFloorAccessControlCounter
/// @notice `AccessControl` with a "last-admin floor" — the final holder of the
///         contract's self-administered `ADMIN_ROLE` cannot be revoked or
///         renounced down to zero holders — enforced with a manual membership
///         counter instead of `AccessControlEnumerable`.
///
///         Single owner for the last-admin floor across the vault family
///         (`Vault`, `BasketVault` and its `RwaVault`/`AgentTokenVault`/
///         `ProtocolAssetVault` subclasses, and `RobotMoneyVault`), replacing
///         what were previously three independent hand-rolled counters (two
///         of them near-identical, one — RobotMoneyVault — missing the floor
///         entirely) (ACL-3 / F-06).
///
///         Finding L-10 (2026-06-18 holistic review): these contracts use a
///         single self-administered `ADMIN_ROLE` as their own role-admin. OZ's
///         `renounceRole`/`revokeRole` are public, so the sole admin dropping
///         itself would brick all configuration and governance forever. This
///         base forbids that one transition while leaving every other
///         role-management path (granting more admins first, then revoking the
///         old one; managing non-admin roles) unchanged.
///
///         Implementation: both `revokeRole` and `renounceRole` funnel through
///         the internal `_revokeRole` in OZ v5, so a single override here closes
///         both vectors. `_revokeRole` is invoked *before* the membership set is
///         mutated, so when an `ADMIN_ROLE` revoke is in flight the current
///         member count still includes the account being removed; a count of
///         exactly 1 therefore means this is the last admin.
abstract contract AdminFloorAccessControlCounter is AccessControl {
    /// @notice The role subject to the last-admin floor. Concrete contracts
    ///         declare their own public `ADMIN_ROLE` constant with the same
    ///         value; this internal mirror is what the floor checks against.
    bytes32 internal constant FLOOR_ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Number of accounts currently holding the floor-protected role.
    uint256 public adminCount;

    /// @notice Revoking the sole `ADMIN_ROLE` holder is forbidden — it would
    ///         leave the contract with zero admins and brick all admin paths.
    error LastAdminFloor();

    /// @inheritdoc AccessControl
    /// @dev Track `ADMIN_ROLE` membership so the last-admin floor can be
    ///      enforced without enumeration. Only increments on a real (new) grant.
    function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {
        bool granted = super._grantRole(role, account);
        if (granted && role == FLOOR_ADMIN_ROLE) adminCount++;
        return granted;
    }

    /// @inheritdoc AccessControl
    /// @dev Block revoking/renouncing the final `ADMIN_ROLE` holder (ACL-3 / F-06);
    ///      both public setters route through here. Decrements only on a real
    ///      (effective) revoke.
    function _revokeRole(bytes32 role, address account) internal virtual override returns (bool) {
        if (role == FLOOR_ADMIN_ROLE && hasRole(role, account) && adminCount == 1) {
            revert LastAdminFloor();
        }
        bool revoked = super._revokeRole(role, account);
        if (revoked && role == FLOOR_ADMIN_ROLE) adminCount--;
        return revoked;
    }
}
