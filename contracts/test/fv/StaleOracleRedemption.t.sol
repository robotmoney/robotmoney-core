// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (SUP-5, ORA-2)
//            docs/code-review/external-audit-verification-20260619.md (NC-1, F-08)
//
// STALE-ORACLE REDEMPTION HARNESS (issue #964, AC4 — SCOUT STUB)
// ───────────────────────────────────────────────────────────────────────────────
// Pins two intertwined RWA-vault oracle properties:
//
//   - ORA-2 (HOLDS, fail-closed): a *price-sensitive* operation never executes
//     against a Chronicle feed older than the heartbeat. Today
//     RwaVault.totalAssets() → _checkOracleFreshness() reverts StalePriceFeed,
//     which correctly halts deposit/share-pricing when the feed is stale.
//
//   - SUP-5 (RED, NC-1): that same unconditional freshness check over-applies to
//     user `redeem` — it reverts even when the vault has already emergency-unwound
//     to idle USDC and holds zero priced RWA tokens, trapping already-safe funds
//     with no permissionless exit. The fix (remediation #966) must SHORT-CIRCUIT
//     freshness when no priced RWA is held, preserving ORA-2 for priced assets
//     while exempting idle-USDC redemption.
//
// SCOUT SCOPE: this file stands up the stale-feed handler shape — a mock Chronicle
// feed whose timestamp can be aged past the heartbeat — and two tests:
//   - test_ORA2_* (passing): documents the fail-closed property the fix must keep.
//   - test_SUP5_* (skipped/expected-fail): the NC-1 trap. Implementing it live
//     requires a faithful RwaVault deployment (swap router + Chronicle mock + a
//     seeded-then-unwound-to-idle state); that rig is built alongside the #966
//     freshness short-circuit. Until then the body is the expected-fail stub.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @dev Minimal Chronicle-feed mock: a settable latest-update timestamp so a test
///      can age the feed past any heartbeat. Mirrors the IChronicleOracle surface
///      RwaVault._checkOracleFreshness reads (`latestTimestamp()`).
contract MockChronicleFeed {
    uint256 public latestTimestamp;
    uint256 public latestValue;

    function set(uint256 value, uint256 updatedAt) external {
        latestValue = value;
        latestTimestamp = updatedAt;
    }

    /// @notice Age the feed so it is `staleness` seconds older than `now`.
    function age(uint256 staleness) external {
        latestTimestamp = block.timestamp > staleness ? block.timestamp - staleness : 0;
    }
}

contract StaleOracleRedemptionTest is Test {
    MockChronicleFeed internal feed;
    uint256 internal constant HEARTBEAT = 1 hours;

    function setUp() public {
        // Warp well past the heartbeat so a feed can be aged into the past without
        // underflowing to zero (forge's default block.timestamp is 1).
        vm.warp(365 days);
        feed = new MockChronicleFeed();
        feed.set(1e18, block.timestamp);
    }

    /// @notice ORA-2 (HOLDS): the freshness predicate the vault enforces — a feed
    ///         older than the heartbeat is stale (fail-closed). Asserts the mock's
    ///         staleness arithmetic so the SUP-5 harness builds on a verified
    ///         notion of "stale". The behavioural revert proof on a live RwaVault
    ///         lives in RwaVault.t.sol (deposit halts on stale feed).
    function test_ORA2_feedOlderThanHeartbeatIsStale() public {
        // Fresh: updatedAt == now → not stale.
        feed.set(1e18, block.timestamp);
        assertFalse(_isStale(feed.latestTimestamp(), HEARTBEAT), "fresh feed flagged stale");

        // Aged just past the heartbeat → stale.
        feed.age(HEARTBEAT + 1);
        assertTrue(_isStale(feed.latestTimestamp(), HEARTBEAT), "aged feed not flagged stale");
    }

    /// @notice SUP-5 (RED, NC-1): a user `redeem` succeeds when the vault holds
    ///         zero priced RWA tokens (already unwound to idle USDC), even while
    ///         the Chronicle feed is stale. On current HEAD redeem reverts
    ///         StalePriceFeed unconditionally, trapping safe funds. When #966 lands
    ///         the freshness short-circuit, remove the skip and assert the redeem
    ///         returns the holder's idle USDC.
    function test_SUP5_idleUsdcRedeemSurvivesStaleFeed() public {
        vm.skip(
            true,
            "RwaVault redeem reverts on stale feed even after unwind to idle USDC (NC-1) - remediation #966"
        );
        fail();
    }

    /// @dev Mirror of RwaVault._checkOracleFreshness's staleness condition:
    ///      `block.timestamp > updatedAt + heartbeat`.
    function _isStale(uint256 updatedAt, uint256 heartbeat) internal view returns (bool) {
        return block.timestamp > updatedAt + heartbeat;
    }
}
