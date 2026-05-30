// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Implements: docs/implementation-plan.md "Router-weight governance" phase
// Implements: issue #309, issue #496
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {PortfolioRouter} from "./PortfolioRouter.sol";

/// @title RouterGovernance
/// @notice Admin-weighted MVP governance module that controls Portfolio Router
///         target weights. ADMIN_ROLE assigns voting power to addresses, creates
///         proposals, and executes after quorum is reached and the execution
///         delay elapses. This is an MVP mock — voting power is admin-assigned,
///         not derived from token holdings. Token-holder voting is a future goal.
///
///         Design constraints (docs/architecture.md §2.3):
///         - Controls router weights only; cannot govern vault internals,
///           agent permissions, or protocol admin operations.
///         - Exposes proposal state, vote tallies, cadence metadata, and
///           resulting weights for rmpc and dapp reads.
///         - One active proposal at a time (simple linear cadence).
///
/// Emits: `ProposalCreated`, `VoteCast`, `ProposalExecuted`, `WeightsApplied`, `ProposalCancelled`.
contract RouterGovernance is AccessControl {
    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Grants voting power to addresses, creates proposals, sets params.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Basis-points denominator (10 000 = 100%).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Minimum quorum threshold. At least 1 vote must be required for
    ///         quorum so that proposals cannot pass with zero votes cast.
    uint256 public constant MIN_QUORUM_THRESHOLD = 1;

    /// @notice Minimum voting period in seconds (1 hour). Prevents proposals
    ///         from being created and immediately executed within the same block.
    uint64 public constant MIN_VOTING_PERIOD = 1 hours;

    // ─── Proposal state ──────────────────────────────────────────────────────

    enum ProposalState {
        /// Proposal is collecting votes.
        Active,
        /// Voting period ended; not enough votes reached quorum.
        Defeated,
        /// Quorum reached; waiting for execution delay to elapse.
        Queued,
        /// Executed: weights applied to the router.
        Executed,
        /// Cancelled by ADMIN_ROLE before execution.
        Cancelled
    }

    struct Proposal {
        /// Sequential proposal id (1-indexed).
        uint256 id;
        /// Address that submitted the proposal.
        address proposer;
        /// Proposed vault address list (parallel to bps).
        address[] vaults;
        /// Proposed weight bps list (must sum to BPS_DENOMINATOR).
        uint256[] bps;
        /// Block timestamp when voting period ends.
        uint64 votingDeadline;
        /// Block timestamp after which the proposal may be executed
        /// (= votingDeadline + executionDelay).
        uint64 executableAfter;
        /// Total voting power cast in favour.
        uint256 votesFor;
        /// Quorum threshold captured at propose() time. Changes to the live
        /// quorumThreshold storage variable do not retroactively affect this
        /// proposal — preventing both retroactive defeat and retroactive passage.
        uint256 snapshotQuorum;
        /// Whether the proposal has been executed.
        bool executed;
        /// Whether the proposal has been cancelled by ADMIN_ROLE.
        bool cancelled;
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @notice The Portfolio Router whose `setWeights` is called on execution.
    PortfolioRouter public immutable router;

    /// @notice Duration of the voting period in seconds.
    uint64 public votingPeriod;

    /// @notice Delay from voting deadline to earliest execution timestamp, in seconds.
    uint64 public executionDelay;

    /// @notice Minimum voting power that must vote FOR to reach quorum.
    uint256 public quorumThreshold;

    /// @notice Voting power per address. Assigned by ADMIN_ROLE.
    mapping(address => uint256) public votingPower;

    /// @notice Total voting power outstanding (sum of all assigned powers).
    uint256 public totalVotingPower;

    /// @dev Proposals by id (1-indexed; id 0 is never used).
    mapping(uint256 => Proposal) private _proposals;

    /// @dev Id of the currently active / queued / executed proposal.
    ///      0 = no proposal ever created.
    uint256 public currentProposalId;

    /// @dev Vote tracking: proposalId -> voter -> voted.
    mapping(uint256 => mapping(address => bool)) private _hasVoted;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when a new weight proposal is created.
    /// @param proposalId     Sequential proposal id.
    /// @param proposer       Address that created the proposal.
    /// @param vaults         Proposed vault addresses.
    /// @param bps            Proposed weight bps (parallel to vaults).
    /// @param votingDeadline Block timestamp when voting ends.
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        address[] vaults,
        uint256[] bps,
        uint64 votingDeadline
    );

    /// @notice Emitted when a voter casts a vote in favour.
    /// @param proposalId Proposal the vote was cast on.
    /// @param voter      Voter address.
    /// @param power      Voting power applied.
    /// @param totalFor   Running total of FOR votes after this cast.
    event VoteCast(
        uint256 indexed proposalId, address indexed voter, uint256 power, uint256 totalFor
    );

    /// @notice Emitted when a queued proposal is executed.
    /// @param proposalId Executed proposal id.
    /// @param executor   Address that called `execute`.
    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);

    /// @notice Emitted when the router weight vector is updated by this contract.
    /// @param proposalId Source proposal.
    /// @param vaults     New vault address list.
    /// @param bps        New weight bps list (parallel to vaults).
    event WeightsApplied(uint256 indexed proposalId, address[] vaults, uint256[] bps);

    /// @notice Emitted when a proposal is cancelled by ADMIN_ROLE.
    /// @param proposalId  Cancelled proposal id.
    /// @param cancelledBy Address that called `cancel`.
    event ProposalCancelled(uint256 indexed proposalId, address indexed cancelledBy);

    /// @notice Emitted when the quorum threshold is changed.
    event QuorumThresholdSet(uint256 oldThreshold, uint256 newThreshold);

    /// @notice Emitted when the voting period is changed.
    event VotingPeriodSet(uint64 oldPeriod, uint64 newPeriod);

    /// @notice Emitted when the execution delay is changed.
    event ExecutionDelaySet(uint64 oldDelay, uint64 newDelay);

    /// @notice Emitted when voting power is granted or revoked.
    event VotingPowerSet(address indexed voter, uint256 oldPower, uint256 newPower);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidWeightSum();
    error LengthMismatch();
    error NoActiveProposal();
    error ProposalNotActive();
    error AlreadyVoted();
    error NoVotingPower();
    error VotingStillOpen();
    error QuorumNotReached();
    error ExecutionDelayNotElapsed();
    error AlreadyExecuted();
    error ProposalDefeated();
    error ActiveProposalExists();
    /// @notice Thrown when cancel() is called on an already-executed proposal.
    error ProposalAlreadyExecuted();
    /// @notice Thrown when cancel() is called on an already-cancelled proposal.
    error ProposalAlreadyCancelled();
    /// @notice Thrown when execute() is called on a cancelled proposal.
    error ProposalIsCancelled();
    /// @notice Thrown when quorumThreshold is set below MIN_QUORUM_THRESHOLD.
    error QuorumBelowMinimum();
    /// @notice Thrown when votingPeriod is set below MIN_VOTING_PERIOD.
    error VotingPeriodBelowMinimum();
    /// @notice Thrown by propose() when a vault in the proposed weight list is
    ///         not router-eligible (zero address, unregistered, ineligible flag
    ///         not set, or wrong underlying asset). Identifies the offending
    ///         vault so the proposer can correct the weight vector before
    ///         resubmitting. Prevents governance deadlock from stuck Queued
    ///         proposals that would revert on execute().
    /// @param vault The vault address that failed the router-eligibility check.
    error VaultNotEligible(address vault);

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param _router          Portfolio Router whose weights this contract controls.
    /// @param _admin           Address that receives ADMIN_ROLE.
    /// @param _votingPeriod    Duration of the voting period in seconds.
    /// @param _executionDelay  Delay from voting end to earliest execution, in seconds.
    /// @param _quorumThreshold Minimum FOR voting power required for quorum.
    constructor(
        address _router,
        address _admin,
        uint64 _votingPeriod,
        uint64 _executionDelay,
        uint256 _quorumThreshold
    ) {
        if (_router == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }
        if (_quorumThreshold < MIN_QUORUM_THRESHOLD) revert QuorumBelowMinimum();
        if (_votingPeriod < MIN_VOTING_PERIOD) revert VotingPeriodBelowMinimum();
        router = PortfolioRouter(_router);
        votingPeriod = _votingPeriod;
        executionDelay = _executionDelay;
        quorumThreshold = _quorumThreshold;
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _grantRole(ADMIN_ROLE, _admin);
    }

    // ─── Admin: cadence parameters ────────────────────────────────────────────

    /// @notice Update the quorum threshold. Restricted to ADMIN_ROLE.
    ///         Reverts with QuorumBelowMinimum if threshold < MIN_QUORUM_THRESHOLD.
    function setQuorumThreshold(uint256 threshold) external onlyRole(ADMIN_ROLE) {
        if (threshold < MIN_QUORUM_THRESHOLD) revert QuorumBelowMinimum();
        emit QuorumThresholdSet(quorumThreshold, threshold);
        quorumThreshold = threshold;
    }

    /// @notice Update the voting period. Restricted to ADMIN_ROLE.
    ///         Reverts with VotingPeriodBelowMinimum if period < MIN_VOTING_PERIOD.
    function setVotingPeriod(uint64 period) external onlyRole(ADMIN_ROLE) {
        if (period < MIN_VOTING_PERIOD) revert VotingPeriodBelowMinimum();
        emit VotingPeriodSet(votingPeriod, period);
        votingPeriod = period;
    }

    /// @notice Update the execution delay. Restricted to ADMIN_ROLE.
    function setExecutionDelay(uint64 delay) external onlyRole(ADMIN_ROLE) {
        emit ExecutionDelaySet(executionDelay, delay);
        executionDelay = delay;
    }

    /// @notice Grant `power` voting weight to `voter`. Setting to 0 removes voting rights.
    ///         Restricted to ADMIN_ROLE.
    ///         NOTE: This is admin-assigned MVP governance — voting power is not derived
    ///         from token holdings. Token-holder voting is a future goal.
    function setVotingPower(address voter, uint256 power) external onlyRole(ADMIN_ROLE) {
        if (voter == address(0)) revert ZeroAddress();
        uint256 old = votingPower[voter];
        totalVotingPower = totalVotingPower - old + power;
        votingPower[voter] = power;
        emit VotingPowerSet(voter, old, power);
    }

    // ─── Admin: default (below-quorum fallback) weights ────────────────────────

    /// @notice Set the router's default (below-quorum fallback) weight vector,
    ///         forwarding to `PortfolioRouter.setDefaultWeights`. This is the
    ///         on-chain vector the router routes by — and the public allocation
    ///         surface renders — whenever no proposal is active or the most
    ///         recent proposal failed quorum. A passed vote overrides it; the
    ///         default itself stays put as the post-vote fallback. Restricted to
    ///         ADMIN_ROLE (Safe -> Timelock -> ADMIN_ROLE). ADR-0002.
    ///
    ///         The router enforces: ADMIN_ROLE on the router (this contract must
    ///         hold it), bps sum == BPS_DENOMINATOR, and length == the
    ///         registry's router-eligible vault count.
    /// @param vaults Ordered vault address list.
    /// @param bps    Parallel weight array (must sum to BPS_DENOMINATOR).
    function setDefaultWeights(address[] calldata vaults, uint256[] calldata bps)
        external
        onlyRole(ADMIN_ROLE)
    {
        router.setDefaultWeights(vaults, bps);
    }

    /// @notice Clear the router's voted weight vector and revert routing to the
    ///         default vector. Intended for governance to fall back to the
    ///         default after the most recent proposal failed quorum. Restricted
    ///         to ADMIN_ROLE. ADR-0002.
    function clearVotedWeights() external onlyRole(ADMIN_ROLE) {
        router.clearVotedWeights();
    }

    // ─── Governance: propose ─────────────────────────────────────────────────

    /// @notice Submit a new weight proposal. Restricted to ADMIN_ROLE.
    ///         Only one proposal may be active or queued at a time.
    ///         NOTE: Proposal creation is admin-only in this MVP mock.
    ///         Public proposal submission is a future goal.
    /// @param vaults  Ordered vault address list.
    /// @param bps     Parallel weight array; must sum to BPS_DENOMINATOR.
    function propose(address[] calldata vaults, uint256[] calldata bps)
        external
        onlyRole(ADMIN_ROLE)
        returns (uint256 proposalId)
    {
        if (vaults.length != bps.length) revert LengthMismatch();

        // Validate weight sum.
        uint256 total;
        for (uint256 i = 0; i < bps.length; i++) {
            total += bps[i];
        }
        if (total != BPS_DENOMINATOR) revert InvalidWeightSum();

        // Validate each vault's router eligibility before entering Active state.
        // Prevents governance deadlock from proposals that would permanently
        // fail on execute() because router.setWeights() reverts on ineligible
        // vaults (zero address, unregistered, or eligibility flag not set).
        for (uint256 i = 0; i < vaults.length; i++) {
            if (!router.isRouterEligible(vaults[i])) {
                revert VaultNotEligible(vaults[i]);
            }
        }

        // Only one active/queued proposal at a time.
        // Defeated and Cancelled proposals do not block new proposals.
        if (currentProposalId != 0) {
            ProposalState s = _state(currentProposalId);
            if (s == ProposalState.Active || s == ProposalState.Queued) {
                revert ActiveProposalExists();
            }
        }

        proposalId = currentProposalId + 1;
        currentProposalId = proposalId;

        uint64 deadline = uint64(block.timestamp) + votingPeriod;
        uint64 execAfter = deadline + executionDelay;

        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.votingDeadline = deadline;
        p.executableAfter = execAfter;
        p.snapshotQuorum = quorumThreshold;

        // Copy arrays into storage.
        for (uint256 i = 0; i < vaults.length; i++) {
            p.vaults.push(vaults[i]);
            p.bps.push(bps[i]);
        }

        emit ProposalCreated(proposalId, msg.sender, vaults, bps, deadline);
    }

    // ─── Governance: cancel ──────────────────────────────────────────────────

    /// @notice Cancel any non-executed proposal. Restricted to ADMIN_ROLE.
    ///         Transitions the proposal to Cancelled state and emits
    ///         ProposalCancelled. A Cancelled proposal cannot be executed and
    ///         does not block subsequent propose() calls, providing an on-chain
    ///         escape from governance deadlock (e.g., a vault in the weight
    ///         vector loses router eligibility after the proposal is Queued).
    /// @param proposalId Id of the proposal to cancel.
    function cancel(uint256 proposalId) external onlyRole(ADMIN_ROLE) {
        Proposal storage p = _proposals[proposalId];
        if (p.id == 0) revert NoActiveProposal();
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();

        p.cancelled = true;

        emit ProposalCancelled(proposalId, msg.sender);
    }

    // ─── Governance: vote ────────────────────────────────────────────────────

    /// @notice Cast a FOR vote on the currently active proposal.
    ///         Caller must have voting power assigned by ADMIN_ROLE.
    function vote(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        if (p.id == 0) revert NoActiveProposal();
        if (_state(proposalId) != ProposalState.Active) revert ProposalNotActive();
        if (_hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        uint256 power = votingPower[msg.sender];
        if (power == 0) revert NoVotingPower();

        _hasVoted[proposalId][msg.sender] = true;
        p.votesFor += power;

        emit VoteCast(proposalId, msg.sender, power, p.votesFor);
    }

    // ─── Governance: execute ─────────────────────────────────────────────────

    /// @notice Execute a queued proposal — call `router.setWeights` with the
    ///         proposed weight vector. Anyone may call once quorum is reached
    ///         and the execution delay has elapsed.
    function execute(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        if (p.id == 0) revert NoActiveProposal();
        if (p.executed) revert AlreadyExecuted();

        ProposalState s = _state(proposalId);
        if (s == ProposalState.Cancelled) revert ProposalIsCancelled();
        if (s == ProposalState.Active) {
            // Voting period still open.
            if (block.timestamp <= p.votingDeadline) revert VotingStillOpen();
            // Voting closed but quorum not reached.
            revert QuorumNotReached();
        }
        if (s == ProposalState.Defeated) revert QuorumNotReached();
        if (s == ProposalState.Queued) {
            if (block.timestamp < p.executableAfter) revert ExecutionDelayNotElapsed();
        }
        if (s == ProposalState.Executed) revert AlreadyExecuted();

        p.executed = true;

        // Apply weights to the Portfolio Router.
        router.setWeights(p.vaults, p.bps);

        emit ProposalExecuted(proposalId, msg.sender);
        emit WeightsApplied(proposalId, p.vaults, p.bps);
    }

    // ─── Read surface ────────────────────────────────────────────────────────

    /// @notice Return the current state of a proposal.
    function proposalState(uint256 proposalId) external view returns (ProposalState) {
        if (_proposals[proposalId].id == 0) revert NoActiveProposal();
        return _state(proposalId);
    }

    /// @notice Return the full proposal struct for inspection.
    function activeProposal()
        external
        view
        returns (
            uint256 id,
            address proposer,
            address[] memory vaults,
            uint256[] memory bps,
            uint64 votingDeadline,
            uint64 executableAfter,
            uint256 votesFor,
            uint256 snapshotQuorum,
            bool executed,
            bool cancelled
        )
    {
        uint256 pid = currentProposalId;
        if (pid == 0) revert NoActiveProposal();
        Proposal storage p = _proposals[pid];
        return (
            p.id,
            p.proposer,
            p.vaults,
            p.bps,
            p.votingDeadline,
            p.executableAfter,
            p.votesFor,
            p.snapshotQuorum,
            p.executed,
            p.cancelled
        );
    }

    /// @notice Return cadence parameters in one call for rmpc/dapp reads.
    function cadenceParams()
        external
        view
        returns (
            uint64 _votingPeriod,
            uint64 _executionDelay,
            uint256 _quorumThreshold,
            uint256 _totalVotingPower
        )
    {
        return (votingPeriod, executionDelay, quorumThreshold, totalVotingPower);
    }

    /// @notice Return the current Portfolio Router weight vector directly.
    function currentWeights()
        external
        view
        returns (address[] memory vaults, uint256[] memory bps)
    {
        return router.getWeights();
    }

    /// @notice Whether `voter` has already voted on `proposalId`.
    function hasVoted(uint256 proposalId, address voter) external view returns (bool) {
        return _hasVoted[proposalId][voter];
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    /// @dev Compute proposal state without requiring `id != 0`.
    function _state(uint256 proposalId) internal view returns (ProposalState) {
        Proposal storage p = _proposals[proposalId];
        if (p.cancelled) return ProposalState.Cancelled;
        if (p.executed) return ProposalState.Executed;

        if (block.timestamp <= p.votingDeadline) {
            return ProposalState.Active;
        }

        // Voting ended — check quorum against snapshot taken at propose() time.
        if (p.votesFor < p.snapshotQuorum) {
            return ProposalState.Defeated;
        }

        return ProposalState.Queued;
    }
}
