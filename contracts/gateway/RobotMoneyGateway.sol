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
import {IPortfolioRouter} from "./interfaces/IPortfolioRouter.sol";

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
    /// @notice `depositTo` was called with a destination not in the agent's
    ///         `allowedDestinations` list (when the list is non-empty), or the
    ///         destination is neither the pinned vault nor the router.
    error InvalidDestination();
    /// @notice `withdraw()` called but the agent's policy has withdrawal disabled
    ///         (`maxWithdrawPerPayment == 0`).
    error WithdrawalNotEnabled();
    /// @notice `withdraw()` shares argument exceeds `maxWithdrawPerPayment` cap.
    error SharesExceedWithdrawPerPaymentCap();
    /// @notice `withdraw()` cumulative shares in the current window would exceed `maxWithdrawPerWindow`.
    error WithdrawWindowCapExceeded();
    /// @notice `withdraw()` called with a `sourceVault` not in the agent's
    ///         `allowedSourceVaults` list (when the list is non-empty), or the
    ///         vault is not the pinned vault.
    error InvalidSourceVault();
    /// @notice `withdraw()` policy has `assetRecipient == address(0)`.
    error InvalidAssetRecipient();
    /// @notice `withdraw()` USDC balance did not increase by the expected amount,
    ///         indicating a malicious or fee-on-transfer vault.
    error UnexpectedAssetsReceived();

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

    /// @notice Portfolio Router for multi-vault agent deposits. May be `address(0)`
    ///         if the gateway was deployed without router support.
    IPortfolioRouter public immutable routerContract;

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

    /// @notice Per-agent windowed gross deposit. NOT shared across agents — each
    ///         agent has an independent allowance per window.
    mapping(address => mapping(uint64 => uint256)) public agentWindowGross;

    /// @notice Per-agent rolling-window withdrawal accounting (issue #449).
    ///         The withdrawal cap is enforced as a strict rolling window of
    ///         length `WINDOW_SECONDS`: at any time `t`, the cumulative shares
    ///         redeemed in the half-open interval `(windowStart, t]` may not
    ///         exceed `policy.maxWithdrawPerWindow`. `windowStart` is anchored
    ///         to the agent's first withdrawal in each rolling window and
    ///         advances to `block.timestamp` only after a full `WINDOW_SECONDS`
    ///         has elapsed with no further withdrawal — eliminating the
    ///         fixed-window boundary burst that allowed ~2× per-window draw
    ///         at calendar-aligned window edges.
    /// @param windowStart Unix-seconds anchor of the agent's current rolling window.
    ///                    Zero when the agent has never withdrawn.
    /// @param gross       Cumulative shares redeemed since `windowStart`.
    struct WithdrawWindow {
        uint64 windowStart;
        uint256 gross;
    }

    /// @notice Per-agent rolling withdrawal window state. See `WithdrawWindow`.
    mapping(address => WithdrawWindow) public agentWithdrawWindow;

    /// @notice Replay protection. `paymentId => used`.
    mapping(bytes32 => bool) public usedPaymentIds;

    /// @notice Stop-the-world flag.
    bool private _paused;

    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------

    /// @param usdc_    USDC (or 6-decimal stand-in) token address.
    /// @param vault_   ERC-4626 vault whose `asset()` MUST equal `usdc_`.
    /// @param admin_   Holder of `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`.
    /// @param pauser_  Holder of `PAUSER_ROLE`. Must be distinct from agents.
    /// @param router_  Portfolio Router address, or `address(0)` to deploy without
    ///                 router support (single-vault mode).
    constructor(IERC20 usdc_, IERC4626 vault_, address admin_, address pauser_, address router_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        if (address(vault_) == address(0)) revert ZeroAddress();
        if (admin_ == address(0)) revert ZeroAddress();
        if (pauser_ == address(0)) revert ZeroAddress();
        if (vault_.asset() != address(usdc_)) revert AssetMismatch();

        usdcToken = usdc_;
        vaultContract = vault_;
        routerContract = IPortfolioRouter(router_);

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
    function router() external view returns (address) {
        return address(routerContract);
    }

    /// @inheritdoc IGateway
    function paused() external view returns (bool) {
        return _paused;
    }

    /// @inheritdoc IGateway
    function effectiveWithdrawWindowGross(address agent) external view returns (uint256) {
        WithdrawWindow memory ww = agentWithdrawWindow[agent];
        if (ww.windowStart == 0) return 0;
        if (block.timestamp >= uint256(ww.windowStart) + WINDOW_SECONDS) return 0;
        return ww.gross;
    }

    /// @dev Apply a `shares` redemption against the agent's rolling-window
    ///      withdrawal budget (#449). Reverts with `WithdrawWindowCapExceeded`
    ///      when the projected cumulative draw would breach `cap`. On success
    ///      writes the updated `WithdrawWindow` to storage. Extracted from
    ///      `withdraw` to keep the entrypoint within EVM stack-depth limits.
    function _accrueRollingWithdraw(address agent, uint256 shares, uint256 cap) internal {
        WithdrawWindow storage ww = agentWithdrawWindow[agent];
        uint64 anchor = ww.windowStart;
        uint256 priorGross = ww.gross;
        if (anchor == 0 || block.timestamp >= uint256(anchor) + WINDOW_SECONDS) {
            anchor = uint64(block.timestamp);
            priorGross = 0;
        }
        uint256 projected = priorGross + shares;
        if (projected > cap) revert WithdrawWindowCapExceeded();
        ww.windowStart = anchor;
        ww.gross = projected;
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
        // Withdrawal fields: if withdrawal is enabled (maxWithdrawPerPayment > 0),
        // validate the recipient and window cap relationship.
        if (p.maxWithdrawPerPayment > 0) {
            if (p.assetRecipient == address(0)) revert InvalidAssetRecipient();
            if (p.maxWithdrawPerWindow == 0) revert InvalidAmount();
            if (p.maxWithdrawPerPayment > p.maxWithdrawPerWindow) revert InvalidAmount();
        }
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

    /// @inheritdoc IGateway
    /// @dev Routes to a specific `destination` (vault or Portfolio Router). All the
    ///      same caps, deadline, idempotency, and policy checks as `deposit` apply.
    ///      When `destination` is the router, `minSharesPerLeg` is forwarded to
    ///      `router.depositFor(shareReceiver, amount, minSharesPerLeg)` and shares
    ///      are minted directly to `shareReceiver`. When `destination` is a vault,
    ///      it behaves identically to `deposit` except the vault is user-specified
    ///      and must pass the allowedDestinations check.
    function depositTo(
        bytes32 orderId,
        uint256 amount,
        uint64 deadline,
        bytes32 idempotencyKey,
        address destination,
        uint256[] calldata minSharesPerLeg
    ) external nonReentrant onlyRole(AGENT_ROLE) returns (bytes32 paymentId) {
        if (_paused) revert PausedError();

        // Build a DepositArgs struct early to collapse locals onto the heap.
        // This avoids the "stack too deep" limit imposed by the EVM legacy codegen.
        DepositArgs memory args;
        args.orderId = orderId;
        args.amount = amount;
        args.destination = destination;

        {
            AgentPolicy memory p = agents[msg.sender];

            // 1. amount > 0 && amount <= maxPerPayment
            if (amount == 0) revert InvalidAmount();
            if (amount > p.maxPerPayment) revert AmountExceedsPerPaymentCap();

            // 2. deadline window
            if (block.timestamp > deadline) revert DeadlineExpired();
            if (deadline > block.timestamp + MAX_DEADLINE_SKEW) revert DeadlineTooFar();

            // 3. policy active and not expired.
            // coverage:unreachable
            if (!p.active) revert AgentNotAuthorized();
            if (p.validUntil < block.timestamp) revert AgentPolicyExpired();

            // 4. destination validation + allowedDestinations whitelist.
            args.isRouter = _validateDestination(destination, p.allowedDestinations);
            args.shareReceiver = p.shareReceiver;
        }

        // 5. windowId
        args.windowId = uint64(block.timestamp / WINDOW_SECONDS);

        // 6. window cap
        {
            uint256 windowSoFar = agentWindowGross[msg.sender][args.windowId];
            if (windowSoFar + amount > agents[msg.sender].maxPerWindow) revert WindowCapExceeded();

            // 7. paymentId — DEADLINE INTENTIONALLY EXCLUDED.
            paymentId = keccak256(
                abi.encode(
                    block.chainid, address(this), msg.sender, orderId, amount, idempotencyKey
                )
            );
            if (usedPaymentIds[paymentId]) revert PaymentIdAlreadyUsed();

            // 8. EFFECTS: write state before any external call (CEI pattern).
            agentWindowGross[msg.sender][args.windowId] = windowSoFar + amount;
        }
        usedPaymentIds[paymentId] = true;
        args.paymentId = paymentId;

        // slither-disable-start reentrancy-balance
        // 9. safeTransferFrom with balance-delta verification.
        args.balBefore = usdcToken.balanceOf(address(this));
        usdcToken.safeTransferFrom(msg.sender, address(this), amount);
        if (usdcToken.balanceOf(address(this)) - args.balBefore != amount) {
            revert FeeOnTransferDetected();
        }

        _executeDeposit(args, minSharesPerLeg);
        // slither-disable-end reentrancy-balance
    }

    /// @dev Internal args struct to avoid stack-too-deep in `depositTo`.
    struct DepositArgs {
        bytes32 paymentId;
        bytes32 orderId;
        address shareReceiver;
        uint256 amount;
        address destination;
        uint64 windowId;
        uint256 balBefore;
        bool isRouter;
    }

    /// @dev Validates `destination` against the pinned vault and router, and
    ///      enforces the policy allowedDestinations whitelist when non-empty.
    ///      Returns `true` when destination is the router, `false` for a vault.
    function _validateDestination(address destination, address[] memory allowedDestinations)
        internal
        view
        returns (bool isRouter)
    {
        bool isVault = (destination == address(vaultContract));
        isRouter = (address(routerContract) != address(0) && destination == address(routerContract));
        if (!isVault && !isRouter) revert InvalidDestination();

        // Enforce allowedDestinations whitelist when non-empty. Early return
        // avoids a `break` statement that viaIR source-maps unreliably.
        uint256 len = allowedDestinations.length;
        if (len > 0) {
            for (uint256 i = 0; i < len; i++) {
                if (allowedDestinations[i] == destination) return isRouter; // allowed
            }
            revert InvalidDestination();
        }
    }

    /// @dev Dispatches to router or vault deposit execution based on `args.isRouter`.
    ///      Separated into two internal calls to give viaIR coverage instrumentation
    ///      a reliable source-map anchor for each path.
    function _executeDeposit(DepositArgs memory args, uint256[] calldata minSharesPerLeg) internal {
        if (args.isRouter) {
            _executeRouterDeposit(args, minSharesPerLeg);
        } else {
            _executeVaultDeposit(args);
        }
    }

    /// @dev Router-path deposit: approve router, call `depositFor`, clear allowance,
    ///      check USDC custody invariant, emit event.
    function _executeRouterDeposit(DepositArgs memory args, uint256[] calldata minSharesPerLeg)
        internal
    {
        usdcToken.forceApprove(address(routerContract), args.amount);
        uint256[] memory sharesPerLeg =
            routerContract.depositFor(args.shareReceiver, args.amount, minSharesPerLeg);
        usdcToken.forceApprove(address(routerContract), 0);

        if (usdcToken.balanceOf(address(this)) != args.balBefore) {
            revert ShareCustodyInvariantViolated();
        }

        emit AgentDepositRouted(
            args.paymentId,
            args.orderId,
            msg.sender,
            args.shareReceiver,
            address(routerContract),
            args.amount,
            sharesPerLeg,
            args.windowId
        );
    }

    /// @dev Vault-path deposit: pre-call share custody check, approve vault, deposit,
    ///      clear allowance, post-call custody invariants, emit event.
    function _executeVaultDeposit(DepositArgs memory args) internal {
        if (IERC20(args.destination).balanceOf(address(this)) != 0) {
            revert ShareCustodyInvariantViolated();
        }

        usdcToken.forceApprove(args.destination, args.amount);
        uint256 sharesMinted = IERC4626(args.destination).deposit(args.amount, args.shareReceiver);
        usdcToken.forceApprove(args.destination, 0);

        if (IERC20(args.destination).balanceOf(address(this)) != 0) {
            revert ShareCustodyInvariantViolated();
        }
        if (usdcToken.balanceOf(address(this)) != args.balBefore) {
            revert ShareCustodyInvariantViolated();
        }

        emit AgentDeposit(
            args.paymentId,
            args.orderId,
            msg.sender,
            args.shareReceiver,
            args.amount,
            sharesMinted,
            args.windowId
        );
    }

    // -------------------------------------------------------------------
    // Withdrawal
    // -------------------------------------------------------------------

    /// @inheritdoc IGateway
    /// @dev The agent must have approved the gateway to spend its vault shares
    ///      before calling this function. The gateway pulls shares via
    ///      `transferFrom(agent, gateway, shares)`, calls `vault.redeem`, and
    ///      forwards USDC only to `policy.assetRecipient`. CEI pattern: state
    ///      effects written before external calls. `nonReentrant` provides
    ///      defense-in-depth.
    function withdraw(
        bytes32 orderId,
        uint256 shares,
        address sourceVault,
        uint64 deadline,
        bytes32 idempotencyKey
    ) external nonReentrant onlyRole(AGENT_ROLE) returns (bytes32 paymentId, uint256 assetsOut) {
        if (_paused) revert PausedError();

        AgentPolicy memory p = agents[msg.sender];

        // 1. Withdrawal must be enabled for this agent.
        if (p.maxWithdrawPerPayment == 0) revert WithdrawalNotEnabled();

        // 2. shares > 0 && shares <= maxWithdrawPerPayment
        if (shares == 0) revert InvalidAmount();
        if (shares > p.maxWithdrawPerPayment) revert SharesExceedWithdrawPerPaymentCap();

        // 3. deadline window
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (deadline > block.timestamp + MAX_DEADLINE_SKEW) revert DeadlineTooFar();

        // 4. policy active and not expired.
        // coverage:unreachable
        if (!p.active) revert AgentNotAuthorized();
        if (p.validUntil < block.timestamp) revert AgentPolicyExpired();

        // 5. sourceVault validation: must be the pinned vault, and must pass
        //    the allowedSourceVaults whitelist when non-empty.
        if (sourceVault != address(vaultContract)) revert InvalidSourceVault();
        {
            uint256 len = p.allowedSourceVaults.length;
            if (len > 0) {
                bool found;
                for (uint256 i = 0; i < len && !found; i++) {
                    found = p.allowedSourceVaults[i] == sourceVault;
                }
                if (!found) revert InvalidSourceVault();
            }
        }

        // 6. windowId — informational only (echoed in event). The on-chain
        //    cap is enforced on a strict rolling window (#449), not on this
        //    calendar-aligned id.
        uint64 windowId = uint64(block.timestamp / WINDOW_SECONDS);

        // 7. rolling-window cap (issue #449).
        //    Anchored on the agent's first withdrawal of each rolling window.
        //    The anchor advances to `block.timestamp` only when a full
        //    WINDOW_SECONDS has elapsed since the last anchor — so cumulative
        //    redemptions in any WINDOW_SECONDS-wide interval are bounded by
        //    `maxWithdrawPerWindow`. Eliminates the fixed-window boundary
        //    burst.
        _accrueRollingWithdraw(msg.sender, shares, p.maxWithdrawPerWindow);

        // 8. paymentId — DEADLINE INTENTIONALLY EXCLUDED.
        paymentId = keccak256(
            abi.encode(block.chainid, address(this), msg.sender, orderId, shares, idempotencyKey)
        );
        if (usedPaymentIds[paymentId]) revert PaymentIdAlreadyUsed();

        // 9. EFFECTS: paymentId reservation. (Rolling-window state was
        //    written in `_accrueRollingWithdraw` above.)
        usedPaymentIds[paymentId] = true;

        // slither-disable-start reentrancy-balance
        // Justification: Balance-delta pattern is used to detect unexpected USDC
        // custody changes. State effects are written above before external calls
        // (CEI). `nonReentrant` provides defense-in-depth. Only `AGENT_ROLE`
        // holders can reach this code.

        // 10. Pull shares from agent into the gateway via transferFrom.
        //     Agent must have approved the gateway for at least `shares`.
        IERC20(sourceVault).safeTransferFrom(msg.sender, address(this), shares);

        // 11. Record USDC balance before redeem so we can verify the vault
        //     transferred exactly the expected amount.
        uint256 usdcBefore = usdcToken.balanceOf(address(this));

        // 12. Call vault.redeem — sends USDC to assetRecipient directly.
        assetsOut = IERC4626(sourceVault).redeem(shares, p.assetRecipient, address(this));

        // 13. Verify the vault did not leave unexpected USDC in the gateway.
        //     The gateway balance must not have increased (USDC went to assetRecipient).
        if (usdcToken.balanceOf(address(this)) != usdcBefore) {
            revert UnexpectedAssetsReceived();
        }

        // 14. Gateway must hold zero vault shares after the redemption.
        if (IERC20(sourceVault).balanceOf(address(this)) != 0) {
            revert ShareCustodyInvariantViolated();
        }
        // slither-disable-end reentrancy-balance

        // 15. event.
        emit AgentWithdrawal(
            paymentId,
            orderId,
            msg.sender,
            sourceVault,
            shares,
            assetsOut,
            p.assetRecipient,
            windowId
        );
    }
}
