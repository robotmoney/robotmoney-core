// SPDX-License-Identifier: MIT
// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §3 — New contract + refactor
// Canonical: docs/architecture.md — Investment Committee Policy
// Implements: issue #1044 — Investment Committee v0
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title InvestmentCommitteePolicy
/// @notice Registry of admin-allowlisted committee agents and their signed
///         allocation votes over the existing four-vault model.
///
/// Design constraints (docs/product/20260623-product-proposal-investment-committee-v0.md §3):
/// - All committee actions are **signalling only**: no treasury spend, no
///   direct router-weight mutation. See `testSignallingOnlyBoundary`.
/// - Membership is admin-gated. ADMIN_ROLE allowlists agents; permissionless
///   onboarding is v1+.
/// - All writes (register / vote) must pass through the RobotMoneyGateway
///   (the `onlyGateway` modifier). The committee does not get a side channel.
/// - Votes are recorded on-chain by their schema-validated JSON hash plus the
///   full fixed-shape fields so third-party consumers can reconstruct audit
///   trails without re-reading the gateway.
///
/// Vote JSON schema (committed at tests/fixtures/committee-vote.schema.json):
///   agent_id, vault, stance, target_weight_bps, confidence, rationale_uri,
///   prompt_hash, inputs_digest, timestamp, schema_version.
///
/// Emits: `AgentRegistered`, `AgentRevoked`, `VoteSubmitted`.
contract InvestmentCommitteePolicy is AccessControl, ReentrancyGuard {
    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Grants/revokes COMMITTEE_AGENT_ROLE; revokeAgent; addGateway.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Held by allowlisted committee agent addresses.
    bytes32 public constant COMMITTEE_AGENT_ROLE = keccak256("COMMITTEE_AGENT_ROLE");

    // ─── Errors ──────────────────────────────────────────────────────────────

    /// @notice Constructor passed `address(0)` for admin or gateway.
    error ZeroAddress();
    /// @notice Caller is not the registered RobotMoneyGateway.
    error CallerNotGateway();
    /// @notice `submitVote` called by an address without COMMITTEE_AGENT_ROLE.
    error AgentNotAllowlisted();
    /// @notice `submitVote` called with an empty `voteJsonHash`.
    error EmptyVoteHash();
    /// @notice `submitVote` called with an invalid stance (must be 0/1/2).
    error InvalidStance();
    /// @notice `submitVote` called with `targetWeightBps > 10_000`.
    error WeightExceedsBps();
    /// @notice `submitVote` called with `confidence > 100`.
    error ConfidenceOutOfRange();
    /// @notice `submitVote` called with an empty `rationaleUri`.
    error EmptyRationaleUri();
    /// @notice `submitVote` called with an empty `vault` address.
    error ZeroVaultAddress();

    // ─── Types ───────────────────────────────────────────────────────────────

    /// @notice Allocation stance for a single vault.
    /// @dev Must remain 3 values in this order — the Rust ABI binding and the
    ///      vote JSON schema both encode Overweight=0, Neutral=1, Underweight=2.
    enum Stance {
        Overweight,
        Neutral,
        Underweight
    }

    /// @notice A single on-chain vote record.
    /// @param agent            Address of the committee agent.
    /// @param vault            Target vault address (one of the four PRD §11 vaults).
    /// @param stance           Overweight / Neutral / Underweight.
    /// @param targetWeightBps  Target allocation weight in basis points (0–10 000).
    /// @param confidence       Confidence score 0–100.
    /// @param rationaleUri     Public URI to the narrative CoT / memo (gist, pastebin, etc.).
    /// @param voteJsonHash     keccak256 of the full vote JSON (schema-validated off-chain).
    /// @param promptHash       keccak256 of the agent prompt used.
    /// @param inputsDigest     keccak256 of the inputs consumed.
    /// @param schemaVersion    Vote JSON schema version string (e.g. "1.0").
    /// @param timestamp        Unix seconds when the vote was formed (agent-supplied).
    /// @param submittedAt      Block timestamp when the vote was registered on-chain.
    struct Vote {
        address agent;
        address vault;
        Stance stance;
        uint16 targetWeightBps;
        uint8 confidence;
        string rationaleUri;
        bytes32 voteJsonHash;
        bytes32 promptHash;
        bytes32 inputsDigest;
        string schemaVersion;
        uint64 timestamp;
        uint64 submittedAt;
    }

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when ADMIN_ROLE registers a committee agent.
    /// @param agent    The newly allowlisted agent address.
    /// @param agentId  Human-readable identifier for the agent (e.g. "athena-v1").
    event AgentRegistered(address indexed agent, string agentId);

    /// @notice Emitted when ADMIN_ROLE revokes a committee agent.
    event AgentRevoked(address indexed agent);

    /// @notice Emitted when an allowlisted agent submits a signed vote.
    event VoteSubmitted(
        uint256 indexed voteId,
        address indexed agent,
        address indexed vault,
        Stance stance,
        uint16 targetWeightBps,
        uint8 confidence,
        string rationaleUri,
        bytes32 voteJsonHash,
        uint64 timestamp
    );

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice The RobotMoneyGateway address. All committee writes must originate here.
    address public immutable gateway;

    /// @notice Human-readable label for each registered agent.
    mapping(address => string) public agentId;

    /// @notice Ordered list of all submitted votes (append-only).
    Vote[] private _votes;

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param admin_    Address granted DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
    /// @param gateway_  Address of the deployed RobotMoneyGateway.
    constructor(address admin_, address gateway_) {
        if (admin_ == address(0) || gateway_ == address(0)) revert ZeroAddress();
        gateway = gateway_;

        // Pin COMMITTEE_AGENT_ROLE administration to ADMIN_ROLE so it survives
        // the standard deploy-handover pattern (same as gateway pattern).
        _setRoleAdmin(COMMITTEE_AGENT_ROLE, ADMIN_ROLE);

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
    }

    // ─── Modifiers ───────────────────────────────────────────────────────────

    /// @dev Reverts unless `msg.sender` is the registered RobotMoneyGateway.
    ///      This is the primary defence ensuring every committee action passes
    ///      through the gateway's agent-policy enforcement layer.
    modifier onlyGateway() {
        if (msg.sender != gateway) revert CallerNotGateway();
        _;
    }

    // ─── Admin surface ───────────────────────────────────────────────────────

    /// @notice Allowlist a committee agent. Only ADMIN_ROLE.
    /// @param agent    Address to grant COMMITTEE_AGENT_ROLE.
    /// @param agentId_ Human-readable label (e.g. "athena-v1", "robot-money", "woon").
    function registerAgent(address agent, string calldata agentId_) external onlyRole(ADMIN_ROLE) {
        if (agent == address(0)) revert ZeroAddress();
        agentId[agent] = agentId_;
        _grantRole(COMMITTEE_AGENT_ROLE, agent);
        emit AgentRegistered(agent, agentId_);
    }

    /// @notice Remove a committee agent from the allowlist. Only ADMIN_ROLE.
    /// @param agent Address to revoke COMMITTEE_AGENT_ROLE from.
    function revokeAgent(address agent) external onlyRole(ADMIN_ROLE) {
        _revokeRole(COMMITTEE_AGENT_ROLE, agent);
        delete agentId[agent];
        emit AgentRevoked(agent);
    }

    // ─── Committee vote surface ───────────────────────────────────────────────

    /// @notice Calldata bundle for `submitVote`. Passed as a struct to keep
    ///         the stack frame below the EVM's 16-slot limit.
    struct VoteParams {
        address agent;
        address vault;
        Stance stance;
        uint16 targetWeightBps;
        uint8 confidence;
        string rationaleUri;
        bytes32 voteJsonHash;
        bytes32 promptHash;
        bytes32 inputsDigest;
        string schemaVersion;
        uint64 timestamp;
    }

    /// @notice Submit a signed allocation vote for a vault.
    ///         Must be called via the RobotMoneyGateway (`onlyGateway`).
    ///
    /// @param p    All vote fields packed into a `VoteParams` struct to keep
    ///             the stack frame within the EVM's 16-slot limit.
    /// @return voteId  Index of the newly appended vote.
    function submitVote(VoteParams calldata p) external onlyGateway nonReentrant returns (uint256 voteId) {
        if (!hasRole(COMMITTEE_AGENT_ROLE, p.agent)) revert AgentNotAllowlisted();
        if (p.voteJsonHash == bytes32(0)) revert EmptyVoteHash();
        if (uint8(p.stance) > 2) revert InvalidStance();
        if (p.targetWeightBps > 10_000) revert WeightExceedsBps();
        if (p.confidence > 100) revert ConfidenceOutOfRange();
        if (bytes(p.rationaleUri).length == 0) revert EmptyRationaleUri();
        if (p.vault == address(0)) revert ZeroVaultAddress();

        voteId = _votes.length;
        _votes.push(
            Vote({
                agent: p.agent,
                vault: p.vault,
                stance: p.stance,
                targetWeightBps: p.targetWeightBps,
                confidence: p.confidence,
                rationaleUri: p.rationaleUri,
                voteJsonHash: p.voteJsonHash,
                promptHash: p.promptHash,
                inputsDigest: p.inputsDigest,
                schemaVersion: p.schemaVersion,
                timestamp: p.timestamp,
                submittedAt: uint64(block.timestamp)
            })
        );

        emit VoteSubmitted(
            voteId,
            p.agent,
            p.vault,
            p.stance,
            p.targetWeightBps,
            p.confidence,
            p.rationaleUri,
            p.voteJsonHash,
            p.timestamp
        );
    }

    // ─── Read surface ────────────────────────────────────────────────────────

    /// @notice Total number of submitted votes.
    function voteCount() external view returns (uint256) {
        return _votes.length;
    }

    /// @notice Retrieve a single vote by index.
    function getVote(uint256 voteId) external view returns (Vote memory) {
        return _votes[voteId];
    }

    /// @notice Latest vote index for a given agent, or type(uint256).max if none.
    function latestVoteByAgent(address agent) external view returns (uint256) {
        uint256 len = _votes.length;
        for (uint256 i = len; i > 0; ) {
            unchecked {
                i--;
            }
            if (_votes[i].agent == agent) return i;
        }
        return type(uint256).max;
    }

    // ─── Signalling-only boundary (issue #1044 AC-4) ─────────────────────────
    //
    // This contract intentionally has NO treasury-spend functions and NO
    // router-weight setters. It holds no ERC-20 balances and cannot call
    // `RouterGovernance.execute()` or `RobotMoneyGateway.deposit()`.
    // The signalling-only constraint is verified by the test suite:
    // InvestmentCommitteePolicyTest.testSignallingOnlyBoundary.
}
