// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0010-unified-vault-architecture.md,
//            docs/technical/unified-vault-spec.md §5 (Unified `Vault`),
//            docs/technical/unified-vault-open-questions-resolution.md.
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPositionAdapter} from "./interfaces/IPositionAdapter.sol";
import {BpsMath} from "./lib/BpsMath.sol";
import {ForeignTokenQuarantine} from "./lib/ForeignTokenQuarantine.sol";

/// @title Vault (unified — ADR-0010)
/// @notice The single ERC-4626 USDC allocator that replaces both vault families.
///         A pure USDC-in / USDC-out allocator over a registry of
///         `IPositionAdapter` contracts, running in one of two pinned accounting
///         modes selected by `allExact()`:
///
///           * EXACT mode  (`allExact() == true`):  every active adapter is a 1:1
///             redemption claim (lending). `withdraw()`/`previewWithdraw()` are
///             live, drawdown is an assets-proportional pull, the exit fee is
///             charged on the gross redeemed value, and a per-adapter shortfall
///             is a fault that reverts `InsufficientAdapterLiquidity`.
///           * INEXACT mode (`allExact() == false`): at least one active adapter
///             is slippage-priced (assets). `withdraw()`/`previewWithdraw()`
///             revert `RedeemOnly`, `maxWithdraw()` is `0`, drawdown is a
///             no-revert share-proportional sell, and the exit fee is charged on
///             the realized proceeds.
///
///         Deposits mint on the REALIZED NAV delta against the idle-INCLUSIVE OZ
///         denominator `taBefore − revokedIdle + 1` (SUP-3 / C1 fix), so a
///         round-trip on a vault holding pre-existing idle USDC can never profit.
///
///         This contract owns the vault CORE (issue #1119). Documented insertion
///         seams are left for the serialized downstream issues that build on it:
///         the global NAV-growth-rate limiter (#1120), the EMERGENCY-gated
///         emergency-model refinements (#1121), the isomorphic surplus-first
///         flow-based rebalancing + `forceRebalance` (#1122), and the exactness-
///         transition timelock + `ExactnessTransition` event (#1123).
/// @dev    Every theme (rmUSDC/rmPROTO/rmAGENT/rmRWA) is one deployment of this
///         non-abstract contract composed with a set of adapters — never a
///         subclass. Swap/TWAP code lives entirely on the adapters, so the vault
///         stays a thin allocator well within the EIP-170 runtime-size limit.
contract Vault is ERC4626, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Roles ─────────────────────────────────────────────────────────

    /// @notice Role that manages adapters and sets parameters (TimelockController
    ///         in production — INV-3). Self-administered.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    /// @notice Role that can pause deposits and perform emergency drains. A
    ///         compromised emergency hot key can only halt the ENTRY path (DoS
    ///         deposits) and drain adapters into idle — it can never freeze
    ///         withdrawals (LIFE-3) nor permanently brick the vault (recovery is
    ///         `ADMIN_ROLE`-only, LIFE-4).
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    // There is deliberately NO KEEPER_ROLE — rebalancing is flow-based (§5.6),
    // so no keeper is granted or wired (#1122 adds the self-funded admin lever).

    // ─── Immutable bytecode constants — no role can change ─────────────

    /// @notice Absolute ceiling on the exit fee (100 bps = 1%).
    uint256 public constant MAX_EXIT_FEE_BPS = 100;
    /// @notice Maximum number of adapters the vault can hold active at once.
    uint256 public constant MAX_ADAPTERS = 20;
    /// @notice Minimum delay an exact→inexact composition-class flip must sit
    ///         armed before it can be executed (§5.1, C2 / #1123). Adding the
    ///         first inexact adapter to an operating all-exact vault reprices
    ///         already-held shares onto the floored preview branch and turns
    ///         `withdraw()` into `RedeemOnly` — a SHARE-SEMANTICS change that
    ///         may not land in one undelayed call. Mirrors the ≥48h ADMIN
    ///         timelock forcing-function so the class flip is announced (the
    ///         `ExactnessTransition` event) and can never surprise a holder.
    uint256 public constant EXACTNESS_TRANSITION_DELAY = 48 hours;
    /// @notice Basis-points denominator (10 000 = 100%). Narrowed to `uint16`
    ///         from `BpsMath.BPS_DENOMINATOR` to preserve call-site arithmetic.
    uint16 public constant MAX_BPS = uint16(BpsMath.BPS_DENOMINATOR);

    // ─── Adapter registry ──────────────────────────────────────────────

    /// @notice A registered position adapter and its vault-attested metadata.
    /// @dev `isExact` is a VAULT-ATTESTED bool set by `ADMIN_ROLE` at
    ///      `addAdapter` — the same act that pins the codehash and the allowlist
    ///      entry. It is NEVER read from `adapter.isExact()` per call: a
    ///      self-reported exactness cannot be allowed to select share-value-
    ///      critical branches (spec §2.2, C2). The adapter's own `isExact()`
    ///      view is for the at-registration cross-check and monitoring only.
    struct AdapterInfo {
        IPositionAdapter adapter;
        uint16 capBps; // max allocation % out of MAX_BPS
        bool active;
        bool isExact; // vault-attested exactness (C2)
    }

    /// @notice Ordered registry of all adapters (active and inactive).
    AdapterInfo[] public adapters;
    /// @notice Timestamp at/after which an ADMIN-armed exact→inexact
    ///         composition-class flip may be executed for a given adapter (the
    ///         earliest `addAdapter(adapter, _, false)` that would flip
    ///         `allExact()` true→false is accepted). Zero means unarmed. Set by
    ///         `armExactnessTransition`, consumed by `addAdapter` (§5.1, C2).
    mapping(address adapter => uint64 readyAt) public exactnessTransitionReadyAt;
    /// @notice Exact adapter instances approved by governance to receive USDC.
    mapping(address adapter => bool allowed) public adapterAllowed;
    /// @notice Runtime bytecode hashes approved by governance for onboarding.
    mapping(bytes32 codeHash => bool allowed) public adapterCodeHashAllowed;
    /// @notice Governance-mirrored protected-token set (M-S4 / INV-2). Tokens an
    ///         adapter custodies that could be donated/mis-sent to the vault and
    ///         must never be sweepable. `IPositionAdapter` is frozen without a
    ///         `custodiedTokens()` view, so the protected set is maintained by
    ///         governance here (spec §5.1 fallback: the governance-mirrored set).
    mapping(address token => bool protectedFlag) public protectedToken;

    // ─── Configurable params ──────────────────────────────────────────

    /// @notice Maximum total assets under management; deposits revert above this.
    uint256 public tvlCap;
    /// @notice Maximum USDC a single deposit may contribute.
    uint256 public perDepositCap;
    /// @notice Exit fee in basis points charged on withdrawal/redemption.
    uint256 public exitFeeBps;
    /// @notice Worst-case per-leg slippage bound (bps). Bounds the deposit
    ///         realized-delta floor, the min-out passed to `adapter.deploy`, the
    ///         min-out passed to `adapter.withdraw` in INEXACT mode, and the
    ///         INEXACT-mode `previewRedeem`/`previewMint` floors.
    uint256 public maxSlippageBps;
    /// @notice Recipient of collected exit fees.
    address public feeRecipient;
    /// @notice Destination for permissionless foreign-token sweeps (INV-1/INV-2).
    ///         Timelock-settable (`ADMIN_ROLE`, INV-3); never caller-supplied.
    address public quarantineAddress;

    /// @notice USDC recovered into idle from a revoked/excluded adapter (an
    ///         ADP-2 exclusion drained via `emergencyWithdrawAdapter` /
    ///         `emergencyDrainAndExclude`) and therefore NOT backing counted
    ///         shares. Subtracted from the deposit mint denominator so recovered
    ///         idle is not repriced onto new depositors. NORMALLY ZERO.
    /// @dev    #1121 (emergency-model refinements) owns the full lifecycle of
    ///         this accumulator: it is INCREMENTED when a NOT-counted (ADP-2
    ///         ineligible) adapter is drained on the EMERGENCY path — the
    ///         recovered USDC that was outside NAV becomes idle inside NAV — and
    ///         DECREMENTED by `redeployRevokedIdle` when that recovered idle is
    ///         routed back into the (healthy) active adapter set. The #1119 core
    ///         wired it into the denominator (the C1-correct formula); see
    ///         `_deposit`. Draining a still-counted (eligible) adapter leaves it
    ///         at zero — those funds already backed shares.
    uint256 public revokedIdle;

    // ─── Global NAV-growth-rate limiter (§4.3a, C3 / ORA-7) ────────────

    /// @notice The residual, adapter-INDEPENDENT vault-side price check: a SINGLE
    ///         GLOBAL cap on how fast the vault's AGGREGATE `totalAssets()` may
    ///         grow between observations, expressed in basis points of the last
    ///         checkpoint NAV permitted per `NAV_GROWTH_RATE_PERIOD` of elapsed
    ///         time. The allowed budget scales LINEARLY with elapsed time, so long
    ///         gaps between deposits widen the permitted aggregate move (§4.3a
    ///         checkpoint cadence). Governed by `ADMIN_ROLE` (a deploy-time
    ///         parameter, not an intervention).
    /// @dev    HONEST LIMIT: this bounds the *speed* of an aggregate mis-mark, not
    ///         slow drift. Because the checkpoint is aggregate it cannot identify
    ///         *which* adapter moved — it is a deposit circuit-breaker, NOT a
    ///         per-adapter drain trigger (localizing a bad adapter is the EMERGENCY
    ///         responder's job, §4.4/§5.5). It is defense-in-depth against the
    ///         ORA-6/F-17 bug/oracle-fault class, never a substitute for the
    ///         codehash-pinning + adapter audit that guards adversarial slow drift.
    uint256 public maxNavGrowthRateBps;

    /// @notice The reference interval the `maxNavGrowthRateBps` rate is quoted per.
    ///         The allowed aggregate-NAV growth budget over an elapsed interval is
    ///         `maxNavGrowthRateBps * elapsed / NAV_GROWTH_RATE_PERIOD` bps.
    uint256 public constant NAV_GROWTH_RATE_PERIOD = 1 hours;

    /// @notice The SINGLE vault-wide NAV checkpoint: the last aggregate
    ///         `totalAssets()` observed on the deposit path. Zero means the
    ///         checkpoint is uninitialized (bootstrapped on the first deposit and
    ///         never gated). Deliberately one slot for the WHOLE vault — never one
    ///         per adapter, and no governance-registered reference pools (§4.3a).
    /// @dev    Written only inside `_deposit` (`totalAssets()` is a `view`), so the
    ///         snapshot-compare-update is one storage read/write on the entry path,
    ///         not a per-adapter loop. Starts at the zero sentinel until the first
    ///         deposit initializes it — a documented seam default, not a bug.
    // slither-disable-next-line uninitialized-state
    uint256 public lastNavCheckpoint;

    /// @notice The `block.timestamp` at which `lastNavCheckpoint` was written.
    // slither-disable-next-line uninitialized-state
    uint64 public lastNavCheckpointTime;

    /// @notice Whether the vault has been permanently shut down (EMERGENCY entry
    ///         hard-stop; recoverable only by `ADMIN_ROLE` via `restoreVault`).
    bool public shutdown;
    /// @notice Whether the vault has been retired by the governance `retire()`
    ///         lifecycle action (DI-2). Distinct from `shutdown` so the two
    ///         deposit-halt paths never alias.
    bool public retired;
    /// @notice Linked `VaultRegistry`; set once by `ADMIN_ROLE`. The only address
    ///         allowed to drive `retire()` / `unretire()` (DI-2).
    address public registry;

    // ─── Split pause semantics ─────────────────────────────────────────

    /// @notice When true, new deposits and mints are blocked.
    bool public depositsPaused;
    /// @notice When true, withdrawals and redeems are blocked. Settable ONLY by
    ///         `ADMIN_ROLE` (timelock) — the EMERGENCY hot key can never freeze
    ///         withdrawals (LIFE-3).
    bool public withdrawalsPaused;

    // ─── Last-admin floor (ACL-3 / F-06, imported from BasketVault) ────

    /// @notice Live count of `ADMIN_ROLE` holders. Maintained by the
    ///         `_grantRole`/`_revokeRole` hooks so the last admin can never be
    ///         removed — guaranteeing a still-available authority can always
    ///         reverse a withdrawal-blocking state (LIFE-4).
    uint256 public adminCount;

    // ─── AZ-BSK-2 actual-value passthroughs ────────────────────────────

    /// @dev Actual shares minted by the most recent `_deposit`; surfaced by the
    ///      `deposit()` override so `PortfolioRouter.minSharesPerLeg` compares
    ///      against reality, not OZ's precomputed preview.
    uint256 internal _lastMintedShares;
    /// @dev Actual net USDC delivered by the most recent `_withdraw`; surfaced by
    ///      the `redeem()` override (AZ-BSK-2).
    uint256 internal _lastWithdrawnAssets;

    // ─── Events ────────────────────────────────────────────────────────

    /// @notice Emitted when a new adapter is registered.
    event AdapterAdded(uint256 indexed index, address indexed adapter, uint16 capBps, bool isExact);
    /// @notice Emitted when governance approves or revokes an exact adapter instance.
    event AdapterAllowedSet(address indexed adapter, bool allowed);
    /// @notice Emitted when governance approves or revokes an adapter runtime code hash.
    event AdapterCodeHashAllowedSet(bytes32 indexed codeHash, bool allowed);
    /// @notice Emitted when an adapter is deactivated (normal removal).
    event AdapterRemoved(uint256 indexed index, address indexed adapter);
    /// @notice Emitted when an adapter's allocation cap is updated.
    event AdapterCapUpdated(uint256 indexed index, uint16 oldBps, uint16 newBps);
    /// @notice Emitted when an adapter is force-removed without withdrawing assets.
    event AdapterForceRemoved(uint256 indexed index, address indexed adapter, uint256 lossAmount);
    /// @notice Emitted when USDC is allocated from the vault into an adapter.
    ///         Byte-identical to the source contracts' `Allocated` (indexer decode).
    event Allocated(uint256 indexed index, address indexed adapter, uint256 amount);
    /// @notice Emitted when USDC is pulled from an adapter back to the vault.
    ///         Byte-identical to the source contracts' `Pulled`; fires in BOTH
    ///         accounting modes (exact pull and inexact sell).
    event Pulled(uint256 indexed index, address indexed adapter, uint256 amount);
    /// @notice Emitted when an exit fee is charged on a withdrawal/redemption.
    event ExitFeeCharged(
        address indexed owner,
        address indexed receiver,
        uint256 grossAssets,
        uint256 fee,
        uint256 netAssets
    );
    /// @notice Emitted when the TVL cap is updated.
    event TvlCapUpdated(uint256 oldCap, uint256 newCap);
    /// @notice Emitted when the per-deposit cap is updated.
    event PerDepositCapUpdated(uint256 oldCap, uint256 newCap);
    /// @notice Emitted when the exit fee is updated.
    event ExitFeeUpdated(uint256 oldBps, uint256 newBps);
    /// @notice Emitted when the max-slippage bound is updated.
    event MaxSlippageBpsUpdated(uint256 oldBps, uint256 newBps);
    /// @notice Emitted when the global NAV-growth-rate cap is updated (§4.3a).
    event MaxNavGrowthRateBpsUpdated(uint256 oldBps, uint256 newBps);
    /// @notice Emitted when the fee recipient is updated.
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    /// @notice Emitted when the quarantine address is updated.
    event QuarantineAddressUpdated(address indexed oldAddr, address indexed newAddr);
    /// @notice Emitted when a token's protected-set membership changes.
    event ProtectedTokenSet(address indexed token, bool protectedFlag);
    /// @notice Emitted when the emergency withdrawal flow is triggered (all adapters).
    event EmergencyWithdrawCalled();
    /// @notice Emitted per-adapter during an emergency withdrawal.
    event EmergencyWithdrawAdapterCalled(
        uint256 indexed index, address indexed adapter, uint256 amount, bool success
    );
    /// @notice Emitted per-adapter by the atomic EMERGENCY arm+execute
    ///         `emergencyDrainAndExclude`: the adapter was drained (best-effort)
    ///         and excluded (deactivated) from NAV in a single action. `recovered`
    ///         is the USDC pulled back; `drainSucceeded` is false when the drain
    ///         reverted but the adapter was still excluded (skip-and-continue).
    event AdapterDrainedAndExcluded(
        uint256 indexed index, address indexed adapter, uint256 recovered, bool drainSucceeded
    );
    /// @notice Emitted whenever the `revokedIdle` accumulator changes — credited
    ///         when a not-counted adapter's recovered USDC lands in idle, and
    ///         decremented when that recovered idle is re-deployed (#1121).
    event RevokedIdleUpdated(uint256 oldValue, uint256 newValue);
    /// @notice Emitted when the vault is shut down.
    event Shutdown();
    /// @notice Emitted when a shut-down vault is restored and deposits re-open.
    event VaultRestored(uint256 newTvlCap);
    /// @notice Emitted when deposit pause state changes.
    event DepositsPausedChanged(bool paused);
    /// @notice Emitted when withdrawal pause state changes.
    event WithdrawalsPausedChanged(bool paused);
    /// @notice Emitted when a deposit cannot be fully routed into adapters.
    event UnroutedDeposit(uint256 amount);
    /// @notice Emitted when the linked `VaultRegistry` reference is set.
    event RegistrySet(address indexed oldRegistry, address indexed newRegistry);
    /// @notice Emitted when the vault is retired by the governance `retire` action.
    event Retired();
    /// @notice Emitted when a retired vault is reactivated (governance abort).
    event Unretired();
    /// @notice Emitted when ADMIN arms an exact→inexact composition-class flip
    ///         (§5.1, C2). `readyAt` is the earliest timestamp the armed
    ///         `adapter` may be added via `addAdapter` to flip the vault out of
    ///         all-exact mode — `block.timestamp + EXACTNESS_TRANSITION_DELAY`.
    event ExactnessTransitionArmed(address indexed adapter, uint64 readyAt);
    /// @notice Emitted when a composition-class flip actually lands through
    ///         `addAdapter` (§5.1, C2). Fires ONLY on the true→false flip — the
    ///         first inexact adapter added to an operating all-exact vault, which
    ///         reprices held shares onto the floored branch and makes the vault
    ///         `RedeemOnly`. A same-class add (exact→exact, inexact→inexact, or
    ///         the improving inexact→exact direction) never fires it. Integrators
    ///         and the indexer observe the class change here.
    event ExactnessTransition(bool wasAllExact, bool nowAllExact, address indexed adapter);
    /// @notice Emitted by the self-funded admin `forceRebalance` (§5.6):
    ///         `totalMoved` is the USDC value actually drawn from overweight
    ///         adapters and re-routed deficit-first toward target. The call is
    ///         NAV-non-decreasing — the caller funds any realized slippage/fees.
    event Rebalanced(uint256 totalMoved);

    // ─── Errors ────────────────────────────────────────────────────────

    error TVLCapExceeded();
    error PerDepositCapExceeded();
    error ZeroAddress();
    error VaultShutdown();
    error VaultRetired();
    error OnlyRegistry();
    error RegistryAlreadySet();
    error NotShutdown();
    error InvalidFee();
    error InvalidParam();
    error InvalidCap();
    error MaxAdaptersReached();
    error AdapterNotFound();
    error AdapterNotEmpty();
    error NoActiveAdapters();
    error DepositsPaused();
    error WithdrawalsPaused();
    error LastAdminFloor();
    /// @notice `withdraw()` / `previewWithdraw()` are unavailable because the
    ///         vault is in INEXACT mode (`allExact() == false`). Use `redeem()`.
    error RedeemOnly();
    /// @notice Realized NAV delta on a deposit fell below the slippage floor.
    error DepositBelowSlippageFloor(uint256 realizedDelta, uint256 floor);
    /// @notice The global NAV-growth-rate limiter (§4.3a) tripped: aggregate NAV
    ///         grew faster than `maxNavGrowthRateBps` allows since the last
    ///         checkpoint. Fails the deposit closed. `elapsed` is the seconds since
    ///         the checkpoint (the allowed budget scales with it).
    error NavGrowthRateExceeded(uint256 observedNav, uint256 checkpointNav, uint256 elapsed);
    error AdapterNotAllowed(address adapter);
    error AdapterCodeHashNotAllowed(address adapter, bytes32 codeHash);
    error AdapterCompatibilityCheckFailed(address adapter);
    error AdapterAssetMismatch(address adapter, address expected, address actual);
    error AdapterVaultMismatch(address adapter, address expected, address actual);
    /// @notice Active adapters cannot deliver the USDC required for an EXACT-mode
    ///         withdrawal (raised before any transfer, spec §5.3).
    error InsufficientAdapterLiquidity(uint256 requested, uint256 available);
    /// @notice A `forceRebalance` would leave aggregate NAV below where it started
    ///         (the caller's top-up did not cover realized slippage + fees). The
    ///         whole call reverts so holders can never lose value (§5.6).
    error NavWouldDecrease(uint256 navBefore, uint256 navAfter);
    /// @notice An `addAdapter` would flip `allExact()` true→false (the first
    ///         inexact adapter on an operating all-exact vault) without a
    ///         matching armed transition whose `EXACTNESS_TRANSITION_DELAY` has
    ///         elapsed (§5.1, C2). `readyAt` is the armed timestamp (0 = unarmed).
    error ExactnessTransitionNotReady(address adapter, uint64 readyAt);

    // ─── Constructor ──────────────────────────────────────────────────

    /// @param asset_          The USDC token this vault denominates in.
    /// @param name_           ERC-20 share name (theme-specific, e.g. "Robot Money USDC").
    /// @param symbol_         ERC-20 share symbol (theme-specific, e.g. "rmUSDC").
    /// @param tvlCap_         Maximum total assets under management (6-decimal USDC).
    /// @param perDepositCap_  Maximum single-deposit amount.
    /// @param exitFeeBps_     Exit fee in basis points (≤ `MAX_EXIT_FEE_BPS`).
    /// @param maxSlippageBps_ Worst-case per-leg slippage bound (< `MAX_BPS`).
    /// @param maxNavGrowthRateBps_ Global aggregate NAV-growth-rate cap in bps of
    ///        the checkpoint NAV per `NAV_GROWTH_RATE_PERIOD` (§4.3a). The residual
    ///        vault-side price check; deposit-entry only, never gates redemptions.
    /// @param feeRecipient_   Recipient of collected exit fees.
    /// @param admin_          `ADMIN_ROLE` holder (TimelockController in production).
    /// @param emergency_      `EMERGENCY_ROLE` holder.
    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        uint256 tvlCap_,
        uint256 perDepositCap_,
        uint256 exitFeeBps_,
        uint256 maxSlippageBps_,
        uint256 maxNavGrowthRateBps_,
        address feeRecipient_,
        address admin_,
        address emergency_
    ) ERC4626(asset_) ERC20(name_, symbol_) {
        if (feeRecipient_ == address(0) || admin_ == address(0) || emergency_ == address(0)) {
            revert ZeroAddress();
        }
        if (exitFeeBps_ > MAX_EXIT_FEE_BPS) revert InvalidFee();
        if (maxSlippageBps_ >= MAX_BPS) revert InvalidParam();
        if (maxNavGrowthRateBps_ == 0) revert InvalidParam();
        if (tvlCap_ > 0 && perDepositCap_ > tvlCap_) revert InvalidParam();

        tvlCap = tvlCap_;
        perDepositCap = perDepositCap_;
        exitFeeBps = exitFeeBps_;
        maxSlippageBps = maxSlippageBps_;
        maxNavGrowthRateBps = maxNavGrowthRateBps_;
        feeRecipient = feeRecipient_;
        quarantineAddress = ForeignTokenQuarantine.QUARANTINE;

        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(EMERGENCY_ROLE, ADMIN_ROLE);

        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(EMERGENCY_ROLE, emergency_);
    }

    // ─── Share scale (CUST-5) ──────────────────────────────────────────

    /// @notice Share-token precision, fixed at 6 to match USDC.
    function decimals() public pure override(ERC4626) returns (uint8) {
        return 6;
    }

    /// @notice ERC-4626 virtual-share decimal offset (18) — donation/inflation
    ///         resistance. See docs/technical/security-model.md.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 18;
    }

    // ─── Last-admin floor hooks (ACL-3 / F-06) ─────────────────────────

    function _grantRole(bytes32 role, address account)
        internal
        virtual
        override
        returns (bool granted)
    {
        granted = super._grantRole(role, account);
        if (granted && role == ADMIN_ROLE) adminCount++;
    }

    function _revokeRole(bytes32 role, address account)
        internal
        virtual
        override
        returns (bool revoked)
    {
        if (role == ADMIN_ROLE && hasRole(role, account) && adminCount == 1) {
            revert LastAdminFloor();
        }
        revoked = super._revokeRole(role, account);
        if (revoked && role == ADMIN_ROLE) adminCount--;
    }

    // ─── NAV ────────────────────────────────────────────────────────────

    /// @notice Idle USDC + the sum of every eligible-and-active adapter's
    ///         `totalAssets()`. A revoked (ADP-2-excluded) adapter is not counted
    ///         (exclusion-not-confiscation; EMERGENCY can still drain it).
    function totalAssets() public view override returns (uint256 sum) {
        sum = IERC20(asset()).balanceOf(address(this));
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (_isAdapterCounted(i)) sum += adapters[i].adapter.totalAssets();
        }
    }

    /// @dev An adapter contributes to NAV / receives withdrawal flow only when it
    ///      is registered-active AND currently eligible (ADP-2 / F-14).
    function _isAdapterCounted(uint256 i) internal view returns (bool) {
        return adapters[i].active && _isAdapterEligible(address(adapters[i].adapter));
    }

    // ─── allExact() — the mode selector (C2) ───────────────────────────

    /// @notice True iff every ACTIVE adapter's VAULT-ATTESTED `isExact` is true
    ///         (never the adapter's self-report). Integrators, the dapp, the
    ///         router and rmpc gate `withdraw`-shaped flows on this STATICALLY.
    ///         Vacuously true when no adapter is active.
    /// @dev Registry-visible view; `VaultRegistry` SHOULD mirror it so the
    ///      router/gateway can gate without a direct vault call (spec §5.1).
    function allExact() public view returns (bool) {
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (adapters[i].active && !adapters[i].isExact) return false;
        }
        return true;
    }

    // ─── Deposit — route-first, mint-on-realized-delta (§5.2) ──────────

    /// @notice Override OZ `deposit()` to return the ACTUAL minted share count
    ///         (AZ-BSK-2), not OZ's precomputed `previewDeposit`.
    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        super.deposit(assets, receiver);
        return _lastMintedShares;
    }

    // slither-disable-start reentrancy-balance
    // This realized-delta core is reached only through the `deposit`/`mint`
    // OZ entrypoints, and the function itself is `nonReentrant`; the pre-call
    // NAV read (`taBefore`) is therefore protected and the stale-balance
    // warning is a false positive.
    /// @dev Route-first, mint-on-realized-delta core. The OZ `deposit`/`mint`
    ///      entrypoints route here; the `shares` arg OZ precomputed from a
    ///      preview is DISCARDED — shares are minted on the REALIZED post-route
    ///      NAV delta against the idle-INCLUSIVE denominator (SUP-3 / C1).
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 /*shares*/
    )
        internal
        override
        nonReentrant
    {
        if (depositsPaused) revert DepositsPaused();
        if (shutdown) revert VaultShutdown();
        if (retired) revert VaultRetired();
        if (assets > perDepositCap) revert PerDepositCapExceeded();
        if (_activeAdapterCount() == 0) revert NoActiveAdapters();

        // Snapshot pre-deposit state. `taBefore` already INCLUDES idle USDC
        // (totalAssets), which is exactly the NAV backing existing shares — the
        // load-bearing C1 ordering: read it BEFORE the caller's USDC is pulled.
        uint256 supplyBefore = totalSupply();
        uint256 taBefore = totalAssets();
        if (taBefore + assets > tvlCap) revert TVLCapExceeded();

        // Pull USDC from the caller — no shares minted yet.
        IERC20(asset()).safeTransferFrom(caller, address(this), assets);

        // Route into adapters (deficit-first two-pass allocator, §5.2 step 4).
        _routeDeposit(assets);

        // Post-route aggregate NAV — read ONCE and reused for both the realized
        // delta and the NAV-growth checkpoint (one `totalAssets()` sweep, not two).
        uint256 taAfter = totalAssets();

        // SEAM (#1120): the adapter-independent global aggregate NAV-growth-rate
        // limiter (the sole vault-side price check, §4.3a) — an ENTRY-side gate,
        // fail-closed, that runs here after routing and before crediting the
        // delta. It compares the PRE-deposit aggregate NAV (`taBefore`, which
        // reflects the adapters' marks BEFORE this deposit's fresh capital) against
        // the single vault-wide checkpoint, and moves the checkpoint to `taAfter`.
        // Deposit-only: it is NEVER on the withdraw/redeem path (§5.3, M-A1).
        _enforceNavGrowthLimit(taBefore, taAfter);

        // Realized delta the vault actually captured. The slippage floor is a
        // REVERT guard, never a credit cap (AZ-BSK-1).
        uint256 realizedDelta = taAfter - taBefore;
        uint256 floor = assets.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
        if (realizedDelta < floor) revert DepositBelowSlippageFloor(realizedDelta, floor);

        // Idle-INCLUSIVE OZ denominator (AZ-BSK-3, C1-corrected):
        //   mintShares = realizedDelta × (supplyBefore + 10^offset)
        //              / (taBefore − revokedIdle + 1)
        // `taBefore` already includes idle, so the whole-vault idle balance is
        // NEVER subtracted (that was the BasketVault C1 bug); only `revokedIdle`
        // — recovered USDC no longer backing counted shares — is excluded.
        // In the common case `revokedIdle == 0` ⇒ denominator `taBefore + 1`,
        // the exact OZ mint denominator, and cannot underflow (taBefore ≥ 0 ⇒
        // denominator ≥ 1).
        uint256 denominator = taBefore + 1;
        if (revokedIdle != 0) {
            denominator = taBefore >= revokedIdle ? taBefore - revokedIdle + 1 : 1;
        }
        uint256 mintShares = realizedDelta.mulDiv(
            supplyBefore + 10 ** _decimalsOffset(), denominator, Math.Rounding.Floor
        );

        _mint(receiver, mintShares);
        _lastMintedShares = mintShares; // AZ-BSK-2
        emit Deposit(caller, receiver, assets, mintShares);
    }

    // slither-disable-end reentrancy-balance

    /// @dev The global NAV-growth-rate limiter (§4.3a). Compares the pre-deposit
    ///      aggregate NAV (`navBefore`) against the single vault-wide checkpoint
    ///      and reverts `NavGrowthRateExceeded` when the aggregate grew faster than
    ///      `maxNavGrowthRateBps` per `NAV_GROWTH_RATE_PERIOD` allows since the
    ///      checkpoint, then advances the checkpoint to the post-route NAV
    ///      (`navAfter`). Entry-side only — this is called ONLY from `_deposit`, so
    ///      redemptions are structurally never gated by it. Growth is measured in
    ///      bps of the checkpoint NAV so no overflow-prone absolute cap is formed;
    ///      NAV DECREASES are never gated (a drop cannot exceed a positive budget).
    ///      The zero checkpoint bootstraps on the first deposit without gating.
    function _enforceNavGrowthLimit(uint256 navBefore, uint256 navAfter) internal {
        uint256 checkpointNav = lastNavCheckpoint;

        // Bootstrap: the first observation has nothing to compare against. The
        // zero sentinel also makes the bps division below division-by-zero-safe.
        if (checkpointNav != 0 && navBefore > checkpointNav) {
            uint256 elapsed = block.timestamp - lastNavCheckpointTime;
            // Allowed budget over the interval, in bps of the checkpoint NAV.
            uint256 budgetBps = maxNavGrowthRateBps.mulDiv(elapsed, NAV_GROWTH_RATE_PERIOD);
            uint256 grownBps = (navBefore - checkpointNav).mulDiv(MAX_BPS, checkpointNav);
            if (grownBps > budgetBps) {
                revert NavGrowthRateExceeded(navBefore, checkpointNav, elapsed);
            }
        }

        lastNavCheckpoint = navAfter;
        lastNavCheckpointTime = uint64(block.timestamp);
    }

    /// @dev Deficit-first two-pass allocator: fill toward `min(equal-target,
    ///      capBps)` first, then spread leftover into remaining cap headroom.
    ///      Ineligible-but-active adapters are SKIPPED, not reverted (audit L-4);
    ///      any unrouted remainder stays idle (counted by `totalAssets`) and
    ///      emits `UnroutedDeposit`. This is the deposit half of flow-based
    ///      rebalancing.
    ///
    ///      Flow-based rebalancing (#1122, §5.6): this deficit-first fill is the
    ///      deposit half; the surplus-first drawdown is in `_pullProportional` /
    ///      `_sellProportional`, ordered via `_surplusFirstOrder`. This stays the
    ///      sole deposit routing entrypoint (also reused by `redeployRevokedIdle`
    ///      and the `forceRebalance` re-route leg).
    function _routeDeposit(uint256 amount) internal returns (uint256 remainingOut) {
        if (amount == 0) return 0;

        uint256 totalAfter = totalAssets(); // already includes the pulled USDC
        uint256 targetBps = _targetBpsFor();
        uint256 remaining = amount;
        uint256 len = adapters.length;

        // Pass 1: fill toward min(equal target, capBps).
        for (uint256 i = 0; i < len && remaining > 0; i++) {
            if (!adapters[i].active) continue;
            if (!_isAdapterEligible(address(adapters[i].adapter))) continue;
            uint256 effectiveTarget =
                adapters[i].capBps < targetBps ? adapters[i].capBps : targetBps;
            uint256 currentBalance = adapters[i].adapter.totalAssets();
            uint256 targetBalance = (totalAfter * effectiveTarget) / MAX_BPS;
            if (currentBalance >= targetBalance) continue;
            uint256 deficit = targetBalance - currentBalance;
            uint256 allocation = deficit < remaining ? deficit : remaining;
            _allocateTo(i, allocation);
            remaining -= allocation;
        }

        // Pass 2: spread leftover into adapters with absolute cap headroom.
        if (remaining > 0) {
            for (uint256 i = 0; i < len && remaining > 0; i++) {
                if (!adapters[i].active) continue;
                if (!_isAdapterEligible(address(adapters[i].adapter))) continue;
                uint256 currentBalance = adapters[i].adapter.totalAssets();
                uint256 capBalance = (totalAfter * adapters[i].capBps) / MAX_BPS;
                if (currentBalance >= capBalance) continue;
                uint256 headroom = capBalance - currentBalance;
                uint256 allocation = headroom < remaining ? headroom : remaining;
                _allocateTo(i, allocation);
                remaining -= allocation;
            }
        }

        if (remaining > 0) emit UnroutedDeposit(remaining);
        return remaining;
    }

    /// @dev Transfer USDC to an eligible adapter and deploy it with the per-leg
    ///      slippage floor as min-out (spec §5.2 step 4).
    function _allocateTo(uint256 i, uint256 amount) internal {
        IPositionAdapter adpt = adapters[i].adapter;
        address adptAddr = address(adpt);
        _requireAdapterEligible(adptAddr);
        IERC20(asset()).safeTransfer(adptAddr, amount);
        uint256 minValueOut = amount.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
        adpt.deploy(amount, minValueOut);
        emit Allocated(i, adptAddr, amount);
    }

    // ─── Previews — branch on allExact() (§5.2 / §5.3) ─────────────────

    /// @notice EXACT sets: OZ floor conversion. INEXACT sets: slippage-discounted
    ///         floor (BasketVault semantics).
    function previewDeposit(uint256 assets) public view override returns (uint256) {
        if (allExact()) return _convertToShares(assets, Math.Rounding.Floor);
        uint256 effectiveAssets = assets.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
        return _convertToShares(effectiveAssets, Math.Rounding.Floor);
    }

    /// @notice EXACT sets: OZ ceil conversion. INEXACT sets: ceil gross-up so
    ///         `mint()` cannot undercharge relative to `deposit()` (H-1).
    function previewMint(uint256 shares) public view override returns (uint256) {
        uint256 grossAssets = _convertToAssets(shares, Math.Rounding.Ceil);
        if (allExact()) return grossAssets;
        return grossAssets.mulDiv(MAX_BPS, MAX_BPS - maxSlippageBps, Math.Rounding.Ceil);
    }

    /// @notice EXACT sets: gross minus exit fee. INEXACT sets: the ADR-0007
    ///         NAV-haircut floor `gross × (1 − maxSlippageBps) × (1 − exitFeeBps)`.
    ///         The fee base differs by composition — integrators MUST branch on
    ///         `allExact()` (documented per-composition property, review L-E6).
    function previewRedeem(uint256 shares) public view override returns (uint256) {
        uint256 gross = _convertToAssets(shares, Math.Rounding.Floor);
        if (allExact()) return _grossToNet(gross);
        uint256 afterSlippage = gross.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
        return afterSlippage - afterSlippage.mulDiv(exitFeeBps, MAX_BPS);
    }

    /// @notice EXACT sets: shares required for `assets` net (net→gross→shares).
    ///         INEXACT sets: reverts `RedeemOnly` (withdraw is redeem-only).
    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        if (!allExact()) revert RedeemOnly();
        uint256 grossAssets = _netToGross(assets);
        return _convertToShares(grossAssets, Math.Rounding.Ceil);
    }

    // ─── Max* views (ERC-4626 conformance) ─────────────────────────────

    function maxDeposit(address) public view override returns (uint256) {
        if (depositsPaused || shutdown || retired) return 0;
        if (_activeAdapterCount() == 0) return 0;
        if (tvlCap == type(uint256).max && perDepositCap == type(uint256).max) {
            return type(uint256).max;
        }
        uint256 current = totalAssets();
        if (current >= tvlCap) return 0;
        uint256 headroom = tvlCap - current;
        return perDepositCap < headroom ? perDepositCap : headroom;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        if (assets == type(uint256).max) return type(uint256).max;
        return previewDeposit(assets);
    }

    /// @notice EXACT sets: net-of-fee floor (0 while withdrawals paused). INEXACT
    ///         sets: `0` — withdraw is unavailable, so `withdraw(maxWithdraw())`
    ///         is a safe no-op and never hits `RedeemOnly` (E-4).
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (!allExact() || withdrawalsPaused) return 0;
        uint256 grossAssets = _convertToAssets(balanceOf(owner), Math.Rounding.Floor);
        return grossAssets.mulDiv(MAX_BPS - exitFeeBps, MAX_BPS, Math.Rounding.Floor);
    }

    /// @notice EXACT sets: the owner's share balance (0 while withdrawals paused).
    ///         INEXACT sets: `0` (spec §5.1). `maxRedeem` UNDERSTATING the
    ///         redeemable amount is ERC-4626-safe; redeem itself stays live via
    ///         the `redeem()` override, which caps on the true share balance.
    function maxRedeem(address owner) public view override returns (uint256) {
        if (!allExact() || withdrawalsPaused) return 0;
        return balanceOf(owner);
    }

    function _grossToNet(uint256 gross) internal view returns (uint256) {
        return gross - gross.mulDiv(exitFeeBps, MAX_BPS);
    }

    function _netToGross(uint256 net) internal view returns (uint256) {
        if (exitFeeBps == 0) return net;
        return net.mulDiv(MAX_BPS, MAX_BPS - exitFeeBps, Math.Rounding.Ceil);
    }

    // ─── Withdraw / redeem — two pinned modes (§5.3) ───────────────────

    /// @notice EXACT sets: standard ERC-4626 withdraw. INEXACT sets: reverts
    ///         `RedeemOnly` (except the E-4 `withdraw(maxWithdraw()==0)` no-op).
    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        returns (uint256)
    {
        if (!allExact()) {
            if (assets == 0) return 0; // E-4: withdraw(maxWithdraw(owner)) is a no-op
            revert RedeemOnly();
        }
        return super.withdraw(assets, receiver, owner);
    }

    /// @notice Redeem `shares` for realized proceeds in BOTH modes. Returns the
    ///         ACTUAL net USDC delivered (AZ-BSK-2), not `previewRedeem`.
    /// @dev Drives `_withdraw` directly with the TRUE share-balance cap rather
    ///      than routing through OZ's `maxRedeem` guard: `maxRedeem()` returns 0
    ///      in INEXACT mode for withdraw-safety, which would otherwise brick the
    ///      redeem-only exit. `_withdraw` enforces `withdrawalsPaused`.
    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        returns (uint256)
    {
        uint256 maxShares = balanceOf(owner);
        if (shares > maxShares) revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);
        uint256 assets = previewRedeem(shares);
        _withdraw(_msgSender(), receiver, owner, assets, shares);
        return _lastWithdrawnAssets;
    }

    /// @dev Two accounting modes gated on the vault-attested `allExact()`. Both
    ///      are implemented in full — neither is deferred (H-A2).
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override nonReentrant {
        if (withdrawalsPaused) revert WithdrawalsPaused();
        if (caller != owner) _spendAllowance(owner, caller, shares);

        if (allExact()) {
            _withdrawExact(caller, receiver, owner, assets, shares);
        } else {
            _withdrawInexact(caller, receiver, owner, shares);
        }
    }

    // slither-disable-start reentrancy-balance
    // The redemption helpers below are reached only through the `withdraw`/
    // `redeem` OZ entrypoints, whose `_withdraw` override is `nonReentrant`;
    // the pre-call idle-balance reads are therefore protected and the
    // stale-balance warnings are false positives.
    /// @dev Mode A — EXACT set (carried from `RobotMoneyVault`). Assets-driven
    ///      proportional pull, shortfall REVERTS, fee-on-GROSS.
    function _withdrawExact(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal {
        uint256 grossAssets = _convertToAssets(shares, Math.Rounding.Floor);
        uint256 fee = grossAssets - assets;

        // The exit fee is only ever paid out of proceeds this withdrawal ACTUALLY
        // realized (FEE-2 / NC-11). `_pullProportional` reverts
        // `InsufficientAdapterLiquidity` before this require can fail on a clean
        // shortfall, so an over-reporting adapter can never socialize its
        // shortfall onto other holders' idle USDC.
        uint256 realizedGross = _pullProportional(grossAssets);
        require(realizedGross >= grossAssets, "fee not covered by realised proceeds");

        _burn(owner, shares);

        if (fee > 0) {
            IERC20(asset()).safeTransfer(feeRecipient, fee);
            emit ExitFeeCharged(owner, receiver, grossAssets, fee, assets);
        }
        IERC20(asset()).safeTransfer(receiver, assets);
        _lastWithdrawnAssets = assets; // AZ-BSK-2

        emit Withdraw(caller, receiver, owner, assets, shares);
    }

    /// @dev Mode B — INEXACT set (carried from `BasketVault._sellProportional`).
    ///      No-revert share-proportional sell, fee-on-REALIZED proceeds.
    function _withdrawInexact(address caller, address receiver, address owner, uint256 shares)
        internal
    {
        uint256 supplyBefore = totalSupply();
        _burn(owner, shares);

        uint256 usdcReceived = _sellProportional(shares, supplyBefore);

        uint256 fee = usdcReceived.mulDiv(exitFeeBps, MAX_BPS);
        uint256 net = usdcReceived - fee;

        if (fee > 0) {
            IERC20(asset()).safeTransfer(feeRecipient, fee);
        }
        IERC20(asset()).safeTransfer(receiver, net);
        _lastWithdrawnAssets = net; // AZ-BSK-2

        emit ExitFeeCharged(owner, receiver, usdcReceived, fee, net);
        emit Withdraw(caller, receiver, owner, net, shares);
    }

    /// @dev Source `assetsNeeded` USDC, returning the amount ACTUALLY realized
    ///      (idle applied + genuinely pulled). Idle first; then an assets-driven
    ///      proportional pass; then a rounding-sweep pass.
    ///      `InsufficientAdapterLiquidity` is raised early and on residual
    ///      under-delivery. Over-delivery is clamped so surplus stays idle for
    ///      all holders. Only eligible-and-active adapters are pulled from (ADP-2).
    ///
    ///      Surplus-first drawdown (§5.6): the adapters furthest ABOVE target are
    ///      drained first, moving composition toward the weights. Ordering is
    ///      orthogonal to exactness — the shortfall-revert and over-delivery-clamp
    ///      semantics are unchanged.
    function _pullProportional(uint256 assetsNeeded) internal returns (uint256) {
        if (assetsNeeded == 0) return 0;

        uint256 idleBalance = IERC20(asset()).balanceOf(address(this));
        if (idleBalance >= assetsNeeded) return assetsNeeded;

        (uint256[] memory order, uint256 n, uint256 totalInAdapters) = _surplusFirstOrder();

        uint256 remainingNeeded = assetsNeeded - idleBalance;
        if (remainingNeeded > totalInAdapters) {
            revert InsufficientAdapterLiquidity(remainingNeeded, totalInAdapters);
        }

        uint256 remaining = remainingNeeded;
        uint256 pulled;

        // Pass 1: greedy surplus-first pulls, capped at each adapter's balance.
        for (uint256 k = 0; k < n && remaining > 0; k++) {
            uint256 i = order[k];
            IPositionAdapter adpt = adapters[i].adapter;
            uint256 adapterBalance = adpt.totalAssets();
            uint256 pull = adapterBalance < remaining ? adapterBalance : remaining;
            if (pull == 0) continue;
            uint256 actual = adpt.withdraw(pull, 0); // 0 ⇒ adapter's own floor
            pulled += actual;
            remaining = actual >= remaining ? 0 : remaining - actual;
            emit Pulled(i, address(adpt), actual);
        }

        // Pass 2: under-delivery sweep in the same surplus-first order.
        for (uint256 k = 0; k < n && remaining > 0; k++) {
            uint256 i = order[k];
            IPositionAdapter adpt = adapters[i].adapter;
            uint256 adapterBalance = adpt.totalAssets();
            uint256 pull = adapterBalance < remaining ? adapterBalance : remaining;
            if (pull == 0) continue;
            uint256 actual = adpt.withdraw(pull, 0);
            pulled += actual;
            remaining = actual >= remaining ? 0 : remaining - actual;
            emit Pulled(i, address(adpt), actual);
        }

        if (remaining > 0) {
            revert InsufficientAdapterLiquidity(remainingNeeded, remainingNeeded - remaining);
        }

        uint256 realized = idleBalance + pulled;
        return realized < assetsNeeded ? realized : assetsNeeded;
    }

    // slither-disable-end reentrancy-balance

    /// @dev Sell the `shares / supplyBefore` fraction of idle USDC and of each
    ///      eligible adapter's position. NO all-or-nothing shortfall revert — an
    ///      inexact adapter systematically delivers `realized ≈ wanted ×
    ///      (1 − slippage)`; each leg's `minUsdcOut = max(caller floor, adapter
    ///      floor)` reverts `SlippageExceeded` only below the floor. Proceeds
    ///      accrue as realized; no socialization.
    ///
    ///      Surplus-first sell (§5.6): the redeemer's pro-rata slice of the
    ///      adapter pool (`totalInAdapters × shares / supplyBefore`) is raised by
    ///      selling from the adapters furthest ABOVE target first, moving
    ///      composition toward the weights. Each leg keeps its `minUsdcOut` floor,
    ///      so the no-revert-above-floor semantics are unchanged.
    function _sellProportional(uint256 shares, uint256 supplyBefore)
        internal
        returns (uint256 usdcOut)
    {
        uint256 idleBefore = IERC20(asset()).balanceOf(address(this));
        if (idleBefore > 0) {
            usdcOut += idleBefore.mulDiv(shares, supplyBefore);
        }

        (uint256[] memory order, uint256 n, uint256 totalInAdapters) = _surplusFirstOrder();
        if (totalInAdapters == 0) return usdcOut;

        // The redeemer's pro-rata slice of the adapter-held value, sourced
        // surplus-first rather than evenly across every leg.
        uint256 remaining = totalInAdapters.mulDiv(shares, supplyBefore);

        for (uint256 k = 0; k < n && remaining > 0; k++) {
            uint256 i = order[k];
            IPositionAdapter adpt = adapters[i].adapter;
            uint256 bal = adpt.totalAssets();
            if (bal == 0) continue;

            uint256 sellAmount = bal < remaining ? bal : remaining;
            if (sellAmount == 0) continue;

            uint256 minUsdcOut = sellAmount.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
            uint256 received = adpt.withdraw(sellAmount, minUsdcOut);
            emit Pulled(i, address(adpt), received);
            usdcOut += received;
            remaining -= sellAmount;
        }
    }

    /// @dev The counted-adapter indices ordered by DESCENDING surplus
    ///      (`currentBalance − equal-weight target`) — the surplus-first drawdown
    ///      order shared by `_pullProportional`, `_sellProportional`, and
    ///      `forceRebalance` (§5.6). Only registered-active-and-eligible adapters
    ///      (`_isAdapterCounted`) are included. `n` is the count of populated
    ///      entries in `order`; `totalInAdapters` is their summed balance (returned
    ///      so callers reuse the single balance loop). A small selection sort
    ///      (n ≤ `MAX_ADAPTERS` = 20) — no external calls, view-only.
    function _surplusFirstOrder()
        internal
        view
        returns (uint256[] memory order, uint256 n, uint256 totalInAdapters)
    {
        uint256 len = adapters.length;
        order = new uint256[](len);
        int256[] memory surplus = new int256[](len);

        uint256 total = totalAssets();
        uint256 targetBps = _targetBpsFor();
        uint256 targetBalance = (total * targetBps) / MAX_BPS;

        for (uint256 i = 0; i < len; i++) {
            if (!_isAdapterCounted(i)) continue;
            uint256 bal = adapters[i].adapter.totalAssets();
            totalInAdapters += bal;
            order[n] = i;
            surplus[n] = int256(bal) - int256(targetBalance);
            n++;
        }

        // Selection sort by descending surplus (stable enough for a ≤20 set).
        for (uint256 a = 0; a < n; a++) {
            uint256 best = a;
            for (uint256 b = a + 1; b < n; b++) {
                if (surplus[b] > surplus[best]) best = b;
            }
            if (best != a) {
                (order[a], order[best]) = (order[best], order[a]);
                (surplus[a], surplus[best]) = (surplus[best], surplus[a]);
            }
        }
    }

    // ─── Adapter management ──────────────────────────────────────────

    /// @notice Register a new adapter with a vault-attested exactness flag.
    /// @param adapter_ `IPositionAdapter`-compatible address (allowlisted +
    ///        codehash-pinned + identity-bound).
    /// @param capBps_  Maximum allocation cap in basis points (1–10 000).
    /// @param isExact_ VAULT-ATTESTED exactness (C2). ADMIN pins this at
    ///        registration alongside the codehash and allowlist entry; it is
    ///        immutable on the `AdapterInfo` and is what `allExact()` reads —
    ///        never `adapter.isExact()` per call.
    /// @dev #1123: when this add flips the composition class true→false (the
    ///      first inexact adapter on an OPERATING all-exact vault — one with at
    ///      least one active adapter), it is a SHARE-SEMANTICS change: it
    ///      reprices held shares onto the floored branch and turns `withdraw()`
    ///      into `RedeemOnly` for every integrator. That flip may not land in a
    ///      single undelayed call — it must first be ARMED via
    ///      `armExactnessTransition` and sit for `EXACTNESS_TRANSITION_DELAY`,
    ///      and it emits `ExactnessTransition(true, false, adapter_)`. A
    ///      same-class add (exact→exact, inexact→inexact) and the empty-vault
    ///      bootstrap (no active adapters yet, no holders relying on exact mode)
    ///      are unaffected. The class is observable via `allExact()` before/after
    ///      the push.
    function addAdapter(address adapter_, uint16 capBps_, bool isExact_)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (adapter_ == address(0)) revert ZeroAddress();
        if (capBps_ == 0 || capBps_ > MAX_BPS) revert InvalidCap();
        if (_activeAdapterCount() >= MAX_ADAPTERS) revert MaxAdaptersReached();
        _requireAdapterEligible(adapter_);

        // Exactness-transition guard (§5.1, C2): detect the true→false flip
        // BEFORE the push. It fires only when the vault is genuinely operating
        // all-exact (≥1 active adapter, all attested exact) and this add is
        // inexact. The empty-vault bootstrap (no active adapters) sets no exact-
        // mode guarantee any holder can rely on, so it is exempt.
        bool flipsToInexact = !isExact_ && _activeAdapterCount() > 0 && allExact();
        if (flipsToInexact) {
            uint64 readyAt = exactnessTransitionReadyAt[adapter_];
            if (readyAt == 0 || block.timestamp < readyAt) {
                revert ExactnessTransitionNotReady(adapter_, readyAt);
            }
            delete exactnessTransitionReadyAt[adapter_];
        }

        adapters.push(
            AdapterInfo({
                adapter: IPositionAdapter(adapter_),
                capBps: capBps_,
                active: true,
                isExact: isExact_
            })
        );
        emit AdapterAdded(adapters.length - 1, adapter_, capBps_, isExact_);
        // Announce the class flip AFTER the push, so `allExact()` reads the new
        // (now false) composition. Only the true→false flip is announced.
        if (flipsToInexact) emit ExactnessTransition(true, false, adapter_);
    }

    /// @notice Arm an exact→inexact composition-class flip for `adapter_`
    ///         (§5.1, C2 / #1123). Required before `addAdapter(adapter_, _,
    ///         false)` can flip an operating all-exact vault out of exact mode.
    ///         The armed transition may be executed no earlier than
    ///         `block.timestamp + EXACTNESS_TRANSITION_DELAY`, giving holders who
    ///         rely on live `withdraw()` an announced window to exit before the
    ///         vault becomes `RedeemOnly`. `ADMIN_ROLE` (timelock) only.
    /// @param adapter_ The inexact adapter that will be added to flip the class.
    function armExactnessTransition(address adapter_) external onlyRole(ADMIN_ROLE) {
        if (adapter_ == address(0)) revert ZeroAddress();
        uint64 readyAt = uint64(block.timestamp + EXACTNESS_TRANSITION_DELAY);
        exactnessTransitionReadyAt[adapter_] = readyAt;
        emit ExactnessTransitionArmed(adapter_, readyAt);
    }

    /// @notice Approve or revoke an exact adapter instance for this vault.
    function setAdapterAllowed(address adapter_, bool allowed_) external onlyRole(ADMIN_ROLE) {
        if (adapter_ == address(0)) revert ZeroAddress();
        adapterAllowed[adapter_] = allowed_;
        emit AdapterAllowedSet(adapter_, allowed_);
    }

    /// @notice Approve or revoke an adapter runtime bytecode hash.
    function setAdapterCodeHashAllowed(bytes32 codeHash_, bool allowed_)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (codeHash_ == bytes32(0)) revert InvalidParam();
        adapterCodeHashAllowed[codeHash_] = allowed_;
        emit AdapterCodeHashAllowedSet(codeHash_, allowed_);
    }

    /// @notice Deactivate an adapter (must hold zero assets).
    function removeAdapter(uint256 index) external onlyRole(ADMIN_ROLE) {
        if (index >= adapters.length || !adapters[index].active) revert AdapterNotFound();
        if (adapters[index].adapter.totalAssets() > 0) revert AdapterNotEmpty();
        adapters[index].active = false;
        emit AdapterRemoved(index, address(adapters[index].adapter));
    }

    /// @notice Update the allocation cap for an existing adapter.
    function setAdapterCap(uint256 index, uint16 newCapBps) external onlyRole(ADMIN_ROLE) {
        if (index >= adapters.length || !adapters[index].active) revert AdapterNotFound();
        if (newCapBps == 0 || newCapBps > MAX_BPS) revert InvalidCap();
        uint16 old = adapters[index].capBps;
        adapters[index].capBps = newCapBps;
        emit AdapterCapUpdated(index, old, newCapBps);
    }

    // ─── Emergency (EMERGENCY_ROLE) ──────────────────────────────────
    // The EMERGENCY-gated emergency model (§4.4/§5.5, resolution Principle 3):
    // adapter drain / force-remove / NAV-exclusion are EMERGENCY_ROLE hot-key
    // actions a human responder performs on OBJECTIVE per-adapter failure
    // conditions (oracle stale past its heartbeat, adapter calls reverting) —
    // NOT permissionless. `emergencyDrainAndExclude` collapses arm+execute into a
    // SINGLE action (M-S5): the responder drains AND excludes an adapter with no
    // intervening ADMIN timelock, preserving the fast-EMERGENCY / timelocked-ADMIN
    // asymmetry. Drains are skip-and-continue (one failing adapter never blocks
    // the rest). There is deliberately NO KEEPER_ROLE (rebalancing is flow-based,
    // §5.6). All EMERGENCY actions pause DEPOSITS only — withdrawals stay open
    // (LIFE-3). The `revokedIdle` accumulator (credited here, decremented by
    // `redeployRevokedIdle`) keeps recovered ADP-2 idle out of the mint denominator.

    /// @notice Pause DEPOSITS (entry hard-stop). Withdrawals stay open (LIFE-3).
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _setDepositsPaused(true);
    }

    /// @notice Resume deposits. `ADMIN_ROLE` only (trust asymmetry).
    function unpause() external onlyRole(ADMIN_ROLE) {
        _setDepositsPaused(false);
    }

    /// @notice Set the withdrawal pause. `ADMIN_ROLE` (timelock) ONLY — the
    ///         EMERGENCY hot key can never freeze withdrawals (LIFE-3).
    function setWithdrawalsPaused(bool paused_) external onlyRole(ADMIN_ROLE) {
        _setWithdrawalsPaused(paused_);
    }

    /// @notice Pause deposits and drain every active adapter into idle USDC.
    ///         `try/catch` so one failed adapter does not block the others.
    function emergencyWithdraw() external onlyRole(EMERGENCY_ROLE) nonReentrant {
        _setDepositsPaused(true);
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].active) continue;
            // Snapshot counted-status BEFORE draining: only funds that were NOT
            // in NAV (an ADP-2 ineligible-but-active adapter) become `revokedIdle`.
            bool wasCounted = _isAdapterCounted(i);
            IPositionAdapter adpt = adapters[i].adapter;
            address adptAddr = address(adpt);
            uint256 balance;
            try adpt.totalAssets() returns (uint256 reported) {
                balance = reported;
            } catch {
                emit EmergencyWithdrawAdapterCalled(i, adptAddr, 0, false);
                continue;
            }
            if (balance == 0) continue;
            try adpt.withdraw(balance, 0) returns (uint256 actual) {
                if (!wasCounted && actual > 0) _creditRevokedIdle(actual);
                emit EmergencyWithdrawAdapterCalled(i, adptAddr, actual, true);
            } catch {
                emit EmergencyWithdrawAdapterCalled(i, adptAddr, 0, false);
            }
        }
        emit EmergencyWithdrawCalled();
    }

    /// @notice Pause deposits and drain a single adapter into idle USDC.
    function emergencyWithdrawAdapter(uint256 index)
        external
        onlyRole(EMERGENCY_ROLE)
        nonReentrant
    {
        if (index >= adapters.length || !adapters[index].active) {
            revert AdapterNotFound();
        }
        _setDepositsPaused(true);
        // Snapshot counted-status BEFORE draining (see `_creditRevokedIdle`).
        bool wasCounted = _isAdapterCounted(index);
        IPositionAdapter adpt = adapters[index].adapter;
        address adptAddr = address(adpt);
        uint256 balance;
        try adpt.totalAssets() returns (uint256 reported) {
            balance = reported;
        } catch {
            emit EmergencyWithdrawAdapterCalled(index, adptAddr, 0, false);
            return;
        }
        if (balance == 0) {
            emit EmergencyWithdrawAdapterCalled(index, adptAddr, 0, true);
            return;
        }
        try adpt.withdraw(balance, 0) returns (uint256 actual) {
            // When this drained adapter is an ADP-2 EXCLUSION (allowlist/codehash
            // revoked while still active, so NOT counted in NAV), the recovered
            // `actual` USDC lands in idle (which IS counted) but was NOT backing
            // shares — credit it to `revokedIdle` so the mint denominator excludes
            // it. A still-counted (eligible) adapter's funds already backed shares,
            // so nothing is credited.
            if (!wasCounted && actual > 0) _creditRevokedIdle(actual);
            emit EmergencyWithdrawAdapterCalled(index, adptAddr, actual, true);
        } catch {
            emit EmergencyWithdrawAdapterCalled(index, adptAddr, 0, false);
        }
    }

    /// @notice Atomic EMERGENCY arm+execute (M-S5): drain AND exclude a set of
    ///         adapters in a SINGLE `EMERGENCY_ROLE` action, with no intervening
    ///         ADMIN timelock. Each listed adapter is drained best-effort and then
    ///         deactivated (excluded from NAV) regardless of whether the drain
    ///         reverted — skip-and-continue, so one failing adapter never blocks
    ///         the rest. Recovered USDC from a NOT-counted (ADP-2 ineligible)
    ///         adapter is credited to `revokedIdle`. Invalid / already-inactive
    ///         indices are skipped. Pauses deposits (LIFE-3: withdrawals stay open).
    /// @param indices The adapter indices to drain and exclude.
    function emergencyDrainAndExclude(uint256[] calldata indices)
        external
        onlyRole(EMERGENCY_ROLE)
        nonReentrant
    {
        _setDepositsPaused(true);
        uint256 n = indices.length;
        for (uint256 k = 0; k < n; k++) {
            uint256 index = indices[k];
            // Skip-and-continue over invalid / already-excluded indices.
            if (index >= adapters.length || !adapters[index].active) continue;
            bool wasCounted = _isAdapterCounted(index);
            IPositionAdapter adpt = adapters[index].adapter;
            address adptAddr = address(adpt);

            uint256 balance;
            try adpt.totalAssets() returns (uint256 reported) {
                balance = reported;
            } catch {
                balance = 0;
            }

            uint256 recovered;
            bool drainSucceeded;
            if (balance == 0) {
                // Nothing to pull (or an unreadable mark): a clean exclusion.
                drainSucceeded = true;
            } else {
                try adpt.withdraw(balance, 0) returns (uint256 actual) {
                    recovered = actual;
                    drainSucceeded = true;
                } catch {
                    // Drain reverted — still exclude below (skip-and-continue).
                    drainSucceeded = false;
                }
            }

            // Exclude from NAV atomically with the drain (arm+execute).
            adapters[index].active = false;
            if (!wasCounted && recovered > 0) _creditRevokedIdle(recovered);
            emit AdapterDrainedAndExcluded(index, adptAddr, recovered, drainSucceeded);
        }
    }

    /// @dev Accumulate `amount` of recovered-but-not-counted USDC into the
    ///      `revokedIdle` exclusion. Single writer used by every EMERGENCY drain.
    function _creditRevokedIdle(uint256 amount) internal {
        uint256 old = revokedIdle;
        revokedIdle = old + amount;
        emit RevokedIdleUpdated(old, revokedIdle);
    }

    /// @notice Re-deploy recovered revoked-idle USDC back into the (now-healthy)
    ///         active adapter set and DECREMENT `revokedIdle` by the amount that
    ///         was actually routed. This is the recovery side of the ADP-2
    ///         lifecycle: once governance has registered a trustworthy replacement
    ///         adapter, the recovered idle stops being excluded and rejoins the
    ///         counted NAV backing new mints. `ADMIN_ROLE` (timelock) — a recovery
    ///         action, not an emergency hot-key one. Reverts if `amount` exceeds
    ///         the outstanding `revokedIdle`.
    /// @param amount The revoked-idle USDC to redeploy (<= `revokedIdle`).
    function redeployRevokedIdle(uint256 amount) external onlyRole(ADMIN_ROLE) nonReentrant {
        if (amount == 0 || amount > revokedIdle) revert InvalidParam();
        if (_activeAdapterCount() == 0) revert NoActiveAdapters();
        uint256 unrouted = _routeDeposit(amount);
        uint256 routed = amount - unrouted;
        if (routed > 0) {
            uint256 old = revokedIdle;
            revokedIdle = old - routed;
            emit RevokedIdleUpdated(old, revokedIdle);
        }
    }

    // slither-disable-start reentrancy-balance
    // `forceRebalance` is `ADMIN_ROLE`-gated and `nonReentrant`; the `navBefore`
    // read is taken before any adapter call and the `navAfter` read after all of
    // them, so the pre/post NAV snapshots the invariant compares are protected —
    // the stale-balance warning on the surrounding withdraw/deploy legs is a
    // false positive (mirrors the `_deposit` / `_withdraw` cores).
    /// @notice Move composition toward the per-instance target weights at any time
    ///         (the ONLY rebalance lever — there is no keeper/scheduled rebalance).
    ///         Overweight adapters are drawn down surplus-first and the recovered
    ///         USDC is re-routed deficit-first, isomorphically across exact and
    ///         inexact sets. The call MUST leave aggregate NAV NON-DECREASING: the
    ///         caller pre-funds `topUp` USDC covering realized slippage + fees, or
    ///         the whole call reverts (`NavWouldDecrease`). Holders can NEVER lose
    ///         value to it — on an exact set the top-up is ~zero (1:1 moves), on an
    ///         inexact set the admin pays the swap slippage out of pocket (§5.6).
    /// @param topUp USDC the caller supplies up front to cover realized cost. Any
    ///        excess stays as vault NAV (a donation to holders); nothing is
    ///        refunded, so the caller SHOULD size `topUp` to the expected cost.
    /// @dev `ADMIN_ROLE` (timelock) — a discretionary lever, not an emergency one.
    function forceRebalance(uint256 topUp) external onlyRole(ADMIN_ROLE) nonReentrant {
        if (_activeAdapterCount() == 0) revert NoActiveAdapters();

        uint256 navBefore = totalAssets();

        // Self-funding: pull the caller's top-up into idle BEFORE measuring the
        // post-rebalance NAV, so it offsets realized slippage/fees one-for-one.
        if (topUp > 0) {
            IERC20(asset()).safeTransferFrom(msg.sender, address(this), topUp);
        }

        // Draw each overweight adapter down to target (surplus-first), then
        // re-route exactly the recovered USDC deficit-first. `revokedIdle` and any
        // pre-existing idle are untouched — only `moved` USDC is redeployed.
        uint256 moved = _drawSurplusToIdle();
        if (moved > 0) _routeDeposit(moved);

        uint256 navAfter = totalAssets();
        if (navAfter < navBefore) revert NavWouldDecrease(navBefore, navAfter);

        emit Rebalanced(moved);
    }

    /// @dev Withdraw the ABOVE-target surplus of every counted adapter into idle,
    ///      returning the USDC actually recovered. Each leg is bounded by the
    ///      vault per-swap slippage floor (`minUsdcOut`), the same bound the
    ///      redemption paths use — so a thin venue cannot turn a rebalance into a
    ///      catastrophic-slippage extraction. Only used by `forceRebalance`.
    function _drawSurplusToIdle() internal returns (uint256 moved) {
        uint256 total = totalAssets();
        uint256 targetBps = _targetBpsFor();
        uint256 targetBalance = (total * targetBps) / MAX_BPS;

        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!_isAdapterCounted(i)) continue;
            IPositionAdapter adpt = adapters[i].adapter;
            uint256 bal = adpt.totalAssets();
            if (bal <= targetBalance) continue;
            uint256 surplus = bal - targetBalance;
            uint256 minUsdcOut = surplus.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
            uint256 received = adpt.withdraw(surplus, minUsdcOut);
            emit Pulled(i, address(adpt), received);
            moved += received;
        }
    }

    // slither-disable-end reentrancy-balance

    /// @notice Force-remove an adapter without withdrawing its assets (last
    ///         resort). Assets in the adapter are treated as lost.
    function forceRemoveAdapter(uint256 index) external onlyRole(EMERGENCY_ROLE) {
        if (index >= adapters.length || !adapters[index].active) revert AdapterNotFound();
        _setDepositsPaused(true);
        IPositionAdapter adapter = adapters[index].adapter;
        adapters[index].active = false;
        uint256 lossAmount;
        try adapter.totalAssets() returns (uint256 reported) {
            lossAmount = reported;
        } catch {}
        emit AdapterForceRemoved(index, address(adapter), lossAmount);
    }

    // ─── Governance retire (DI-2) ─────────────────────────────────────

    /// @notice Set the linked `VaultRegistry` once. `ADMIN_ROLE` (timelock).
    function setRegistry(address newRegistry) external onlyRole(ADMIN_ROLE) {
        if (newRegistry == address(0)) revert ZeroAddress();
        if (registry != address(0)) revert RegistryAlreadySet();
        registry = newRegistry;
        emit RegistrySet(address(0), newRegistry);
    }

    /// @notice Retire the vault (hard-stop deposits/mints). Registry-only.
    ///         Withdrawals/redemptions stay open (ADR-0009).
    function retire() external {
        if (msg.sender != registry) revert OnlyRegistry();
        if (retired) return;
        retired = true;
        emit Retired();
    }

    /// @notice Reactivate a retired vault (governance abort). Registry-only.
    function unretire() external {
        if (msg.sender != registry) revert OnlyRegistry();
        if (!retired) return;
        retired = false;
        emit Unretired();
    }

    /// @notice Shut down the vault: set `shutdown` and zero the TVL cap.
    ///         `EMERGENCY_ROLE`; recoverable only by `ADMIN_ROLE`.
    function shutdownVault() external onlyRole(EMERGENCY_ROLE) {
        shutdown = true;
        tvlCap = 0;
        emit Shutdown();
    }

    /// @notice Reverse a shutdown and re-open deposits under a fresh TVL cap.
    ///         `ADMIN_ROLE`.
    function restoreVault(uint256 newTvlCap) external onlyRole(ADMIN_ROLE) {
        if (!shutdown) revert NotShutdown();
        if (newTvlCap == 0) revert InvalidCap();
        if (perDepositCap > newTvlCap) revert InvalidParam();
        shutdown = false;
        uint256 old = tvlCap;
        tvlCap = newTvlCap;
        emit VaultRestored(newTvlCap);
        emit TvlCapUpdated(old, newTvlCap);
    }

    // ─── Param setters (ADMIN_ROLE) ───────────────────────────────────

    function setTvlCap(uint256 newCap) external onlyRole(ADMIN_ROLE) {
        if (newCap > 0 && perDepositCap > newCap) revert InvalidParam();
        uint256 old = tvlCap;
        tvlCap = newCap;
        emit TvlCapUpdated(old, newCap);
    }

    function setPerDepositCap(uint256 newCap) external onlyRole(ADMIN_ROLE) {
        if (tvlCap > 0 && newCap > tvlCap) revert InvalidParam();
        uint256 old = perDepositCap;
        perDepositCap = newCap;
        emit PerDepositCapUpdated(old, newCap);
    }

    function setExitFeeBps(uint256 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps > MAX_EXIT_FEE_BPS) revert InvalidFee();
        uint256 old = exitFeeBps;
        exitFeeBps = newBps;
        emit ExitFeeUpdated(old, newBps);
    }

    function setMaxSlippageBps(uint256 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps >= MAX_BPS) revert InvalidParam();
        uint256 old = maxSlippageBps;
        maxSlippageBps = newBps;
        emit MaxSlippageBpsUpdated(old, newBps);
    }

    /// @notice Update the global NAV-growth-rate cap (§4.3a). A governance
    ///         parameter, not an intervention: raising it loosens the residual
    ///         price check, lowering it tightens the deposit circuit-breaker. Must
    ///         be non-zero (zero would gate every deposit); set very high to make
    ///         the limiter effectively inert. Never affects redemptions.
    function setMaxNavGrowthRateBps(uint256 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps == 0) revert InvalidParam();
        uint256 old = maxNavGrowthRateBps;
        maxNavGrowthRateBps = newBps;
        emit MaxNavGrowthRateBpsUpdated(old, newBps);
    }

    function setFeeRecipient(address newRecipient) external onlyRole(ADMIN_ROLE) {
        if (newRecipient == address(0)) revert ZeroAddress();
        address old = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(old, newRecipient);
    }

    function setQuarantineAddress(address newAddr) external onlyRole(ADMIN_ROLE) {
        if (newAddr == address(0)) revert ZeroAddress();
        address old = quarantineAddress;
        quarantineAddress = newAddr;
        emit QuarantineAddressUpdated(old, newAddr);
    }

    /// @notice Add or remove a token from the governance-mirrored protected set
    ///         (M-S4 / INV-2). A protected token can never be swept — used to
    ///         shield adapter-custodied tokens donated/mis-sent to the vault.
    function setProtectedToken(address token, bool protectedFlag) external onlyRole(ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        protectedToken[token] = protectedFlag;
        emit ProtectedTokenSet(token, protectedFlag);
    }

    /// @notice Permissionlessly sweep a NON-protected foreign token to the
    ///         governed quarantine address (INV-1/INV-2). USDC, the share token,
    ///         and any governance-flagged protected token are unsweepable.
    function sweepForeignToken(address token) external nonReentrant {
        if (token == asset() || token == address(this) || protectedToken[token]) {
            revert ForeignTokenQuarantine.TokenIsProtected(token);
        }
        ForeignTokenQuarantine.sweep(token, quarantineAddress, msg.sender);
    }

    // ─── Internal helpers ─────────────────────────────────────────────

    function _setDepositsPaused(bool paused_) internal {
        if (depositsPaused != paused_) {
            depositsPaused = paused_;
            emit DepositsPausedChanged(paused_);
        }
    }

    function _setWithdrawalsPaused(bool paused_) internal {
        if (withdrawalsPaused != paused_) {
            withdrawalsPaused = paused_;
            emit WithdrawalsPausedChanged(paused_);
        }
    }

    /// @dev Non-reverting eligibility probe (allowlist + codehash + identity).
    function _isAdapterEligible(address adapter_) internal view returns (bool) {
        if (!adapterAllowed[adapter_]) return false;
        if (!adapterCodeHashAllowed[adapter_.codehash]) return false;
        (bool usdcOk, bytes memory usdcData) =
            adapter_.staticcall(abi.encodeWithSignature("USDC()"));
        if (!usdcOk || usdcData.length != 32 || abi.decode(usdcData, (address)) != asset()) {
            return false;
        }
        (bool vaultOk, bytes memory vaultData) =
            adapter_.staticcall(abi.encodeWithSignature("VAULT()"));
        if (!vaultOk || vaultData.length != 32 || abi.decode(vaultData, (address)) != address(this))
        {
            return false;
        }
        return true;
    }

    function _requireAdapterEligible(address adapter_) internal view {
        if (!adapterAllowed[adapter_]) revert AdapterNotAllowed(adapter_);
        bytes32 codeHash = adapter_.codehash;
        if (!adapterCodeHashAllowed[codeHash]) {
            revert AdapterCodeHashNotAllowed(adapter_, codeHash);
        }
        _requireAdapterCompatible(adapter_);
    }

    function _requireAdapterCompatible(address adapter_) internal view {
        (bool usdcOk, bytes memory usdcData) =
            adapter_.staticcall(abi.encodeWithSignature("USDC()"));
        if (!usdcOk || usdcData.length != 32) revert AdapterCompatibilityCheckFailed(adapter_);
        address reportedAsset = abi.decode(usdcData, (address));
        if (reportedAsset != asset()) {
            revert AdapterAssetMismatch(adapter_, asset(), reportedAsset);
        }

        (bool vaultOk, bytes memory vaultData) =
            adapter_.staticcall(abi.encodeWithSignature("VAULT()"));
        if (!vaultOk || vaultData.length != 32) revert AdapterCompatibilityCheckFailed(adapter_);
        address reportedVault = abi.decode(vaultData, (address));
        if (reportedVault != address(this)) {
            revert AdapterVaultMismatch(adapter_, address(this), reportedVault);
        }
    }

    function _targetBpsFor() internal view returns (uint256) {
        uint256 active = _activeAdapterCount();
        return active == 0 ? 0 : MAX_BPS / active;
    }

    function _activeAdapterCount() internal view returns (uint256 count) {
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (adapters[i].active) count++;
        }
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Legacy convenience: `depositsPaused || withdrawalsPaused` (M-A4).
    ///         Redefined from the old AND semantics so a deposits-only EMERGENCY
    ///         pause is not silently masked. Off-chain consumers SHOULD read the
    ///         first-class `depositsPaused` / `withdrawalsPaused` views to
    ///         distinguish a deposit-halt from a full halt.
    function paused() external view returns (bool) {
        return depositsPaused || withdrawalsPaused;
    }

    /// @notice Total adapters in the registry (active and inactive).
    function adapterCount() external view returns (uint256) {
        return adapters.length;
    }

    /// @notice Whether the vault has been permanently shut down.
    function isShutdown() external view returns (bool) {
        return shutdown;
    }

    /// @notice Detailed information about a single adapter entry.
    function getAdapterInfo(uint256 index)
        external
        view
        returns (
            address adapterAddr,
            uint16 capBps,
            bool active,
            bool isExact,
            uint256 currentBalance,
            uint256 targetBps
        )
    {
        AdapterInfo memory info = adapters[index];
        return (
            address(info.adapter),
            info.capBps,
            info.active,
            info.isExact,
            info.adapter.totalAssets(),
            info.active ? _targetBpsFor() : 0
        );
    }

    /// @notice Current vs. target balances and signed drift for every adapter —
    ///         describes the target allocation the flow tends toward (§5.6).
    function getAdapterDrift()
        external
        view
        returns (
            uint256[] memory currentBalances,
            uint256[] memory targetBalances,
            int256[] memory drifts
        )
    {
        uint256 len = adapters.length;
        currentBalances = new uint256[](len);
        targetBalances = new uint256[](len);
        drifts = new int256[](len);

        uint256 total = totalAssets();
        uint256 targetBps = _targetBpsFor();

        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].active) continue;
            currentBalances[i] = adapters[i].adapter.totalAssets();
            targetBalances[i] = (total * targetBps) / MAX_BPS;
            drifts[i] = int256(currentBalances[i]) - int256(targetBalances[i]);
        }
    }

    /// @notice Number of currently active adapters.
    function activeAdapterCount() external view returns (uint256) {
        return _activeAdapterCount();
    }

    /// @notice Equal-weight target allocation per active adapter in basis points.
    function currentTargetBps() external view returns (uint256) {
        return _targetBpsFor();
    }
}
