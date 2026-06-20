// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (ACL-1, ORA-3, ORA-6)
//            docs/code-review/external-audit-verification-20260619.md (F-01, F-09, F-17)
//
// POST-DEPLOY ASSERTION HARNESS (issue #964, AC4 — SCOUT STUB)
// ───────────────────────────────────────────────────────────────────────────────
// Deploy-assertion / static-guard checks for three configuration invariants the
// spec calls out for a post-deploy state check:
//
//   - ACL-1 (RED, F-01): after handover NO EOA holds ANY privileged role
//     (DEFAULT_ADMIN_ROLE, ADMIN_ROLE, EMERGENCY_ROLE, PAUSER_ROLE). Today the
//     deployer EOA keeps the Gateway DEFAULT_ADMIN_ROLE and every vault
//     EMERGENCY_ROLE; DeployTimelock.t.sol only asserts ADMIN_ROLE is clear. The
//     #965 fix completes the handover AND broadens the assertion — this is where
//     the broadened assertion will live (or be folded into DeployTimelock.t.sol).
//
//   - ORA-3 (RED, F-09): the pricing-TWAP pool == the execution pool
//     (fee/tickSpacing/hooks). BasketVault.addAsset stores `pool` and `swapFee`
//     independently and never asserts they resolve to one pool. The #966 fix adds
//     the equality check in addAsset; this asserts addAsset reverts on mismatch.
//
//   - ORA-6 (HOLDS — 🟡 TRUSTED, F-17): the decimals scaling between a priced
//     asset and USDC is correct for the asset actually configured. Today the
//     ChronicleOracleAdapter hardcodes 1e12 = 10^(18-6), correct only while
//     deSPXA == 18 decimals and USDC == 6. The constructor SHOULD assert
//     decimals()==18 && usdc.decimals()==6. This is a passing static-guard that
//     documents the current trust assumption (the 1e12 constant) and is the seam
//     where the dynamic decimals() read would be asserted.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

contract DeployAssertionsTest is Test {
    /// @dev Naive substring scan (same pattern as CustodyInvariantGuard.t.sol).
    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
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

    /// @notice ACL-1 (RED, F-01): after deployment handover, no EOA holds any
    ///         privileged role. On current HEAD the deployer EOA keeps Gateway
    ///         DEFAULT_ADMIN_ROLE + every vault EMERGENCY_ROLE, and the deploy
    ///         script only revokes ADMIN_ROLE. When #965 completes the handover,
    ///         remove the skip and assert the EOA holds none of
    ///         {DEFAULT_ADMIN_ROLE, ADMIN_ROLE, EMERGENCY_ROLE, PAUSER_ROLE} on
    ///         the gateway and every vault.
    function test_ACL1_eoaHoldsNoPrivilegedRoleAfterHandover() public {
        vm.skip(
            true,
            "deployer EOA retains Gateway DEFAULT_ADMIN_ROLE + vault EMERGENCY_ROLE; handover moves only ADMIN_ROLE (F-01) - remediation #965"
        );
        fail();
    }

    /// @notice ORA-3 (RED, F-09): BasketVault.addAsset reverts when the configured
    ///         execution pool (derived from swapFee) does not equal the TWAP
    ///         pricing pool. On current HEAD addAsset performs NO such equality
    ///         check. When #966 adds it, remove the skip and assert addAsset
    ///         reverts on a pool/fee mismatch.
    function test_ORA3_addAssetRevertsOnPoolMismatch() public {
        vm.skip(
            true,
            "BasketVault.addAsset stores pool and swapFee independently, never asserts equality (F-09) - remediation #966"
        );
        fail();
    }

    /// @notice ORA-6 (HOLDS — 🟡 TRUSTED, F-17): documents the current decimals
    ///         trust assumption. The ChronicleOracleAdapter hardcodes the
    ///         1e12 = 10^(18-6) scale, correct only while the priced asset is
    ///         18-dec and USDC is 6-dec. This passing static-guard pins that the
    ///         hardcoded constant is still present (so a silent decimals change is
    ///         caught) and marks the seam where #966 would add the dynamic
    ///         `decimals()==18 && usdc.decimals()==6` constructor assertion.
    function test_ORA6_chronicleAdapterDecimalsAssumptionIsDocumented() public view {
        string memory src = vm.readFile("contracts/adapters/ChronicleOracleAdapter.sol");
        // The 18→6 decimals scale is currently hardcoded (1e12). This guard makes
        // any change to that scaling a deliberate, reviewed edit — and is the
        // anchor for ORA-6's eventual dynamic decimals() assertion.
        assertTrue(
            _contains(src, "1e12"),
            "ORA-6: ChronicleOracleAdapter 18->6 decimals scale (1e12) missing - re-verify F-17 assumption"
        );
    }
}
