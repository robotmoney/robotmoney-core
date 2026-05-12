// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §5.2 — Bucket A (vault adapter abstraction)
// Issue: #277 — Wire RobotMoneyVault + PassthroughAdapter into smoke-test devnet
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TestERC20} from "./helpers/TestERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {PassthroughAdapter} from "../adapters/PassthroughAdapter.sol";

/// @dev Tests for PassthroughAdapter and its integration with RobotMoneyVault.
///
///      Key invariants under test:
///      - PassthroughAdapter correctly holds USDC after deploy().
///      - PassthroughAdapter returns USDC on withdraw().
///      - totalAssets() reflects the held balance.
///      - Only VAULT can call mutating functions.
///      - rescueTokens reverts for USDC.
///
///      Integration (testPassthroughRoundTrip):
///      - Deposit 1e6 USDC into a fresh RobotMoneyVault + PassthroughAdapter.
///      - Assert balanceOf >= 1e24 raw shares (decimalsOffset=18).
///      - Assert previewRedeem returns >= 999_000 (zero-fee, within rounding).
contract PassthroughAdapterTest is Test {
    TestERC20 internal usdc;
    RobotMoneyVault internal vault;
    PassthroughAdapter internal adapter;

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
            admin // ADMIN_ROLE
        );
        // Deploy adapter and wire into vault
        adapter = new PassthroughAdapter(address(usdc), address(vault));
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
        vm.expectRevert(PassthroughAdapter.ZeroAddress.selector);
        new PassthroughAdapter(address(0), address(vault));
    }

    function test_constructor_revertsOnZeroVault() public {
        vm.expectRevert(PassthroughAdapter.ZeroAddress.selector);
        new PassthroughAdapter(address(usdc), address(0));
    }

    // ── Access control ────────────────────────────────────────────────────

    function test_deploy_revertsForNonVault() public {
        vm.prank(attacker);
        vm.expectRevert(PassthroughAdapter.OnlyVault.selector);
        adapter.deploy(ONE_USDC);
    }

    function test_withdraw_revertsForNonVault() public {
        vm.prank(attacker);
        vm.expectRevert(PassthroughAdapter.OnlyVault.selector);
        adapter.withdraw(ONE_USDC);
    }

    function test_rescueTokens_revertsForNonVault() public {
        TestERC20 other = new TestERC20();
        vm.prank(attacker);
        vm.expectRevert(PassthroughAdapter.OnlyVault.selector);
        adapter.rescueTokens(address(other), attacker);
    }

    function test_rescueTokens_revertsForUsdc() public {
        // Even the vault cannot rescue its own protected asset.
        vm.prank(address(vault));
        vm.expectRevert(PassthroughAdapter.CannotRescueUsdc.selector);
        adapter.rescueTokens(address(usdc), admin);
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
    ///         RobotMoneyVault + PassthroughAdapter, assert:
    ///           - balanceOf(user) >= 1e24 (decimalsOffset=18)
    ///           - previewRedeem(balanceOf) >= 999_000 (zero-fee, within rounding)
    function testPassthroughRoundTrip() public {
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
