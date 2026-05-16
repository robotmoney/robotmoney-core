// SPDX-License-Identifier: MIT
// Canonical: config/feature-flags.json — cross-system feature flag registry.
// Implements: issue #389 — Forge unit tests for contracts/FeatureFlags.sol.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeatureFlags} from "../FeatureFlags.sol";

contract FeatureFlagsTest is Test {
    // -------------------------------------------------------------------------
    // isEnabled
    // -------------------------------------------------------------------------

    function test_isEnabled_flagZero() public pure {
        // bitmap = 0b001 → flag 0 on, flags 1 and 2 off.
        uint256 bitmap = FeatureFlags.set(FeatureFlags.MULTI_VAULT_ENABLED, 0);
        assertTrue(FeatureFlags.isEnabled(FeatureFlags.MULTI_VAULT_ENABLED, bitmap));
        assertFalse(FeatureFlags.isEnabled(FeatureFlags.PORTFOLIO_ROUTER_ENABLED, bitmap));
        assertFalse(FeatureFlags.isEnabled(FeatureFlags.INDEXER_MULTI_VAULT_EVENTS, bitmap));
    }

    function test_isEnabled_flagOne() public pure {
        // bitmap = 0b010 → flag 1 on only.
        uint256 bitmap = FeatureFlags.set(FeatureFlags.PORTFOLIO_ROUTER_ENABLED, 0);
        assertFalse(FeatureFlags.isEnabled(FeatureFlags.MULTI_VAULT_ENABLED, bitmap));
        assertTrue(FeatureFlags.isEnabled(FeatureFlags.PORTFOLIO_ROUTER_ENABLED, bitmap));
        assertFalse(FeatureFlags.isEnabled(FeatureFlags.INDEXER_MULTI_VAULT_EVENTS, bitmap));
    }

    function test_isEnabled_flagTwo() public pure {
        // bitmap = 0b100 → flag 2 on only.
        uint256 bitmap = FeatureFlags.set(FeatureFlags.INDEXER_MULTI_VAULT_EVENTS, 0);
        assertFalse(FeatureFlags.isEnabled(FeatureFlags.MULTI_VAULT_ENABLED, bitmap));
        assertFalse(FeatureFlags.isEnabled(FeatureFlags.PORTFOLIO_ROUTER_ENABLED, bitmap));
        assertTrue(FeatureFlags.isEnabled(FeatureFlags.INDEXER_MULTI_VAULT_EVENTS, bitmap));
    }

    function test_isEnabled_allFlagsOn() public pure {
        // Enable all three known flags.
        uint256 bitmap = 0;
        bitmap = FeatureFlags.set(FeatureFlags.MULTI_VAULT_ENABLED, bitmap);
        bitmap = FeatureFlags.set(FeatureFlags.PORTFOLIO_ROUTER_ENABLED, bitmap);
        bitmap = FeatureFlags.set(FeatureFlags.INDEXER_MULTI_VAULT_EVENTS, bitmap);

        assertTrue(FeatureFlags.isEnabled(FeatureFlags.MULTI_VAULT_ENABLED, bitmap));
        assertTrue(FeatureFlags.isEnabled(FeatureFlags.PORTFOLIO_ROUTER_ENABLED, bitmap));
        assertTrue(FeatureFlags.isEnabled(FeatureFlags.INDEXER_MULTI_VAULT_EVENTS, bitmap));
    }

    function test_isEnabled_emptyBitmap() public pure {
        assertFalse(FeatureFlags.isEnabled(FeatureFlags.MULTI_VAULT_ENABLED, 0));
        assertFalse(FeatureFlags.isEnabled(FeatureFlags.PORTFOLIO_ROUTER_ENABLED, 0));
        assertFalse(FeatureFlags.isEnabled(FeatureFlags.INDEXER_MULTI_VAULT_EVENTS, 0));
    }

    // -------------------------------------------------------------------------
    // set / clear round-trips
    // -------------------------------------------------------------------------

    function test_set_and_clear_roundtrip() public pure {
        uint256 bitmap = 0;
        bitmap = FeatureFlags.set(FeatureFlags.MULTI_VAULT_ENABLED, bitmap);
        assertTrue(FeatureFlags.isEnabled(FeatureFlags.MULTI_VAULT_ENABLED, bitmap));

        bitmap = FeatureFlags.clear(FeatureFlags.MULTI_VAULT_ENABLED, bitmap);
        assertFalse(FeatureFlags.isEnabled(FeatureFlags.MULTI_VAULT_ENABLED, bitmap));
    }

    function test_clear_doesNotAffectOtherFlags() public pure {
        uint256 bitmap = 0;
        bitmap = FeatureFlags.set(FeatureFlags.MULTI_VAULT_ENABLED, bitmap);
        bitmap = FeatureFlags.set(FeatureFlags.PORTFOLIO_ROUTER_ENABLED, bitmap);

        bitmap = FeatureFlags.clear(FeatureFlags.MULTI_VAULT_ENABLED, bitmap);

        assertFalse(FeatureFlags.isEnabled(FeatureFlags.MULTI_VAULT_ENABLED, bitmap));
        assertTrue(FeatureFlags.isEnabled(FeatureFlags.PORTFOLIO_ROUTER_ENABLED, bitmap));
    }

    // -------------------------------------------------------------------------
    // Fuzz: isEnabled only reads the correct bit
    // -------------------------------------------------------------------------

    /// @dev Any bitmap with bit 0 set must report MULTI_VAULT_ENABLED as true,
    ///      regardless of the other bits.
    function testFuzz_isEnabled_bit0(uint256 bitmap) public pure {
        bitmap = bitmap | 1; // force bit 0 on
        assertTrue(FeatureFlags.isEnabled(FeatureFlags.MULTI_VAULT_ENABLED, bitmap));
    }

    function testFuzz_isEnabled_bit0Off(uint256 bitmap) public pure {
        bitmap = bitmap & ~uint256(1); // force bit 0 off
        assertFalse(FeatureFlags.isEnabled(FeatureFlags.MULTI_VAULT_ENABLED, bitmap));
    }

    // -------------------------------------------------------------------------
    // ID constants match registry (values pinned against config/feature-flags.json)
    // -------------------------------------------------------------------------

    function test_flagIdConstants() public pure {
        assertEq(FeatureFlags.MULTI_VAULT_ENABLED, 0);
        assertEq(FeatureFlags.PORTFOLIO_ROUTER_ENABLED, 1);
        assertEq(FeatureFlags.INDEXER_MULTI_VAULT_EVENTS, 2);
    }
}
