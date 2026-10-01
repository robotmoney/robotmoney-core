// SPDX-License-Identifier: MIT
// Canonical: docs/operations/contract-release-runbooks.md §4.2 item 4 — Network identity
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";

/// @title ExpectedChainGuard
/// @notice Shared chain-identity check for the broadcasting deploy scripts.
/// @dev The release policy says every broadcasting script verifies the chain id
///      itself, but `forge script --chain <id>` does not refuse an RPC that
///      serves a different chain (tested against a chain-31337 node: it ran and
///      only stopped because USDC had no code there). A ceremony therefore sets
///      `EXPECTED_CHAIN_ID` (8453 on Base mainnet) and every script refuses to
///      run anywhere else. Unset or 0 means "no check", which keeps devnets and
///      forge tests working without configuration. Found by the devops mainnet
///      runbook review (2026-09-30, B6).
abstract contract ExpectedChainGuard is Script {
    /// @dev Reverts unless `<prefix>EXPECTED_CHAIN_ID` is unset/0 or equals
    ///      `block.chainid`. `prefix` is "" in production; tests pass their own
    ///      prefix because env vars are process-wide and forge runs tests in parallel.
    function _requireExpectedChain(string memory prefix) internal view {
        uint256 expected = vm.envOr(string.concat(prefix, "EXPECTED_CHAIN_ID"), uint256(0));
        require(
            expected == 0 || block.chainid == expected,
            "EXPECTED_CHAIN_ID does not match the RPC's chain id"
        );
    }
}
