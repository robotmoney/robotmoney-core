// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md — Investment Committee Policy
// Implements: issue #1048 — InvestmentCommitteePolicy.sol interface
pragma solidity ^0.8.24;

/// @title IInvestmentCommitteePolicy
/// @notice Interface for the InvestmentCommitteePolicy contract.
///
/// Design constraints (docs/product/20260623-product-proposal-investment-committee-v0.md §3):
/// - All committee actions are **signalling only**: no treasury spend, no direct
///   router-weight mutation.
/// - Membership is admin-gated (ADMIN_ROLE). Permissionless onboarding is v1+.
/// - All writes (register / voteSubmit) must be called through the
///   RobotMoneyGateway (enforced by the `onlyGateway` modifier on the
///   implementation).
interface IInvestmentCommitteePolicy {
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

    /// @notice Calldata bundle for `submitVote`.
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

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when ADMIN_ROLE registers a committee agent.
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

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error CallerNotGateway();
    error AgentNotAllowlisted();
    error EmptyVoteHash();
    error InvalidStance();
    error WeightExceedsBps();
    error ConfidenceOutOfRange();
    error EmptyRationaleUri();
    error ZeroVaultAddress();

    // ─── Admin surface ───────────────────────────────────────────────────────

    /// @notice Allowlist a committee agent. Only ADMIN_ROLE.
    /// @param agent    Address to grant COMMITTEE_AGENT_ROLE.
    /// @param agentId_ Human-readable label (e.g. "athena-v1").
    function registerAgent(address agent, string calldata agentId_) external;

    /// @notice Remove a committee agent from the allowlist. Only ADMIN_ROLE.
    /// @param agent Address to revoke COMMITTEE_AGENT_ROLE from.
    function revokeAgent(address agent) external;

    // ─── Committee vote surface ───────────────────────────────────────────────

    /// @notice Submit a signed allocation vote for a vault.
    ///         Must be called via the RobotMoneyGateway.
    /// @param p All vote fields packed into a `VoteParams` struct.
    /// @return voteId Index of the newly appended vote.
    function submitVote(VoteParams calldata p) external returns (uint256 voteId);

    // ─── Read surface ────────────────────────────────────────────────────────

    /// @notice Total number of submitted votes.
    function voteCount() external view returns (uint256);

    /// @notice Retrieve a single vote by index.
    function getVote(uint256 voteId) external view returns (Vote memory);

    /// @notice Latest vote index for a given agent, or type(uint256).max if none.
    function latestVoteByAgent(address agent) external view returns (uint256);

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice The RobotMoneyGateway address. All committee writes must originate here.
    function gateway() external view returns (address);

    /// @notice Human-readable label for each registered agent.
    function agentId(address agent) external view returns (string memory);
}
