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
    /// @param active                  Policy is enabled.
    /// @param validUntil              Unix-seconds expiry; deposits revert at/after.
    /// @param maxPerPayment           Maximum gross USDC per single `deposit` call.
    /// @param maxPerWindow            Maximum gross USDC per `WINDOW_SECONDS` window.
    /// @param shareReceiver           Address that receives minted vault shares.
    /// @param allowedDestinations     Whitelist of deposit destinations (vault or router
    ///                                addresses). When non-empty, `depositTo` requires the
    ///                                supplied destination to appear in this list. An empty
    ///                                array disables the allowlist — only the pinned vault
    ///                                or the pinned router is permitted (no registry lookup).
    /// @param assetRecipient          Address that receives redeemed USDC on `withdraw`.
    ///                                Must be non-zero when `maxWithdrawPerPayment > 0`.
    /// @param maxWithdrawPerPayment   Maximum vault shares redeemable per single `withdraw` call.
    ///                                Set to zero to disable agent-initiated withdrawal.
    /// @param maxWithdrawPerWindow    Maximum vault shares redeemable per `WINDOW_SECONDS` window.
    ///                                Must be >= `maxWithdrawPerPayment` when non-zero.
    /// @param allowedSourceVaults     Whitelist of vaults the agent may redeem from via `withdraw`.
    ///                                When non-empty, the supplied `sourceVault` must appear in
    ///                                this list. An empty array permits only the pinned vault
    ///                                (no registry lookup; arbitrary vault addresses are never
    ///                                accepted).
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
    /// @notice Emitted on every successful agent deposit to a single vault.
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

    /// @notice Emitted on every successful agent deposit routed through the Portfolio Router.
    /// @param paymentId       Replay-protection hash for this payment.
    /// @param orderId         Caller-supplied order identifier.
    /// @param agent           Agent address that made the deposit.
    /// @param shareReceiver   Address that received the minted vault shares per leg.
    /// @param router          Portfolio Router address used for this deposit.
    /// @param amount          Gross USDC deposited (6-decimal units).
    /// @param sharesPerLeg    Vault shares minted per leg (parallel to router weight list).
    /// @param windowId        Rolling window identifier (`block.timestamp / WINDOW_SECONDS`).
    event AgentDepositRouted(
        bytes32 indexed paymentId,
        bytes32 indexed orderId,
        address indexed agent,
        address shareReceiver,
        address router,
        uint256 amount,
        uint256[] sharesPerLeg,
        uint64 windowId
    );

    /// @notice Emitted on every successful agent withdrawal (vault redemption).
    /// @param paymentId       Replay-protection hash for this payment.
    /// @param orderId         Caller-supplied order identifier.
    /// @param agent           Agent address that initiated the withdrawal.
    /// @param sourceVault     Vault address shares were redeemed from.
    /// @param shares          Vault shares burned.
    /// @param assetsOut       USDC transferred to `assetRecipient`.
    /// @param assetRecipient  Address that received the redeemed USDC.
    /// @param windowId        Rolling window identifier (`block.timestamp / WINDOW_SECONDS`).
    event AgentWithdrawal(
        bytes32 indexed paymentId,
        bytes32 indexed orderId,
        address indexed agent,
        address sourceVault,
        uint256 shares,
        uint256 assetsOut,
        address assetRecipient,
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

    /// @notice Pull `amount` USDC from caller, route to `destination` (vault or
    ///         Portfolio Router), and deliver resulting shares to the agent's
    ///         configured `shareReceiver`. When `destination` is the router,
    ///         `minSharesPerLeg` provides per-leg slippage protection.
    /// @dev Restricted to `AGENT_ROLE`. Reverts when paused. Enforces all the
    ///      same caps, deadline, idempotency, and policy checks as `deposit`.
    ///      `destination` must appear in the agent's `allowedDestinations` list
    ///      (or the list must be empty, in which case only the pinned vault or
    ///      the pinned router is accepted — no registry lookup is performed).
    /// @param orderId          Caller-supplied order identifier (echoed in event).
    /// @param amount           Gross USDC amount, in 6-decimal base units.
    /// @param deadline         Hard expiry; must be `<= block.timestamp + 600`.
    /// @param idempotencyKey   Caller-side dedup salt mixed into `paymentId`.
    /// @param destination      Vault address or Portfolio Router address.
    /// @param minSharesPerLeg  Per-leg slippage floor (router path only). Pass
    ///                         empty array when routing to a single vault.
    /// @return paymentId       Hash committing chain/contract/agent/order/amount/key.
    function depositTo(
        bytes32 orderId,
        uint256 amount,
        uint64 deadline,
        bytes32 idempotencyKey,
        address destination,
        uint256[] calldata minSharesPerLeg
    ) external returns (bytes32 paymentId);

    /// @notice Redeem `shares` from `sourceVault` on behalf of the agent's
    ///         configured depositor. USDC proceeds are sent only to the
    ///         policy-configured `assetRecipient` — the agent cannot redirect
    ///         funds. The gateway pulls shares from `msg.sender` via
    ///         `transferFrom` (agent must have approved the gateway).
    /// @dev Restricted to `AGENT_ROLE`. Reverts when paused. Enforces all the
    ///      same deadline, idempotency, and policy checks as `deposit`. The
    ///      agent must approve the gateway to spend its vault shares before
    ///      calling this function.
    /// @param orderId          Caller-supplied order identifier (echoed in event).
    /// @param shares           Vault shares to redeem.
    /// @param sourceVault      Vault address to redeem from.
    /// @param deadline         Hard expiry; must be `<= block.timestamp + 600`.
    /// @param idempotencyKey   Caller-side dedup salt mixed into `paymentId`.
    /// @return paymentId       Hash committing chain/contract/agent/order/shares/key.
    /// @return assetsOut       USDC transferred to `assetRecipient`.
    function withdraw(
        bytes32 orderId,
        uint256 shares,
        address sourceVault,
        uint64 deadline,
        bytes32 idempotencyKey
    ) external returns (bytes32 paymentId, uint256 assetsOut);

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

    /// @notice Portfolio Router address, or `address(0)` if not configured.
    function router() external view returns (address);

    /// @notice Whether the gateway is currently paused.
    function paused() external view returns (bool);

    /// @notice Recorded owner (depositor EOA) for `agent`, or `address(0)`
    ///         if no policy is recorded.
    /// @param agent The agent address whose recorded owner to look up.
    /// @return The depositor EOA that authorized `agent`, or zero if none.
    function agentOwner(address agent) external view returns (address);
}
