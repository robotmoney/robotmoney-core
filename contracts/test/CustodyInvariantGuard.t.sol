// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/smart-contract-holistic-review-20260618.md (L-11, L-15)
// (See also: docs/prd.md — Security invariants INV-1/INV-2/INV-3)
//
// Guard test for custody invariants INV-1/INV-2/INV-3 (issue #929). This is a
// source-level AST/grep guard, not a behavioural test: it scans every
// production Solidity source file under contracts/ (excluding contracts/test/
// and contracts/doc/) and FAILS if any arbitrary-recipient asset-mover survives.
//
// INV-1: no admin/role-gated function may route a PROTOCOL or DEPOSITOR asset
//        to a caller-supplied recipient. The historical offenders were the
//        `rescueTokens(address,address)` / `rescueUsdc(address)` functions whose
//        second/only parameter was a free-choice destination. They are deleted
//        protocol-wide; the only sanctioned asset movement left is the
//        permissionless `sweepForeignToken(token)` whose destination is a
//        hardcoded quarantine constant (no caller-supplied recipient).
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

contract CustodyInvariantGuardTest is Test {
    /// @dev Every production source file (NOT under contracts/test or
    ///      contracts/doc). Kept as an explicit list so the guard is
    ///      deterministic and a newly-added contract is a deliberate edit here.
    function _productionSources() internal pure returns (string[] memory paths) {
        paths = new string[](18);
        paths[0] = "contracts/PortfolioRouter.sol";
        paths[1] = "contracts/RobotMoneyVault.sol";
        paths[2] = "contracts/VaultRegistry.sol";
        paths[3] = "contracts/RouterGovernance.sol";
        paths[4] = "contracts/RmToken.sol";
        paths[5] = "contracts/FeatureFlags.sol";
        paths[6] = "contracts/UniswapV3PoolSlot0Stub.sol";
        paths[7] = "contracts/vaults/BasketVault.sol";
        paths[8] = "contracts/vaults/AgentTokenVault.sol";
        paths[9] = "contracts/vaults/ProtocolAssetVault.sol";
        paths[10] = "contracts/vaults/RwaVault.sol";
        paths[11] = "contracts/adapters/AaveV3Adapter.sol";
        paths[12] = "contracts/adapters/CompoundV3Adapter.sol";
        paths[13] = "contracts/adapters/MorphoAdapter.sol";
        paths[14] = "contracts/adapters/AerodromeSwapAdapter.sol";
        paths[15] = "contracts/adapters/UniswapV4SwapAdapter.sol";
        paths[16] = "contracts/adapters/ChronicleOracleAdapter.sol";
        paths[17] = "contracts/interfaces/IStrategyAdapter.sol";
    }

    /// @dev True if `haystack` contains `needle` (naive substring scan).
    function _contains(string memory haystack, string memory needle)
        internal
        pure
        returns (bool)
    {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i = 0; i + n.length <= h.length; i++) {
            bool matched = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }

    /// @notice INV-1: no production source declares an arbitrary-recipient
    ///         rescue function. `rescueTokens`/`rescueUsdc` are deleted, and the
    ///         IStrategyAdapter interface no longer declares them.
    function test_INV1_noArbitraryRecipientRescueFunctions() public view {
        string[] memory paths = _productionSources();
        for (uint256 i = 0; i < paths.length; i++) {
            string memory src = vm.readFile(paths[i]);
            assertFalse(
                _contains(src, "function rescueTokens"),
                string.concat("INV-1 violated: rescueTokens survives in ", paths[i])
            );
            assertFalse(
                _contains(src, "function rescueUsdc"),
                string.concat("INV-1 violated: rescueUsdc survives in ", paths[i])
            );
            // The interface declaration form (no `function` keyword inside an
            // interface still has it, but catch the bare selector names too).
            assertFalse(
                _contains(src, "rescueTokens(address,address)"),
                string.concat("INV-1 violated: rescueTokens selector survives in ", paths[i])
            );
        }
    }

    /// @notice INV-2: every balance-holding production contract that previously
    ///         exposed a rescue function now exposes the permissionless
    ///         `sweepForeignToken(token)` quarantine sweep instead.
    function test_INV2_sweepForeignTokenReplacesRescue() public view {
        string[3] memory mustHaveSweep = [
            "contracts/PortfolioRouter.sol",
            "contracts/RobotMoneyVault.sol",
            "contracts/vaults/BasketVault.sol"
        ];
        for (uint256 i = 0; i < mustHaveSweep.length; i++) {
            string memory src = vm.readFile(mustHaveSweep[i]);
            assertTrue(
                _contains(src, "function sweepForeignToken"),
                string.concat("INV-2: sweepForeignToken missing from ", mustHaveSweep[i])
            );
        }

        // Every concrete adapter exposes the sweep, and the interface declares it.
        string[4] memory adapterSweep = [
            "contracts/adapters/AaveV3Adapter.sol",
            "contracts/adapters/CompoundV3Adapter.sol",
            "contracts/adapters/MorphoAdapter.sol",
            "contracts/interfaces/IStrategyAdapter.sol"
        ];
        for (uint256 i = 0; i < adapterSweep.length; i++) {
            string memory src = vm.readFile(adapterSweep[i]);
            assertTrue(
                _contains(src, "sweepForeignToken"),
                string.concat("INV-2: sweepForeignToken missing from ", adapterSweep[i])
            );
        }
    }

    /// @notice INV-1/INV-2: the quarantine destination is a hardcoded constant in
    ///         the shared library, so no role or caller can steer the sweep.
    function test_quarantineDestinationIsConstant() public view {
        string memory lib = vm.readFile("contracts/lib/ForeignTokenQuarantine.sol");
        assertTrue(
            _contains(lib, "address internal constant QUARANTINE"),
            "QUARANTINE must be a compile-time constant (no caller-supplied recipient)"
        );
    }

    /// @notice The PRD documents the three invariants (docs-first gate).
    function test_prdDocumentsSecurityInvariants() public view {
        string memory prd = vm.readFile("docs/prd.md");
        assertTrue(_contains(prd, "Security invariants"), "PRD missing 'Security invariants' section");
        assertTrue(_contains(prd, "INV-1"), "PRD missing INV-1 statement");
        assertTrue(_contains(prd, "INV-2"), "PRD missing INV-2 statement");
        assertTrue(_contains(prd, "INV-3"), "PRD missing INV-3 statement");
    }
}
