// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
// Canonical: docs/operations/contract-release-runbooks.md — "The Safe's own timelock role" (owner question 1)
// Implements: issue #1645 (owner question 1, default (b)), issue #1447 — CS-3, the last proposer floor
// (See also: contracts/lib/AdminFloorAccessControlCounter.sol — the same counter floor on ADMIN_ROLE)
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title ProposerFloorTimelock
/// @notice OpenZeppelin `TimelockController` with a "last-proposer floor": the final
///         holder of `PROPOSER_ROLE` cannot be revoked or renounced down to zero
///         holders. Everything else is stock `TimelockController`.
///
///         `DeployTimelock` makes the Safe the only proposer, gives the timelock
///         `ADMIN_ROLE` on every governed contract and lets the timelock administer
///         its own roles (`admin = address(0)`). Stock OZ lets the Safe drop that one
///         proposer role in two ways: `revokeRole` as a timelock self-call after the
///         delay, or `renounceRole` in one instant Safe transaction. Either way no
///         account can ever schedule an operation again, so every `ADMIN_ROLE`
///         function on every governed contract is unreachable forever (withdrawals
///         survive: security-model §4). This contract forbids exactly that one
///         transition. Granting a second proposer first, then revoking the Safe, is
///         still allowed: the floor is on the count, not on the Safe.
///
///         Implementation: both `revokeRole` and `renounceRole` funnel through the
///         internal `_revokeRole` in OZ v5, so a single override closes both
///         vectors. `_revokeRole` runs *before* the membership is mutated, so when a
///         `PROPOSER_ROLE` revoke is in flight the counter still includes the account
///         being removed; a count of exactly 1 therefore means this is the last
///         proposer. The counter is kept by hand (the way
///         `AdminFloorAccessControlCounter` does for `ADMIN_ROLE`) because
///         `TimelockController` is `AccessControl`, not `AccessControlEnumerable`.
///         The constructor's grants to `proposers` go through the same override,
///         so the count is right from birth. `proposerCount()` is what the govern
///         tool reads before it builds `timelock-revoke-role PROPOSER_ROLE`.
contract ProposerFloorTimelock is TimelockController {
    /// @notice Number of accounts currently holding `PROPOSER_ROLE`.
    /// @dev No initializer on purpose: a derived-contract initializer would run
    ///      after the `TimelockController` constructor and reset the count.
    uint256 public proposerCount;

    /// @notice Revoking or renouncing the sole `PROPOSER_ROLE` holder is forbidden:
    ///         nothing could ever be scheduled again.
    error LastProposerFloor();

    /// @notice A timelock born with no proposer could never schedule anything.
    error NoProposer();

    /// @param minDelay Initial minimum delay in seconds for operations.
    /// @param proposers Accounts granted `PROPOSER_ROLE` and `CANCELLER_ROLE`; at least one.
    /// @param executors Accounts granted `EXECUTOR_ROLE` (`address(0)` opens it).
    /// @param admin Optional account granted `DEFAULT_ADMIN_ROLE`; `address(0)` for self-administration.
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {
        if (proposerCount == 0) revert NoProposer();
    }

    /// @inheritdoc AccessControl
    /// @dev Track `PROPOSER_ROLE` membership so the floor can be enforced without
    ///      enumeration. Only increments on a real (new) grant.
    function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {
        bool granted = super._grantRole(role, account);
        if (granted && role == PROPOSER_ROLE) proposerCount++;
        return granted;
    }

    /// @inheritdoc AccessControl
    /// @dev Reverts when the revoke would remove the final `PROPOSER_ROLE` holder.
    ///      Covers both `revokeRole` and `renounceRole`, which both route here.
    ///      Decrements only on a real (effective) revoke.
    function _revokeRole(bytes32 role, address account) internal virtual override returns (bool) {
        if (role == PROPOSER_ROLE && proposerCount == 1 && hasRole(role, account)) {
            revert LastProposerFloor();
        }
        bool revoked = super._revokeRole(role, account);
        if (revoked && role == PROPOSER_ROLE) proposerCount--;
        return revoked;
    }
}
