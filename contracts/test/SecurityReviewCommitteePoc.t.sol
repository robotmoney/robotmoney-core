// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICGatewayIntegration} from "./ICGatewayIntegration.t.sol";
import {IInvestmentCommitteePolicy} from "../gateway/interfaces/IInvestmentCommitteePolicy.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";

contract SecurityReviewCommitteePoc is ICGatewayIntegration {
    /// Remediated by core 1790 (PR 1818): `committeeVoteSubmit` binds `p.agent` to
    /// `msg.sender`, so a self-registered gateway agent carrying the allowlisted
    /// member's address in calldata is refused before the IC contract sees the vote.
    function test_selfRegisteredAgentCannotImpersonateCommitteeMember() public {
        address otherAgent = address(0xB2);
        // A gateway agent without committee membership self-registers through the
        // permissionless commit/reveal path and submits a vote carrying the
        // allowlisted committeeAgent's address in calldata.
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
        gateway.revealAuthorization(otherAgent, salt, policy);
        assertFalse(ic.hasRole(ic.COMMITTEE_AGENT_ROLE(), otherAgent));
        IInvestmentCommitteePolicy.VoteParams memory p = _defaultVoteParams();
        assertEq(p.agent, committeeAgent);
        vm.prank(otherAgent);
        vm.expectRevert(RobotMoneyGateway.CommitteeAgentNotCaller.selector);
        gateway.committeeVoteSubmit(p);
        assertEq(ic.voteCount(), 0, "spoofed vote must not be recorded");
    }
}
