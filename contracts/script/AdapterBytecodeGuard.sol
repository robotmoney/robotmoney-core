// SPDX-License-Identifier: MIT
// Canonical: docs/security-model.md §2 — "Delegatecall to attacker-controlled target"
//            and the adapter-allowlist no-proxy invariant for approved adapters.
// Issue: #448 — guard RobotMoneyVault adapter codehash check against
//                delegatecall-proxy adapters.
pragma solidity ^0.8.24;

/// @title AdapterBytecodeGuard
/// @notice Deploy-time / test-time invariant that approved RobotMoneyVault
///         strategy adapters are direct deployments whose runtime bytecode
///         contains no `DELEGATECALL` opcode.
/// @dev    Motivation: `RobotMoneyVault._requireAdapterEligible` pins an
///         adapter's *bytecode codehash* in the allowlist. If a future adapter
///         were deployed behind a minimal delegatecall proxy, the pinned hash
///         would cover the proxy bytecode only and the implementation could
///         be hot-swapped without violating the allowlist. The current
///         production set (Aave V3, Compound V3, Morpho, Passthrough) is
///         direct-deployed and has no `DELEGATECALL` in its runtime bytecode.
///         This guard enforces that invariant on every adapter the deploy
///         script approves, and is exercised by a contrived-proxy regression
///         test (`AdapterDelegatecallGuard.t.sol`).
///
///         The scan is opcode-aware: PUSH1..PUSH32 immediate data is skipped
///         so a `0xF4` byte embedded in a constant cannot trigger a false
///         positive. EOF / Cancun introduce no new variants that affect this
///         check (existing `DELEGATECALL` opcode == `0xF4`).
library AdapterBytecodeGuard {
    /// @dev EVM opcode for `DELEGATECALL`.
    uint8 internal constant OP_DELEGATECALL = 0xF4;
    /// @dev First PUSH opcode (`PUSH1`).
    uint8 internal constant OP_PUSH1 = 0x60;
    /// @dev Last PUSH opcode (`PUSH32`).
    uint8 internal constant OP_PUSH32 = 0x7F;

    /// @notice Thrown when an approved adapter's runtime bytecode contains
    ///         the `DELEGATECALL` opcode, which would let the allowlist be
    ///         bypassed by hot-swapping a proxy's implementation.
    /// @param adapter   The adapter address that failed the scan.
    /// @param position  Byte index of the `0xF4` opcode in the runtime bytecode.
    error AdapterContainsDelegatecall(address adapter, uint256 position);

    /// @notice Returns true if `code` contains the `DELEGATECALL` opcode
    ///         outside of PUSH immediate data and outside the trailing
    ///         Solidity CBOR metadata blob.
    /// @param code Runtime bytecode of the candidate adapter.
    function containsDelegatecall(bytes memory code) internal pure returns (bool) {
        (bool found,) = _scan(code);
        return found;
    }

    /// @notice Reverts with `AdapterContainsDelegatecall` if `adapter`'s
    ///         runtime bytecode contains a `DELEGATECALL` opcode.
    /// @param adapter Address of the contract to scan.
    function requireNoDelegatecall(address adapter) internal view {
        bytes memory code = adapter.code;
        (bool found, uint256 position) = _scan(code);
        if (found) revert AdapterContainsDelegatecall(adapter, position);
    }

    /// @dev Opcode-aware linear scan of `code` with Solidity metadata
    ///      stripping. Returns `(true, i)` for the first `DELEGATECALL`
    ///      opcode found outside PUSH immediate data.
    ///
    ///      Solidity appends a CBOR metadata blob to the runtime bytecode
    ///      followed by a 2-byte big-endian length. Those bytes are not
    ///      executable code and may contain arbitrary IPFS / solc hash
    ///      bytes including `0xF4`, so the scan must stop at the metadata
    ///      boundary to avoid false positives.
    function _scan(bytes memory code) private pure returns (bool, uint256) {
        uint256 len = _codeLengthWithoutMetadata(code);
        uint256 i = 0;
        while (i < len) {
            uint8 op = uint8(code[i]);
            if (op == OP_DELEGATECALL) {
                return (true, i);
            }
            if (op >= OP_PUSH1 && op <= OP_PUSH32) {
                // Skip the immediate bytes that follow a PUSHn instruction.
                // PUSHn consumes `op - 0x5F` (== n) immediate bytes.
                uint256 skip = uint256(op) - 0x5F;
                i += 1 + skip;
            } else {
                i += 1;
            }
        }
        return (false, 0);
    }

    /// @dev Returns the length of `code` with the trailing Solidity CBOR
    ///      metadata blob stripped. If the last two bytes do not encode a
    ///      plausible metadata length, the full length is returned.
    function _codeLengthWithoutMetadata(bytes memory code) private pure returns (uint256) {
        uint256 len = code.length;
        if (len < 2) return len;
        uint256 metaLen = (uint256(uint8(code[len - 2])) << 8) | uint256(uint8(code[len - 1]));
        // Metadata blob is `metaLen` bytes followed by the 2-byte length.
        // Reject implausible values (zero, or larger than the bytecode).
        if (metaLen == 0 || metaLen + 2 > len) return len;
        return len - metaLen - 2;
    }
}
