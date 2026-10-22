// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5 — On-Chain Gateway
// (See also: Plan tracking issue #109 §3.2 — RobotMoneyGateway.sol)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {AccessRoles} from "./AccessRoles.sol";
import {GovernedUUPS} from "../lib/GovernedUUPS.sol";
import {GatewayWindows} from "../lib/GatewayWindows.sol";
import {IGateway} from "./interfaces/IGateway.sol";
import {IPortfolioRouter} from "./interfaces/IPortfolioRouter.sol";
import {IInvestmentCommitteePolicy} from "./interfaces/IInvestmentCommitteePolicy.sol";
import {IConsensusRecommendationReceipt} from "./interfaces/IConsensusRecommendationReceipt.sol";

/// @title RobotMoneyGateway
/// @notice Policy-gated agent deposit into an owner-selected ERC-4626 vault. Pulls USDC
///         from the agent, enforces per-agent caps and a rolling per-window cap, deposits
///         into a destination named in the depositor's `allowedDestinations`, and mints
///         the shares to the policy's share receiver (the owner).
/// @dev Canonical: docs/architecture.md §5.2. The gateway pins no vault list and has no
///      registry lookup: the policy list is the only destination authority, and the
///      Portfolio Router is never a destination. The agent has no withdrawal path.
///      Custom errors only; OZ v5 SafeERC20; the gateway never custodies vault shares.
///      The idempotency hash deliberately excludes `deadline`.
///
///      Runs behind its own ERC-1967 proxy (issue 1808): `initialize` replaces the
///      constructor, the implementation is locked, and only `upgradeTimelock()` can upgrade
///      or freeze it (`GovernedUUPS`). No gateway role carries upgrade power. `usdcToken`
///      is set once at initialization, no setter. `vaultContract`, `routerContract` and the
///      withdraw window state are retired storage kept only for the proxy layout gate.
contract RobotMoneyGateway is AccessRoles, ReentrancyGuardUpgradeable, IGateway, GovernedUUPS {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------

    /// @notice Gas left is below the floor a deposit needs before it calls the destination vault.
    ///         Raised before the external call so a gas limit that is too low reverts with a
    ///         reason. Retry with more gas. (core 1482.)
    /// @param available `gasleft()` at the check.
    /// @param required  The floor that was not met.
    error InsufficientGas(uint256 available, uint256 required);

    /// @dev Gas `depositTo` needs at entry. The vault's deposit entry floor is 1_600_000 after
    ///      the 63/64 forward, and the gateway spends its policy reads, window and payment-id
    ///      writes and the USDC pull before the call.
    uint256 internal constant DEPOSIT_GAS_FLOOR = 2_000_000;

    /// @notice Constructor or admin call passed `address(0)` where a real address is required.
    error ZeroAddress();
    /// @notice Deposit rejected because gateway deposits are paused (also raised by
    ///         `pauseDeposits()` if deposits are already paused).
    error DepositsArePaused();
    /// @notice `unpauseDeposits()` called while deposits were not paused.
    error DepositsNotPaused();
    /// @notice Deposit amount is zero, or registration policy has zero/inverted per-payment vs per-window caps.
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
    /// @notice Retired: a policy can no longer name a zero `shareReceiver`, because
    ///         the receiver must equal the (non-zero) caller. Kept for ABI stability.
    error InvalidShareReceiver();
    /// @notice registration policy is inactive or `validUntil` is already in the past.
    error InvalidValidUntil();
    /// @notice Caller is not the recorded owner of the target agent. Raised by
    ///         `setPolicy` when `msg.sender != agentOwner[agent]`, and by
    ///         `revokeAgent` when the caller is neither the owner nor the agent.
    error NotAgentOwner();
    /// @notice `revealAuthorization` named an agent whose registration is still
    ///         live (`validUntil` not passed). The owner or the agent must call
    ///         `revokeAgent`, or the policy must expire, before a new registration.
    error AgentAlreadyOwned();
    /// @notice `revealAuthorization` named an `agent` other than the caller, and the
    ///         agent has not consented to the caller as owner for this exact call.
    ///         The agent must first submit the consent hash from its own key through
    ///         `commitAuthorization`: `keccak256(abi.encode(owner, keccak256(callData)))`
    ///         where `callData` is the full `revealAuthorization` calldata. (core 1791.)
    error OwnerConsentMissing();
    /// @notice `revealAuthorization` called but no prior commitment exists for
    ///         this commit hash. The depositor must call `commitAuthorization`
    ///         first and wait at least one block.
    error CommitmentNotFound();
    /// @notice `revealAuthorization` called after the commitment has expired
    ///         (block.number > commitBlock + COMMIT_EXPIRY_BLOCKS).
    error CommitmentExpired();
    /// @notice Unused since core 1791 (the check was unreachable: the commit hash binds
    ///         the caller). Kept so the ABI and its clients do not change.
    error CommitmentOwnerMismatch();
    /// @notice `revealAuthorization` called but `keccak256(agent, msg.sender, salt)`
    ///         does not match the stored commitment hash.
    error CommitmentHashMismatch();
    /// @notice `revealAuthorization` called in the same block as the commitment.
    ///         Must wait at least one block before revealing.
    error CommitmentTooRecent();
    /// @notice A caller named a `shareReceiver` other than itself. Raised by
    ///         `revealAuthorization` and `setPolicy`: every policy writer applies
    ///         the same rule to every caller, whatever its role (ACL-9).
    error ShareReceiverNotAuthorized();
    /// @notice `depositTo` was called with a destination not in the agent's
    ///         `allowedDestinations` list. An empty list authorizes nothing. The policy list is
    ///         the only destination authority: the gateway pins no vault and has no registry.
    error InvalidDestination();
    /// @notice A policy named no `allowedDestinations`, or named the zero address as one.
    error EmptyAllowedDestinations();
    /// @notice A policy set a retired withdraw member (`assetRecipient`, `maxWithdrawPerPayment`,
    ///         `maxWithdrawPerWindow`, `allowedSourceVaults`). The gateway has no withdraw path,
    ///         so the members must be zero or empty (architecture 5.2).
    error RetiredPolicyFieldNonZero();

    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------

    /// @notice Window length in seconds for per-window gross caps. Unix-epoch
    ///         aligned: `windowId = block.timestamp / WINDOW_SECONDS`.
    uint64 public constant WINDOW_SECONDS = 86400;

    /// @notice Maximum future skew permitted on `deadline` arguments.
    uint256 public constant MAX_DEADLINE_SKEW = 600;

    /// @notice Number of blocks after which an unrevealed commitment expires.
    ///         After `commitBlock + COMMIT_EXPIRY_BLOCKS` the commitment can
    ///         no longer be revealed and the depositor must re-commit.
    uint256 public constant COMMIT_EXPIRY_BLOCKS = 256;

    /// @notice Op-kind discriminator prepended to the `paymentId` hash. The value 3 is kept
    ///         from the deployed release so ids stay stable, and the retired kinds (1, 2, 4)
    ///         are never reused.
    uint8 internal constant OP_DEPOSIT_TO = 3;

    // -------------------------------------------------------------------
    // Pinned at initialization (no setter)
    // -------------------------------------------------------------------

    /// @notice Pinned USDC token.
    IERC20 public usdcToken;

    /// @dev RETIRED. Held the pinned vault. Never written or read; the slot stays because the
    ///      proxy storage layout gate (scripts/ci/check-core-storage-layout.sh) allows no
    ///      removal. The policy's `allowedDestinations` is the only destination authority.
    IERC4626 internal vaultContract;

    /// @dev RETIRED. Held the Portfolio Router. Never written or read, same reason as
    ///      `vaultContract`. The router is never a destination.
    IPortfolioRouter internal routerContract;

    // -------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------

    /// @notice Pending authorization commitment. Stored by commitHash to allow
    ///         the depositor to reveal in a subsequent block, defeating
    ///         mempool front-running of `revealAuthorization`.
    /// @param committer   EOA that submitted the commitment (`msg.sender` at commit time).
    /// @param blockNumber Block number at which the commitment was submitted.
    struct Commitment {
        address committer;
        uint64 blockNumber;
    }

    /// @notice Pending commitments keyed by
    ///         `keccak256(abi.encode(commitHash, committer))`. Caller scoping
    ///         prevents another account from overwriting a commitment observed
    ///         in the mempool or on-chain.
    mapping(bytes32 => Commitment) public commitments;

    /// @notice Per-agent policy. Keyed on the agent's signing address.
    mapping(address => AgentPolicy) public agents;

    /// @notice Recorded owner (depositor EOA) for each agent. Set on the
    ///         `revealAuthorization`; cleared when the registration ends. Used to
    ///         gate `setPolicy` and `revokeAgent` so each depositor is the
    ///         sole authority over her own agent (issue #269).
    mapping(address => address) public agentOwner;

    /// @notice Per-agent calendar-window gross deposit. Deprecated in issue #497
    ///         — the gateway stopped writing new values when rolling-window
    ///         deposit accounting was introduced. Retained only for ABI
    ///         compatibility with off-chain indexers that may still read it.
    ///         Use `agentDepositWindow` and `effectiveDepositWindowGross` instead.
    mapping(address => mapping(uint64 => uint256)) public agentWindowGross;

    /// @notice Per-agent rolling-window deposit accounting (issue #497).
    ///         Eliminates the fixed-window boundary burst on the deposit side.
    ///         An agent cannot deposit more than `maxPerWindow` in any contiguous
    ///         `WINDOW_SECONDS`-wide interval regardless of calendar boundary.
    /// @param windowStart Unix-seconds anchor of the agent's current rolling window.
    ///                    Zero when the agent has never deposited.
    /// @param gross       Cumulative USDC deposited since `windowStart`.
    struct DepositWindow {
        uint64 windowStart;
        uint256 gross;
    }

    /// @notice Per-agent rolling deposit window state. See `DepositWindow`.
    mapping(address => DepositWindow) public agentDepositWindow;

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

    /// @dev RETIRED with the withdraw path; never written. Kept for the layout gate.
    mapping(address => WithdrawWindow) internal agentWithdrawWindow;

    // Bounded ring buffer backing one agent's rolling-window accounting (NC-7 / GW-4):
    // same-second coalescing bounds the live entry count, and pruned slots are reused so
    // storage plateaus at the high-water mark. Exact `(t-WINDOW_SECONDS, t]` expiry per entry.
    // The ring buffer type and its logic live in the linked library `GatewayWindows`
    // (issue 1808), which runs on this proxy's storage by DELEGATECALL.

    /// @notice Hard cap on the number of distinct live ring-buffer entries per
    ///         agent per side. Because same-second operations coalesce, the live
    ///         count can never exceed the number of distinct seconds in the
    ///         rolling window; this constant pins the storage footprint regardless
    ///         and makes the bound explicit. `WINDOW_SECONDS` distinct seconds is
    ///         the theoretical ceiling, but no real agent approaches it — the cap
    ///         exists purely so the worst case is provably O(1) in storage.
    uint256 public constant MAX_WINDOW_ENTRIES = WINDOW_SECONDS;

    /// @notice Raised when an agent's live window-entry count would exceed
    ///         `MAX_WINDOW_ENTRIES`. Unreachable in practice (same-second
    ///         coalescing keeps the live count far below the cap) but guarantees
    ///         the ring buffer can never silently overflow its bound.
    error WindowBufferFull();

    mapping(address => GatewayWindows.RollingWindow) private _depositWindow;
    /// @dev RETIRED with the withdraw path; never written. Kept for the layout gate.
    mapping(address => GatewayWindows.RollingWindow) private _withdrawWindow;

    /// @notice Replay protection. `paymentId => used`.
    mapping(bytes32 => bool) public usedPaymentIds;

    /// @notice Deposit pause flag. Blocks `depositTo`. The gateway has no withdrawal path.
    bool private _depositsPaused;

    /// @notice Retired storage slot (issue 1888). The on-chain committee is deleted and nothing
    ///         writes or reads this. The getter stays so the slot keeps its type and its value
    ///         on deployed proxies stays readable. `IInvestmentCommitteePolicy` is empty.
    IInvestmentCommitteePolicy public icPolicy;

    // ─── Last-admin floor (ACL-3 / F-06) ──────────────────────────────
    //
    // Appended at the END of storage so the layout of every preceding slot
    // (notably `agents` at slot 3 and `commitments` at slot 2) is unchanged —
    // a plain manual counter, not AccessControlEnumerable, to avoid both a
    // storage-layout shift and the extra bytecode. The two privileged admin
    // tiers (`ADMIN_ROLE`, `DEFAULT_ADMIN_ROLE`) each get a counter; revoking
    // or renouncing the sole holder of either is forbidden, so governance can
    // never be permanently bricked.

    /// @notice Number of accounts currently holding `ADMIN_ROLE`.
    uint256 private _adminCount;
    /// @notice Number of accounts currently holding `DEFAULT_ADMIN_ROLE`.
    uint256 private _defaultAdminCount;

    /// @notice Retired storage slot (issue 1888). Receipts are recorded directly on the
    ///         receipt contract by its submitter, never through the gateway. Nothing writes
    ///         or reads this. The getter stays so the slot keeps its value on deployed proxies.
    ///         Appended after the admin-tier counters so no preceding storage slot moves.
    IConsensusRecommendationReceipt public consensusReceipt;

    /// @notice Revoking/renouncing the sole holder of an admin tier is forbidden.
    error LastAdminFloor();

    /// @dev Maintain the admin-tier counters and enforce the floor. `AccessRoles`
    ///      keeps its role-separation override; we route through `super` so both
    ///      invariants compose (separation on grant, last-admin floor on revoke).
    function _grantRole(bytes32 role, address account) internal override returns (bool granted) {
        granted = super._grantRole(role, account);
        if (granted) {
            if (role == ADMIN_ROLE) _adminCount++;
            else if (role == DEFAULT_ADMIN_ROLE) _defaultAdminCount++;
        }
    }

    /// @dev ACL-3 / F-06: block dropping the final `ADMIN_ROLE` or
    ///      `DEFAULT_ADMIN_ROLE` holder. Both `revokeRole` and `renounceRole`
    ///      route through this hook.
    function _revokeRole(bytes32 role, address account) internal override returns (bool revoked) {
        if (hasRole(role, account)) {
            if (role == ADMIN_ROLE && _adminCount == 1) revert LastAdminFloor();
            if (role == DEFAULT_ADMIN_ROLE && _defaultAdminCount == 1) revert LastAdminFloor();
        }
        revoked = super._revokeRole(role, account);
        if (revoked) {
            if (role == ADMIN_ROLE) _adminCount--;
            else if (role == DEFAULT_ADMIN_ROLE) _defaultAdminCount--;
        }
    }

    // -------------------------------------------------------------------
    // Initializer
    // -------------------------------------------------------------------

    /// @notice Atomic proxy initialization (the ERC1967Proxy constructor calls it).
    /// @param usdc_    USDC (or 6-decimal stand-in) token address.
    /// @param admin_   Holder of `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`.
    /// @param pauser_  Holder of `DEPOSIT_PAUSER_ROLE`. Must be distinct from agents.
    /// @param upgradeTimelock_ The Safe-controlled timelock: the only upgrade and freeze authority.
    /// @param upgradeMode_ The release mode. `Undeclared` reverts.
    /// @dev The gateway pins no vault and no router. Destinations come from each depositor's
    ///      policy (architecture 5.2).
    function initialize(
        IERC20 usdc_,
        address admin_,
        address pauser_,
        address upgradeTimelock_,
        UpgradeMode upgradeMode_
    ) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __GovernedUUPS_init(upgradeTimelock_, upgradeMode_);
        if (address(usdc_) == address(0)) revert ZeroAddress();
        if (admin_ == address(0)) revert ZeroAddress();
        if (pauser_ == address(0)) revert ZeroAddress();

        usdcToken = usdc_;

        // Historical role-admin pin. The public grant/revoke/renounce methods
        // revert for AGENT_ROLE whatever the stored admin is (ACL-9), so this
        // only keeps `getRoleAdmin(AGENT_ROLE)` stable for existing readers.
        _setRoleAdmin(AGENT_ROLE, ADMIN_ROLE);

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(DEPOSIT_PAUSER_ROLE, pauser_);
    }

    // -------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------

    /// @inheritdoc IGateway
    function usdc() external view returns (address) {
        return address(usdcToken);
    }

    /// @inheritdoc IGateway
    function depositsPaused() external view returns (bool) {
        return _depositsPaused;
    }

    /// @inheritdoc IGateway
    function effectiveDepositWindowGross(address agent) external view returns (uint256) {
        return GatewayWindows.effectiveTotal(_depositWindow[agent]);
    }

    /// @dev Apply an `amount` deposit against the agent's rolling-window deposit
    ///      budget (#497). Reverts with `WindowCapExceeded` when the projected
    ///      cumulative deposit would breach `cap`. On success writes the updated
    ///      `DepositWindow` to storage. Keeps the window write
    ///      out of the entrypoint.
    function _accrueRollingDeposit(address agent, uint256 amount, uint256 cap) internal {
        (bool withinCap, uint64 oldest, uint256 total) =
            GatewayWindows.accrue(_depositWindow[agent], amount, cap);
        if (!withinCap) revert WindowCapExceeded();
        agentDepositWindow[agent] = DepositWindow({windowStart: oldest, gross: total});
    }

    function _commitmentKey(bytes32 commitHash, address committer) internal pure returns (bytes32) {
        return keccak256(abi.encode(commitHash, committer));
    }

    // -------------------------------------------------------------------
    // Agent lifecycle — owner-consented (ACL-9)
    //
    // The only way to register an agent is commitAuthorization +
    // revealAuthorization. The caller of the reveal becomes the agent's owner
    // for that registration and is always the share receiver. No role can
    // grant, revoke or renounce AGENT_ROLE through the public methods.
    //
    // Writers of `agents[...]` / `agentOwner[...]`:
    //   _register        writes both; runs _validatePolicy(caller, p)
    //   setPolicy        writes agents; runs _validatePolicy(caller, p)
    //   _endRegistration deletes both, the role and the deposit window
    // -------------------------------------------------------------------

    /// @inheritdoc IGateway
    function commitAuthorization(bytes32 commitHash) external {
        bytes32 storageKey = _commitmentKey(commitHash, msg.sender);
        commitments[storageKey] =
            Commitment({committer: msg.sender, blockNumber: uint64(block.number)});
        emit CommitSubmitted(msg.sender, commitHash, uint64(block.number));
    }

    /// @inheritdoc IGateway
    function revealAuthorization(address agent, bytes32 salt, AgentPolicy calldata p) external {
        bytes32 commitHash = keccak256(abi.encode(agent, msg.sender, salt));
        bytes32 storageKey = _commitmentKey(commitHash, msg.sender);
        Commitment memory c = commitments[storageKey];

        // 1. Commitment must exist.
        if (c.committer == address(0)) revert CommitmentNotFound();

        // 2. Must wait at least one block (front-running protection).
        if (block.number <= uint256(c.blockNumber)) revert CommitmentTooRecent();

        // 3. Commitment must not be expired.
        if (block.number > uint256(c.blockNumber) + COMMIT_EXPIRY_BLOCKS) {
            revert CommitmentExpired();
        }

        // 4. Clear the commitment before the authorization logic (CEI).
        delete commitments[storageKey];

        emit CommitRevealed(msg.sender, commitHash, agent);

        // 5. Register the agent.
        _register(agent, p);
        // 6. The agent must have consented to this caller and this exact policy
        //    (core 1791), checked after the policy rules so their errors keep
        //    their order. The consent is a `commitAuthorization` the agent made from
        //    its own key; it is cleared here and expires like the owner's commitment.
        //    An agent that reveals for itself consents by calling.
        if (agent != msg.sender) {
            bytes32 ck =
                _commitmentKey(keccak256(abi.encode(msg.sender, keccak256(msg.data))), agent);
            Commitment storage consent = commitments[ck];
            if (consent.committer != agent) revert OwnerConsentMissing();
            if (block.number > uint256(consent.blockNumber) + COMMIT_EXPIRY_BLOCKS) {
                revert CommitmentExpired();
            }
            delete commitments[ck];
        }
    }

    /// @dev Registration logic for `revealAuthorization`. An agent whose policy
    ///      `validUntil` has passed is treated as unowned: the old registration
    ///      is ended (emitting `AgentRevoked(old)`) before the new one starts.
    function _register(address agent, AgentPolicy calldata p) internal {
        if (agent == address(0)) revert ZeroAddress();
        address oldOwner = agentOwner[agent];
        if (oldOwner != address(0)) {
            if (agents[agent].validUntil >= block.timestamp) revert AgentAlreadyOwned();
            _endRegistration(agent, oldOwner);
        }
        _validatePolicy(msg.sender, p);

        agentOwner[agent] = msg.sender;
        agents[agent] = p;

        // The role-separation override in AccessRoles reverts if the candidate
        // already holds ADMIN/DEPOSIT_PAUSER.
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
        // An expired registration cannot be revived: the agent is open to a new owner.
        if (agents[agent].validUntil < block.timestamp) revert AgentPolicyExpired();
        _validatePolicy(msg.sender, p);

        agents[agent] = p;

        emit AgentAuthorized(
            agent, msg.sender, p.validUntil, p.maxPerPayment, p.maxPerWindow, p.shareReceiver
        );
    }

    /// @inheritdoc IGateway
    function revokeAgent(address agent) external {
        if (agent == address(0)) revert ZeroAddress();
        address owner = agentOwner[agent];
        if (owner == address(0) || (msg.sender != owner && msg.sender != agent)) {
            revert NotAgentOwner();
        }
        _endRegistration(agent, owner);
    }

    /// @dev Ends a registration: clears policy, owner, role and the deposit
    ///      budget, then emits `AgentRevoked`.
    function _endRegistration(address agent, address owner) internal {
        delete agents[agent];
        delete agentOwner[agent];
        _revokeRole(AGENT_ROLE, agent);
        GatewayWindows.RollingWindow storage w = _depositWindow[agent];
        w.head = 0;
        w.count = 0;
        w.total = 0;
        delete agentDepositWindow[agent];
        emit AgentRevoked(agent, owner);
    }

    /// @dev The one policy validator every writer of `agents[...]` calls, so
    ///      the rules for first-time registration and for later updates
    ///      cannot drift apart. Every caller must name itself as
    ///      `shareReceiver`, whatever its role (ACL-9).
    function _validatePolicy(address caller, AgentPolicy calldata p) internal view {
        if (p.shareReceiver != caller) revert ShareReceiverNotAuthorized();
        if (!p.active) revert InvalidValidUntil();
        if (p.validUntil < block.timestamp) revert InvalidValidUntil();
        if (p.maxPerPayment == 0 || p.maxPerWindow == 0) revert InvalidAmount();
        if (p.maxPerPayment > p.maxPerWindow) revert InvalidAmount();
        // Destinations: the policy list is the only authority, so it must name at least one
        // contract. A zero entry is never a vault.
        uint256 n = p.allowedDestinations.length;
        if (n == 0) revert EmptyAllowedDestinations();
        for (uint256 i = 0; i < n; i++) {
            if (p.allowedDestinations[i] == address(0)) revert EmptyAllowedDestinations();
        }
        // Retired withdraw members must stay zero: no withdraw path exists.
        if (
            p.assetRecipient != address(0) || p.maxWithdrawPerPayment != 0
                || p.maxWithdrawPerWindow != 0 || p.allowedSourceVaults.length != 0
        ) revert RetiredPolicyFieldNonZero();
    }

    /// @inheritdoc IGateway
    function pauseDeposits() external onlyRole(DEPOSIT_PAUSER_ROLE) {
        if (_depositsPaused) revert DepositsArePaused();
        _depositsPaused = true;
        emit DepositsPaused(msg.sender);
    }

    /// @inheritdoc IGateway
    function unpauseDeposits() external onlyRole(ADMIN_ROLE) {
        if (!_depositsPaused) revert DepositsNotPaused();
        _depositsPaused = false;
        emit DepositsUnpaused(msg.sender);
    }

    // -------------------------------------------------------------------
    // Deposit
    // -------------------------------------------------------------------

    /// @inheritdoc IGateway
    /// @dev The only agent action. Deposits into `destination`, which must appear in the
    ///      policy's non-empty `allowedDestinations`. No registry lookup, no pinned vault.
    ///      Shares are minted to `shareReceiver`. `minSharesPerLeg` is bound into the
    ///      `paymentId` (GW-2) and is not otherwise enforced: the gateway has no router leg.
    function depositTo(
        bytes32 orderId,
        uint256 amount,
        uint64 deadline,
        bytes32 idempotencyKey,
        address destination,
        uint256[] calldata minSharesPerLeg
    ) external nonReentrant onlyRole(AGENT_ROLE) returns (bytes32 paymentId) {
        if (_depositsPaused) revert DepositsArePaused();

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

            // 4. destination must be a member of the policy's allowedDestinations.
            _validateDestination(destination, p.allowedDestinations);
            args.shareReceiver = p.shareReceiver;
            // Capture maxPerWindow from the snapshot so the rolling-window cap
            // check below never re-reads from storage (avoids TOCTOU and saves
            // one cold SLOAD per depositTo call — issue #509).
            args.maxPerWindow = p.maxPerWindow;
        }

        // Gas guard (core 1482): before any vault call, so the estimate sits on this floor.
        _requireGas(DEPOSIT_GAS_FLOOR);

        // 5. windowId — used for event emission only; cap is enforced by the
        //    rolling-window accounting below (#497).
        args.windowId = uint64(block.timestamp / WINDOW_SECONDS);

        // 6. paymentId — DEADLINE INTENTIONALLY EXCLUDED.
        //    OP_DEPOSIT_TO prefix namespaces depositTo ids away from deposit
        //    and withdrawal ids so the same (orderId, amount, idempotencyKey)
        //    tuple cannot be replayed across operation kinds.
        //
        //    NC-9 / GW-2 (idempotency key must bind the FULL intent): the
        //    `destination` and the per-leg slippage vector `minSharesPerLeg` are
        //    folded into the hash. Without them, two depositTo calls sharing the
        //    same (orderId, amount, idempotencyKey) but routing to a different
        //    destination — or carrying a different per-leg floor — collide on the
        //    same paymentId, so the second is silently rejected as a replay even
        //    though it is a materially different execution intent. Binding the
        //    routing target and the slippage vector makes the idempotency key a
        //    fingerprint of the whole intent, never a partial one.
        paymentId = keccak256(
            abi.encode(
                OP_DEPOSIT_TO,
                block.chainid,
                address(this),
                msg.sender,
                orderId,
                amount,
                idempotencyKey,
                destination,
                minSharesPerLeg
            )
        );
        if (usedPaymentIds[paymentId]) revert PaymentIdAlreadyUsed();

        // 7. EFFECTS: write state before any external call (CEI pattern).
        //    Rolling-window deposit cap (#497): eliminates the calendar-boundary
        //    burst that fixed-window accounting allowed. `agentWindowGross` is
        //    no longer written (deprecated in #497; retained for ABI compat).
        //    Issue #509: use the in-memory snapshot value (args.maxPerWindow) to
        //    avoid a second cold SLOAD on agents[msg.sender] and a TOCTOU window
        //    where setPolicy could update maxPerWindow between the snapshot and
        //    this check. Matches the pattern used in deposit().
        _accrueRollingDeposit(msg.sender, amount, args.maxPerWindow);
        usedPaymentIds[paymentId] = true;
        args.paymentId = paymentId;

        // slither-disable-start reentrancy-balance
        // 9. safeTransferFrom with balance-delta verification.
        args.balBefore = usdcToken.balanceOf(address(this));
        usdcToken.safeTransferFrom(msg.sender, address(this), amount);
        if (usdcToken.balanceOf(address(this)) - args.balBefore != amount) {
            revert FeeOnTransferDetected();
        }

        _executeVaultDeposit(args);
        // slither-disable-end reentrancy-balance
    }

    /// @dev Revert `InsufficientGas` when less than `floor` gas is left.
    function _requireGas(uint256 floor) internal view {
        if (gasleft() < floor) revert InsufficientGas(gasleft(), floor);
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
        /// @dev Captured from the in-memory policy snapshot so the rolling-window
        ///      cap check never performs a second cold SLOAD on `agents[msg.sender]`.
        uint256 maxPerWindow;
    }

    /// @dev Reverts `InvalidDestination` unless `destination` appears in the policy list. An
    ///      empty list authorizes nothing, so a legacy stored policy with no destinations is
    ///      inert rather than a wildcard.
    function _validateDestination(address destination, address[] memory allowedDestinations)
        internal
        pure
    {
        uint256 len = allowedDestinations.length;
        for (uint256 i = 0; i < len; i++) {
            if (allowedDestinations[i] == destination) return;
        }
        revert InvalidDestination();
    }

    /// @dev Deposit execution: pre-call share custody check, approve vault, deposit,
    ///      clear allowance, post-call custody invariants, emit event.
    // slither-disable-start reentrancy-balance
    // `depositTo()` is `nonReentrant`; the pre-call balance
    // snapshot and post-call custody checks are therefore safe from observable
    // reentry and the stale-balance warning is a false positive.
    function _executeVaultDeposit(DepositArgs memory args) internal {
        uint256 shareBalanceBefore = IERC20(args.destination).balanceOf(address(this));

        usdcToken.forceApprove(args.destination, args.amount);
        uint256 sharesMinted = IERC4626(args.destination).deposit(args.amount, args.shareReceiver);
        usdcToken.forceApprove(args.destination, 0);

        if (IERC20(args.destination).balanceOf(address(this)) != shareBalanceBefore) {
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

    // slither-disable-end reentrancy-balance
}
