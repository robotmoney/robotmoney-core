// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RobotMoneyVaultTest, MockAdapter} from "./RobotMoneyVault.t.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {ExclusionLedger} from "../ExclusionLedger.sol";

/// @dev Adversarial re-check of docs/code-review/20261012-security-review.md, vault side.
///      Fixture facts (RobotMoneyVaultTest.setUp): `admin` holds ADMIN_ROLE and EMERGENCY_ROLE,
///      `adapter` is registry index 0 at a 100% cap, no exit fee.
///      Finding 2 (duplicate adapter entry): at baseline the `test_f2_*` PoCs proved the
///      duplicate landed and double counted NAV. Issue #1789 added the `addAdapter` active-entry
///      scan (`AdapterAlreadyActive`), so the same paths now pin the refusal and assert each
///      holder is paid at par. The baseline recovery PoCs (`adminRebalance` drain then
///      `removeAdapter`, or `forceRemoveAdapter` of the duplicate) have no duplicate to repair
///      any more; they now pin the legal re-add after removal instead.
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

    /// @dev Issue #1789: the duplicate add (index 1 -> same contract as index 0) is refused,
    ///      so the registry keeps one active entry for `adapter`.
    function _addDuplicateRefused() internal {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.AdapterAlreadyActive.selector, address(adapter), 0
            )
        );
        vault.addAdapter(address(adapter), 10_000);
        assertEq(vault.adapterCount(), 1, "one registry entry");
        assertEq(vault.activeAdapterCount(), 1, "one active entry");
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

    /// Was: a holder exiting during exclusion lost its share-based recovery entitlement, and
    /// after restoration at zero supply the surplus sat orphaned behind the virtual shares.
    /// Remediated by core 1820: the exiter keeps the claim, restoration realises the excluded
    /// balance into the exclusion record first, and a later depositor neither gains nor loses.
    function test_f1_holderExitDuringWindowKeepsRecoveryClaim() public {
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
            usdc.balanceOf(alice) - aliceBefore, 1_000 * ONE_USDC, 1, "exit at the reduced NAV"
        );
        assertEq(vault.totalSupply(), 0, "supply zero");
        assertEq(
            usdc.balanceOf(address(second)), 1_000 * ONE_USDC, "excluded balance still in adapter"
        );

        vm.prank(admin);
        vault.setAdapterAllowed(address(second), true);
        assertEq(usdc.balanceOf(address(second)), 0, "restoration realised it into the record");
        assertEq(vault.totalAssets(), 0, "nothing orphaned in NAV");
        ExclusionLedger ledger = vault.exclusionLedger();
        assertEq(ledger.claimable(1, alice), 1_000 * ONE_USDC, "the exiter owns the recovery");

        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_000 * ONE_USDC, bob);
        assertApproxEqAbs(vault.convertToAssets(bobShares), 1_000 * ONE_USDC, 2, "bob's own 1000");
        assertEq(ledger.claimable(1, bob), 0, "bob has no claim on the recovery");

        ledger.claim(1, alice);
        assertApproxEqAbs(
            usdc.balanceOf(alice) - aliceBefore, 2_000 * ONE_USDC, 1, "alice is made whole"
        );
        vm.expectRevert();
        vault.sweepForeignToken(address(usdc));
    }

    /// Remediated by core 1788 (PR 1814) and core 1820: with no window depositor,
    /// `emergencyWithdrawAdapter` on a revoked adapter returns the recovered value to the
    /// holders who funded it, through the exclusion record (not idle NAV).
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
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "the recovery stays out of NAV");
        ExclusionLedger ledger = vault.exclusionLedger();
        assertEq(usdc.balanceOf(address(ledger)), 1_000 * ONE_USDC, "the record holds it");
        assertApproxEqAbs(
            vault.convertToAssets(vault.balanceOf(alice)) + ledger.claimable(1, alice),
            2_000 * ONE_USDC,
            2,
            "alice keeps it all"
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

    // ─── Finding 2: duplicate adapter entry (refused since #1789) ────────

    /// Was: a PARTIAL redemption was paid at the doubled share price and emptied the vault.
    /// Now the duplicate is refused, NAV is counted once and half the shares take half.
    function test_f2_partialRedeemPaysParAfterDuplicateRefused() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        _addDuplicateRefused();
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "NAV counted once");

        uint256 half = vault.balanceOf(alice) / 2;
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(half, alice, alice);
        uint256 proceeds = usdc.balanceOf(alice) - before;
        emit log_named_uint("Alice proceeds for HALF her shares (USDC units)", proceeds);

        assertApproxEqAbs(proceeds, 500 * ONE_USDC, 2, "half the shares take half the deposit");
        assertGt(vault.balanceOf(alice), 0, "Alice still holds half her shares");
        assertApproxEqAbs(
            vault.previewRedeem(vault.balanceOf(alice)),
            500 * ONE_USDC,
            2,
            "remaining shares keep their backing"
        );
    }

    /// Was: with two holders the FIRST full redeemer took the second holder's backing and the
    /// second holder's exit reverted. Now each holder redeems exactly their own deposit.
    function test_f2_eachHolderRedeemsOwnBackingAfterDuplicateRefused() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);
        _addDuplicateRefused();
        assertEq(vault.totalAssets(), 2_000 * ONE_USDC, "NAV counted once");

        uint256 aliceShares = vault.balanceOf(alice);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        uint256 aliceProceeds = usdc.balanceOf(alice) - before;
        emit log_named_uint("Alice proceeds (deposited 1,000)", aliceProceeds);
        assertApproxEqAbs(aliceProceeds, 1_000 * ONE_USDC, 2, "Alice is paid her deposit");

        assertApproxEqAbs(vault.maxWithdraw(bob), 1_000 * ONE_USDC, 2, "Bob's backing intact");
        uint256 bobShares = vault.balanceOf(bob);
        before = usdc.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        assertApproxEqAbs(usdc.balanceOf(bob) - before, 1_000 * ONE_USDC, 2, "Bob at par");
        assertLe(vault.totalAssets(), 2, "vault empty after both exit");
    }

    /// Was (the revert face): after a partial extraction a later holder's FULL redemption
    /// reverted `InsufficientAdapterLiquidity`. Now the later claim stays fully backed.
    function test_f2_laterFullRedemptionSucceedsAfterDuplicateRefused() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);
        _addDuplicateRefused();

        uint256 aliceHalf = vault.balanceOf(alice) / 2;
        vm.prank(alice);
        vault.redeem(aliceHalf, alice, alice);
        uint256 realLeft = adapter.totalAssets();
        assertApproxEqAbs(realLeft, 1_500 * ONE_USDC, 2);

        uint256 bobShares = vault.balanceOf(bob);
        uint256 gross = vault.previewRedeem(bobShares);
        assertLe(gross, realLeft, "Bob's claim is within the real backing");
        uint256 before = usdc.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        assertApproxEqAbs(usdc.balanceOf(bob) - before, 1_000 * ONE_USDC, 2, "Bob at par");
    }

    /// Was: a deposit AFTER the duplicate was minted at the inflated price (about half the
    /// shares). Now the same deposit mints the same shares. Routing places the full deposit.
    function test_f2_depositAfterDuplicateRefusedMintsAtPar() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        _addDuplicateRefused();
        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);

        uint256 aliceShares = vault.balanceOf(alice);
        uint256 bobShares = vault.balanceOf(bob);
        emit log_named_uint("Alice shares", aliceShares);
        emit log_named_uint("Bob shares (same deposit)", bobShares);
        assertApproxEqRel(bobShares, aliceShares, 1e12, "Bob minted at the same price");
        assertEq(adapter.totalAssets(), 2_000 * ONE_USDC, "fully routed");
        assertEq(usdc.balanceOf(address(vault)), 0, "no idle leftover");
    }

    /// Was: `removeAdapter` could not undo the duplicate because both entries read the same
    /// balance. Now there is no second entry; the one real entry still refuses a funded removal.
    function test_f2_noDuplicateEntryToRemoveAfterRefusal() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        _addDuplicateRefused();
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.AdapterNotFound.selector);
        vault.removeAdapter(1);
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.AdapterNotEmpty.selector);
        vault.removeAdapter(0);
    }

    /// Was: ADMIN-only recovery of the duplicate (drain, remove the duplicate, reallocate).
    /// Now the legal ADMIN path is drain -> `removeAdapter(0)` -> re-add the same address.
    /// The re-add appends a new entry, NAV is counted once and no deposit pause is needed.
    function test_f2_reAddAfterRemoveAdapterCountsBalanceOnce() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);
        _addDuplicateRefused();
        assertEq(vault.totalAssets(), 2_000 * ONE_USDC);

        uint256[] memory drain = new uint256[](1);
        vm.prank(admin);
        vault.adminRebalance(drain);
        assertEq(adapter.totalAssets(), 0, "adapter drained to idle");
        assertEq(vault.totalAssets(), 2_000 * ONE_USDC, "NAV correct while idle");

        vm.prank(admin);
        vault.removeAdapter(0);
        assertEq(vault.activeAdapterCount(), 0, "entry deactivated");

        vm.prank(admin);
        vault.addAdapter(address(adapter), 10_000);
        assertEq(vault.adapterCount(), 2, "re-add appends index 1");
        assertEq(vault.activeAdapterCount(), 1, "only the new entry is active");

        uint256[] memory redeploy = new uint256[](2);
        redeploy[1] = 2_000 * ONE_USDC;
        vm.prank(admin);
        vault.adminRebalance(redeploy);
        assertEq(adapter.totalAssets(), 2_000 * ONE_USDC, "funds back in the adapter");
        assertEq(vault.totalAssets(), 2_000 * ONE_USDC, "NAV counted once after re-add");
        assertFalse(vault.depositsPaused(), "no deposit pause was needed");

        uint256 aliceShares = vault.balanceOf(alice);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        assertApproxEqAbs(usdc.balanceOf(alice) - before, 1_000 * ONE_USDC, 2, "Alice at par");
        uint256 bobShares = vault.balanceOf(bob);
        before = usdc.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        assertApproxEqAbs(usdc.balanceOf(bob) - before, 1_000 * ONE_USDC, 2, "Bob at par");
    }

    /// Was: EMERGENCY `forceRemoveAdapter(1)` fixed the duplicate's NAV but paused deposits and
    /// emitted a misleading full-balance loss. Now there is no duplicate index to write off,
    /// so no pause and no misreported loss.
    function test_f2_noDuplicateToForceRemoveAfterRefusal() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        _addDuplicateRefused();

        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.AdapterNotFound.selector);
        vault.forceRemoveAdapter(1);

        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "NAV correct, nothing to repair");
        assertFalse(vault.depositsPaused(), "no pause side effect");
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
