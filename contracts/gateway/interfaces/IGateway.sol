// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5 — On-Chain Gateway
// (See also: docs/implementation-plan.md §3.2 — RobotMoneyGateway.sol)
pragma solidity ^0.8.24;

/// @title IGateway
/// @notice Minimal interface stub for the RobotMoney deposit gateway.
/// @dev Per the MVP plan (`docs/implementation-plan.md` §2.2), the gateway
///      exposes a single state-mutating entrypoint for agents (`deposit`),
///      a permissionless depositor-owned authorize/revoke/policy surface
///      (`authorizeAgent`, `revokeAgent`, `setPolicy`), and a protocol-wide
///      pause asymmetry (PAUSER pauses, ADMIN unpauses) retained as a
///      kill-switch by the contract upgrader.
///
/// Authority model (see issue #269). Each depositor is the sole authority
/// over her own agent. `authorizeAgent` is callable by any EOA;
/// `msg.sender` is recorded as the agent's owner. Only that recorded
/// owner can update policy or revoke. The Robot Money team has no
/// runtime authority over any agent's lifecycle — `ADMIN_ROLE` is
/// reserved for protocol-wide kill switches (e.g. `unpause`) retained
/// by the contract upgrader for incident response.
interface IGateway {
    // -------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------

    /// @notice Per-agent policy. Set by the agent's recorded owner via
    ///         `authorizeAgent` (first time) or `setPolicy` (subsequent
    ///         updates).
    /// @param active         Policy is enabled.
    /// @param validUntil     Unix-seconds expiry; deposits revert at/after.
    /// @param maxPerPayment  Maximum gross USDC per single `deposit` call.
    /// @param maxPerWindow   Maximum gross USDC per `WINDOW_SECONDS` window.
    /// @param shareReceiver  Address that receives minted vault shares.
    struct AgentPolicy {
        bool active;
        uint64 validUntil;
        uint256 maxPerPayment;
        uint256 maxPerWindow;
        address shareReceiver;
    }

    // -------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------

    /// @notice Emitted when an agent's policy is created or updated.
    /// @param agent          Agent address whose policy was set.
    /// @param owner          Depositor EOA that authorized the agent
    ///                       (`msg.sender` at first `authorizeAgent` call).
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
    /// @param owner Depositor EOA that revoked (must equal the recorded owner).
    event AgentRevoked(address indexed agent, address indexed owner);
    /// @notice Emitted when the gateway is paused.
    /// @param by Address that called `pause()`.
    event Paused(address indexed by);
    /// @notice Emitted when the gateway is unpaused.
    /// @param by Address that called `unpause()`.
    event Unpaused(address indexed by);
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

    /// @notice Pull `amount` USDC from caller, deposit into the vault, route
    ///         resulting shares to the agent's configured `shareReceiver`.
    /// @dev Restricted to `AGENT_ROLE`. Reverts when paused. See MVP §2.2 for
    ///      the full preflight checklist (caps, window, deadline, idempotency).
    /// @param orderId          Caller-supplied order identifier (echoed in event).
    /// @param amount           Gross USDC amount, in 6-decimal base units.
    /// @param deadline         Hard expiry; must be `<= block.timestamp + 600`.
    /// @param idempotencyKey   Caller-side dedup salt mixed into `paymentId`.
    /// @return paymentId       Hash committing chain/contract/agent/order/amount/key.
    /// @return sharesMinted    Vault shares minted to `shareReceiver`.
    function deposit(bytes32 orderId, uint256 amount, uint64 deadline, bytes32 idempotencyKey)
        external
        returns (bytes32 paymentId, uint256 sharesMinted);

    /// @notice First-time authorization for `agent`. Permissionless — any EOA
    ///         may call to register their own agent. `msg.sender` is recorded
    ///         as the agent's owner. Reverts if `agent` already has a
    ///         recorded owner; that owner must call `setPolicy` to update or
    ///         `revokeAgent` to release.
    /// @param agent The agent address to authorize (must not already be owned).
    /// @param p     Initial policy parameters.
    function authorizeAgent(address agent, AgentPolicy calldata p) external;

    /// @notice Update the policy for an agent the caller already owns.
    ///         Reverts if `msg.sender` is not the recorded owner of `agent`.
    /// @param agent The agent address whose policy to update.
    /// @param p     New policy parameters.
    function setPolicy(address agent, AgentPolicy calldata p) external;

    /// @notice Revoke an agent. Reverts if `msg.sender` is not the recorded
    ///         owner. Clears policy, role, and owner record.
    /// @param agent The agent address whose policy and role are revoked.
    function revokeAgent(address agent) external;

    /// @notice Stop-the-world pause. Restricted to `PAUSER_ROLE`.
    function pause() external;

    /// @notice Resume operations. Restricted to `ADMIN_ROLE` (asymmetric).
    ///         `ADMIN_ROLE` is retained as a protocol-wide kill-switch
    ///         counterweight to `pause`; it has no authority over any
    ///         agent's lifecycle.
    function unpause() external;

    // -------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------

    /// @notice Window length in seconds for per-window gross caps.
    function WINDOW_SECONDS() external view returns (uint64);

    /// @notice Pinned USDC token address.
    function usdc() external view returns (address);

    /// @notice Pinned ERC-4626 vault address.
    function vault() external view returns (address);

    /// @notice Whether the gateway is currently paused.
    function paused() external view returns (bool);

    /// @notice Recorded owner (depositor EOA) for `agent`, or `address(0)`
    ///         if no policy is recorded.
    /// @param agent The agent address whose recorded owner to look up.
    /// @return The depositor EOA that authorized `agent`, or zero if none.
    function agentOwner(address agent) external view returns (address);
}
