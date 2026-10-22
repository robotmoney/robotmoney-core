// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5 — On-Chain Gateway
// (See also: Plan tracking issue #109 §3.2 — RobotMoneyGateway.sol)
pragma solidity ^0.8.24;

import {IInvestmentCommitteePolicy} from "./IInvestmentCommitteePolicy.sol";
import {IConsensusRecommendationReceipt} from "./IConsensusRecommendationReceipt.sol";

/// @title IGateway
/// @notice Minimal interface stub for the RobotMoney deposit gateway.
/// @dev Per the MVP plan (`Plan tracking issue #109` §2.2), the gateway
///      exposes one state-mutating entrypoint for agents (`depositTo`), an owner-gated
///      agent lifecycle surface
///      (`commitAuthorization`/`revealAuthorization`,
///      `setPolicy`, `revokeAgent`), and a
///      deposit-pause asymmetry (DEPOSIT_PAUSER pauses deposits, ADMIN
///      resumes them). A pause stops new deposits. The gateway has no
///      withdrawal path (owner decision 2026-10-19).
///
/// Authority model (issues #269, #1476, ACL-9). Registration records
/// `msg.sender` as the agent's owner, only through `commitAuthorization` +
/// `revealAuthorization`. The owner never changes within a registration.
/// Only the owner can update the policy. The owner or the agent can revoke.
/// No role can grant, revoke or renounce `AGENT_ROLE` through the public
/// role methods. `ADMIN_ROLE` grants no authority over any agent.
///
/// Policy rule. Every call that writes a policy applies the same validator,
/// and every caller must name itself as `shareReceiver`.
interface IGateway {
    // -------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------

    /// @notice Per-agent policy. Set by the agent's recorded owner via
    ///         `revealAuthorization` (first time) or `setPolicy` (subsequent
    ///         updates).
    /// @param active                  Policy is enabled.
    /// @param validUntil              Unix-seconds expiry; deposits revert at/after.
    /// @param maxPerPayment           Maximum gross USDC per single `deposit` call.
    /// @param maxPerWindow            Maximum gross USDC per `WINDOW_SECONDS` window.
    /// @param shareReceiver           Address that receives minted vault shares.
    /// @param allowedDestinations     Contracts the agent may deposit into (ERC-4626 vaults the
    ///                                owner selected). Must be non-empty with no zero entry.
    ///                                `depositTo` requires the destination to appear here.
    ///                                The router is never a destination.
    /// @param assetRecipient          RETIRED. Must be zero.
    /// @param maxWithdrawPerPayment   RETIRED. Must be zero.
    /// @param maxWithdrawPerWindow    RETIRED. Must be zero.
    /// @param allowedSourceVaults     RETIRED. Must be empty.
    struct AgentPolicy {
        bool active;
        uint64 validUntil;
        uint256 maxPerPayment;
        uint256 maxPerWindow;
        address shareReceiver;
        address[] allowedDestinations;
        address assetRecipient;
        uint256 maxWithdrawPerPayment;
        uint256 maxWithdrawPerWindow;
        address[] allowedSourceVaults;
    }

    // -------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------

    /// @notice Emitted when a depositor submits a commitment hash for a
    ///         future `revealAuthorization` call.
    /// @param committer    EOA that submitted the commitment (`msg.sender`).
    /// @param commitHash   `keccak256(abi.encode(agent, committer, salt))`.
    /// @param blockNumber  Block number at which the commitment was recorded.
    event CommitSubmitted(
        address indexed committer, bytes32 indexed commitHash, uint64 blockNumber
    );

    /// @notice Emitted when a depositor successfully reveals a commitment and
    ///         the agent is authorized.
    /// @param committer   EOA that revealed (must equal the original committer).
    /// @param commitHash  The commitment hash that was revealed and cleared.
    /// @param agent       Agent address that was authorized.
    event CommitRevealed(
        address indexed committer, bytes32 indexed commitHash, address indexed agent
    );

    /// @notice Emitted when an agent's policy is created or updated.
    /// @param agent          Agent address whose policy was set.
    /// @param owner          The agent's recorded owner, which is `msg.sender`
    ///                       of the `revealAuthorization` or
    ///                       `setPolicy` call that emitted it.
    /// @param validUntil     Policy expiry timestamp (Unix seconds).
    /// @param maxPerPayment  Maximum USDC per single deposit call.
    /// @param maxPerWindow   Maximum USDC per rolling window.
    /// @param shareReceiver  Address receiving minted vault shares.
    event AgentAuthorized(
        address indexed agent,
        address indexed owner,
        uint64 validUntil,
        uint256 maxPerPayment,
        uint256 maxPerWindow,
        address shareReceiver
    );
    /// @notice Emitted when an agent's policy and role are revoked.
    /// @param agent Agent address whose policy was removed.
    /// @param owner The registration's owner. Also emitted when a reveal replaces an
    ///              expired registration, before the new `AgentAuthorized`.
    event AgentRevoked(address indexed agent, address indexed owner);
    /// @notice Emitted when gateway deposits are paused.
    /// @param by Address that called `pauseDeposits()`.
    event DepositsPaused(address indexed by);
    /// @notice Emitted when gateway deposits are resumed.
    /// @param by Address that called `unpauseDeposits()`.
    event DepositsUnpaused(address indexed by);
    /// @notice Emitted on every successful agent deposit.
    /// @param paymentId     Replay-protection hash for this payment.
    /// @param orderId       Caller-supplied order identifier.
    /// @param agent         Agent address that made the deposit.
    /// @param shareReceiver Address that received the minted vault shares.
    /// @param amount        Gross USDC deposited (6-decimal units).
    /// @param sharesMinted  Vault shares minted to `shareReceiver`.
    /// @param windowId      Rolling window identifier (`block.timestamp / WINDOW_SECONDS`).
    event AgentDeposit(
        bytes32 indexed paymentId,
        bytes32 indexed orderId,
        address indexed agent,
        address shareReceiver,
        uint256 amount,
        uint256 sharesMinted,
        uint64 windowId
    );

    // -------------------------------------------------------------------
    // State-changing functions
    // -------------------------------------------------------------------

    /// @notice Pull `amount` USDC from caller, deposit it into `destination`, and
    ///         deliver the resulting shares to the agent's `shareReceiver` (the owner).
    ///         This is the gateway's only agent action.
    /// @dev Restricted to `AGENT_ROLE`. Reverts `DepositsArePaused` while deposits are
    ///      paused. `destination` must appear in the agent's non-empty
    ///      `allowedDestinations`; the gateway pins no vault, has no registry lookup, and
    ///      never accepts the Portfolio Router as a target. An empty list authorizes nothing.
    /// @param orderId          Caller-supplied order identifier (echoed in event).
    /// @param amount           Gross USDC amount, in 6-decimal base units.
    /// @param deadline         Hard expiry; must be `<= block.timestamp + 600`.
    /// @param idempotencyKey   Caller-side dedup salt mixed into `paymentId`.
    /// @param destination      ERC-4626 vault named in the policy.
    /// @param minSharesPerLeg  Bound into `paymentId` only. Pass an empty array.
    /// @return paymentId       keccak256(abi.encode(OP_DEPOSIT_TO=3, chainId, gateway, agent,
    ///                         orderId, amount, idempotencyKey, destination, minSharesPerLeg)).
    function depositTo(
        bytes32 orderId,
        uint256 amount,
        uint64 deadline,
        bytes32 idempotencyKey,
        address destination,
        uint256[] calldata minSharesPerLeg
    ) external returns (bytes32 paymentId);

    /// @notice Phase-1 of the two-phase commit/reveal agent authorization.
    ///         Submit `commitHash = keccak256(abi.encode(agent, msg.sender, salt))`
    ///         to reserve the agent address. Must wait at least one block
    ///         before revealing. The commitment expires after
    ///         `COMMIT_EXPIRY_BLOCKS` blocks.
    /// @dev    Permissionless. Any EOA may commit. The hash binds the agent
    ///         address, the caller identity, and a caller-chosen salt so that
    ///         a mempool observer cannot front-run the reveal with a different
    ///         depositor address.
    ///         An agent address also uses this to consent to an owner (core 1791):
    ///         from its own key it submits
    ///         `keccak256(abi.encode(owner, keccak256(callData)))`, where `callData` is
    ///         the full `revealAuthorization(agent, salt, policy)` calldata `owner` will
    ///         send. That reveal then consumes it, so the consent covers one agent, one
    ///         policy and one salt. Without the consent the reveal reverts
    ///         `OwnerConsentMissing`, so nobody can take an address that never agreed.
    /// @param commitHash `keccak256(abi.encode(agent, msg.sender, salt))`, or the consent hash above.
    function commitAuthorization(bytes32 commitHash) external;

    /// @notice Phase-2 of the two-phase commit/reveal agent authorization.
    ///         Reveal `agent` and `salt` to validate the prior commitment and
    ///         authorize the agent with the supplied policy. Reverts if no
    ///         prior commitment matches, if the commitment has expired, if
    ///         `msg.sender` is not the original committer, or if the hash
    ///         does not match. For an `agent` other than the caller it also
    ///         reverts `OwnerConsentMissing` unless the agent consented to this
    ///         caller and this exact call through `commitAuthorization`.
    /// @dev    Must be called at least one block after `commitAuthorization`.
    ///         The policy is checked by the same validator as `setPolicy`:
    ///         every caller must name itself as
    ///         `shareReceiver` (`ShareReceiverNotAuthorized`).
    /// @param agent  The agent address to authorize (must not already be owned).
    /// @param salt   The caller-chosen salt used when building `commitHash`.
    /// @param p      Initial policy parameters.
    function revealAuthorization(address agent, bytes32 salt, AgentPolicy calldata p) external;

    /// @notice Update the policy for an agent the caller already owns.
    ///         Reverts `NotAgentOwner` if `msg.sender` is not the recorded
    ///         owner of `agent`. The new policy passes the same validator as
    ///         registration: the caller must name itself as `shareReceiver`
    ///         (`ShareReceiverNotAuthorized`). Reverts `AgentPolicyExpired`
    ///         once the stored `validUntil` has passed, so an expired
    ///         registration cannot be revived. Emits `AgentAuthorized`.
    /// @param agent The agent address whose policy to update.
    /// @param p     New policy parameters.
    function setPolicy(address agent, AgentPolicy calldata p) external;

    /// @notice End an agent registration. The recorded owner or the agent
    ///         itself (self-revoke) can call it (`NotAgentOwner` otherwise).
    ///         Clears policy, role, owner record and the agent's rolling
    ///         deposit window. Emits `AgentRevoked(agent, owner)`.
    /// @param agent The agent address whose policy and role are revoked.
    function revokeAgent(address agent) external;

    /// @notice Pause new deposits (`depositTo`). Restricted to
    ///         `DEPOSIT_PAUSER_ROLE`.
    function pauseDeposits() external;

    /// @notice Resume deposits. Restricted to `ADMIN_ROLE` (asymmetric).
    ///         `ADMIN_ROLE` is retained as the counterweight to
    ///         `pauseDeposits`; it has no authority over the
    ///         lifecycle of an agent it does not own.
    function unpauseDeposits() external;

    // -------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------

    /// @notice Window length in seconds for per-window gross caps.
    function WINDOW_SECONDS() external view returns (uint64);

    /// @notice Pinned USDC token address.
    function usdc() external view returns (address);

    /// @notice Whether gateway deposits are currently paused.
    function depositsPaused() external view returns (bool);

    /// @notice Retired storage slot (issue 1888): the on-chain committee is deleted. Read-only.
    function icPolicy() external view returns (IInvestmentCommitteePolicy);

    /// @notice Retired storage slot (issue 1888): receipts are recorded directly on the receipt
    ///         contract, never through the gateway. Read-only.
    function consensusReceipt() external view returns (IConsensusRecommendationReceipt);

    /// @notice Recorded owner for `agent`, or `address(0)` if no policy is
    ///         recorded.
    /// @param agent The agent address whose recorded owner to look up.
    /// @return The account that registered `agent`, or zero if none.
    function agentOwner(address agent) external view returns (address);

    /// @notice Cumulative USDC the agent has deposited in the current rolling
    ///         deposit window. Returns zero when the agent has either never
    ///         deposited or the last anchor lies more than `WINDOW_SECONDS` in
    ///         the past. Use this — not the deprecated `agentWindowGross`
    ///         mapping — to project whether the next deposit would breach
    ///         `maxPerWindow` (issue #497).
    /// @param agent The agent address to look up.
    /// @return The agent's cumulative rolling-window deposit gross.
    function effectiveDepositWindowGross(address agent) external view returns (uint256);
}
