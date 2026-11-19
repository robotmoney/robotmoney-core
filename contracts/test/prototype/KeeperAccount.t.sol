// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md E56 (the keeper account), E34, E47;
//            docs/technical/one-vault-rebalancer-proposal.md D36
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {Roles} from "../../FundTypes.sol";
import {KeeperAccount} from "../../KeeperAccount.sol";
import {FlowQueueBase} from "./FlowQueue.t.sol";

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
