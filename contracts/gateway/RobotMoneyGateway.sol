// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5 — On-Chain Gateway
// (See also: Plan tracking issue #109 §3.2 — RobotMoneyGateway.sol;
//  docs/adr/ADR-0014-governed-upgrades-and-freeze.md — UUPS proxy, timelock upgrades, freeze)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {GovernedUpgrade} from "../lib/GovernedUpgrade.sol";
import {GatewayWindows} from "../lib/GatewayWindows.sol";
import {GatewayAuth} from "../lib/GatewayAuth.sol";
import {GatewayWithdrawOps} from "../lib/GatewayWithdrawOps.sol";

import {AccessRoles} from "./AccessRoles.sol";
import {IGateway} from "./interfaces/IGateway.sol";
import {IPortfolioRouter} from "./interfaces/IPortfolioRouter.sol";
import {IInvestmentCommitteePolicy} from "./interfaces/IInvestmentCommitteePolicy.sol";
import {IConsensusRecommendationReceipt} from "./interfaces/IConsensusRecommendationReceipt.sol";

/// @title RobotMoneyGateway
/// @notice Thin policy-gated wrapper around `vault.deposit()`. Pulls USDC from
///         the agent, enforces per-agent caps and a per-window gross cap,
///         calls the vault, and routes the resulting `rmUSDC` shares to a
///         per-agent configured receiver.
/// @dev Implements `Plan tracking issue #109` §2.2. Custom errors only;
///      OZ v5 SafeERC20; the gateway must never custody `rmUSDC`. Idempotency
///      hash deliberately excludes `deadline`.
///
///      Upgradeability (ADR-0014): deployed behind its own ERC1967Proxy and
///      initialized in the proxy's deployment transaction. Only the timelock named
///      at `initialize` can upgrade it, and `freezeUpgrades` ends upgrades forever.
///      The withdraw paths have no upgrade- or freeze-dependent branch. The
///      EIP-712 domain uses `address(this)`, the proxy, so a consent stays bound
///      to the proxy address across upgrades (ADR-0014 §10).
contract RobotMoneyGateway is AccessRoles, ReentrancyGuardUpgradeable, GovernedUpgrade, IGateway {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------

    /// @notice Gas left is below the floor a withdraw needs before it fans out to the vault
    ///         (or to the router and its vaults). Raised before the external call so a
    ///         gas limit that is too low reverts with a reason. Retry with more gas. (core 1482.)
    /// @param available `gasleft()` at the check.
    /// @param required  The floor that was not met.
    error InsufficientGas(uint256 available, uint256 required);

    /// @dev Gas `withdraw` needs, checked at entry before any state-dependent work (core 1482).
    ///      The vault's entry floor is 1_600_000 after the 63/64 forward (about 1_625_400 at the
    ///      call), and the gateway spends its policy reads, window and payment-id writes and the
    ///      share pull before the call. A floor checked after that work would move with the
    ///      state, so eth_estimateGas could land on it and fail at inclusion.
    ///      See docs/technical/redeem-gas-1482.md.
    uint256 internal constant WITHDRAW_GAS_FLOOR = 2_000_000;
    /// @dev `withdrawFromRouter` needs this fixed part plus `ROUTER_WITHDRAW_GAS_PER_LEG` per
    ///      non-zero leg, checked at entry. Per leg the router needs 1_700_000 after the 63/64
    ///      forward (about 1_727_000 at the call) plus the gateway's share pull, approvals and
    ///      custody reads for that leg.
    uint256 internal constant ROUTER_WITHDRAW_BASE_GAS = 400_000;
    uint256 internal constant ROUTER_WITHDRAW_GAS_PER_LEG = 1_850_000;
    /// @dev `deposit` and a vault-destination `depositTo` need this at entry. The vault's deposit
    ///      entry floor is 1_600_000 after the 63/64 forward, and the gateway spends its policy
    ///      reads, window and payment-id writes and the USDC pull before the call.
    uint256 internal constant DEPOSIT_GAS_FLOOR = 2_000_000;
    /// @dev A router-destination `depositTo` needs this fixed part plus
    ///      `ROUTER_DEPOSIT_GAS_PER_LEG` per effective weight leg, checked before the first
    ///      vault call. Per leg the router needs 1_700_000 after the 63/64 forward.
    uint256 internal constant ROUTER_DEPOSIT_BASE_GAS = 400_000;
    uint256 internal constant ROUTER_DEPOSIT_GAS_PER_LEG = 1_850_000;

    /// @notice Constructor or admin call passed `address(0)` where a real address is required.
    error ZeroAddress();
    /// @notice Constructor-time check: vault.asset() does not match the configured USDC token.
    error AssetMismatch();
    /// @notice Deposit rejected because gateway deposits are paused (also raised by
    ///         `pauseDeposits()` if deposits are already paused). Withdrawals never raise it.
    error DepositsArePaused();
    /// @notice `unpauseDeposits()` called while deposits were not paused.
    error DepositsNotPaused();
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
    ///         `setPolicy`, `revokeAgent` and `transferAgentOwnership` when
    ///         `msg.sender != agentOwner[agent]`.
    error NotAgentOwner();
    /// @notice `transferAgentOwnership` named a destination that does not hold
    ///         `ADMIN_ROLE`. An agent can only be handed to an `ADMIN_ROLE` holder.
    error NewAgentOwnerNotAdmin();
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
    /// @notice A caller without `ADMIN_ROLE` named a `shareReceiver` other than
    ///         itself. Raised by `revealAuthorization` and `setPolicy`: every
    ///         policy writer applies the same caller-dependent rule, judged on
    ///         the caller's role at call time (`authorizeAgent` callers hold
    ///         `ADMIN_ROLE`, so it never raises it).
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
    /// @notice `committeeVoteSubmit()` called with `p.agent != msg.sender`. A
    ///         committee signal is the caller's own (architecture §4.8 identity
    ///         model), so one gateway agent cannot file it under another
    ///         member's address (issue #1790).
    error CommitteeAgentNotCaller();
    /// @notice `consensusRecordReceipt()` called but no consensus receipt contract
    ///         is configured (`consensusReceipt == address(0)`).
    error ConsensusReceiptNotSet();
    /// @notice A caller without `ADMIN_ROLE` revealed for an agent other than
    ///         itself, and `agentConsent` is missing, malformed, or not the
    ///         agent's EIP-712 signature over this owner, share receiver and
    ///         the agent's current `agentConsentNonce` (issue #1791).
    error InvalidAgentConsent();
    /// @notice `releaseAgent` called by an address that has no recorded owner,
    ///         or whose binding carries its consent (issue #1791).
    error AgentNotReleasable();

    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------

    /// @notice Window length in seconds for per-window gross caps. Unix-epoch
    ///         aligned: `windowId = block.timestamp / WINDOW_SECONDS`.
    uint64 public constant WINDOW_SECONDS = GatewayWindows.WINDOW_SECONDS;

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

    /// @notice EIP-712 type of the agent's consent to a binding (issue #1791).
    ///         Signed by the agent; `owner` is the revealer, `nonce` is
    ///         `agentConsentNonce(agent)`.
    bytes32 public constant AGENT_CONSENT_TYPEHASH = GatewayAuth.AGENT_CONSENT_TYPEHASH;
    /// @dev EIP-712 domain parts. The separator is derived per call from
    ///      `block.chainid` and `address(this)` (the proxy), so a consent never
    ///      verifies on another chain or another gateway. The domain `version` is
    ///      `implementationVersion()` (ADR-0014 §10, QA plan Decisions D5).
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant _EIP712_NAME_HASH = keccak256("RobotMoneyGateway");

    // -------------------------------------------------------------------
    // Write-once addresses (constructor immutables before ADR-0014)
    // -------------------------------------------------------------------

    /// @notice Pinned USDC token. Written once by `initialize`; no setter.
    IERC20 public usdcToken;

    /// @notice Pinned ERC-4626 vault. Written once by `initialize`; no setter.
    IERC4626 public vaultContract;

    /// @notice Portfolio Router for multi-vault agent deposits. May be `address(0)`
    ///         if the gateway was deployed without router support. Written once
    ///         by `initialize`; no setter.
    IPortfolioRouter public routerContract;

    // -------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------

    /// @notice Pending commitments keyed by
    ///         `keccak256(abi.encode(commitHash, committer))`. Caller scoping
    ///         prevents another account from overwriting a commitment observed
    ///         in the mempool or on-chain. A commitment (`GatewayAuth.Commitment`:
    ///         committer, block number) lets the depositor reveal in a later
    ///         block, defeating mempool front-running of the authorization.
    mapping(bytes32 => GatewayAuth.Commitment) public commitments;

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

    // Rolling windows (NC-7 / GW-4): one bounded ring buffer per agent per side,
    // `GatewayWindows.RollingWindow`, maintained by the linked `GatewayWindows`
    // library (ADR-0014 §9). Same-second operations coalesce and freed slots are
    // reused, so the storage footprint plateaus and every windowed op stays O(1)
    // in storage while keeping exact `(t-WINDOW_SECONDS, t]` expiry per entry.

    /// @notice Hard cap on the number of distinct live ring-buffer entries per
    ///         agent per side. Because same-second operations coalesce, the live
    ///         count can never exceed the number of distinct seconds in the
    ///         rolling window; this constant pins the storage footprint regardless
    ///         and makes the bound explicit. `WINDOW_SECONDS` distinct seconds is
    ///         the theoretical ceiling, but no real agent approaches it — the cap
    ///         exists purely so the worst case is provably O(1) in storage.
    uint256 public constant MAX_WINDOW_ENTRIES = GatewayWindows.MAX_WINDOW_ENTRIES;

    /// @notice Raised when an agent's live window-entry count would exceed
    ///         `MAX_WINDOW_ENTRIES`. Unreachable in practice (same-second
    ///         coalescing keeps the live count far below the cap) but guarantees
    ///         the ring buffer can never silently overflow its bound.
    error WindowBufferFull();

    mapping(address => GatewayWindows.RollingWindow) private _depositWindow;
    mapping(address => GatewayWindows.RollingWindow) private _withdrawWindow;

    /// @notice Replay protection. `paymentId => used`.
    mapping(bytes32 => bool) public usedPaymentIds;

    /// @notice Deposit pause flag. Blocks `deposit` and `depositTo` only. Withdrawals
    ///         are never frozen (owner decision 2026-10-05, core 1494).
    bool private _depositsPaused;

    /// @notice Investment Committee Policy contract. When set, `committeeRegister`
    ///         and `committeeVoteSubmit` forward calls here. Settable by
    ///         `ADMIN_ROLE` via `setICPolicy`. `address(0)` means not configured.
    IInvestmentCommitteePolicy public icPolicy;

    // ─── Last-admin floor (ACL-3 / F-06) ──────────────────────────────
    //
    // Appended at the END of storage so the layout of every preceding slot
    // stayed unchanged in the direct-deployment series — a plain manual
    // counter, not AccessControlEnumerable, to avoid both a storage-layout
    // shift and the extra bytecode. (ADR-0014 started a new proxy layout
    // series; `contracts/test/fixtures/storage-layout/RobotMoneyGateway.json`
    // pins it, and new fields append after `agentConsented`.) The two privileged admin
    // tiers (`ADMIN_ROLE`, `DEFAULT_ADMIN_ROLE`) each get a counter; revoking
    // or renouncing the sole holder of either is forbidden, so governance can
    // never be permanently bricked.

    /// @notice Number of accounts currently holding `ADMIN_ROLE`.
    uint256 private _adminCount;
    /// @notice Number of accounts currently holding `DEFAULT_ADMIN_ROLE`.
    uint256 private _defaultAdminCount;

    /// @notice Consensus Recommendation Receipt contract. When set,
    ///         `consensusRecordReceipt` forwards calls here. Settable by
    ///         `ADMIN_ROLE` via `setConsensusReceipt`. `address(0)` means not
    ///         configured. Appended after the admin-tier counters so no
    ///         preceding storage slot moves.
    IConsensusRecommendationReceipt public consensusReceipt;

    /// @inheritdoc IGateway
    /// @dev Appended after `consensusReceipt` so no preceding slot moves.
    mapping(address => uint256) public agentConsentNonce;

    /// @inheritdoc IGateway
    /// @dev Set on a binding made with the agent's consent; cleared with the
    ///      binding by `revokeAgent`. Gates `releaseAgent`.
    mapping(address => bool) public agentConsented;

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
    // Initializer (ADR-0014)
    // -------------------------------------------------------------------

    /// @dev The implementation is never initialized: only a proxy is.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy. Runs once, inside the proxy's deployment transaction.
    /// @param usdc_            USDC (or 6-decimal stand-in) token address.
    /// @param vault_           ERC-4626 vault whose `asset()` MUST equal `usdc_`.
    /// @param admin_           Holder of `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`.
    /// @param pauser_          Holder of `DEPOSIT_PAUSER_ROLE`. Must be distinct from agents.
    /// @param router_          Portfolio Router address, or `address(0)` to deploy without
    ///                         router support (single-vault mode).
    /// @param upgradeAuthority The deployment's timelock: the only address that may upgrade or freeze.
    /// @param mode             `Upgradeable` or `FrozenAtDeploy`; `Unset` reverts.
    function initialize(
        IERC20 usdc_,
        IERC4626 vault_,
        address admin_,
        address pauser_,
        address router_,
        address upgradeAuthority,
        UpgradeMode mode
    ) external initializer {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        if (address(vault_) == address(0)) revert ZeroAddress();
        if (admin_ == address(0)) revert ZeroAddress();
        if (pauser_ == address(0)) revert ZeroAddress();
        if (vault_.asset() != address(usdc_)) revert AssetMismatch();

        __ReentrancyGuard_init();
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
        _grantRole(DEPOSIT_PAUSER_ROLE, pauser_);
        __GovernedUpgrade_init(upgradeAuthority, mode);
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
    function depositsPaused() external view returns (bool) {
        return _depositsPaused;
    }

    /// @inheritdoc IGateway
    function effectiveWithdrawWindowGross(address agent) external view returns (uint256) {
        return GatewayWindows.effectiveTotal(_withdrawWindow[agent]);
    }

    /// @inheritdoc IGateway
    function effectiveDepositWindowGross(address agent) external view returns (uint256) {
        return GatewayWindows.effectiveTotal(_depositWindow[agent]);
    }

    /// @dev Apply a `shares` redemption against the agent's rolling-window
    ///      withdrawal budget (#449). Reverts with `WithdrawWindowCapExceeded`
    ///      when the projected cumulative draw would breach `cap`. On success
    ///      writes the updated `WithdrawWindow` to storage. The ring buffer runs
    ///      in the linked `GatewayWindows` (ADR-0014 §9).
    function _accrueRollingWithdraw(address agent, uint256 shares, uint256 cap) internal {
        (uint64 windowStart, uint256 gross) =
            GatewayWindows.accrue(_withdrawWindow[agent], shares, cap, true);
        agentWithdrawWindow[agent] = WithdrawWindow({windowStart: windowStart, gross: gross});
    }

    /// @dev Apply an `amount` deposit against the agent's rolling-window deposit
    ///      budget (#497). Reverts with `WindowCapExceeded` when the projected
    ///      cumulative deposit would breach `cap`. On success writes the updated
    ///      `DepositWindow` to storage. Mirrors `_accrueRollingWithdraw` so
    ///      the deposit side is equally hardened against calendar-boundary bursts.
    function _accrueRollingDeposit(address agent, uint256 amount, uint256 cap) internal {
        (uint64 windowStart, uint256 gross) =
            GatewayWindows.accrue(_depositWindow[agent], amount, cap, false);
        agentDepositWindow[agent] = DepositWindow({windowStart: windowStart, gross: gross});
    }

    // -------------------------------------------------------------------
    // Agent lifecycle — owner-gated
    //
    // First-time authorization records `msg.sender` as the agent's owner
    // (`revealAuthorization` for anyone, `authorizeAgent` for ADMIN_ROLE).
    // After that only the recorded owner can call setPolicy, revokeAgent
    // or transferAgentOwnership (issue #269, docs/architecture.md §6).
    //
    // Writers of `agents[...]` / `agentOwner[...]` (issue #1476):
    //   _authorizeAgentInternal  writes both; runs _validatePolicy(caller, p)
    //                            and, for a caller without ADMIN_ROLE, the
    //                            agent-consent check (issue #1791)
    //   setPolicy                writes agents; runs _validatePolicy(caller, p)
    //   transferAgentOwnership   writes agentOwner only; the destination
    //                            must hold ADMIN_ROLE, which the caller-
    //                            dependent shareReceiver rule does not bind,
    //                            so the stored policy is not checked again
    //   revokeAgent              deletes both; writes no policy, so no check
    //   releaseAgent             deletes both, called by the agent itself and
    //                            only for a binding made without its consent
    // -------------------------------------------------------------------

    /// @inheritdoc IGateway
    function commitAuthorization(bytes32 commitHash) external {
        bytes32 storageKey = GatewayAuth.commitmentKey(commitHash, msg.sender);
        commitments[storageKey] =
            GatewayAuth.Commitment({committer: msg.sender, blockNumber: uint64(block.number)});
        emit CommitSubmitted(msg.sender, commitHash, uint64(block.number));
    }

    /// @inheritdoc IGateway
    function revealAuthorization(
        address agent,
        bytes32 salt,
        AgentPolicy calldata p,
        bytes calldata agentConsent
    ) external {
        // 1–5. The revealer's own commitment exists, is at least one block old
        //      and at most COMMIT_EXPIRY_BLOCKS old; it is deleted before the
        //      authorization (CEI) and `CommitRevealed` is emitted. Runs in the
        //      linked `GatewayAuth.consumeCommitment` (ADR-0014 §9).
        GatewayAuth.consumeCommitment(commitments, agent, salt, COMMIT_EXPIRY_BLOCKS);

        // 6. Perform the authorization (same logic as authorizeAgent), with
        //    the agent's consent checked for a caller without ADMIN_ROLE.
        _authorizeAgentInternal(agent, p, agentConsent);
    }

    /// @inheritdoc IGateway
    function authorizeAgent(address agent, AgentPolicy calldata p) external onlyRole(ADMIN_ROLE) {
        // The caller holds ADMIN_ROLE, so no consent is read (empty slice).
        _authorizeAgentInternal(agent, p, msg.data[0:0]);
    }

    /// @dev Shared authorization logic for both `authorizeAgent` (direct) and
    ///      `revealAuthorization` (commit/reveal path).
    ///
    ///      Agent consent (issue #1791, review CS-1 and CS-2). Without it a
    ///      caller could bind an agent address it does not control, with
    ///      itself as share receiver, so that agent's deposits mint to the
    ///      caller; or claim a published address first and block its real
    ///      owner (`AgentAlreadyOwned`). A caller without ADMIN_ROLE therefore
    ///      binds an agent other than itself only with the agent's signature
    ///      (`GatewayAuth.requireAgentConsent`). Revealing for itself is consent by the
    ///      call. An ADMIN_ROLE caller takes no consent; that binding is
    ///      recorded as unconsented, and the agent may undo it with
    ///      `releaseAgent`.
    function _authorizeAgentInternal(address agent, AgentPolicy calldata p, bytes calldata consent)
        internal
    {
        if (agent == address(0)) revert ZeroAddress();
        if (agentOwner[agent] != address(0)) revert AgentAlreadyOwned();
        _validatePolicy(msg.sender, p);
        if (!hasRole(ADMIN_ROLE, msg.sender)) {
            if (agent != msg.sender) {
                GatewayAuth.requireAgentConsent(
                    agentConsentNonce, _domainSeparator(), agent, p.shareReceiver, consent
                );
            }
            agentConsented[agent] = true;
        }

        agentOwner[agent] = msg.sender;
        agents[agent] = p;

        // First-time grant. The role-separation override in AccessRoles
        // will revert if the candidate already holds ADMIN/DEPOSIT_PAUSER.
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
        _validatePolicy(msg.sender, p);

        agents[agent] = p;

        emit AgentAuthorized(
            agent, msg.sender, p.validUntil, p.maxPerPayment, p.maxPerWindow, p.shareReceiver
        );
    }

    /// @inheritdoc IGateway
    function transferAgentOwnership(address agent, address newOwner) external {
        if (agent == address(0) || newOwner == address(0)) revert ZeroAddress();
        address owner = agentOwner[agent];
        if (owner != msg.sender) revert NotAgentOwner();
        // The destination must hold ADMIN_ROLE. The caller-dependent
        // shareReceiver rule does not bind an ADMIN_ROLE holder, so the
        // stored policy is not checked again.
        if (!hasRole(ADMIN_ROLE, newOwner)) revert NewAgentOwnerNotAdmin();

        agentOwner[agent] = newOwner;
        emit AgentOwnershipTransferred(agent, owner, newOwner);
    }

    /// @inheritdoc IGateway
    function revokeAgent(address agent) external {
        if (agent == address(0)) revert ZeroAddress();
        address owner = agentOwner[agent];
        if (owner != msg.sender) revert NotAgentOwner();
        _clearAgent(agent, owner);
    }

    /// @inheritdoc IGateway
    function releaseAgent() external {
        address owner = agentOwner[msg.sender];
        if (owner == address(0) || agentConsented[msg.sender]) revert AgentNotReleasable();
        _clearAgent(msg.sender, owner);
    }

    /// @dev Clear one binding: policy, owner, consent record and AGENT_ROLE.
    ///      Shared by `revokeAgent` and `releaseAgent`; both emit `AgentRevoked`
    ///      so off-chain readers see the agent leave by either path.
    function _clearAgent(address agent, address owner) internal {
        delete agents[agent];
        delete agentOwner[agent];
        delete agentConsented[agent];
        if (hasRole(AGENT_ROLE, agent)) {
            _revokeRole(AGENT_ROLE, agent);
        }
        emit AgentRevoked(agent, owner);
    }

    /// @inheritdoc IGateway
    /// @dev The one source of the domain version: `_domainSeparator` hashes this
    ///      return value, so the getter clients read and the digest the gateway
    ///      checks cannot disagree. Bump it in an implementation that changes what
    ///      a signed consent means (ADR-0014 §10); a pure fix keeps it.
    function implementationVersion() public pure virtual returns (string memory) {
        return "1";
    }

    /// @dev The EIP-712 domain separator of agent consents (issue #1791): this
    ///      gateway's name, `implementationVersion()` (ADR-0014 §10), the chain,
    ///      and `address(this)`, the proxy. The signature check itself runs in the
    ///      linked `GatewayAuth.requireAgentConsent` (ADR-0014 §9).
    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                _EIP712_NAME_HASH,
                keccak256(bytes(implementationVersion())),
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev The one policy validator every writer of `agents[...]` calls, so
    ///      the rules for first-time authorization and for later updates
    ///      cannot drift apart. It applies the caller-dependent rule, judged
    ///      on `caller`'s role at call time (a caller without `ADMIN_ROLE`
    ///      must name itself as `shareReceiver`; an `ADMIN_ROLE` caller may
    ///      name any receiver), and then the caller-independent shape rules.
    ///      Custom errors match the previous public surface so downstream
    ///      clients (rmpc, dapp) keep the same revert vocabulary.
    function _validatePolicy(address caller, AgentPolicy calldata p) internal view {
        if (!hasRole(ADMIN_ROLE, caller) && p.shareReceiver != caller) {
            revert ShareReceiverNotAuthorized();
        }
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
    /// @dev Implements §2.2 steps 1–12. Effects (`usedPaymentIds`, rolling
    ///      deposit window) are written before external calls (CEI pattern).
    ///      `nonReentrant` provides defense-in-depth.
    ///
    ///      The policy checks, the USDC pull and the vault leg are the same
    ///      helpers `depositTo` uses for a vault destination
    ///      (`_requireDepositPolicy`, `_pullDepositUsdc`,
    ///      `_executeVaultDeposit`), in the same order as before. Sharing them
    ///      is what keeps the runtime under EIP-170 with the agent-consent
    ///      check of issue #1791 in it.
    function deposit(bytes32 orderId, uint256 amount, uint64 deadline, bytes32 idempotencyKey)
        external
        nonReentrant
        onlyRole(AGENT_ROLE)
        returns (bytes32 paymentId, uint256 sharesMinted)
    {
        // Gas guard (core 1482): at entry, before any state-dependent work.
        if (gasleft() < DEPOSIT_GAS_FLOOR) revert InsufficientGas(gasleft(), DEPOSIT_GAS_FLOOR);
        if (_depositsPaused) {
            revert DepositsArePaused();
        }

        AgentPolicy memory p = agents[msg.sender];

        // 1–3. amount, deadline window, policy active and not expired.
        _requireDepositPolicy(p, amount, deadline);

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

        // 6. EFFECTS: write state before any external call (CEI pattern).
        //    Rolling-window deposit cap (#497): eliminates the calendar-boundary
        //    burst that fixed-window accounting allowed. `agentWindowGross` is
        //    no longer written (deprecated in #497; retained for ABI compat).
        _accrueRollingDeposit(msg.sender, amount, p.maxPerWindow);
        usedPaymentIds[paymentId] = true;

        DepositArgs memory args;
        args.paymentId = paymentId;
        args.orderId = orderId;
        args.shareReceiver = p.shareReceiver;
        args.amount = amount;
        args.destination = address(vaultContract);
        args.windowId = windowId;

        // slither-disable-start reentrancy-balance
        // Justification: The `balBefore` pattern below is intentional fee-on-transfer
        // detection (§2.2 step 8) and a post-call invariant check (§2.2 step 12).
        // Only `AGENT_ROLE` holders can reach this code. State effects (window gross,
        // paymentId flag) are written above before any external call, satisfying the
        // CEI pattern. `nonReentrant` provides defense-in-depth.

        // 8. safeTransferFrom with balance-delta verification.
        _pullDepositUsdc(args);

        // 9–12. one-shot allowance, vault deposit to the pre-registered
        //       shareReceiver, allowance cleared, custody invariants (no rmUSDC
        //       and no leftover USDC in the gateway), event. The share balance
        //       the custody check compares against is read after the USDC pull;
        //       a USDC transfer cannot move the gateway's vault-share balance.
        sharesMinted = _executeVaultDeposit(args);
        // slither-disable-end reentrancy-balance
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
        if (_depositsPaused) revert DepositsArePaused();

        // Build a DepositArgs struct early to collapse locals onto the heap.
        // This avoids the "stack too deep" limit imposed by the EVM legacy codegen.
        DepositArgs memory args;
        args.orderId = orderId;
        args.amount = amount;
        args.destination = destination;

        {
            AgentPolicy memory p = agents[msg.sender];

            // 1–3. amount, deadline window, policy active and not expired.
            _requireDepositPolicy(p, amount, deadline);

            // 4. destination validation + allowedDestinations whitelist.
            args.isRouter = _validateDestination(destination, p.allowedDestinations);
            args.shareReceiver = p.shareReceiver;
            // Capture maxPerWindow from the snapshot so the rolling-window cap
            // check below never re-reads from storage (avoids TOCTOU and saves
            // one cold SLOAD per depositTo call — issue #509).
            args.maxPerWindow = p.maxPerWindow;
        }

        // Gas guard (core 1482): before any vault call, so the estimate sits on this floor.
        _requireDepositGas(args.isRouter);

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
        _pullDepositUsdc(args);

        _executeDeposit(args, minSharesPerLeg);
        // slither-disable-end reentrancy-balance
    }

    /// @dev Deposit policy checks shared by `deposit` and `depositTo`, in this
    ///      order: amount, deadline window, policy active and not expired.
    function _requireDepositPolicy(AgentPolicy memory p, uint256 amount, uint64 deadline)
        internal
        view
    {
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
    }

    /// @dev Pull `args.amount` USDC from the agent into the gateway and refuse
    ///      a short delivery (fee-on-transfer or rebasing token). Records the
    ///      pre-pull balance in `args.balBefore` for the custody checks.
    function _pullDepositUsdc(DepositArgs memory args) internal {
        args.balBefore = usdcToken.balanceOf(address(this));
        usdcToken.safeTransferFrom(msg.sender, address(this), args.amount);
        if (usdcToken.balanceOf(address(this)) - args.balBefore != args.amount) {
            revert FeeOnTransferDetected();
        }
    }

    /// @dev Entry gas floor for `depositTo`. The router floor scales with the effective legs.
    function _requireDepositGas(bool isRouter) internal view {
        uint256 floor = DEPOSIT_GAS_FLOOR;
        if (isRouter) {
            (address[] memory legs,) = routerContract.getEffectiveWeights();
            floor = ROUTER_DEPOSIT_BASE_GAS + legs.length * ROUTER_DEPOSIT_GAS_PER_LEG;
        }
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
    ///      clear allowance, post-call custody invariants, emit event. Shared by
    ///      `deposit` (destination = the pinned vault) and a vault-destination
    ///      `depositTo`.
    // slither-disable-start reentrancy-balance
    // `deposit()` and `depositTo()` are `nonReentrant`; the pre-call balance
    // snapshot and post-call custody checks are therefore safe from observable
    // reentry and the stale-balance warning is a false positive.
    function _executeVaultDeposit(DepositArgs memory args) internal returns (uint256 sharesMinted) {
        uint256 shareBalanceBefore = IERC20(args.destination).balanceOf(address(this));

        usdcToken.forceApprove(args.destination, args.amount);
        sharesMinted = IERC4626(args.destination).deposit(args.amount, args.shareReceiver);
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
        // Gas guard (core 1482): at entry, before any state-dependent work.
        if (gasleft() < WITHDRAW_GAS_FLOOR) revert InsufficientGas(gasleft(), WITHDRAW_GAS_FLOOR);
        // core 1494: no pause applies. Withdrawals stay open while deposits are paused.

        // 1–5. Withdrawal enabled, shares within (0, maxWithdrawPerPayment],
        //      deadline window, policy active and not expired, sourceVault the
        //      pinned vault and in the allowlist when that is non-empty. Runs in
        //      the linked `GatewayWithdrawOps.checkWithdraw` (ADR-0014 §9).
        address assetRecipient;
        {
            uint256 maxWithdrawPerWindow;
            (maxWithdrawPerWindow, assetRecipient) = GatewayWithdrawOps.checkWithdraw(
                agents[msg.sender],
                address(vaultContract),
                sourceVault,
                shares,
                deadline,
                MAX_DEADLINE_SKEW
            );

            // 6. windowId — informational only, echoed in the event below. The
            //    on-chain cap is enforced on a strict rolling window (#449), not
            //    on this calendar-aligned id.

            // 7. rolling-window cap (issue #449).
            //    Anchored on the agent's first withdrawal of each rolling window.
            //    The anchor advances to `block.timestamp` only when a full
            //    WINDOW_SECONDS has elapsed since the last anchor — so cumulative
            //    redemptions in any WINDOW_SECONDS-wide interval are bounded by
            //    `maxWithdrawPerWindow`. Eliminates the fixed-window boundary
            //    burst.
            _accrueRollingWithdraw(msg.sender, shares, maxWithdrawPerWindow);
        }

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
        assetsOut = IERC4626(sourceVault).redeem(shares, assetRecipient, address(this));

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
            assetRecipient,
            uint64(block.timestamp / WINDOW_SECONDS) // 6. windowId
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
        // core 1494: no pause applies. Withdrawals stay open while deposits are paused.
        // 1. Router must be configured.
        if (address(routerContract) == address(0)) revert RouterNotConfigured();

        // 1a. The caller-supplied per-leg slippage floor must be parallel to the
        //     share vector (GW-5 / F-11). The gateway forwards this floor verbatim
        //     to the router; it no longer fabricates an all-zero vector.
        if (minAssetsPerLeg.length != sharesPerLeg.length) revert RouterLegLengthMismatch();

        // Gas guard (core 1482): one floor at entry, scaled by the non-zero legs.
        {
            uint256 legs;
            for (uint256 i = 0; i < sharesPerLeg.length; i++) {
                if (sharesPerLeg[i] != 0) legs++;
            }
            uint256 floor = ROUTER_WITHDRAW_BASE_GAS + legs * ROUTER_WITHDRAW_GAS_PER_LEG;
            if (gasleft() < floor) revert InsufficientGas(gasleft(), floor);
        }

        // 2–6. Withdrawal enabled, deadline window, policy active and not
        //      expired, leg arrays parallel and non-empty, every non-zero leg
        //      allowed (F-03/NC-5: the explicit caller-supplied `vaults[]`, not the
        //      router's live weights, so a holder can exit a reweighted-out or
        //      retired position; AZ-GW-3: an empty allowlist means the pinned
        //      vault only), total within the per-payment cap. Runs in the linked
        //      `GatewayWithdrawOps.checkRouterWithdraw` (ADR-0014 §9).
        GatewayWithdrawOps.RouterWithdraw memory w = GatewayWithdrawOps.checkRouterWithdraw(
            agents[msg.sender],
            address(vaultContract),
            vaults,
            sharesPerLeg,
            deadline,
            MAX_DEADLINE_SKEW
        );

        // 7. Rolling-window cap (#449).
        _accrueRollingWithdraw(msg.sender, w.totalShares, w.maxWithdrawPerWindow);

        // 9. paymentId — DEADLINE INTENTIONALLY EXCLUDED; the explicit legs and
        //    `minAssetsPerLeg` are bound (#967 NC-5, GW-5 / F-11), and the
        //    OP_WITHDRAW_ROUTER prefix namespaces it (L-12). See
        //    `GatewayWithdrawOps.routerWithdrawPaymentId`.
        paymentId = GatewayWithdrawOps.routerWithdrawPaymentId(
            orderId, w.totalShares, vaults, sharesPerLeg, minAssetsPerLeg, idempotencyKey
        );
        if (usedPaymentIds[paymentId]) revert PaymentIdAlreadyUsed();

        // 10. EFFECTS: paymentId reservation.
        usedPaymentIds[paymentId] = true;

        // 11–14. Pull each leg's shares from the share holder, approve the router,
        //        `router.redeemFor` with the caller's per-leg floors and real
        //        deadline (F-11; USDC goes straight to the asset recipient), clear
        //        the approvals, and check share custody. Runs in the linked
        //        `GatewayWithdrawOps.executeRouterWithdraw`.
        assetsPerLeg = GatewayWithdrawOps.executeRouterWithdraw(
            routerContract, w, vaults, sharesPerLeg, minAssetsPerLeg
        );

        // 15. Event.
        emit AgentWithdrawalRouted(
            paymentId,
            orderId,
            msg.sender,
            address(routerContract),
            w.shareHolder,
            sharesPerLeg,
            assetsPerLeg,
            w.assetRecipient,
            uint64(block.timestamp / WINDOW_SECONDS) // 8. windowId — informational only.
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
    ///         Restricted to `AGENT_ROLE`. Reverts if `icPolicy` is not set,
    ///         if `p.agent` is not the caller (`CommitteeAgentNotCaller`), or
    ///         if the IC contract's own guards fail (agent not allowlisted,
    ///         invalid vote fields, etc.).
    ///
    ///         `p.agent` must equal `msg.sender` (issue #1790): the IC contract
    ///         checks `COMMITTEE_AGENT_ROLE` on `p.agent`, so without this bind
    ///         any `AGENT_ROLE` holder could file a signal under a registered
    ///         member's address.
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
        if (p.agent != msg.sender) revert CommitteeAgentNotCaller();
        voteId = icPolicy.submitVote(p);
    }

    // -------------------------------------------------------------------
    // Consensus recommendation receipt routing (issue #1247)
    // -------------------------------------------------------------------

    /// @notice Emitted when the consensus receipt contract address is set or updated.
    /// @param by      Address that called `setConsensusReceipt` (must hold `ADMIN_ROLE`).
    /// @param receipt New receipt contract address (`address(0)` clears it).
    event ConsensusReceiptSet(address indexed by, address indexed receipt);

    /// @notice Set or update the ConsensusRecommendationReceipt contract address.
    ///         Restricted to `ADMIN_ROLE`. Pass `address(0)` to clear (disable).
    /// @param receipt_ Address of the deployed `ConsensusRecommendationReceipt`
    ///                 contract, or `address(0)` to disable receipt routing.
    function setConsensusReceipt(address receipt_) external onlyRole(ADMIN_ROLE) {
        consensusReceipt = IConsensusRecommendationReceipt(receipt_);
        emit ConsensusReceiptSet(msg.sender, receipt_);
    }

    /// @notice Record a consensus recommendation receipt commitment on chain.
    ///         Restricted to `AGENT_ROLE`; the caller is the single submitter
    ///         attesting for the committee, and it must additionally hold
    ///         `COMMITTEE_AGENT_ROLE` on the IC policy (checked by the receipt
    ///         contract, which keeps no registry of its own).
    ///
    ///         This is the whole write surface for anchoring. There is no
    ///         `consensusSubmitSignature`: the rejected multi-signer design was
    ///         replaced by one submitter carrying the analysts' ed25519
    ///         signatures as payload data verified off-chain (ADR-0012 §5,
    ///         `docs/architecture.md` §4.9). Recording is **signalling only**.
    ///
    ///         Release is deliberately NOT routed through the gateway: routing
    ///         it here would require granting the gateway `ADMIN_ROLE` on the
    ///         receipt contract, and INV-3 requires that role to be held by the
    ///         `TimelockController`. The timelock calls
    ///         `ConsensusRecommendationReceipt.releaseReceipt` directly.
    ///
    /// @param receiptId     `keccak256("robotmoney:consensus-receipt-id:v1\n" +
    ///                      session_id + "\n" + subject_id)`.
    /// @param payloadDigest `keccak256` of the receipt's canonical bytes.
    /// @param payloadUri    Public route serving those exact bytes.
    /// @return index Index of the newly appended receipt.
    function consensusRecordReceipt(
        bytes32 receiptId,
        bytes32 payloadDigest,
        string calldata payloadUri
    ) external onlyRole(AGENT_ROLE) returns (uint256 index) {
        if (address(consensusReceipt) == address(0)) {
            revert ConsensusReceiptNotSet();
        }
        index = consensusReceipt.recordReceipt(msg.sender, receiptId, payloadDigest, payloadUri);
    }
}
