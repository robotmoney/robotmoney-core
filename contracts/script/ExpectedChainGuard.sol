// SPDX-License-Identifier: MIT
// Canonical: docs/operations/contract-release-runbooks.md §4.2 item 4 — Network identity
// Implements: robotmoney-core S1 (one deployment scheme): floors keyed to chain id 8453
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

/// @title ExpectedChainGuard
/// @notice Shared chain-identity check and strict env readers for every deploy script.
/// @dev One deployment scheme: the scripts are the same on every chain. The only
///      difference is a `require` that is keyed to chain id 8453 (Base mainnet).
///      On 8453 `EXPECTED_CHAIN_ID` must be set to 8453: an unset value no longer
///      disables the check. On any other chain an unset or 0 value means "no check"
///      (the Twin chain 918453, anvil and forge tests); a set value must still match.
///      No flag, env switch or sheet line lifts a floor on 8453.
abstract contract ExpectedChainGuard is Script {
    /// @dev Base mainnet chain id. Every floor in the scripts keys off this value.
    uint256 internal constant BASE_MAINNET_CHAIN_ID = 8453;

    /// @dev Canonical Base USDC (FiatTokenProxy). A constant on every chain: the Twin
    ///      chain carries real USDC from its Base snapshot, and a mock token fails the
    ///      code-hash check. No script reads a USDC address from the environment.
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @dev Reverts unless `<prefix>EXPECTED_CHAIN_ID` matches `block.chainid`.
    ///      On chain id 8453 the variable is mandatory and must equal 8453.
    ///      `prefix` is "" in production; tests pass their own prefix because env vars
    ///      are process-wide and forge runs tests in parallel.
    function _requireExpectedChain(string memory prefix) internal view {
        string memory key = string.concat(prefix, "EXPECTED_CHAIN_ID");
        uint256 expected = vm.envOr(key, uint256(0));
        if (block.chainid == BASE_MAINNET_CHAIN_ID) {
            require(
                expected == BASE_MAINNET_CHAIN_ID,
                "EXPECTED_CHAIN_ID must be set to 8453 on Base mainnet"
            );
        }
        require(
            expected == 0 || block.chainid == expected,
            "EXPECTED_CHAIN_ID does not match the RPC's chain id"
        );
    }

    // ─── Strict env readers: unset or malformed input reverts, never defaults ───

    /// @dev A required unsigned integer. Reverts when unset or malformed.
    function _envUintRequired(string memory key) internal view returns (uint256) {
        require(vm.envExists(key), string.concat(key, " must be set"));
        try vm.envUint(key) returns (uint256 v) {
            return v;
        } catch {
            revert(string.concat(key, " is malformed: expected an unsigned integer"));
        }
    }

    /// @dev A required address. Reverts when unset or malformed. Zero is allowed
    ///      here: each script adds its own named non-zero check.
    function _envAddressRequired(string memory key) internal view returns (address) {
        require(vm.envExists(key), string.concat(key, " must be set"));
        try vm.envAddress(key) returns (address v) {
            return v;
        } catch {
            revert(string.concat(key, " is malformed: expected an address"));
        }
    }

    /// @dev A required non-empty string. Reverts when unset or empty.
    function _envStringRequired(string memory key) internal view returns (string memory v) {
        require(vm.envExists(key), string.concat(key, " must be set"));
        try vm.envString(key) returns (string memory s) {
            v = s;
        } catch {
            revert(string.concat(key, " is malformed: expected a string"));
        }
        require(bytes(v).length != 0, string.concat(key, " is empty"));
    }

    /// @dev A required uint64. Reverts when unset, malformed or above uint64 max.
    function _envUint64Required(string memory key) internal view returns (uint64) {
        uint256 v = _envUintRequired(key);
        require(v <= type(uint64).max, string.concat(key, " exceeds uint64"));
        return uint64(v);
    }
}
