// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5 — On-Chain Gateway
// (See also: Plan tracking issue #109 §3.2 — RobotMoneyGateway.sol)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {AccessRoles} from "./AccessRoles.sol";
import {IGateway} from "./interfaces/IGateway.sol";
import {IPortfolioRouter} from "./interfaces/IPortfolioRouter.sol";
import {IInvestmentCommitteePolicy} from "./interfaces/IInvestmentCommitteePolicy.sol";

/// @title RobotMoneyGateway
/// @notice Thin policy-gated wrapper around `vault.deposit()`. Pulls USDC from
///         the agent, enforces per-agent caps and a per-window gross cap,
///         calls the vault, and routes the resulting `rmUSDC` shares to a
///         per-agent configured receiver.
/// @dev Implements `Plan tracking issue #109` §2.2. Custom errors only;
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
    /// @notice `revealAuthorization` called but no prior commitment exists for
    ///         this commit hash. The depositor must call `commitAuthorization`
    ///         first and wait at least one block.
    error CommitmentNotFound();
    /// @notice `revealAuthorization` called after the commitment has expired
    ///         (block.number > commitBlock + COMMIT_EXPIRY_BLOCKS).
    error CommitmentExpired();
    /// @notice `revealAuthorization` called from a different address than the
    ///         one that submitted the commitment.
    error CommitmentOwnerMismatch();
    /// @notice `revealAuthorization` called but `keccak256(agent, msg.sender, salt)`
    ///         does not match the stored commitment hash.
    error CommitmentHashMismatch();
    /// @notice `revealAuthorization` called in the same block as the commitment.
    ///         Must wait at least one block before revealing.
    error CommitmentTooRecent();
    /// @notice `revealAuthorization` called with a policy whose `shareReceiver`
    ///         is not `msg.sender`. In the permissionless commit/reveal path the
    ///         caller must be the intended share receiver so that vault-share
    ///         allowances from the receiver cannot be spent by an unauthorized
    ///         third party (AZ-GW-1 — critical / access-control).
    error ShareReceiverNotAuthorized();
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
    /// @notice `committeeRegister()` or `committeeVoteSubmit()` called but no IC
    ///         policy contract is configured (`icPolicy == address(0)`).
    error ICPolicyNotSet();

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

    /// @notice Op-kind discriminators prepended to every `paymentId` hash to
    ///         prevent cross-operation replay (deposit id ≠ depositTo id ≠
    ///         withdrawal id ≠ router-withdrawal id even when all other inputs
    ///         are identical).
    uint8 internal constant OP_DEPOSIT = 1;
    uint8 internal constant OP_WITHDRAW = 2;
    uint8 internal constant OP_DEPOSIT_TO = 3;
    uint8 internal constant OP_WITHDRAW_ROUTER = 4;

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

    /// @notice Pending authorization commitment. Stored by commitHash to allow
    ///         the depositor to reveal in a subsequent block, defeating
    ///         mempool front-running of `authorizeAgent`.
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
    ///         first `authorizeAgent` call; cleared on `revokeAgent`. Used to
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
    ///         Mirrors the withdrawal rolling-window pattern (`agentWithdrawWindow`)
    ///         to eliminate the fixed-window boundary burst on the deposit side.
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

    /// @notice Per-agent rolling withdrawal window state. See `WithdrawWindow`.
    mapping(address => WithdrawWindow) public agentWithdrawWindow;

    struct WindowEntry {
        uint64 timestamp;
        uint256 amount;
    }

    /// @notice Bounded ring buffer backing one agent's rolling-window accounting
    ///         (NC-7 / GW-4). The previous design `.push`ed a fresh `WindowEntry`
    ///         for every operation and only advanced a `head` cursor on prune, so
    ///         the underlying dynamic array grew without bound for the life of the
    ///         agent — eventually making every windowed op (and the linear prune
    ///         scan) cost so much gas that the agent gas-bricks itself out of the
    ///         gateway permanently.
    ///
    ///         The ring buffer fixes this in two ways:
    ///           1. SAME-SECOND COALESCING — operations sharing a `block.timestamp`
    ///              merge into the single newest entry instead of appending. The
    ///              count of distinct live entries can therefore never exceed the
    ///              number of distinct seconds in the rolling window, which is
    ///              hard-capped at `MAX_WINDOW_ENTRIES`.
    ///           2. SLOT REUSE — pruned (expired) slots are reclaimed by wrapping
    ///              `head`/`count` around the fixed-capacity `slots` array, so the
    ///              array's storage footprint plateaus at the high-water mark of
    ///              concurrently-live entries and never grows monotonically.
    ///
    ///         Exact rolling-window semantics (strict `(t-WINDOW_SECONDS, t]`
    ///         expiry) are preserved per-entry; only the storage shape changed.
    struct RollingWindow {
        WindowEntry[] slots; // ring storage; length == live capacity (≤ MAX_WINDOW_ENTRIES)
        uint256 head; // index of the oldest live entry
        uint256 count; // number of live entries
        uint256 total; // cumulative amount across the live entries
    }

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

    mapping(address => RollingWindow) private _depositWindow;
    mapping(address => RollingWindow) private _withdrawWindow;

    /// @notice Replay protection. `paymentId => used`.
    mapping(bytes32 => bool) public usedPaymentIds;

    /// @notice Stop-the-world flag.
    bool private _paused;

    /// @notice Investment Committee Policy contract. When set, `committeeRegister`
    ///         and `committeeVoteSubmit` forward calls here. Settable by
    ///         `ADMIN_ROLE` via `setICPolicy`. `address(0)` means not configured.
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

        // Redirect AGENT_ROLE administration to ADMIN_ROLE (F-01 fix-interaction
        // warning). Without this, AGENT_ROLE's admin defaults to
        // DEFAULT_ADMIN_ROLE; once the deploy handover revokes the deployer's
        // Gateway DEFAULT_ADMIN_ROLE (ACL-1), any account holding only ADMIN_ROLE
        // — i.e. the TimelockController after handover — could no longer authorize
        // agents, permanently bricking agent onboarding. Pinning AGENT_ROLE's
        // admin to ADMIN_ROLE (and gating `authorizeAgent` on ADMIN_ROLE) keeps
        // agents grantable by whoever holds ADMIN_ROLE post-handover.
        _setRoleAdmin(AGENT_ROLE, ADMIN_ROLE);

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
        return _effectiveWindowTotal(_withdrawWindow[agent]);
    }

    /// @inheritdoc IGateway
    function effectiveDepositWindowGross(address agent) external view returns (uint256) {
        return _effectiveWindowTotal(_depositWindow[agent]);
    }

    /// @dev Apply a `shares` redemption against the agent's rolling-window
    ///      withdrawal budget (#449). Reverts with `WithdrawWindowCapExceeded`
    ///      when the projected cumulative draw would breach `cap`. On success
    ///      writes the updated `WithdrawWindow` to storage. Extracted from
    ///      `withdraw` to keep the entrypoint within EVM stack-depth limits.
    function _accrueRollingWithdraw(address agent, uint256 shares, uint256 cap) internal {
        RollingWindow storage w = _withdrawWindow[agent];
        _pruneWindow(w);
        uint256 projected = w.total + shares;
        if (projected > cap) revert WithdrawWindowCapExceeded();
        _appendWindowEntry(w, shares);
        agentWithdrawWindow[agent] =
            WithdrawWindow({windowStart: _oldestTimestamp(w), gross: w.total});
    }

    /// @dev Apply an `amount` deposit against the agent's rolling-window deposit
    ///      budget (#497). Reverts with `WindowCapExceeded` when the projected
    ///      cumulative deposit would breach `cap`. On success writes the updated
    ///      `DepositWindow` to storage. Mirrors `_accrueRollingWithdraw` so
    ///      the deposit side is equally hardened against calendar-boundary bursts.
    function _accrueRollingDeposit(address agent, uint256 amount, uint256 cap) internal {
        RollingWindow storage w = _depositWindow[agent];
        _pruneWindow(w);
        uint256 projected = w.total + amount;
        if (projected > cap) revert WindowCapExceeded();
        _appendWindowEntry(w, amount);
        agentDepositWindow[agent] =
            DepositWindow({windowStart: _oldestTimestamp(w), gross: w.total});
    }

    /// @dev Drop every live entry whose timestamp has aged past the rolling
    ///      window `(t-WINDOW_SECONDS, t]`, reclaiming its ring slot and
    ///      decrementing `total`. Strictly bounded: it scans at most `count`
    ///      entries, which can never exceed `MAX_WINDOW_ENTRIES` (NC-7).
    function _pruneWindow(RollingWindow storage w) internal {
        uint256 cutoff = block.timestamp > WINDOW_SECONDS ? block.timestamp - WINDOW_SECONDS : 0;
        uint256 head = w.head;
        uint256 count = w.count;
        uint256 total = w.total;
        uint256 cap = w.slots.length;
        while (count > 0 && w.slots[head].timestamp <= cutoff) {
            total -= w.slots[head].amount;
            head = head + 1 == cap ? 0 : head + 1;
            count--;
        }
        w.head = count == 0 ? 0 : head;
        w.count = count;
        w.total = total;
    }

    /// @dev Record `amount` at the current `block.timestamp` in the ring buffer.
    ///      Operations within the same second COALESCE into the newest live entry
    ///      (no new slot), which is what bounds the live entry count. Otherwise a
    ///      freed slot is reused (ring wrap) or, only while the buffer has not yet
    ///      reached its high-water mark, a new slot is `push`ed — capped at
    ///      `MAX_WINDOW_ENTRIES`. `total` always tracks the live sum.
    function _appendWindowEntry(RollingWindow storage w, uint256 amount) internal {
        uint256 count = w.count;
        uint256 cap = w.slots.length;
        // Same-second coalescing: fold into the newest live entry if present.
        if (count > 0) {
            uint256 newest = w.head + count - 1;
            if (newest >= cap) newest -= cap;
            if (w.slots[newest].timestamp == uint64(block.timestamp)) {
                w.slots[newest].amount += amount;
                w.total += amount;
                return;
            }
        }
        // Distinct second: claim the next ring slot after the newest live entry.
        if (count == cap) {
            // Buffer is completely full — every slot is live, so there is no freed
            // slot to reuse. Grow capacity by one (hard-capped at
            // MAX_WINDOW_ENTRIES), re-linearizing the live region to start at
            // index 0 first so the wrapped layout cannot corrupt ordering. The
            // re-pack is O(count) and only ever runs when the high-water mark
            // actually increases, which is rare in practice.
            //
            // The `count >= MAX_WINDOW_ENTRIES` revert cannot be reached through
            // the public deposit/withdraw API. Live entries each occupy a
            // distinct second (same-second deposits coalesce), and the window is
            // exactly WINDOW_SECONDS == MAX_WINDOW_ENTRIES seconds wide. Filling
            // every distinct second reaches count == MAX_WINDOW_ENTRIES, but
            // adding one more distinct second advances past the oldest entry's
            // expiry, so `_pruneWindow` evicts it before the append ever observes
            // a full buffer. The guard is a defensive overflow bound, never
            // triggerable externally. See
            // test_rollingWindow_liveCountBoundedAcrossDistinctSeconds.
            // coverage:unreachable
            if (count >= MAX_WINDOW_ENTRIES) revert WindowBufferFull();
            _relinearize(w);
            w.slots.push(WindowEntry({timestamp: uint64(block.timestamp), amount: amount}));
            w.head = 0;
            w.count = count + 1;
            w.total += amount;
            return;
        }
        uint256 tail = w.head + count;
        if (tail >= cap) tail -= cap;
        w.slots[tail] = WindowEntry({timestamp: uint64(block.timestamp), amount: amount});
        w.count = count + 1;
        w.total += amount;
    }

    /// @dev Rotate the full ring buffer so the oldest live entry sits at index 0.
    ///      Precondition: the buffer is completely full (`count == slots.length`),
    ///      so every slot is live and a simple rotation by `head` re-linearizes
    ///      the live region. Used only on the rare grow path. Implemented as a
    ///      sequence of in-place reversals (reverse[0,head), reverse[head,len),
    ///      reverse[0,len)) so it needs no scratch array.
    function _relinearize(RollingWindow storage w) internal {
        uint256 head = w.head;
        if (head == 0) return;
        uint256 len = w.slots.length;
        _reverseRange(w, 0, head);
        _reverseRange(w, head, len);
        _reverseRange(w, 0, len);
        w.head = 0;
    }

    /// @dev Reverse `slots[lo:hi)` in place.
    function _reverseRange(RollingWindow storage w, uint256 lo, uint256 hi) internal {
        while (lo + 1 < hi) {
            hi--;
            WindowEntry memory tmp = w.slots[lo];
            w.slots[lo] = w.slots[hi];
            w.slots[hi] = tmp;
            lo++;
        }
    }

    /// @dev Timestamp of the oldest live entry, or 0 when the window is empty.
    function _oldestTimestamp(RollingWindow storage w) internal view returns (uint64) {
        // The empty-window early return is dead through the public API.
        // `_oldestTimestamp` is only called in
        // `_accrueRollingWithdraw`/`_accrueRollingDeposit`, immediately after
        // `_appendWindowEntry` has added an entry, so `w.count` is always >= 1
        // at the call site. The guard is defensive for internal reuse only.
        // coverage:unreachable
        if (w.count == 0) return 0;
        return w.slots[w.head].timestamp;
    }

    /// @dev View-only effective live total after notionally pruning expired
    ///      entries. Mirrors `_pruneWindow`'s arithmetic without mutating storage.
    function _effectiveWindowTotal(RollingWindow storage w) internal view returns (uint256 total) {
        uint256 cutoff = block.timestamp > WINDOW_SECONDS ? block.timestamp - WINDOW_SECONDS : 0;
        uint256 head = w.head;
        uint256 count = w.count;
        total = w.total;
        uint256 cap = w.slots.length;
        while (count > 0 && w.slots[head].timestamp <= cutoff) {
            total -= w.slots[head].amount;
            head = head + 1 == cap ? 0 : head + 1;
            count--;
        }
    }

    function _commitmentKey(bytes32 commitHash, address committer) internal pure returns (bytes32) {
        return keccak256(abi.encode(commitHash, committer));
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

        // 2. Revealer must be the original committer.
        //
        // Note: this branch is defense-in-depth only. Because the commit hash
        // is computed as `keccak256(abi.encode(agent, msg.sender, salt))` at
        // commit time, a caller with a different `msg.sender` would produce a
        // different hash. The lookup above returns a zero-committer entry for
        // that hash (no matching commitment), which already reverts at step 1.
        // The `CommitmentOwnerMismatch` check here is therefore unreachable
        // through the current API surface.
        // coverage:unreachable
        if (c.committer != msg.sender) revert CommitmentOwnerMismatch();

        // 3. Must wait at least one block (front-running protection).
        if (block.number <= uint256(c.blockNumber)) revert CommitmentTooRecent();

        // 4. Commitment must not be expired.
        if (block.number > uint256(c.blockNumber) + COMMIT_EXPIRY_BLOCKS) {
            revert CommitmentExpired();
        }

        // 5. Clear the commitment before the authorization logic (CEI).
        delete commitments[storageKey];

        emit CommitRevealed(msg.sender, commitHash, agent);

        // 6. Perform the authorization (same logic as authorizeAgent).
        _authorizeAgentInternal(agent, p);
    }

    /// @inheritdoc IGateway
    function authorizeAgent(address agent, AgentPolicy calldata p) external onlyRole(ADMIN_ROLE) {
        _authorizeAgentInternal(agent, p);
    }

    /// @dev Shared authorization logic for both `authorizeAgent` (direct) and
    ///      `revealAuthorization` (commit/reveal path). Extracted to avoid code
    ///      duplication and to keep each entrypoint concise.
    function _authorizeAgentInternal(address agent, AgentPolicy calldata p) internal {
        if (agent == address(0)) revert ZeroAddress();
        if (agentOwner[agent] != address(0)) revert AgentAlreadyOwned();

        // AZ-GW-1 (critical): in the permissionless commit/reveal path the caller
        // must be the intended share receiver. Without this gate an attacker can
        // name a victim as `shareReceiver`, obtain AGENT_ROLE, and drain the
        // victim's vault-share allowance via `withdrawFromRouter` by routing USDC
        // to an attacker-controlled `assetRecipient`. The `ADMIN_ROLE` path
        // (`authorizeAgent`) is exempt because the caller is a trusted privileged
        // account; permissionless callers have no implicit authority over a
        // third-party's share allowances.
        if (!hasRole(ADMIN_ROLE, msg.sender)) {
            if (p.shareReceiver != msg.sender) revert ShareReceiverNotAuthorized();
        }

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
    /// @dev Implements §2.2 steps 1–12. Effects (`usedPaymentIds`, rolling
    ///      deposit window) are written before external calls (CEI pattern).
    ///      `nonReentrant` provides defense-in-depth.
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

        // 4. windowId — used for event emission only; cap is enforced by the
        //    rolling-window accounting below (#497).
        uint64 windowId = uint64(block.timestamp / WINDOW_SECONDS);

        // 5. paymentId — DEADLINE INTENTIONALLY EXCLUDED.
        //    OP_DEPOSIT prefix namespaces deposit ids away from withdrawal ids.
        paymentId = keccak256(
            abi.encode(
                OP_DEPOSIT,
                block.chainid,
                address(this),
                msg.sender,
                orderId,
                amount,
                idempotencyKey
            )
        );
        if (usedPaymentIds[paymentId]) revert PaymentIdAlreadyUsed();

        uint256 shareBalanceBefore = IERC20(address(vaultContract)).balanceOf(address(this));

        // 6. EFFECTS: write state before any external call (CEI pattern).
        //    Rolling-window deposit cap (#497): eliminates the calendar-boundary
        //    burst that fixed-window accounting allowed. `agentWindowGross` is
        //    no longer written (deprecated in #497; retained for ABI compat).
        _accrueRollingDeposit(msg.sender, amount, p.maxPerWindow);
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
        if (IERC20(address(vaultContract)).balanceOf(address(this)) != shareBalanceBefore) {
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
            // Capture maxPerWindow from the snapshot so the rolling-window cap
            // check below never re-reads from storage (avoids TOCTOU and saves
            // one cold SLOAD per depositTo call — issue #509).
            args.maxPerWindow = p.maxPerWindow;
        }

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
        /// @dev Captured from the in-memory policy snapshot so the rolling-window
        ///      cap check never performs a second cold SLOAD on `agents[msg.sender]`.
        uint256 maxPerWindow;
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
    // slither-disable-start reentrancy-balance
    // `deposit()` and `depositTo()` are `nonReentrant`; the pre-call balance
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
    ///
    ///      Share custody requirement (audit 2026-06-09, L-13 — intentional):
    ///      this single-vault path pulls shares from the AGENT (`msg.sender`),
    ///      while `deposit` mints shares to `policy.shareReceiver` and the
    ///      router path (`withdrawFromRouter`) pulls from `policy.shareReceiver`.
    ///      Single-vault withdrawal therefore requires `agent == shareReceiver`,
    ///      or the share holder to have transferred shares to the agent first.
    ///      This matches the production client contract: rmpc preflights
    ///      `vault.allowance(agent, gateway)` and `vault.balanceOf(agent)`
    ///      (clients/rust-payment-client/src/commands/withdraw.rs) before
    ///      submitting, so changing the pull source here would break the only
    ///      production caller. No funds are at risk either way: USDC always
    ///      settles to `policy.assetRecipient`.
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
        //    OP_WITHDRAW prefix namespaces withdrawal ids away from deposit ids.
        paymentId = keccak256(
            abi.encode(
                OP_WITHDRAW,
                block.chainid,
                address(this),
                msg.sender,
                orderId,
                shares,
                idempotencyKey
            )
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

        uint256 shareBalanceBefore = IERC20(sourceVault).balanceOf(address(this));

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
        if (IERC20(sourceVault).balanceOf(address(this)) != shareBalanceBefore) {
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

    // -------------------------------------------------------------------
    // Router Withdrawal
    // -------------------------------------------------------------------

    /// @notice Error: `withdrawFromRouter()` called but no router is configured
    ///         (`routerContract == address(0)`).
    error RouterNotConfigured();

    /// @notice Error: `sharesPerLeg` length does not match the router's current
    ///         effective weight vector length.
    error RouterLegLengthMismatch();

    /// @dev Internal args struct to avoid stack-too-deep in `withdrawFromRouter`.
    struct RouterWithdrawArgs {
        bytes32 paymentId;
        bytes32 orderId;
        address shareHolder;
        address assetRecipient;
        uint256 totalShares;
        uint64 windowId;
        uint64 deadline;
        address[] vaultList;
        uint256[] shareBalancesBefore;
    }

    /// @inheritdoc IGateway
    /// @dev Proportional multi-vault redemption through the Portfolio Router.
    ///      All legs must succeed (all-or-revert). No outer share token is
    ///      minted; the gateway temporarily holds each vault's shares during the
    ///      call frame and passes them to the router's `redeemFor`, which calls
    ///      `vault.redeem` per leg and delivers USDC directly to `assetRecipient`.
    ///      CEI pattern: all state effects written before external calls.
    ///      `nonReentrant` provides defense-in-depth.
    function withdrawFromRouter(
        bytes32 orderId,
        address[] calldata vaults,
        uint256[] calldata sharesPerLeg,
        uint256[] calldata minAssetsPerLeg,
        uint64 deadline,
        bytes32 idempotencyKey
    )
        external
        nonReentrant
        onlyRole(AGENT_ROLE)
        returns (bytes32 paymentId, uint256[] memory assetsPerLeg)
    {
        if (_paused) revert PausedError();

        // 1. Router must be configured.
        if (address(routerContract) == address(0)) revert RouterNotConfigured();

        // 1a. The caller-supplied per-leg slippage floor must be parallel to the
        //     share vector (GW-5 / F-11). The gateway forwards this floor verbatim
        //     to the router; it no longer fabricates an all-zero vector.
        if (minAssetsPerLeg.length != sharesPerLeg.length) revert RouterLegLengthMismatch();

        // Build args struct early to collapse locals onto the heap.
        RouterWithdrawArgs memory args;
        args.orderId = orderId;
        // F-03/NC-5 (issue #967): redeem legs are driven by the caller-supplied
        // explicit `vaults[]`, not the router's live weight vector, so a holder
        // can exit a reweighted-out or retired position. The array is identity-
        // bound to `sharesPerLeg` and committed to the intent hash (paymentId).
        args.vaultList = vaults;
        // F-11 (issue #969): forward the real agent deadline to the router too.
        args.deadline = deadline;

        {
            AgentPolicy memory p = agents[msg.sender];

            // 2. Withdrawal must be enabled for this agent.
            if (p.maxWithdrawPerPayment == 0) revert WithdrawalNotEnabled();

            // 3. deadline window.
            if (block.timestamp > deadline) revert DeadlineExpired();
            if (deadline > block.timestamp + MAX_DEADLINE_SKEW) revert DeadlineTooFar();

            // 4. policy active and not expired.
            // coverage:unreachable
            if (!p.active) revert AgentNotAuthorized();
            if (p.validUntil < block.timestamp) revert AgentPolicyExpired();

            // 5. Validate the leg arrays are parallel. The vault set is the
            //    caller-supplied `vaults[]` (issue #967, F-03) — NOT the router's
            //    live weight vector — so a holder can redeem a position the router
            //    has reweighted away from. The router re-validates each named vault
            //    against the registry (registered + not Paused) in `redeemFor`.
            if (args.vaultList.length == 0) revert RouterLegLengthMismatch();
            if (sharesPerLeg.length != args.vaultList.length) revert RouterLegLengthMismatch();

            // 5a. allowedSourceVaults check: every vault with non-zero shares
            //     must be in the policy allowlist when non-empty, or must be
            //     the pinned vault (vaultContract) when the list is empty.
            //     AZ-GW-3: an empty list is NOT an open allowlist — it is a
            //     pinned-vault-only restriction (matching the single-vault
            //     withdraw path and the IGateway.AgentPolicy natspec).
            uint256 slen = p.allowedSourceVaults.length;
            if (slen > 0) {
                for (uint256 i = 0; i < args.vaultList.length; i++) {
                    if (sharesPerLeg[i] == 0) continue;
                    address vaultAddr = args.vaultList[i];
                    bool found;
                    for (uint256 j = 0; j < slen && !found; j++) {
                        found = p.allowedSourceVaults[j] == vaultAddr;
                    }
                    if (!found) revert InvalidSourceVault();
                }
            } else {
                // Empty allowlist → pinned-vault only.
                address pinned = address(vaultContract);
                for (uint256 i = 0; i < args.vaultList.length; i++) {
                    if (sharesPerLeg[i] == 0) continue;
                    if (args.vaultList[i] != pinned) revert InvalidSourceVault();
                }
            }

            // 6. Compute totalShares for cap accounting.
            for (uint256 i = 0; i < sharesPerLeg.length; i++) {
                args.totalShares += sharesPerLeg[i];
            }
            if (args.totalShares == 0) revert InvalidAmount();
            if (args.totalShares > p.maxWithdrawPerPayment) {
                revert SharesExceedWithdrawPerPaymentCap();
            }

            // 7. Rolling-window cap (#449).
            _accrueRollingWithdraw(msg.sender, args.totalShares, p.maxWithdrawPerWindow);

            // Capture policy fields into args to avoid p being live across
            // external calls (stack frame shrinks, helps viaIR codegen).
            args.shareHolder = p.shareReceiver;
            args.assetRecipient = p.assetRecipient;
        }

        // 8. windowId — informational only.
        args.windowId = uint64(block.timestamp / WINDOW_SECONDS);

        // 9. paymentId — DEADLINE INTENTIONALLY EXCLUDED (a deadline is liveness,
        //    not intent). `minAssetsPerLeg` IS bound (GW-5 / F-11): the per-leg
        //    slippage floor is part of the redemption intent, so a replay can
        //    never re-execute the same order under a weaker (e.g. zeroed) floor.
        //    OP_WITHDRAW_ROUTER prefix namespaces router-withdrawal ids away
        //    from the three sibling op kinds (audit 2026-06-09, L-12).
        //    The explicit `vaults[]` and `sharesPerLeg` are committed to the
        //    intent hash (issue #967, NC-5): the redeemed leg set is part of the
        //    signed intent, so two withdrawals that name different vaults or
        //    per-leg shares can never collide on the same paymentId.
        args.paymentId = _routerWithdrawPaymentId(
            orderId, args.totalShares, vaults, sharesPerLeg, minAssetsPerLeg, idempotencyKey
        );
        if (usedPaymentIds[args.paymentId]) revert PaymentIdAlreadyUsed();

        // 10. EFFECTS: paymentId reservation.
        usedPaymentIds[args.paymentId] = true;

        // 11–14. Execute the multi-leg redemption in a separate frame to
        //        stay within EVM stack-depth limits.
        assetsPerLeg = _executeRouterWithdraw(args, sharesPerLeg, minAssetsPerLeg);

        paymentId = args.paymentId;

        // 15. Event — emit from the outer frame so indexed args are available.
        emit AgentWithdrawalRouted(
            args.paymentId,
            args.orderId,
            msg.sender,
            address(routerContract),
            args.shareHolder,
            sharesPerLeg,
            assetsPerLeg,
            args.assetRecipient,
            args.windowId
        );
    }

    /// @dev Compute the router-withdrawal paymentId. DEADLINE INTENTIONALLY
    ///      EXCLUDED (a deadline is liveness, not intent). `OP_WITHDRAW_ROUTER`
    ///      prefix namespaces these ids from the three sibling op kinds (L-12).
    ///      The explicit `vaults`/`sharesPerLeg` are committed so two withdrawals
    ///      that name different vaults or per-leg shares can never collide (#967,
    ///      NC-5), and `minAssetsPerLeg` is bound so a replay can never re-execute
    ///      the same order under a weaker (e.g. zeroed) slippage floor (GW-5 /
    ///      F-11). Extracted to a helper to keep `withdrawFromRouter` under the
    ///      EVM stack-depth limit.
    function _routerWithdrawPaymentId(
        bytes32 orderId,
        uint256 totalShares,
        address[] calldata vaults,
        uint256[] calldata sharesPerLeg,
        uint256[] calldata minAssetsPerLeg,
        bytes32 idempotencyKey
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                OP_WITHDRAW_ROUTER,
                block.chainid,
                address(this),
                msg.sender,
                orderId,
                totalShares,
                vaults,
                sharesPerLeg,
                keccak256(abi.encode(minAssetsPerLeg)),
                idempotencyKey
            )
        );
    }

    // -------------------------------------------------------------------
    // Investment Committee routing (issue #1049)
    // -------------------------------------------------------------------

    /// @notice Emitted when the IC policy contract address is set or updated.
    /// @param by     Address that called `setICPolicy` (must hold `ADMIN_ROLE`).
    /// @param policy New IC policy contract address (`address(0)` clears it).
    event ICPolicySet(address indexed by, address indexed policy);

    /// @notice Set or update the Investment Committee policy contract address.
    ///         Restricted to `ADMIN_ROLE`. Pass `address(0)` to clear (disable).
    /// @param policy_ Address of the deployed `InvestmentCommitteePolicy` contract,
    ///                or `address(0)` to disable committee routing.
    function setICPolicy(address policy_) external onlyRole(ADMIN_ROLE) {
        icPolicy = IInvestmentCommitteePolicy(policy_);
        emit ICPolicySet(msg.sender, policy_);
    }

    /// @notice Forward a committee agent registration to the IC policy contract.
    ///         Restricted to `ADMIN_ROLE` (mirrors IC contract's own `ADMIN_ROLE`
    ///         requirement on `registerAgent`). Reverts if `icPolicy` is not set.
    ///
    ///         All committee writes pass through the gateway so that the IC
    ///         contract's `onlyGateway` modifier enforcement is the single
    ///         choke point — no committee side channel exists.
    ///
    /// @param agent    Address to grant `COMMITTEE_AGENT_ROLE` on the IC contract.
    /// @param agentId_ Human-readable label (e.g. "athena-v1").
    function committeeRegister(address agent, string calldata agentId_)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (address(icPolicy) == address(0)) revert ICPolicyNotSet();
        icPolicy.registerAgent(agent, agentId_);
    }

    /// @notice Forward a signed committee vote to the IC policy contract.
    ///         Restricted to `AGENT_ROLE`. Reverts if `icPolicy` is not set or
    ///         if the IC contract's own guards fail (agent not allowlisted,
    ///         invalid vote fields, etc.).
    ///
    ///         The gateway is the sole permitted caller of `IC.submitVote`
    ///         (enforced by the IC contract's `onlyGateway` modifier). This
    ///         function is the only path through which an agent may reach the
    ///         IC contract.
    ///
    /// @param p  All vote fields packed into a `VoteParams` struct.
    /// @return voteId  Index of the newly appended vote in the IC contract.
    function committeeVoteSubmit(IInvestmentCommitteePolicy.VoteParams calldata p)
        external
        onlyRole(AGENT_ROLE)
        returns (uint256 voteId)
    {
        if (address(icPolicy) == address(0)) revert ICPolicyNotSet();
        voteId = icPolicy.submitVote(p);
    }

    /// @dev Execute the multi-leg router withdrawal: pull shares from shareHolder,
    ///      approve router, call redeemFor, clear allowances, verify custody.
    ///      Separated to avoid stack-too-deep in `withdrawFromRouter`.
    function _executeRouterWithdraw(
        RouterWithdrawArgs memory args,
        uint256[] calldata sharesPerLeg,
        uint256[] calldata minAssetsPerLeg
    ) internal returns (uint256[] memory assetsPerLeg) {
        // slither-disable-start reentrancy-balance
        // Justification: all state effects (paymentId, rolling window) are written
        // in the calling frame before this function is called (CEI). `nonReentrant`
        // on the outer function provides defense-in-depth. AGENT_ROLE gate limits
        // callers. The share-pull loop below temporarily custodies shares within the
        // call frame and passes them through to the router within the same frame.

        // 11. Pull each vault's shares from shareHolder into the gateway,
        //     then approve the router to spend them on behalf of the gateway.
        args.shareBalancesBefore = new uint256[](args.vaultList.length);
        for (uint256 i = 0; i < sharesPerLeg.length; i++) {
            args.shareBalancesBefore[i] = IERC20(args.vaultList[i]).balanceOf(address(this));
            if (sharesPerLeg[i] == 0) continue;
            IERC20(args.vaultList[i])
                .safeTransferFrom(args.shareHolder, address(this), sharesPerLeg[i]);
            IERC20(args.vaultList[i]).forceApprove(address(routerContract), sharesPerLeg[i]);
        }

        // 12. Call router.redeemFor — router calls vault.redeem per leg with
        //     the gateway as `owner`. USDC goes directly to assetRecipient.
        //     The agent's `deadline` is enforced upstream in `withdrawFromRouter`
        //     (step 3) before any state effects AND forwarded here so the router's
        //     own deadline guard also bites (no `type(uint256).max` bypass — F-11).
        //     The caller-supplied per-leg slippage floor (`minAssetsPerLeg`) is
        //     forwarded verbatim: each non-zero leg reverts `SlippageExceeded`
        //     when realized USDC proceeds fall below the floor. The gateway no
        //     longer fabricates an all-zero floor vector (GW-5 / F-11).
        assetsPerLeg = routerContract.redeemFor(
            address(this),
            args.assetRecipient,
            args.vaultList,
            sharesPerLeg,
            minAssetsPerLeg,
            uint256(args.deadline)
        );

        // 13. Clear residual vault share approvals (defense-in-depth).
        for (uint256 i = 0; i < sharesPerLeg.length; i++) {
            if (sharesPerLeg[i] == 0) continue;
            IERC20(args.vaultList[i]).forceApprove(address(routerContract), 0);
        }

        // 14. Post-call custody invariant: gateway must hold zero vault shares.
        for (uint256 i = 0; i < args.vaultList.length; i++) {
            if (IERC20(args.vaultList[i]).balanceOf(address(this)) != args.shareBalancesBefore[i]) {
                revert ShareCustodyInvariantViolated();
            }
        }
        // slither-disable-end reentrancy-balance
    }
}
