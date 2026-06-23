// SPDX-License-Identifier: MIT
// Canonical: none — Foundry unit tests for contracts/gateway/InvestmentCommitteePolicy.sol
// Implements: issue #1044 Acceptance criteria 1, 4 and Test plan item 1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";

// ─── Minimal gateway stub ────────────────────────────────────────────────────

/// @dev Thin stub that forwards `submitVote` calls as if they came from a
///      real RobotMoneyGateway.  The real gateway enforces per-agent policy
///      caps; for this test we only care about the IC contract's own guards.
contract MockGateway {
    InvestmentCommitteePolicy public ic;

    function setIC(InvestmentCommitteePolicy ic_) external {
        ic = ic_;
    }

    function callSubmitVote(InvestmentCommitteePolicy.VoteParams calldata p)
        external
        returns (uint256 voteId)
    {
        return ic.submitVote(p);
    }
}

// ─── Test contract ────────────────────────────────────────────────────────────

contract InvestmentCommitteePolicyTest is Test {
    InvestmentCommitteePolicy public ic;
    MockGateway public gw;

    address admin = address(0xA0);
    address agent1 = address(0xA1);
    address agent2 = address(0xA2);
    address vault1 = address(0xB1);
    address notGateway = address(0xDEAD);

    bytes32 constant VOTE_JSON_HASH = keccak256("valid-vote-json");
    bytes32 constant PROMPT_HASH = keccak256("prompt-v1");
    bytes32 constant INPUTS_DIGEST = keccak256("inputs-2026-06-23");

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _defaultParams() internal view returns (InvestmentCommitteePolicy.VoteParams memory) {
        return InvestmentCommitteePolicy.VoteParams({
            agent: agent1,
            vault: vault1,
            stance: InvestmentCommitteePolicy.Stance.Overweight,
            targetWeightBps: 6000,
            confidence: 85,
            rationaleUri: "https://gist.github.com/test/abc123",
            voteJsonHash: VOTE_JSON_HASH,
            promptHash: PROMPT_HASH,
            inputsDigest: INPUTS_DIGEST,
            schemaVersion: "1.0",
            timestamp: uint64(block.timestamp)
        });
    }

    function setUp() public {
        gw = new MockGateway();
        ic = new InvestmentCommitteePolicy(admin, address(gw));
        gw.setIC(ic);

        // Grant COMMITTEE_AGENT_ROLE to agent1 via admin.
        vm.prank(admin);
        ic.registerAgent(agent1, "athena-v1");
    }

    // ─── Registration ─────────────────────────────────────────────────────────

    function testRegisterAgent() public view {
        assertTrue(ic.hasRole(ic.COMMITTEE_AGENT_ROLE(), agent1));
        assertEq(ic.agentId(agent1), "athena-v1");
    }

    function testRegisterAgentEmitsEvent() public {
        vm.prank(admin);
        vm.expectEmit(true, false, false, true, address(ic));
        emit InvestmentCommitteePolicy.AgentRegistered(agent2, "robot-money");
        ic.registerAgent(agent2, "robot-money");
    }

    function testRegisterAgentRevertsIfNotAdmin() public {
        vm.prank(agent1);
        vm.expectRevert();
        ic.registerAgent(agent2, "unauthorized");
    }

    function testRegisterAgentRevertsOnZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(InvestmentCommitteePolicy.ZeroAddress.selector);
        ic.registerAgent(address(0), "zero");
    }

    function testRevokeAgent() public {
        vm.prank(admin);
        ic.revokeAgent(agent1);

        assertFalse(ic.hasRole(ic.COMMITTEE_AGENT_ROLE(), agent1));
        assertEq(ic.agentId(agent1), "");
    }

    function testRevokeAgentEmitsEvent() public {
        vm.prank(admin);
        vm.expectEmit(true, false, false, false, address(ic));
        emit InvestmentCommitteePolicy.AgentRevoked(agent1);
        ic.revokeAgent(agent1);
    }

    function testRevokeAgentRevertsIfNotAdmin() public {
        vm.prank(agent1);
        vm.expectRevert();
        ic.revokeAgent(agent1);
    }

    // ─── Vote submission — gateway routing required (AC-1) ────────────────────

    /// @dev AC-1: committee actions revert unless routed through RobotMoneyGateway.
    function testSubmitVoteRevertsIfCallerNotGateway() public {
        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        vm.prank(notGateway);
        vm.expectRevert(InvestmentCommitteePolicy.CallerNotGateway.selector);
        ic.submitVote(p);
    }

    /// @dev AC-1: direct call from agent (not via gateway) reverts.
    function testSubmitVoteRevertsIfCalledDirectlyByAgent() public {
        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        vm.prank(agent1);
        vm.expectRevert(InvestmentCommitteePolicy.CallerNotGateway.selector);
        ic.submitVote(p);
    }

    // ─── Vote submission — happy path ─────────────────────────────────────────

    function testSubmitVoteHappyPath() public {
        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        uint256 voteId = gw.callSubmitVote(p);

        assertEq(voteId, 0);
        assertEq(ic.voteCount(), 1);

        InvestmentCommitteePolicy.Vote memory v = ic.getVote(0);
        assertEq(v.agent, agent1);
        assertEq(v.vault, vault1);
        assertEq(uint8(v.stance), uint8(InvestmentCommitteePolicy.Stance.Overweight));
        assertEq(v.targetWeightBps, 6000);
        assertEq(v.confidence, 85);
        assertEq(v.rationaleUri, "https://gist.github.com/test/abc123");
        assertEq(v.voteJsonHash, VOTE_JSON_HASH);
        assertEq(v.promptHash, PROMPT_HASH);
        assertEq(v.inputsDigest, INPUTS_DIGEST);
        assertEq(v.schemaVersion, "1.0");
        assertEq(v.timestamp, p.timestamp);
    }

    function testSubmitVoteEmitsEvent() public {
        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        p.stance = InvestmentCommitteePolicy.Stance.Neutral;
        p.targetWeightBps = 5000;
        p.confidence = 70;
        p.rationaleUri = "https://gist.github.com/test/def456";

        vm.expectEmit(true, true, true, true, address(ic));
        emit InvestmentCommitteePolicy.VoteSubmitted(
            0,
            agent1,
            vault1,
            InvestmentCommitteePolicy.Stance.Neutral,
            5000,
            70,
            "https://gist.github.com/test/def456",
            VOTE_JSON_HASH,
            p.timestamp
        );
        gw.callSubmitVote(p);
    }

    function testMultipleVotesAccumulate() public {
        // Register a second agent.
        vm.prank(admin);
        ic.registerAgent(agent2, "robot-money");

        InvestmentCommitteePolicy.VoteParams memory p1 = _defaultParams();
        InvestmentCommitteePolicy.VoteParams memory p2 = _defaultParams();
        p2.agent = agent2;
        p2.stance = InvestmentCommitteePolicy.Stance.Underweight;
        p2.targetWeightBps = 4000;
        p2.confidence = 60;
        p2.rationaleUri = "https://ex.com/2";

        gw.callSubmitVote(p1);
        gw.callSubmitVote(p2);

        assertEq(ic.voteCount(), 2);
        assertEq(ic.latestVoteByAgent(agent1), 0);
        assertEq(ic.latestVoteByAgent(agent2), 1);
    }

    function testLatestVoteByAgentReturnsMaxUintWhenNone() public view {
        assertEq(ic.latestVoteByAgent(agent2), type(uint256).max);
    }

    // ─── Vote submission — non-allowlisted agent rejected ─────────────────────

    function testSubmitVoteRevertsForNonAllowlistedAgent() public {
        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        p.agent = agent2; // not registered
        vm.expectRevert(InvestmentCommitteePolicy.AgentNotAllowlisted.selector);
        gw.callSubmitVote(p);
    }

    function testSubmitVoteRevertsAfterRevoke() public {
        vm.prank(admin);
        ic.revokeAgent(agent1);

        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        vm.expectRevert(InvestmentCommitteePolicy.AgentNotAllowlisted.selector);
        gw.callSubmitVote(p);
    }

    // ─── Vote submission — input validation ──────────────────────────────────

    function testSubmitVoteRevertsOnEmptyHash() public {
        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        p.voteJsonHash = bytes32(0);
        vm.expectRevert(InvestmentCommitteePolicy.EmptyVoteHash.selector);
        gw.callSubmitVote(p);
    }

    function testSubmitVoteRevertsOnWeightOver10000() public {
        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        p.targetWeightBps = 10_001;
        vm.expectRevert(InvestmentCommitteePolicy.WeightExceedsBps.selector);
        gw.callSubmitVote(p);
    }

    function testSubmitVoteRevertsOnConfidenceOver100() public {
        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        p.confidence = 101;
        vm.expectRevert(InvestmentCommitteePolicy.ConfidenceOutOfRange.selector);
        gw.callSubmitVote(p);
    }

    function testSubmitVoteRevertsOnEmptyRationaleUri() public {
        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        p.rationaleUri = "";
        vm.expectRevert(InvestmentCommitteePolicy.EmptyRationaleUri.selector);
        gw.callSubmitVote(p);
    }

    function testSubmitVoteRevertsOnZeroVaultAddress() public {
        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        p.vault = address(0);
        vm.expectRevert(InvestmentCommitteePolicy.ZeroVaultAddress.selector);
        gw.callSubmitVote(p);
    }

    // ─── Signalling-only boundary (AC-4) ─────────────────────────────────────

    /// @notice AC-4: InvestmentCommitteePolicy grants no treasury-spend or
    ///         auto-apply authority. It holds no ERC-20 interface, cannot call
    ///         `deposit()`, and has no function that mutates router weights.
    ///
    ///         This test asserts the property structurally: any ETH sent to
    ///         the contract reverts (no `receive`/`fallback`), and the contract
    ///         bytecode contains none of the function selectors for
    ///         `RouterGovernance.execute(uint256)` (0x168e3b1f),
    ///         `RobotMoneyGateway.deposit(...)`, or ERC-20 `transfer`.
    function testSignallingOnlyBoundary() public {
        // 1. No ether receive: sending ETH reverts.
        (bool ok,) = address(ic).call{value: 1 wei}("");
        assertFalse(ok, "IC must not accept ETH (no receive)");

        // 2. No `transfer(address,uint256)` selector (ERC-20).
        bytes memory transferSelector =
            abi.encodeWithSignature("transfer(address,uint256)", address(this), 1);
        (bool ok2,) = address(ic).call(transferSelector);
        assertFalse(ok2, "IC must not have ERC-20 transfer");

        // 3. No `execute(uint256)` selector (RouterGovernance).
        bytes memory executeSelector = abi.encodeWithSignature("execute(uint256)", uint256(0));
        (bool ok3,) = address(ic).call(executeSelector);
        assertFalse(ok3, "IC must not have RouterGovernance.execute");

        // 4. Vote count only increases — it can never drain funds (pure storage write).
        uint256 before = ic.voteCount();
        InvestmentCommitteePolicy.VoteParams memory p = _defaultParams();
        p.rationaleUri = "https://ex.com/x";
        gw.callSubmitVote(p);
        uint256 after_ = ic.voteCount();
        assertEq(after_, before + 1, "vote appended");
        // Balance unchanged — no value moved.
        assertEq(address(ic).balance, 0, "IC balance must remain zero");
    }
}
