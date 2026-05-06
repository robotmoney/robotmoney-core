// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AccessRoles} from "./AccessRoles.sol";
import {IGateway} from "./interfaces/IGateway.sol";

/// @title RobotMoneyGateway
/// @notice Thin policy-gated wrapper around `vault.deposit()`. Pulls USDC from
///         the agent, enforces per-agent caps and a per-window gross cap,
///         calls the vault, and routes the resulting `rmUSDC` shares to a
///         per-agent configured receiver.
/// @dev Implements `docs/implementation-plan-mvp.md` §2.2. Custom errors only;
///      OZ v5 SafeERC20; the gateway must never custody `rmUSDC`. Idempotency
///      hash deliberately excludes `deadline`.
contract RobotMoneyGateway is AccessRoles, IGateway {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------

    error ZeroAddress();
    error AssetMismatch();
    error PausedError();
    error NotPaused();
    error InvalidAmount();
    error AmountExceedsPerPaymentCap();
    error DeadlineExpired();
    error DeadlineTooFar();
    error AgentNotAuthorized();
    error AgentPolicyExpired();
    error WindowCapExceeded();
    error PaymentIdAlreadyUsed();
    error FeeOnTransferDetected();
    error ShareCustodyInvariantViolated();
    error InvalidShareReceiver();
    error InvalidValidUntil();

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
    // Admin / lifecycle
    // -------------------------------------------------------------------

    /// @inheritdoc IGateway
    function authorizeAgent(address agent, AgentPolicy calldata p)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (agent == address(0)) revert ZeroAddress();
        if (p.shareReceiver == address(0)) revert InvalidShareReceiver();
        if (!p.active) revert InvalidValidUntil();
        if (p.validUntil < block.timestamp) revert InvalidValidUntil();
        if (p.maxPerPayment == 0 || p.maxPerWindow == 0) revert InvalidAmount();
        if (p.maxPerPayment > p.maxPerWindow) revert InvalidAmount();

        agents[agent] = p;

        // Idempotent grant: only call _grantRole if not already an agent.
        // The role-separation override in AccessRoles will revert if the
        // candidate already holds ADMIN/PAUSER.
        if (!hasRole(AGENT_ROLE, agent)) {
            _grantRole(AGENT_ROLE, agent);
        }
        _assertRoleSeparation(agent);

        emit AgentAuthorized(
            agent, p.validUntil, p.maxPerPayment, p.maxPerWindow, p.shareReceiver
        );
    }

    /// @inheritdoc IGateway
    function revokeAgent(address agent) external onlyRole(ADMIN_ROLE) {
        if (agent == address(0)) revert ZeroAddress();
        delete agents[agent];
        if (hasRole(AGENT_ROLE, agent)) {
            _revokeRole(AGENT_ROLE, agent);
        }
        emit AgentRevoked(agent);
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
    /// @dev Implements §2.2 steps 1–12 verbatim.
    function deposit(
        bytes32 orderId,
        uint256 amount,
        uint64 deadline,
        bytes32 idempotencyKey
    ) external onlyRole(AGENT_ROLE) returns (bytes32 paymentId, uint256 sharesMinted) {
        if (_paused) revert PausedError();

        AgentPolicy memory p = agents[msg.sender];

        // 1. amount > 0 && amount <= maxPerPayment
        if (amount == 0) revert InvalidAmount();
        if (amount > p.maxPerPayment) revert AmountExceedsPerPaymentCap();

        // 2. deadline window
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (deadline > block.timestamp + MAX_DEADLINE_SKEW) revert DeadlineTooFar();

        // 3. policy active and not expired
        if (!p.active) revert AgentNotAuthorized();
        if (p.validUntil < block.timestamp) revert AgentPolicyExpired();

        // 4. windowId
        uint64 windowId = uint64(block.timestamp / WINDOW_SECONDS);

        // 5. window cap
        uint256 windowSoFar = agentWindowGross[msg.sender][windowId];
        if (windowSoFar + amount > p.maxPerWindow) revert WindowCapExceeded();

        // 6. paymentId — DEADLINE INTENTIONALLY EXCLUDED.
        paymentId = keccak256(
            abi.encode(
                block.chainid, address(this), msg.sender, orderId, amount, idempotencyKey
            )
        );
        if (usedPaymentIds[paymentId]) revert PaymentIdAlreadyUsed();

        // Pre-call invariant: gateway must hold zero shares.
        if (IERC20(address(vaultContract)).balanceOf(address(this)) != 0) {
            revert ShareCustodyInvariantViolated();
        }

        // 7. safeTransferFrom with balance-delta verification.
        uint256 balBefore = usdcToken.balanceOf(address(this));
        usdcToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balAfter = usdcToken.balanceOf(address(this));
        if (balAfter - balBefore != amount) revert FeeOnTransferDetected();

        // 8. one-shot allowance.
        usdcToken.forceApprove(address(vaultContract), amount);

        // 9. vault deposit; receiver = pre-registered shareReceiver.
        sharesMinted = vaultContract.deposit(amount, p.shareReceiver);

        // 10. clear residual allowance.
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

        // 11. update window gross + mark paymentId used.
        agentWindowGross[msg.sender][windowId] = windowSoFar + amount;
        usedPaymentIds[paymentId] = true;

        // 12. event.
        emit AgentDeposit(
            paymentId, orderId, msg.sender, p.shareReceiver, amount, sharesMinted, windowId
        );
    }
}
