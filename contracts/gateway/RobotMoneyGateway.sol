// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5 — On-Chain Gateway
// (See also: docs/implementation-plan.md §3.2 — RobotMoneyGateway.sol)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {AccessRoles} from "./AccessRoles.sol";
import {IGateway} from "./interfaces/IGateway.sol";

/// @title RobotMoneyGateway
/// @notice Thin policy-gated wrapper around `vault.deposit()`. Pulls USDC from
///         the agent, enforces per-agent caps and a per-window gross cap,
///         calls the vault, and routes the resulting `rmUSDC` shares to a
///         per-agent configured receiver.
/// @dev Implements `docs/implementation-plan.md` §2.2. Custom errors only;
///      OZ v5 SafeERC20; the gateway must never custody `rmUSDC`. Idempotency
///      hash deliberately excludes `deadline`.
contract RobotMoneyGateway is AccessRoles, ReentrancyGuard, IGateway {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------

    /// @notice Constructor or admin call passed `address(0)` where a real address is required.
    error ZeroAddress();
    /// @notice Constructor-time check: vault.asset() does not match the configured USDC token.
    error AssetMismatch();
    /// @notice Operation rejected because the gateway is paused (also re-thrown by `pause()` if already paused).
    error PausedError();
    /// @notice `unpause()` called while the gateway was not paused.
    error NotPaused();
    /// @notice Deposit amount is zero, or `authorizeAgent` policy has zero/inverted per-payment vs per-window caps.
    error InvalidAmount();
    /// @notice Deposit amount exceeds the agent's `maxPerPayment` cap.
    error AmountExceedsPerPaymentCap();
    /// @notice `block.timestamp > deadline` — the signed transaction's deadline has already passed.
    error DeadlineExpired();
    /// @notice `deadline` is more than `MAX_DEADLINE_SKEW` seconds in the future.
    error DeadlineTooFar();
    /// @notice Agent has no active policy (defensive — unreachable through current public API).
    error AgentNotAuthorized();
    /// @notice Agent's policy `validUntil` is in the past.
    error AgentPolicyExpired();
    /// @notice Cumulative deposits in the current window would exceed `maxPerWindow`.
    error WindowCapExceeded();
    /// @notice Idempotency: this `paymentId` has already been consumed by a prior deposit.
    error PaymentIdAlreadyUsed();
    /// @notice USDC `safeTransferFrom` delivered fewer tokens than requested (fee-on-transfer or rebasing token).
    error FeeOnTransferDetected();
    /// @notice Pre/post-call invariant: gateway must never custody vault shares or leftover USDC across the call frame.
    error ShareCustodyInvariantViolated();
    /// @notice `authorizeAgent` policy specifies `shareReceiver == address(0)`.
    error InvalidShareReceiver();
    /// @notice `authorizeAgent` policy is inactive or `validUntil` is already in the past.
    error InvalidValidUntil();
    /// @notice Caller is not the recorded owner of the target agent. Raised by
    ///         `setPolicy` and `revokeAgent` when `msg.sender != agentOwner[agent]`.
    error NotAgentOwner();
    /// @notice `authorizeAgent` called on an agent that already has a recorded
    ///         owner. The existing owner must call `setPolicy` to update or
    ///         `revokeAgent` to release the address before a new authorization.
    error AgentAlreadyOwned();

    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------

    /// @notice Window length in seconds for per-window gross caps. Unix-epoch
    ///         aligned: `windowId = block.timestamp / WINDOW_SECONDS`.
    uint64 public constant WINDOW_SECONDS = 86400;

    /// @notice Maximum future skew permitted on `deadline` arguments.
    uint256 public constant MAX_DEADLINE_SKEW = 600;

    // -------------------------------------------------------------------
    // Immutables
    // -------------------------------------------------------------------

    /// @notice Pinned USDC token.
    IERC20 public immutable usdcToken;

    /// @notice Pinned ERC-4626 vault.
    IERC4626 public immutable vaultContract;

    // -------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------

    /// @notice Per-agent policy. Keyed on the agent's signing address.
    mapping(address => AgentPolicy) public agents;

    /// @notice Recorded owner (depositor EOA) for each agent. Set on the
    ///         first `authorizeAgent` call; cleared on `revokeAgent`. Used to
    ///         gate `setPolicy` and `revokeAgent` so each depositor is the
    ///         sole authority over her own agent (issue #269).
    mapping(address => address) public agentOwner;

    /// @notice Per-agent windowed gross. NOT shared across agents — each
    ///         agent has an independent allowance per window.
    mapping(address => mapping(uint64 => uint256)) public agentWindowGross;

    /// @notice Replay protection. `paymentId => used`.
    mapping(bytes32 => bool) public usedPaymentIds;

    /// @notice Stop-the-world flag.
    bool private _paused;

    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------

    /// @param usdc_   USDC (or 6-decimal stand-in) token address.
    /// @param vault_  ERC-4626 vault whose `asset()` MUST equal `usdc_`.
    /// @param admin_  Holder of `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`.
    /// @param pauser_ Holder of `PAUSER_ROLE`. Must be distinct from agents.
    constructor(IERC20 usdc_, IERC4626 vault_, address admin_, address pauser_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        if (address(vault_) == address(0)) revert ZeroAddress();
        if (admin_ == address(0)) revert ZeroAddress();
        if (pauser_ == address(0)) revert ZeroAddress();
        if (vault_.asset() != address(usdc_)) revert AssetMismatch();

        usdcToken = usdc_;
        vaultContract = vault_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(PAUSER_ROLE, pauser_);
    }

    // -------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------

    /// @inheritdoc IGateway
    function usdc() external view returns (address) {
        return address(usdcToken);
    }

    /// @inheritdoc IGateway
    function vault() external view returns (address) {
        return address(vaultContract);
    }

    /// @inheritdoc IGateway
    function paused() external view returns (bool) {
        return _paused;
    }

    // -------------------------------------------------------------------
    // Agent lifecycle — permissionless, depositor-owned
    //
    // Each depositor is the sole authority over her own agent. The
    // authorize/setPolicy/revoke trio is gated on `msg.sender ==
    // agentOwner[agent]` (or, for first-time authorize, on the agent
    // having no recorded owner yet). `ADMIN_ROLE` plays no part in
    // these calls — see issue #269 and docs/architecture.md §6.
    // -------------------------------------------------------------------

    /// @inheritdoc IGateway
    function authorizeAgent(address agent, AgentPolicy calldata p) external {
        if (agent == address(0)) revert ZeroAddress();
        if (agentOwner[agent] != address(0)) revert AgentAlreadyOwned();
        _validatePolicy(p);

        agentOwner[agent] = msg.sender;
        agents[agent] = p;

        // First-time grant. The role-separation override in AccessRoles
        // will revert if the candidate already holds ADMIN/PAUSER.
        _grantRole(AGENT_ROLE, agent);
        _assertRoleSeparation(agent);

        emit AgentAuthorized(
            agent, msg.sender, p.validUntil, p.maxPerPayment, p.maxPerWindow, p.shareReceiver
        );
    }

    /// @inheritdoc IGateway
    function setPolicy(address agent, AgentPolicy calldata p) external {
        if (agent == address(0)) revert ZeroAddress();
        if (agentOwner[agent] != msg.sender) revert NotAgentOwner();
        _validatePolicy(p);

        agents[agent] = p;

        emit AgentAuthorized(
            agent, msg.sender, p.validUntil, p.maxPerPayment, p.maxPerWindow, p.shareReceiver
        );
    }

    /// @inheritdoc IGateway
    function revokeAgent(address agent) external {
        if (agent == address(0)) revert ZeroAddress();
        address owner = agentOwner[agent];
        if (owner != msg.sender) revert NotAgentOwner();

        delete agents[agent];
        delete agentOwner[agent];
        if (hasRole(AGENT_ROLE, agent)) {
            _revokeRole(AGENT_ROLE, agent);
        }
        emit AgentRevoked(agent, owner);
    }

    /// @dev Internal policy-shape validator shared by `authorizeAgent` and
    ///      `setPolicy`. Custom errors match the previous public surface
    ///      so downstream clients (rmpc, dapp) keep the same revert
    ///      vocabulary across the depositor-owned redesign.
    function _validatePolicy(AgentPolicy calldata p) internal view {
        if (p.shareReceiver == address(0)) revert InvalidShareReceiver();
        if (!p.active) revert InvalidValidUntil();
        if (p.validUntil < block.timestamp) revert InvalidValidUntil();
        if (p.maxPerPayment == 0 || p.maxPerWindow == 0) revert InvalidAmount();
        if (p.maxPerPayment > p.maxPerWindow) revert InvalidAmount();
    }

    /// @inheritdoc IGateway
    function pause() external onlyRole(PAUSER_ROLE) {
        if (_paused) revert PausedError();
        _paused = true;
        emit Paused(msg.sender);
    }

    /// @inheritdoc IGateway
    function unpause() external onlyRole(ADMIN_ROLE) {
        if (!_paused) revert NotPaused();
        _paused = false;
        emit Unpaused(msg.sender);
    }

    // -------------------------------------------------------------------
    // Deposit
    // -------------------------------------------------------------------

    /// @inheritdoc IGateway
    /// @dev Implements §2.2 steps 1–12. Effects (`usedPaymentIds`, `agentWindowGross`) are
    ///      written before external calls (CEI pattern). `nonReentrant` provides defense-in-depth.
    function deposit(bytes32 orderId, uint256 amount, uint64 deadline, bytes32 idempotencyKey)
        external
        nonReentrant
        onlyRole(AGENT_ROLE)
        returns (bytes32 paymentId, uint256 sharesMinted)
    {
        if (_paused) revert PausedError();

        AgentPolicy memory p = agents[msg.sender];

        // 1. amount > 0 && amount <= maxPerPayment
        if (amount == 0) revert InvalidAmount();
        if (amount > p.maxPerPayment) revert AmountExceedsPerPaymentCap();

        // 2. deadline window
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (deadline > block.timestamp + MAX_DEADLINE_SKEW) revert DeadlineTooFar();

        // 3. policy active and not expired.
        //
        // Note: the `!p.active` branch is defensive and unreachable through
        // the current public API — `authorizeAgent` requires `p.active==true`
        // and `revokeAgent` `delete`s the policy AND revokes `AGENT_ROLE`,
        // so any caller reaching this point with the role granted has
        // `p.active==true`. Kept for defense-in-depth against future storage
        // corruption / upgrade paths. Excluded from branch-coverage targets.
        // coverage:unreachable
        if (!p.active) revert AgentNotAuthorized();
        if (p.validUntil < block.timestamp) revert AgentPolicyExpired();

        // 4. windowId
        uint64 windowId = uint64(block.timestamp / WINDOW_SECONDS);

        // 5. window cap
        uint256 windowSoFar = agentWindowGross[msg.sender][windowId];
        if (windowSoFar + amount > p.maxPerWindow) revert WindowCapExceeded();

        // 6. paymentId — DEADLINE INTENTIONALLY EXCLUDED.
        paymentId = keccak256(
            abi.encode(block.chainid, address(this), msg.sender, orderId, amount, idempotencyKey)
        );
        if (usedPaymentIds[paymentId]) revert PaymentIdAlreadyUsed();

        // Pre-call invariant: gateway must hold zero shares.
        if (IERC20(address(vaultContract)).balanceOf(address(this)) != 0) {
            revert ShareCustodyInvariantViolated();
        }

        // 7. EFFECTS: write state before any external call (CEI pattern).
        agentWindowGross[msg.sender][windowId] = windowSoFar + amount;
        usedPaymentIds[paymentId] = true;

        // slither-disable-start reentrancy-balance
        // Justification: The `balBefore` pattern below is intentional fee-on-transfer
        // detection (§2.2 step 8) and a post-call invariant check (§2.2 step 12).
        // Only `AGENT_ROLE` holders can reach this code. State effects (window gross,
        // paymentId flag) are written above before any external call, satisfying the
        // CEI pattern. `nonReentrant` provides defense-in-depth.

        // 8. safeTransferFrom with balance-delta verification.
        uint256 balBefore = usdcToken.balanceOf(address(this));
        usdcToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balAfter = usdcToken.balanceOf(address(this));
        if (balAfter - balBefore != amount) revert FeeOnTransferDetected();

        // 9. one-shot allowance.
        usdcToken.forceApprove(address(vaultContract), amount);

        // 10. vault deposit; receiver = pre-registered shareReceiver.
        sharesMinted = vaultContract.deposit(amount, p.shareReceiver);

        // 11. clear residual allowance.
        usdcToken.forceApprove(address(vaultContract), 0);

        // Post-call invariants:
        // gateway must not custody any rmUSDC.
        if (IERC20(address(vaultContract)).balanceOf(address(this)) != 0) {
            revert ShareCustodyInvariantViolated();
        }
        // gateway must not custody any leftover USDC from this call.
        if (usdcToken.balanceOf(address(this)) != balBefore) {
            revert ShareCustodyInvariantViolated();
        }
        // slither-disable-end reentrancy-balance

        // 12. event.
        emit AgentDeposit(
            paymentId, orderId, msg.sender, p.shareReceiver, amount, sharesMinted, windowId
        );
    }
}
