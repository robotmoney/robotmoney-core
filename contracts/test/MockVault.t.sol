// SPDX-License-Identifier: MIT
// Canonical: none — Foundry test for contracts/gateway/MockVault.sol fixture
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../gateway/MockUSDC.sol";
import {MockVault} from "../gateway/MockVault.sol";

contract MockVaultTest is Test {
    MockUSDC internal usdc;
    MockVault internal vault;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal receiver = makeAddr("receiver");

    function setUp() public {
        usdc = new MockUSDC();
        vault = new MockVault(address(usdc));
    }

    function test_metadata() public view {
        assertEq(vault.name(), "Mock Robot Money USDC");
        assertEq(vault.symbol(), "rmUSDC");
        assertEq(vault.decimals(), 6);
        assertEq(vault.asset(), address(usdc));
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.totalSupply(), 0);
    }

    function test_deposit_oneToOneShares_routesToReceiver() public {
        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 100e6);
        uint256 shares = vault.deposit(40e6, receiver);
        vm.stopPrank();

        assertEq(shares, 40e6, "1:1 share minting");
        assertEq(vault.balanceOf(receiver), 40e6);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(alice), 60e6);
        assertEq(usdc.balanceOf(address(vault)), 40e6);
        assertEq(vault.totalAssets(), 40e6);
        assertEq(vault.totalSupply(), 40e6);
    }

    function test_deposit_revertsWithoutAllowance() public {
        usdc.mint(alice, 50e6);
        vm.prank(alice);
        vm.expectRevert();
        vault.deposit(10e6, alice);
    }

    function test_deposit_revertsOnZeroAmount() public {
        vm.expectRevert(MockVault.ZeroAmount.selector);
        vault.deposit(0, alice);
    }

    function test_deposit_revertsOnZeroReceiver() public {
        usdc.mint(alice, 5e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 5e6);
        vm.expectRevert(MockVault.ZeroReceiver.selector);
        vault.deposit(5e6, address(0));
        vm.stopPrank();
    }

    function test_deposit_multipleAgentsAccumulate() public {
        usdc.mint(alice, 10e6);
        usdc.mint(bob, 20e6);

        vm.startPrank(alice);
        usdc.approve(address(vault), 10e6);
        vault.deposit(10e6, receiver);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(vault), 20e6);
        vault.deposit(20e6, receiver);
        vm.stopPrank();

        assertEq(vault.balanceOf(receiver), 30e6);
        assertEq(vault.totalAssets(), 30e6);
        assertEq(usdc.balanceOf(address(vault)), 30e6);
    }

    function test_emitsDepositEvent() public {
        usdc.mint(alice, 1e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1e6);

        vm.expectEmit(true, true, false, true, address(vault));
        emit MockVault.Deposit(alice, receiver, 1e6, 1e6);
        vault.deposit(1e6, receiver);
        vm.stopPrank();
    }

    function testFuzz_deposit_oneToOne(uint96 amount) public {
        vm.assume(amount > 0);
        usdc.mint(alice, amount);
        vm.startPrank(alice);
        usdc.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, receiver);
        vm.stopPrank();
        assertEq(shares, amount);
        assertEq(vault.balanceOf(receiver), amount);
    }
}
