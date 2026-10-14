// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Finding 3 of docs/code-review/20261012-security-review.md (committee vote
// attribution). At baseline this PoC proved the spoof landed. Issue #1790
// (PR 1818) added the gateway identity guard, so the same path now pins the
// refusal: `committeeVoteSubmit` reverts `CommitteeAgentNotCaller` when
// `p.agent != msg.sender`.
// Run: forge test --match-path 'contracts/test/SecurityReviewCommitteePoc.t.sol' -vv

import {ICGatewayIntegration} from "./ICGatewayIntegration.t.sol";
import {IInvestmentCommitteePolicy} from "../gateway/interfaces/IInvestmentCommitteePolicy.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";

contract SecurityReviewCommitteePoc is ICGatewayIntegration {
    /// @dev Issue #1790: a gateway agent that self-registered through the
    ///      permissionless commit/reveal path (AGENT_ROLE, no
    ///      COMMITTEE_AGENT_ROLE) cannot submit a vote carrying the allowlisted
    ///      committeeAgent's address in calldata. The gateway refuses before
    ///      the IC contract sees the vote, so nothing is recorded.
    function test_selfRevealedAgentCannotImpersonateCommitteeMember() public {
        address otherAgent = address(0xB2);
        address[] memory empty = new address[](0);
        IGateway.AgentPolicy memory policy = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 30 days),
            maxPerPayment: 1e6,
            maxPerWindow: 10e6,
            shareReceiver: otherAgent,
            allowedDestinations: empty,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
        bytes32 salt = keccak256("review-permissionless-agent");
        bytes32 commitment = keccak256(abi.encode(otherAgent, otherAgent, salt));
        vm.prank(otherAgent);
        gateway.commitAuthorization(commitment);
        vm.roll(block.number + 1);
        vm.prank(otherAgent);
        // Revealing for itself is the agent's consent; no signature (issue #1791).
        gateway.revealAuthorization(otherAgent, salt, policy, "");

        // The impostor really does hold AGENT_ROLE: the revert below is the
        // identity guard, not the role modifier. Read the role constants
        // before pranking so the staticcalls do not consume the prank.
        bytes32 agentRole = gateway.AGENT_ROLE();
        bytes32 committeeRole = ic.COMMITTEE_AGENT_ROLE();
        assertTrue(gateway.hasRole(agentRole, otherAgent));
        assertFalse(ic.hasRole(committeeRole, otherAgent));

        IInvestmentCommitteePolicy.VoteParams memory p = _defaultVoteParams();
        assertEq(p.agent, committeeAgent);
        vm.prank(otherAgent);
        vm.expectRevert(RobotMoneyGateway.CommitteeAgentNotCaller.selector);
        gateway.committeeVoteSubmit(p);

        assertEq(ic.voteCount(), 0, "spoofed vote must not be recorded");
        assertFalse(ic.hasRole(committeeRole, otherAgent));
    }
}
