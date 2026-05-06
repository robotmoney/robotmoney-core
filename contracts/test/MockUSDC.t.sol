// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../gateway/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC internal usdc;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockUSDC();
    }

    function test_metadata() public view {
        assertEq(usdc.name(), "Mock USDC");
        assertEq(usdc.symbol(), "mUSDC");
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.totalSupply(), 0);
    }

    function test_mint_increasesBalanceAndSupply() public {
        usdc.mint(alice, 1_000_000); // 1 USDC
        assertEq(usdc.balanceOf(alice), 1_000_000);
        assertEq(usdc.totalSupply(), 1_000_000);
    }

    function test_mint_isPermissionless() public {
        // Anyone can mint — this is a test fixture token.
        vm.prank(bob);
        usdc.mint(bob, 5e6);
        assertEq(usdc.balanceOf(bob), 5e6);
    }

    function test_transfer() public {
        usdc.mint(alice, 10e6);
        vm.prank(alice);
        assertTrue(usdc.transfer(bob, 4e6));
        assertEq(usdc.balanceOf(alice), 6e6);
        assertEq(usdc.balanceOf(bob), 4e6);
    }

    function test_approveAndTransferFrom() public {
        usdc.mint(alice, 10e6);
        vm.prank(alice);
        usdc.approve(bob, 7e6);
        assertEq(usdc.allowance(alice, bob), 7e6);

        vm.prank(bob);
        assertTrue(usdc.transferFrom(alice, bob, 5e6));
        assertEq(usdc.balanceOf(alice), 5e6);
        assertEq(usdc.balanceOf(bob), 5e6);
        assertEq(usdc.allowance(alice, bob), 2e6);
    }

    function testFuzz_mint(address to, uint128 amount) public {
        vm.assume(to != address(0));
        usdc.mint(to, amount);
        assertEq(usdc.balanceOf(to), amount);
    }
}
