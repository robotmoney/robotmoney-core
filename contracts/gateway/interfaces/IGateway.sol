// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5 — On-Chain Gateway
// (See also: docs/implementation-plan.md §3.2 — RobotMoneyGateway.sol)
pragma solidity ^0.8.24;

/// @title IGateway
/// @notice Minimal interface stub for the RobotMoney deposit gateway.
/// @dev This is the surface downstream issues (#9 RobotMoneyGateway, #10 deploy
///      script, #13 forge tests) compile against. Keep it stable. Per the MVP
///      plan (`docs/implementation-plan.md` §2.2), the gateway exposes a
///      single state-mutating entrypoint for agents (`deposit`), admin
///      lifecycle calls, and a pause asymmetry (PAUSER pauses, ADMIN unpauses).
interface IGateway {
    // -------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------

    /// @notice Per-agent policy. Set by ADMIN via `authorizeAgent`.
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
    /// @param validUntil     Policy expiry timestamp (Unix seconds).
    /// @param maxPerPayment  Maximum USDC per single deposit call.
    /// @param maxPerWindow   Maximum USDC per rolling window.
    /// @param shareReceiver  Address receiving minted vault shares.
    event AgentAuthorized(
        address indexed agent,
        uint64 validUntil,
        uint256 maxPerPayment,
        uint256 maxPerWindow,
        address shareReceiver
    );
    /// @notice Emitted when an agent's policy and role are revoked.
    /// @param agent Agent address whose policy was removed.
    event AgentRevoked(address indexed agent);
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

    /// @notice Set or replace the policy for `agent`. Restricted to `ADMIN_ROLE`.
    /// @param agent The agent address to authorize.
    /// @param p     Policy parameters to assign to the agent.
    function authorizeAgent(address agent, AgentPolicy calldata p) external;

    /// @notice Disable policy for `agent`. Restricted to `ADMIN_ROLE`.
    /// @param agent The agent address whose policy and role are revoked.
    function revokeAgent(address agent) external;

    /// @notice Stop-the-world pause. Restricted to `PAUSER_ROLE`.
    function pause() external;

    /// @notice Resume operations. Restricted to `ADMIN_ROLE` (asymmetric).
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
}
