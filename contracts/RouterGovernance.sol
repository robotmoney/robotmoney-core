// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// (See also: docs/prd.md §5 — Multi-vault product direction)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VaultRegistry} from "./VaultRegistry.sol";
import {PortfolioRouter} from "./PortfolioRouter.sol";

/// @title RouterGovernance
/// @notice RM-token weight-vote module that gives RM holders on-chain control
///         over Portfolio Router target weights.
///
/// Flow:
///   1. An RM holder calls `propose(vaults, bps)` to submit a new weight vector.
///      Vote weight is snapshotted at the proposal block.
///   2. RM holders call `vote(proposalId)`. Each holder may vote once, weighted
///      by their RM `balanceOf` at the snapshot block.
///   3. After `executionDelay` seconds and once quorum is reached, anyone calls
///      `execute(proposalId)`. The router's weights are updated via
///      `PortfolioRouter.setWeights`.
///   4. A proposal expires if quorum is not reached within `cadenceWindow` seconds.
///
/// Events: ProposalCreated, VoteCast, ProposalExecuted, WeightsApplied.
///
/// Canonical: docs/architecture.md §2.3
contract RouterGovernance {
    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Basis-points denominator (10 000 = 100%).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ─── Proposal state ──────────────────────────────────────────────────────

    /// @notice Lifecycle status of a proposal.
    enum ProposalState {
        Active, // Voting ongoing; quorum not yet reached or delay not elapsed.
        Succeeded, // Quorum reached and execution delay elapsed; ready to execute.
        Executed, // Weights applied to the Portfolio Router.
        Expired // Cadence window elapsed without quorum.
    }

    /// @notice Full on-chain record for a single weight proposal.
    /// @param proposer       Address that submitted the proposal.
    /// @param vaults         Ordered vault list proposed.
    /// @param bps            Parallel weight bps proposed.
    /// @param snapshotBlock  Block at which RM balances are snapshotted for vote weight.
    /// @param createdAt      Timestamp when the proposal was created.
    /// @param totalVotes     Running sum of weighted votes cast.
    /// @param executed       True once `execute()` has been called and succeeded.
    struct Proposal {
        address proposer;
        address[] vaults;
        uint256[] bps;
        uint256 snapshotBlock;
        uint256 createdAt;
        uint256 totalVotes;
        bool executed;
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @notice The RM token; `balanceOf(account)` at snapshot block determines vote weight.
    IERC20 public immutable rmToken;

    /// @notice VaultRegistry used to validate proposed vault addresses.
    VaultRegistry public immutable registry;

    /// @notice Portfolio Router whose weights are updated upon execution.
    PortfolioRouter public immutable router;

    /// @notice Total RM supply at deploy time, used as quorum denominator.
    ///         Stored once to avoid repeated token calls in governance math.
    uint256 public immutable totalRmSupply;

    /// @notice Minimum fraction of total RM supply that must vote for quorum, in bps.
    ///         Default: 5 100 = 51%.
    uint256 public quorumBps;

    /// @notice Seconds that must elapse after proposal creation before execution.
    uint256 public executionDelay;

    /// @notice Seconds within which quorum must be reached before expiry.
    uint256 public cadenceWindow;

    /// @notice Monotonically incrementing proposal id counter.
    uint256 public proposalCount;

    /// @notice The proposal id currently accepting votes (0 = none).
    uint256 public activeProposalId;

    /// @notice All proposals indexed by id (1-based).
    mapping(uint256 => Proposal) private _proposals;

    /// @notice Whether a given address has voted on a given proposal.
    mapping(uint256 => mapping(address => bool)) private _hasVoted;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when a new weight proposal is created.
    /// @param proposalId     Proposal identifier.
    /// @param proposer       Address that submitted the proposal.
    /// @param vaults         Proposed vault list.
    /// @param bps            Proposed weight array.
    /// @param snapshotBlock  Block at which RM balances are snapshotted.
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        address[] vaults,
        uint256[] bps,
        uint256 snapshotBlock
    );

    /// @notice Emitted when an RM holder casts a vote.
    /// @param proposalId  Proposal voted on.
    /// @param voter       Voter's address.
    /// @param weight      Vote weight (RM balance at snapshot block).
    event VoteCast(uint256 indexed proposalId, address indexed voter, uint256 weight);

    /// @notice Emitted when a proposal is executed and weights are applied.
    /// @param proposalId  Proposal identifier.
    /// @param executor    Address that called `execute`.
    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);

    /// @notice Emitted after `PortfolioRouter.setWeights` succeeds.
    /// @param vaults  Vault list applied to the router.
    /// @param bps     Weight array applied to the router.
    event WeightsApplied(address[] vaults, uint256[] bps);

    // ─── Errors ──────────────────────────────────────────────────────────────

    /// @notice Caller holds zero RM tokens at the snapshot block.
    error NotRmHolder();

    /// @notice An active proposal already exists; only one at a time is allowed.
    error ProposalAlreadyActive();

    /// @notice Proposal id does not exist.
    error ProposalNotFound();

    /// @notice Proposal is not in Active state (already executed, expired, or succeeded).
    error ProposalNotActive();

    /// @notice Caller has already voted on this proposal.
    error AlreadyVoted();

    /// @notice Proposal has expired (cadence window elapsed without quorum).
    error ProposalExpired();

    /// @notice Execution delay has not elapsed yet.
    error ExecutionDelayNotElapsed();

    /// @notice Quorum has not been reached.
    error QuorumNotReached();

    /// @notice Weight bps array does not sum to BPS_DENOMINATOR.
    error InvalidWeightSum();

    /// @notice Vaults and bps arrays have mismatched lengths.
    error LengthMismatch();

    /// @notice A vault in the proposed list is not registered in the VaultRegistry.
    error VaultNotRegistered();

    /// @notice Address argument is `address(0)`.
    error ZeroAddress();

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param _rmToken         RM governance token address.
    /// @param _registry        VaultRegistry for vault validation.
    /// @param _router          Portfolio Router whose weights this contract controls.
    /// @param _quorumBps       Quorum threshold in bps of total RM supply (e.g. 5100 = 51%).
    /// @param _executionDelay  Seconds required between proposal creation and execution.
    /// @param _cadenceWindow   Seconds within which quorum must be reached before expiry.
    constructor(
        address _rmToken,
        address _registry,
        address _router,
        uint256 _quorumBps,
        uint256 _executionDelay,
        uint256 _cadenceWindow
    ) {
        if (_rmToken == address(0) || _registry == address(0) || _router == address(0)) {
            revert ZeroAddress();
        }
        rmToken = IERC20(_rmToken);
        registry = VaultRegistry(_registry);
        router = PortfolioRouter(_router);
        quorumBps = _quorumBps;
        executionDelay = _executionDelay;
        cadenceWindow = _cadenceWindow;
        totalRmSupply = IERC20(_rmToken).totalSupply();
    }

    // ─── Propose ─────────────────────────────────────────────────────────────

    /// @notice Submit a new weight proposal. Permissionless for RM holders.
    ///         Only one active proposal may exist at a time.
    /// @param vaults  Ordered vault list; each must be registered in VaultRegistry.
    /// @param bps     Parallel weight array in basis points; must sum to BPS_DENOMINATOR.
    /// @return proposalId  Assigned proposal id.
    function propose(address[] calldata vaults, uint256[] calldata bps)
        external
        returns (uint256 proposalId)
    {
        // Caller must hold RM tokens at the current block.
        if (rmToken.balanceOf(msg.sender) == 0) revert NotRmHolder();

        // Only one active proposal allowed at a time.
        if (activeProposalId != 0) {
            // Allow a new proposal if the active one has expired.
            uint256 aid = activeProposalId;
            Proposal storage ap = _proposals[aid];
            if (!ap.executed && block.timestamp <= ap.createdAt + cadenceWindow) {
                revert ProposalAlreadyActive();
            }
            // Stale/expired active proposal — clear it.
            activeProposalId = 0;
        }

        // Validate weight vector.
        if (vaults.length != bps.length) revert LengthMismatch();
        uint256 total;
        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i] == address(0)) revert ZeroAddress();
            registry.getVault(vaults[i]); // reverts with NotRegistered if unknown
            total += bps[i];
        }
        if (total != BPS_DENOMINATOR) revert InvalidWeightSum();

        // Create proposal.
        proposalId = ++proposalCount;

        Proposal storage p = _proposals[proposalId];
        p.proposer = msg.sender;
        p.snapshotBlock = block.number;
        p.createdAt = block.timestamp;
        // Copy arrays into storage.
        for (uint256 i = 0; i < vaults.length; i++) {
            p.vaults.push(vaults[i]);
            p.bps.push(bps[i]);
        }

        activeProposalId = proposalId;

        emit ProposalCreated(proposalId, msg.sender, vaults, bps, block.number);
    }

    // ─── Vote ────────────────────────────────────────────────────────────────

    /// @notice Cast a vote on the active proposal. Permissionless for RM holders.
    ///         Weight equals the voter's RM `balanceOf` at the proposal's snapshot block.
    ///         Note: standard ERC-20 does not support historical balance queries; this
    ///         contract reads the current balance. For production, use ERC20Votes.
    /// @param proposalId  Id of the proposal to vote on.
    function vote(uint256 proposalId) external {
        if (proposalId == 0 || proposalId > proposalCount) revert ProposalNotFound();

        Proposal storage p = _proposals[proposalId];

        // Must be the active proposal.
        if (p.executed) revert ProposalNotActive();

        // Check expiry.
        if (block.timestamp > p.createdAt + cadenceWindow) revert ProposalExpired();

        // Double-vote guard.
        if (_hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        // Vote weight: RM balance at snapshot block.
        // NOTE: standard ERC-20 has no historical balance; we use current balance
        //       as a best-effort approximation. A production upgrade should migrate
        //       rmToken to ERC20Votes and use `getPastVotes(voter, snapshotBlock)`.
        uint256 weight = rmToken.balanceOf(msg.sender);
        if (weight == 0) revert NotRmHolder();

        _hasVoted[proposalId][msg.sender] = true;
        p.totalVotes += weight;

        emit VoteCast(proposalId, msg.sender, weight);
    }

    // ─── Execute ─────────────────────────────────────────────────────────────

    /// @notice Apply the proposed weights to the Portfolio Router. Permissionless
    ///         once the execution delay has elapsed and quorum is reached.
    /// @param proposalId  Id of the proposal to execute.
    function execute(uint256 proposalId) external {
        if (proposalId == 0 || proposalId > proposalCount) revert ProposalNotFound();

        Proposal storage p = _proposals[proposalId];

        // Cannot execute an already-executed proposal.
        if (p.executed) revert ProposalNotActive();

        // Cannot execute an expired proposal.
        if (block.timestamp > p.createdAt + cadenceWindow) revert ProposalExpired();

        // Execution delay must have elapsed.
        if (block.timestamp < p.createdAt + executionDelay) revert ExecutionDelayNotElapsed();

        // Quorum check: totalVotes must be >= quorumBps % of totalRmSupply.
        uint256 quorumThreshold = (totalRmSupply * quorumBps) / BPS_DENOMINATOR;
        if (p.totalVotes < quorumThreshold) revert QuorumNotReached();

        // Mark executed before external call (reentrancy protection).
        p.executed = true;
        activeProposalId = 0;

        // Apply weights to the Portfolio Router.
        router.setWeights(p.vaults, p.bps);

        emit ProposalExecuted(proposalId, msg.sender);
        emit WeightsApplied(p.vaults, p.bps);
    }

    // ─── View: proposal lifecycle ─────────────────────────────────────────────

    /// @notice Return the full record for a proposal.
    /// @param proposalId  Proposal identifier.
    function getProposal(uint256 proposalId)
        external
        view
        returns (
            address proposer,
            address[] memory vaults,
            uint256[] memory bps,
            uint256 snapshotBlock,
            uint256 createdAt,
            uint256 totalVotes,
            bool executed
        )
    {
        if (proposalId == 0 || proposalId > proposalCount) {
            revert ProposalNotFound();
        }
        Proposal storage p = _proposals[proposalId];
        return (p.proposer, p.vaults, p.bps, p.snapshotBlock, p.createdAt, p.totalVotes, p.executed);
    }

    /// @notice Return the id of the currently active proposal (0 = none) and its
    ///         lifecycle state. Useful for dapp and rmpc reads.
    /// @return id     Active proposal id (0 if none).
    /// @return state  Current lifecycle state of the active proposal.
    function activeProposal() external view returns (uint256 id, ProposalState state) {
        id = activeProposalId;
        if (id == 0) return (0, ProposalState.Active); // no active proposal
        state = _proposalState(id);
    }

    /// @notice Return vote tallies for a proposal.
    /// @param proposalId  Proposal identifier.
    /// @return totalVotes  Aggregate weighted votes cast.
    /// @return quorumNeeded  Minimum votes required for quorum.
    /// @return quorumReached  Whether quorum has been met.
    function voteTallies(uint256 proposalId)
        external
        view
        returns (uint256 totalVotes, uint256 quorumNeeded, bool quorumReached)
    {
        if (proposalId == 0 || proposalId > proposalCount) revert ProposalNotFound();
        Proposal storage p = _proposals[proposalId];
        totalVotes = p.totalVotes;
        quorumNeeded = (totalRmSupply * quorumBps) / BPS_DENOMINATOR;
        quorumReached = totalVotes >= quorumNeeded;
    }

    /// @notice Return the current weight vector from the Portfolio Router.
    /// @return vaults  Ordered vault addresses.
    /// @return bps     Parallel weight array in basis points.
    function currentWeights()
        external
        view
        returns (address[] memory vaults, uint256[] memory bps)
    {
        return router.getWeights();
    }

    /// @notice Return governance cadence parameters.
    /// @return _quorumBps       Quorum threshold in bps.
    /// @return _executionDelay  Seconds required before execution.
    /// @return _cadenceWindow   Seconds within which quorum must be reached.
    function cadenceParams()
        external
        view
        returns (uint256 _quorumBps, uint256 _executionDelay, uint256 _cadenceWindow)
    {
        return (quorumBps, executionDelay, cadenceWindow);
    }

    /// @notice Whether `voter` has voted on `proposalId`.
    function hasVoted(uint256 proposalId, address voter) external view returns (bool) {
        return _hasVoted[proposalId][voter];
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    /// @dev Compute the lifecycle state for an existing proposal.
    function _proposalState(uint256 proposalId) internal view returns (ProposalState) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) return ProposalState.Executed;
        if (block.timestamp > p.createdAt + cadenceWindow) return ProposalState.Expired;
        uint256 quorumThreshold = (totalRmSupply * quorumBps) / BPS_DENOMINATOR;
        if (p.totalVotes >= quorumThreshold && block.timestamp >= p.createdAt + executionDelay) {
            return ProposalState.Succeeded;
        }
        return ProposalState.Active;
    }
}
