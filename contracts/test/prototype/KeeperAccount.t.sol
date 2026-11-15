// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md E56 (the keeper account), E34, E47;
//            docs/technical/one-vault-rebalancer-proposal.md D36
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Roles} from "./src/FundTypes.sol";
import {KeeperAccount} from "./src/KeeperAccount.sol";
import {FlowQueueBase} from "./FlowQueue.t.sol";

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

/// @title KeeperAccountFlowTest
/// @notice E56 on the real queue: the account holds `KEEPER_ROLE`, a bot key settles a round through it, and the owner
///         replaces that bot key without the timelock.
contract KeeperAccountFlowTest is FlowQueueBase {
    function test_E56_aBotKeySettlesThroughTheAccountAndTheOwnerRotatesItWithoutTheTimelock()
        public
        fixtureCovered
    {
        address acctOwner = makeAddr("keeperOwner");
        address bot = makeAddr("keeperBot");
        address bot2 = makeAddr("keeperBot2");
        address[] memory o = new address[](1);
        o[0] = acctOwner;
        address[] memory b = new address[](1);
        b[0] = bot;
        KeeperAccount acct = new KeeperAccount(o, b);

        // The account is the one keeper: it takes the role through the timelock, and the old holder loses it.
        timelockExecute(
            address(queue), abi.encodeCall(queue.grantRole, (Roles.KEEPER_ROLE, address(acct)))
        );
        timelockExecute(
            address(queue), abi.encodeCall(queue.revokeRole, (Roles.KEEPER_ROLE, keeper))
        );
        assertTrue(queue.liveness().keeperConfigured, "the queue has a keeper");

        _invest();
        uint256 d = openDepositRequest(alice, 20_000e6);
        warpToSettleable(d);
        alignFeedsToPools();
        refreshFeeds();

        // The old keeper key can no longer settle. A stranger cannot use the account.
        vm.prank(keeper);
        vm.expectRevert();
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(KeeperAccount.NotBotKey.selector);
        acct.execute(
            address(queue), abi.encodeCall(queue.settle, (SETTLE_MAX_REQUESTS, type(uint256).max))
        );

        uint256 before = queue.settlementCount();
        vm.prank(bot);
        acct.execute(
            address(queue), abi.encodeCall(queue.settle, (SETTLE_MAX_REQUESTS, type(uint256).max))
        );
        assertGt(queue.settlementCount(), before, "the bot key settled a round through the account");

        // The bot key leaks. The owner swaps it in one call, with no timelock operation.
        vm.startPrank(acctOwner);
        acct.addBotKey(bot2);
        acct.removeBotKey(bot);
        vm.stopPrank();
        vm.prank(bot);
        vm.expectRevert(KeeperAccount.NotBotKey.selector);
        acct.execute(
            address(queue), abi.encodeCall(queue.settle, (SETTLE_MAX_REQUESTS, type(uint256).max))
        );
        assertTrue(acct.isBotKey(bot2), "the new bot key is live at once");
        assertTrue(
            queue.hasRole(Roles.KEEPER_ROLE, address(acct)), "the role stayed with the account"
        );
    }
}
