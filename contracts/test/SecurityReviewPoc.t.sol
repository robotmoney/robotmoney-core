// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RobotMoneyVaultTest, MockAdapter} from "./RobotMoneyVault.t.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";

contract SecurityReviewPoc is RobotMoneyVaultTest {
    /// Remediated by core 1789: a duplicate add reverts, so NAV is never double counted.
    function test_duplicateAdapterAddReverts() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterAlreadyActive.selector, address(adapter))
        );
        vault.addAdapter(address(adapter), 10_000);

        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "single balance counted once");
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        assertApproxEqAbs(usdc.balanceOf(alice) - before, 1_000 * ONE_USDC, 2, "alice at par");
    }

    /// Remediated by core 1788 (PR 1814): deposits close while a funded adapter is excluded
    /// from NAV, so no window depositor can mint against the reduced NAV.
    function test_revokedAdapterWindowDepositBlocked() public {
        MockAdapter second = new MockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(second));
        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);

        vm.prank(alice);
        vault.deposit(2_000 * ONE_USDC, alice);
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);

        assertEq(vault.maxDeposit(bob), 0, "deposits closed during exclusion");
        vm.prank(bob);
        vm.expectRevert();
        vault.deposit(1_000 * ONE_USDC, bob);

        // core 1820: restoration realises the excluded balance into the exclusion record, so
        // alice's full claim is her shares plus her record claim.
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), true);
        assertGt(vault.maxDeposit(bob), 0, "deposits reopen after restoration");
        assertApproxEqAbs(
            vault.convertToAssets(vault.balanceOf(alice))
                + vault.exclusionLedger().claimable(1, alice),
            2_000 * ONE_USDC,
            2,
            "alice keeps full claim"
        );
    }
}
