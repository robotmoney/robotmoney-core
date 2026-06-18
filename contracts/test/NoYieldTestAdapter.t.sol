// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.3 — Vault Adapters (test no-yield adapter)
// Test fixture for the test-only NoYieldTestAdapter.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TestERC20} from "./helpers/TestERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {NoYieldTestAdapter} from "./helpers/NoYieldTestAdapter.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";

/// @dev Tests for NoYieldTestAdapter and its integration with RobotMoneyVault.
///
///      Key invariants under test:
///      - NoYieldTestAdapter correctly holds USDC after deploy().
///      - NoYieldTestAdapter returns USDC on withdraw().
///      - totalAssets() reflects the held balance.
///      - Only VAULT can call mutating functions.
///      - rescueTokens reverts for USDC.
///
///      Integration (testNoYieldRoundTrip):
///      - Deposit 1e6 USDC into a fresh RobotMoneyVault + NoYieldTestAdapter.
///      - Assert balanceOf >= 1e24 raw shares (decimalsOffset=18).
///      - Assert previewRedeem returns >= 999_000 (zero-fee, within rounding).
contract NoYieldTestAdapterTest is Test {
    TestERC20 internal usdc;
    RobotMoneyVault internal vault;
    NoYieldTestAdapter internal adapter;

    address internal admin = makeAddr("admin");
    address internal user = makeAddr("user");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant ONE_USDC = 1_000_000; // 1 USDC (6-decimal)

    function setUp() public {
        usdc = new TestERC20();
        // Deploy vault: tvlCap=10M, perDepositCap=1M, exitFeeBps=0
        vault = new RobotMoneyVault(
            IERC20(address(usdc)),
            10_000_000 * ONE_USDC, // tvlCap
            1_000_000 * ONE_USDC, // perDepositCap
            0, // exitFeeBps
            admin, // feeRecipient
            admin, // ADMIN_ROLE
            admin // EMERGENCY_ROLE
        );
        // Deploy adapter and wire into vault
        adapter = new NoYieldTestAdapter(address(usdc), address(vault));
        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), true);
        vm.prank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vm.prank(admin);
        vault.addAdapter(address(adapter), 10_000); // 100% cap

        // Fund user
        usdc.mint(user, 1_000_000 * ONE_USDC);
        vm.prank(user);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ── Constructor validation ────────────────────────────────────────────

    function test_constructor_setsImmutables() public view {
        assertEq(address(adapter.USDC()), address(usdc), "USDC mismatch");
        assertEq(adapter.VAULT(), address(vault), "VAULT mismatch");
    }

    function test_constructor_revertsOnZeroUsdc() public {
        vm.expectRevert(NoYieldTestAdapter.ZeroAddress.selector);
        new NoYieldTestAdapter(address(0), address(vault));
    }

    function test_constructor_revertsOnZeroVault() public {
        vm.expectRevert(NoYieldTestAdapter.ZeroAddress.selector);
        new NoYieldTestAdapter(address(usdc), address(0));
    }

    // ── Access control ────────────────────────────────────────────────────

    function test_deploy_revertsForNonVault() public {
        vm.prank(attacker);
        vm.expectRevert(NoYieldTestAdapter.OnlyVault.selector);
        adapter.deploy(ONE_USDC);
    }

    function test_withdraw_revertsForNonVault() public {
        vm.prank(attacker);
        vm.expectRevert(NoYieldTestAdapter.OnlyVault.selector);
        adapter.withdraw(ONE_USDC);
    }

    function test_sweepForeignToken_permissionlessToQuarantine() public {
        // INV-1/INV-2: a foreign token is swept to the fixed quarantine address
        // by ANY caller (permissionless) — no arbitrary recipient.
        TestERC20 other = new TestERC20();
        other.mint(address(adapter), 7e18);
        vm.prank(attacker);
        adapter.sweepForeignToken(address(other));
        assertEq(other.balanceOf(address(adapter)), 0, "adapter not swept");
        assertEq(
            other.balanceOf(ForeignTokenQuarantine.QUARANTINE),
            7e18,
            "tokens not in quarantine"
        );
    }

    function test_sweepForeignToken_revertsForUsdc() public {
        // USDC is the protected vault asset and may never be swept.
        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, address(usdc))
        );
        adapter.sweepForeignToken(address(usdc));
    }

    // ── totalAssets ───────────────────────────────────────────────────────

    function test_totalAssets_zeroWhenEmpty() public view {
        assertEq(adapter.totalAssets(), 0, "expected 0 on fresh adapter");
    }

    function test_totalAssets_reflectsBalance() public {
        usdc.mint(address(adapter), 5 * ONE_USDC);
        assertEq(adapter.totalAssets(), 5 * ONE_USDC, "totalAssets mismatch");
    }

    // ── withdraw partial/full/over ────────────────────────────────────────

    function test_withdraw_fullBalance() public {
        usdc.mint(address(adapter), 10 * ONE_USDC);
        vm.prank(address(vault));
        uint256 actual = adapter.withdraw(10 * ONE_USDC);
        assertEq(actual, 10 * ONE_USDC, "withdraw full mismatch");
        assertEq(usdc.balanceOf(address(vault)), 10 * ONE_USDC, "vault balance");
        assertEq(adapter.totalAssets(), 0, "adapter should be empty");
    }

    function test_withdraw_partialBalance() public {
        usdc.mint(address(adapter), 10 * ONE_USDC);
        vm.prank(address(vault));
        uint256 actual = adapter.withdraw(4 * ONE_USDC);
        assertEq(actual, 4 * ONE_USDC, "partial withdraw amount");
        assertEq(adapter.totalAssets(), 6 * ONE_USDC, "remaining in adapter");
    }

    function test_withdraw_overBalance_returnsActual() public {
        usdc.mint(address(adapter), 3 * ONE_USDC);
        vm.prank(address(vault));
        uint256 actual = adapter.withdraw(100 * ONE_USDC);
        assertEq(actual, 3 * ONE_USDC, "over-withdraw capped at balance");
        assertEq(adapter.totalAssets(), 0, "adapter should be empty after over-withdraw");
    }

    function test_withdraw_zeroBalance_returnsZero() public {
        vm.prank(address(vault));
        uint256 actual = adapter.withdraw(ONE_USDC);
        assertEq(actual, 0, "withdraw from empty adapter should return 0");
    }

    // ── Integration: deposit→redeem round-trip ────────────────────────────

    /// @notice Issue #277 acceptance criterion: deposit 1e6 USDC into fresh
    ///         RobotMoneyVault + NoYieldTestAdapter, assert:
    ///           - balanceOf(user) >= 1e24 (decimalsOffset=18)
    ///           - previewRedeem(balanceOf) >= 999_000 (zero-fee, within rounding)
    function testNoYieldRoundTrip() public {
        uint256 depositAmount = ONE_USDC; // 1 USDC

        // --- Deposit ---
        vm.prank(user);
        uint256 shares = vault.deposit(depositAmount, user);

        // Raw share count: fresh vault, decimalsOffset=18 → 1e6 USDC yields ~1e24 raw shares
        assertGe(shares, 1e24, "shares should be >= 1e24 (decimalsOffset=18)");
        assertGe(vault.balanceOf(user), 1e24, "balanceOf >= 1e24");

        // Adapter holds the USDC
        assertEq(adapter.totalAssets(), depositAmount, "adapter should hold deposited USDC");

        // --- Preview redeem ---
        uint256 rawShares = vault.balanceOf(user);
        uint256 preview = vault.previewRedeem(rawShares);
        // Zero-fee vault: expect back at least 999_000 (rounding-tolerant)
        assertGe(preview, 999_000, "previewRedeem should return >= 999_000 USDC (6dp)");

        // --- Actual redeem ---
        vm.prank(user);
        uint256 assetsOut = vault.redeem(rawShares, user, user);
        assertGe(assetsOut, 999_000, "redeem should return >= 999_000 USDC");
        assertEq(vault.balanceOf(user), 0, "user shares should be 0 after full redeem");
        assertGe(
            usdc.balanceOf(user), 999_000 * ONE_USDC - ONE_USDC, "user USDC balance after redeem"
        );
    }
}
