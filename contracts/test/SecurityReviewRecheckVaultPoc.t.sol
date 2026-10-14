// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RobotMoneyVaultTest, MockAdapter} from "./RobotMoneyVault.t.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";

/// @dev Adversarial re-check of docs/code-review/20261012-security-review.md, vault side.
///      Fixture facts (RobotMoneyVaultTest.setUp): `admin` holds ADMIN_ROLE and EMERGENCY_ROLE,
///      `adapter` is registry index 0 at a 100% cap, no exit fee.
contract SecurityReviewRecheckVaultPoc is RobotMoneyVaultTest {
    address internal emergency = makeAddr("emergency");
    address internal keeper = makeAddr("keeper");

    function _grantHotKeys() internal {
        vm.startPrank(admin);
        vault.grantRole(vault.EMERGENCY_ROLE(), emergency);
        vault.grantRole(vault.KEEPER_ROLE(), keeper);
        vm.stopPrank();
    }

    function _secondAdapter() internal returns (MockAdapter second) {
        second = new MockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(second));
        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);
    }

    /// Core 1789: a second registry entry for an already-active adapter reverts.
    function _addDuplicate() internal {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterAlreadyActive.selector, address(adapter))
        );
        vault.addAdapter(address(adapter), 10_000);
        assertEq(vault.adapterCount(), 1, "no second registry entry");
        assertEq(vault.activeAdapterCount(), 1, "still one active");
    }

    // ─── Finding 1: adapter exclusion window ─────────────────────────────

    /// Remediated by core 1788 (PR 1814): deposits close during exclusion, and KEEPER
    /// `rebalance()` skips the ineligible adapter instead of pulling it into NAV.
    function test_f1_keeperRebalanceSkipsRevokedAdapter() public {
        _grantHotKeys();
        _secondAdapter();
        vm.prank(alice);
        vault.deposit(2_000 * ONE_USDC, alice); // 1000 / 1000

        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "NAV excludes revoked adapter");
        assertEq(vault.maxDeposit(bob), 0, "no window deposit");

        vm.warp(block.timestamp + 13 hours);
        uint256 revokedBefore = usdc.balanceOf(address(adapter));
        vm.prank(keeper);
        vault.rebalance();

        assertEq(
            usdc.balanceOf(address(adapter)), revokedBefore, "keeper left revoked adapter alone"
        );
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "excluded value stays out of NAV");
    }

    /// A holder exiting during exclusion loses its share-based recovery entitlement.
    /// After restoration at zero supply, an ordinary new deposit does not capture the surplus.
    /// This does not prove unconditional permanent lock: further ADMIN eligibility changes
    /// can redistribute it, as SecurityReviewRevisionAssessment demonstrates.
    function test_f1_holderExitDuringWindowStrandsSurplusBehindVirtualShares() public {
        MockAdapter second = _secondAdapter();
        vm.prank(alice);
        vault.deposit(2_000 * ONE_USDC, alice);
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);

        uint256 aliceShares = vault.balanceOf(alice);
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        assertApproxEqAbs(
            usdc.balanceOf(alice) - aliceBefore, 1_000 * ONE_USDC, 1, "alice lost 1000"
        );
        assertEq(vault.totalSupply(), 0, "supply zero");
        assertEq(
            usdc.balanceOf(address(second)), 1_000 * ONE_USDC, "surplus still in revoked adapter"
        );

        vm.prank(admin);
        vault.setAdapterAllowed(address(second), true);
        assertApproxEqAbs(vault.totalAssets(), 1_000 * ONE_USDC, 1, "orphaned NAV with zero supply");

        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);
        uint256 bobClaim = vault.convertToAssets(vault.balanceOf(bob));
        emit log_named_uint("bob claim after depositing into orphaned NAV", bobClaim);
        assertApproxEqAbs(
            bobClaim, 1_000 * ONE_USDC, 2, "orphaned 1000 is locked behind virtual shares"
        );

        vm.prank(admin);
        vault.emergencyWithdraw();
        assertApproxEqAbs(vault.maxWithdraw(bob), 1_000 * ONE_USDC, 2, "still only bob's own 1000");
        vm.expectRevert();
        vault.sweepForeignToken(address(usdc));
    }

    /// Remediated by core 1788 (PR 1814): with no window depositor, `emergencyWithdrawAdapter`
    /// on a revoked adapter returns the recovered value to the holders who funded it.
    function test_f1_emergencyWithdrawAdapterOnRevokedAdapterRecoversToExistingHolders() public {
        MockAdapter second = _secondAdapter();
        vm.prank(alice);
        vault.deposit(2_000 * ONE_USDC, alice);
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);
        vm.prank(bob);
        vm.expectRevert();
        vault.deposit(1_000 * ONE_USDC, bob);

        vm.prank(admin);
        vault.emergencyWithdrawAdapter(1);
        assertTrue(vault.depositsPaused(), "emergency drain pauses deposits");
        assertEq(usdc.balanceOf(address(second)), 0, "revoked adapter drained");
        assertEq(vault.totalAssets(), 2_000 * ONE_USDC, "idle recovery re-enters NAV");
        assertApproxEqAbs(
            vault.convertToAssets(vault.balanceOf(alice)), 2_000 * ONE_USDC, 2, "alice keeps it all"
        );
    }

    /// Mitigation available today: the EMERGENCY hot key pauses before the revoke executes.
    function test_f1_pauseBeforeRevokeClosesWindow() public {
        MockAdapter second = _secondAdapter();
        vm.prank(alice);
        vault.deposit(2_000 * ONE_USDC, alice);
        vm.prank(admin);
        vault.pauseDeposits();
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);
        vm.prank(bob);
        vm.expectRevert(RobotMoneyVault.DepositsArePaused.selector);
        vault.deposit(1_000 * ONE_USDC, bob);
        assertEq(vault.maxDeposit(bob), 0);
    }

    // ─── Finding 2: duplicate adapter entry (fixed by core 1789) ─────────

    /// The duplicate add that doubled NAV now reverts, so a partial redeem pays par.
    function test_f2_partialRedeemPaysDoubledPriceAndEmptiesVault() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        _addDuplicate();
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "NAV not double-counted");

        uint256 half = vault.balanceOf(alice) / 2;
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(half, alice, alice);
        assertApproxEqAbs(usdc.balanceOf(alice) - before, 500 * ONE_USDC, 2, "half pays half");
    }

    /// The first redeemer can no longer take the second holder's backing.
    function test_f2_firstRedeemerTakesSecondHoldersBacking() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);
        _addDuplicate();
        assertEq(vault.totalAssets(), 2_000 * ONE_USDC, "NAV not double-counted");

        uint256 before = usdc.balanceOf(alice);
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        assertApproxEqAbs(usdc.balanceOf(alice) - before, 1_000 * ONE_USDC, 2, "Alice at par");

        uint256 bobShares = vault.balanceOf(bob);
        before = usdc.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        assertApproxEqAbs(usdc.balanceOf(bob) - before, 1_000 * ONE_USDC, 2, "Bob at par");
    }

    /// A later holder's full redemption succeeds because no duplicate inflates the claim.
    function test_f2_laterFullRedemptionRevertsAfterPartialExtraction() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);
        _addDuplicate();

        uint256 aliceHalf = vault.balanceOf(alice) / 2;
        vm.prank(alice);
        vault.redeem(aliceHalf, alice, alice);

        uint256 bobShares = vault.balanceOf(bob);
        uint256 before = usdc.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        assertApproxEqAbs(usdc.balanceOf(bob) - before, 1_000 * ONE_USDC, 2, "Bob at par");
    }

    /// A deposit after the rejected duplicate mints at the true price.
    function test_f2_depositAfterDuplicateMintsAtInflatedPrice() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        _addDuplicate();
        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);
        assertApproxEqAbs(vault.balanceOf(bob), vault.balanceOf(alice), 2, "same price");
    }

    /// Reactivating a deliberately removed (inactive) adapter still works.
    function test_f2_reactivatingInactiveAdapterStillWorks() public {
        MockAdapter second = _secondAdapter();
        vm.prank(admin);
        vault.removeAdapter(1);
        assertEq(vault.activeAdapterCount(), 1);

        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);
        assertEq(vault.activeAdapterCount(), 2, "re-added");

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterAlreadyActive.selector, address(second))
        );
        vault.addAdapter(address(second), 10_000);
    }

    // ─── Omitted: EMERGENCY write-off reprices exits ─────────────────────

    /// EMERGENCY force-removes the only funded adapter. NAV -> 0. `maxRedeem` still promises
    /// the full balance while `redeem` burns every share for 0 USDC. The USDC stays in the
    /// adapter; only ADMIN `addAdapter` brings it back, and with zero supply the ERC4626
    /// virtual shares then own it.
    function test_O1a_forceRemoveAllFunded_redeemBurnsSharesForZero() public {
        _grantHotKeys();
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 * ONE_USDC, alice);

        vm.prank(emergency);
        vault.forceRemoveAdapter(0);

        assertEq(vault.totalAssets(), 0, "NAV written off");
        assertEq(vault.maxRedeem(alice), shares, "view promises the full balance");
        assertEq(vault.previewRedeem(shares), 0, "but it is worth 0");

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertEq(out, 0, "redeem pays nothing");
        assertEq(usdc.balanceOf(alice) - before, 0);
        assertEq(vault.balanceOf(alice), 0, "shares are gone");
        assertEq(adapter.totalAssets(), 1_000 * ONE_USDC, "the USDC is still in the adapter");

        vm.prank(admin);
        vault.addAdapter(address(adapter), 10_000);
        vm.prank(admin);
        vault.unpauseDeposits();
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC);
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1 * ONE_USDC, bob);
        assertApproxEqAbs(
            vault.previewRedeem(bobShares), 1 * ONE_USDC, 2, "orphan stays behind virtual shares"
        );
    }

    /// Partial force-remove: exits during the exclusion are under-paid; stayers are over-paid
    /// after ADMIN re-adds. Mirror image of finding 1, triggerable by the EMERGENCY key alone
    /// and NOT closed by the deposit pause.
    function test_O1b_forceRemovePartial_exitsUnderpaidStayersOverpaid() public {
        _grantHotKeys();
        MockAdapter second = _secondAdapter();

        vm.prank(alice);
        uint256 aliceShares = vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);
        assertEq(second.totalAssets(), 1_000 * ONE_USDC);

        vm.prank(emergency);
        vault.forceRemoveAdapter(1);
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "half of NAV excluded");

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        assertLe(usdc.balanceOf(alice) - before, 500 * ONE_USDC, "alice exits at half value");

        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);
        assertGe(vault.maxWithdraw(bob), 1_499 * ONE_USDC, "bob now owns alice's 500");
    }

    /// SR-M10, remediated by core 1788 (PR 1814): KEEPER `rebalance()` reverts while
    /// deposits are paused, so it cannot re-deploy emergency-rescued idle USDC.
    function test_O2_keeperRebalanceBlockedAfterEmergencyWithdraw() public {
        _grantHotKeys();
        vm.prank(alice);
        vault.deposit(10_000 * ONE_USDC, alice);

        vm.prank(emergency);
        vault.emergencyWithdraw();
        assertEq(adapter.totalAssets(), 0, "drained");
        assertTrue(vault.depositsPaused());

        vm.warp(block.timestamp + 13 hours);
        vm.prank(keeper);
        vm.expectRevert(RobotMoneyVault.DepositsArePaused.selector);
        vault.rebalance();

        assertEq(adapter.totalAssets(), 0, "funds stay idle");
        assertEq(usdc.balanceOf(address(vault)), 10_000 * ONE_USDC);
    }

    /// 1 wei donated to an adapter blocks ADMIN `removeAdapter`; only the EMERGENCY
    /// write-off path bypasses it.
    function test_O3_dustDonationBlocksRemoveAdapter() public {
        usdc.mint(address(adapter), 1);
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.AdapterNotEmpty.selector);
        vault.removeAdapter(0);
    }

    /// Force-removed funded adapter plus some idle: redeem does not revert but pays out only
    /// the idle share.
    function test_O4_forceRemoveWithIdle_payoutIsIdleOnly() public {
        _grantHotKeys();
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 * ONE_USDC, alice);
        usdc.mint(address(vault), 100 * ONE_USDC);

        vm.prank(emergency);
        vault.forceRemoveAdapter(0);
        assertEq(vault.totalAssets(), 100 * ONE_USDC);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        assertApproxEqAbs(usdc.balanceOf(alice) - before, 100 * ONE_USDC, 1, "1,000 in, 100 out");
    }
}
