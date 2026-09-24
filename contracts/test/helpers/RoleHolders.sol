// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
// Implements: issue #1447 — after the handover the timelock is the only admin
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @title RoleHolders
/// @notice Lists who holds a role on a plain OpenZeppelin `AccessControl`
///         contract, from the `RoleGranted` / `RoleRevoked` logs a test recorded.
/// @dev The governed contracts are not `AccessControlEnumerable`, so a test
///      cannot ask them for their members. A `hasRole` check can only clear the
///      addresses the test thought to name, and an address nobody named (the
///      deploy script's own contract, say) passes unseen. OpenZeppelin emits
///      `RoleGranted` only when an account gains a role and `RoleRevoked` only
///      when it loses one, so replaying every such log from before the
///      contract's construction yields its exact current member set. Call
///      `vm.recordLogs()` before the contracts are built. TEST HELPER ONLY.
library RoleHolders {
    bytes32 internal constant ROLE_GRANTED = keccak256("RoleGranted(bytes32,address,address)");
    bytes32 internal constant ROLE_REVOKED = keccak256("RoleRevoked(bytes32,address,address)");

    /// @notice The accounts that hold `role` on `target` after replaying `logs`.
    function holders(Vm.Log[] memory logs, address target, bytes32 role)
        internal
        pure
        returns (address[] memory out)
    {
        address[] memory members = new address[](logs.length);
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter != target || l.topics.length != 4 || l.topics[1] != role) continue;
            address account = address(uint160(uint256(l.topics[2])));
            uint256 at = _indexOf(members, n, account);
            if (l.topics[0] == ROLE_GRANTED && at == n) {
                members[n++] = account;
            } else if (l.topics[0] == ROLE_REVOKED && at < n) {
                members[at] = members[--n];
            }
        }
        out = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = members[i];
        }
    }

    /// @notice True when `logs` show `account` losing `role` on `target`, which
    ///         proves it held the role before: OpenZeppelin emits RoleRevoked
    ///         only for an account that had the role.
    function wasRevoked(Vm.Log[] memory logs, address target, bytes32 role, address account)
        internal
        pure
        returns (bool)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (
                l.emitter == target && l.topics.length == 4 && l.topics[0] == ROLE_REVOKED
                    && l.topics[1] == role && address(uint160(uint256(l.topics[2]))) == account
            ) return true;
        }
        return false;
    }

    function _indexOf(address[] memory members, uint256 n, address account)
        private
        pure
        returns (uint256)
    {
        for (uint256 i = 0; i < n; i++) {
            if (members[i] == account) return i;
        }
        return n;
    }
}
