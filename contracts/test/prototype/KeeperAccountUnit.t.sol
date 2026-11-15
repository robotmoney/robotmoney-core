// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md E56 (the keeper account), E34, E47;
//            docs/technical/one-vault-rebalancer-proposal.md D36
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KeeperAccount} from "./src/KeeperAccount.sol";

/// @title KeeperAccountUnitTest
/// @notice The account's own rules. No fork state is read.
contract KeeperAccountUnitTest is Test {
    KeeperAccount internal acct;
    address internal ownerA = makeAddr("ownerA");
    address internal ownerB = makeAddr("ownerB");
    address internal bot1 = makeAddr("bot1");
    address internal bot2 = makeAddr("bot2");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        address[] memory o = new address[](1);
        o[0] = ownerA;
        address[] memory b = new address[](1);
        b[0] = bot1;
        acct = new KeeperAccount(o, b);
    }

    function test_constructorRefusesBadSets() public {
        address[] memory none = new address[](0);
        address[] memory dup = new address[](2);
        dup[0] = ownerA;
        dup[1] = ownerA;
        address[] memory zero = new address[](1);
        vm.expectRevert(KeeperAccount.InvalidAccount.selector);
        new KeeperAccount(none, none);
        vm.expectRevert(KeeperAccount.InvalidAccount.selector);
        new KeeperAccount(dup, none);
        vm.expectRevert(KeeperAccount.InvalidAccount.selector);
        new KeeperAccount(zero, none);
    }

    function test_viewsMatchWhatTheVerifierReads() public view {
        address[] memory o = acct.owners();
        address[] memory b = acct.botKeys();
        assertEq(o.length, 1, "one owner");
        assertEq(o[0], ownerA, "owner");
        assertEq(b.length, 1, "one bot key");
        assertEq(b[0], bot1, "bot key");
    }

    function test_ownersRotateBotKeysWithoutAnyTimelock() public {
        vm.startPrank(ownerA);
        acct.addBotKey(bot2);
        acct.removeBotKey(bot1);
        vm.stopPrank();
        assertTrue(acct.isBotKey(bot2) && !acct.isBotKey(bot1), "bot keys rotated");
        assertEq(acct.botKeys().length, 1, "one bot key left");
        assertEq(acct.botKeys()[0], bot2, "the new key");
    }

    function test_onlyOwnersRotate() public {
        vm.startPrank(bot1);
        vm.expectRevert(KeeperAccount.NotOwner.selector);
        acct.addBotKey(bot2);
        vm.expectRevert(KeeperAccount.NotOwner.selector);
        acct.addOwner(bot2);
        vm.expectRevert(KeeperAccount.NotOwner.selector);
        acct.removeBotKey(bot1);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(KeeperAccount.NotOwner.selector);
        acct.removeOwner(ownerA);
    }

    function test_lastOwnerStays() public {
        vm.startPrank(ownerA);
        vm.expectRevert(KeeperAccount.LastOwner.selector);
        acct.removeOwner(ownerA);
        acct.addOwner(ownerB);
        acct.removeOwner(ownerA);
        vm.stopPrank();
        assertEq(acct.owners().length, 1, "one owner");
        assertEq(acct.owners()[0], ownerB, "the other owner");
    }

    function test_executeNeedsABotKeyOrAnOwner() public {
        vm.prank(stranger);
        vm.expectRevert(KeeperAccount.NotBotKey.selector);
        acct.execute(address(this), "");
    }

    function test_executeNeverCallsTheAccountItself() public {
        vm.prank(bot1);
        vm.expectRevert(KeeperAccount.SelfCall.selector);
        acct.execute(address(acct), abi.encodeCall(KeeperAccount.addBotKey, (bot2)));
        assertFalse(acct.isBotKey(bot2), "a bot key cannot add a key through execute");
    }

    function test_aRevertIsPassedUpWithItsData() public {
        vm.prank(bot1);
        vm.expectRevert(
            abi.encodeWithSelector(
                KeeperAccount.CallFailed.selector, abi.encodeWithSignature("Error(string)", "boom")
            )
        );
        acct.execute(address(this), abi.encodeCall(this.alwaysReverts, ()));
    }

    function alwaysReverts() external pure {
        revert("boom");
    }
}
