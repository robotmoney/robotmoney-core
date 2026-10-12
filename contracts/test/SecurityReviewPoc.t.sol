// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RobotMoneyVaultTest, MockAdapter} from "./RobotMoneyVault.t.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";

contract SecurityReviewPoc is RobotMoneyVaultTest {
    function test_duplicateAdapterDoubleCountsNavAndBlocksFullRedemption() public {
        vm.prank(alice);
        vault.deposit(1_000 * ONE_USDC, alice);
        vm.prank(admin);
        vault.addAdapter(address(adapter), 10_000);

        assertEq(vault.totalAssets(), 2_000 * ONE_USDC, "single balance counted twice");
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.InsufficientAdapterLiquidity.selector,
                2_000 * ONE_USDC - 1,
                1_000 * ONE_USDC
            )
        );
        vault.redeem(aliceShares, alice, alice);
    }

    function test_revokedAdapterReactivationTransfersValue() public {
        MockAdapter second = new MockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(second));
        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);

        vm.prank(alice);
        vault.deposit(2_000 * ONE_USDC, alice);
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);

        vm.prank(bob);
        vault.deposit(1_000 * ONE_USDC, bob);
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), true);

        uint256 before = usdc.balanceOf(bob);
        uint256 bobShares = vault.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        uint256 proceeds = usdc.balanceOf(bob) - before;
        emit log_named_uint("Bob proceeds (USDC units)", proceeds);
        assertGt(proceeds, 1_400 * ONE_USDC, "bob captures Alice's restored NAV");
    }
}
