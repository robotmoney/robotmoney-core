// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2 — Portfolio Router
// (See also: docs/adr/ADR-0002-router-default-weights-on-chain.md — on-chain
//            defaultWeights fallback for below-quorum router behaviour;
//            docs/prd.md §5 — Core Workflows (Router deposit flows);
//            docs/development/single-production-codebase.md — the principle
//            that drives expressing production-readiness as VaultRegistry
//            state instead of a per-environment code variant.)
pragma solidity ^0.8.24;

import {AdminFloorAccessControl} from "./lib/AdminFloorAccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {VaultRegistry} from "./VaultRegistry.sol";
import {BpsMath} from "./lib/BpsMath.sol";
import {ForeignTokenQuarantine} from "./lib/ForeignTokenQuarantine.sol";

/// @title PortfolioRouter
/// @notice Outer allocation contract that accepts USDC and splits deposits
///         across active vaults by RM-governed weight bps.
///
/// A depositor calls `deposit(amount, minSharesPerLeg[])`. The router reads
/// active vault addresses and weights from the governance-set weight vector,
/// splits `amount` proportionally, calls `vault.deposit` on each leg, and
/// delivers vault receipts directly to the depositor. If any leg reverts the
/// whole transaction reverts (all-or-revert semantics).
///
/// `previewDeposit(amount)` returns per-vault estimated receipts, weights,
/// fees, net amounts, and an unavailable flag per leg without executing.
///
/// Router eligibility (whether a vault may be weighted at all) is **registry
/// state**, not a contract variant: `VaultRegistry.isRouterEligible(vault)`
/// is the single signal an operator sets. This keeps the same production
/// contract path live across test, demo, and mainnet — environments differ
/// only by which vaults the operator has opted in. See
/// `docs/development/single-production-codebase.md` for the principle.
///
/// Canonical: docs/architecture.md §4.2
contract PortfolioRouter is AdminFloorAccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Grants/revokes roles, sets weights, caps, and registry address.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Basis-points denominator (10 000 = 100%). Sourced from the
    ///         shared `BpsMath.BPS_DENOMINATOR` so fee/weight math cannot drift.
    uint256 public constant BPS_DENOMINATOR = BpsMath.BPS_DENOMINATOR;

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @notice USDC token used as the deposit asset across all vaults.
    IERC20 public immutable usdc;

    /// @notice VaultRegistry from which vault addresses, lifecycle status, and
    ///         router-eligibility state are read.
    VaultRegistry public immutable registry;

    /// @notice Global ceiling on the total USDC that may flow through a single
    ///         `deposit()` call. 0 means no cap enforced.
    /// @dev RTR-6 / F-12 — SEMANTICS DECISION: `routerCap` is a PER-TRANSACTION sanity
    ///      bound, NOT a cumulative/windowed exposure limit. It bounds the size of any one
    ///      `deposit()` call (fat-finger / single-tx blast-radius protection); it does NOT
    ///      track or limit aggregate inflow across multiple calls, so a depositor can exceed
    ///      it over several transactions by design. Cumulative inflow throttling is the
    ///      gateway's responsibility via its rolling-window accounting (GW-4); the router cap
    ///      deliberately does not duplicate that state. Treat this value as a per-call upper
    ///      bound only when configuring it.
    uint256 public routerCap;

    /// @notice Destination for permissionless foreign-token sweeps (INV-1/INV-2).
    ///         Defaults to `ForeignTokenQuarantine.QUARANTINE`; settable only via
    ///         the TimelockController (ADMIN_ROLE, INV-3).
    address public quarantineAddress;

    /// @notice Per-vault USDC ceiling for a single `deposit()` leg.
    ///         0 means no cap enforced for that vault.
    /// @dev RTR-6 / F-12 — like `routerCap`, this is a PER-TRANSACTION per-leg sanity bound,
    ///      not a cumulative per-vault exposure limit (see `routerCap`). It bounds a single
    ///      deposit leg's size; aggregate per-vault exposure across calls is not tracked here.
    mapping(address => uint256) public vaultCap;

    /// @notice Ordered list of vaults included in the voted (active) weight
    ///         vector. Set by governance on a successful proposal execution
    ///         via `setWeights`. Empty until the first vote passes.
    address[] private _weightVaultList;

    /// @notice Weight in basis points for each vault in `_weightVaultList`.
    ///         Parallel array — must always sum to BPS_DENOMINATOR.
    uint256[] private _weightBps;

    /// @notice True when the voted weight vector is in effect. False means the
    ///         router falls back to `defaultWeights` (the on-chain below-quorum
    ///         fallback). Set true by `setWeights`, set false by
    ///         `clearVotedWeights`. See ADR-0002.
    bool public votedWeightsActive;

    /// @notice Ordered list of vaults included in the default (fallback) weight
    ///         vector. Used by `previewDeposit`/`deposit` whenever the voted
    ///         vector is not active — i.e. no proposal has ever passed or
    ///         governance has reverted to the default after a failed quorum.
    ///         Admin-settable; survives proposal execution unchanged. ADR-0002.
    address[] private _defaultWeightVaultList;

    /// @notice Weight in basis points for each vault in `_defaultWeightVaultList`.
    ///         Parallel array — must always sum to BPS_DENOMINATOR.
    uint256[] private _defaultWeightBps;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted once per successful `deposit()` call, per vault leg.
    /// @param depositor  Address that initiated the deposit.
    /// @param vault      Vault address that received the USDC leg.
    /// @param amount     USDC forwarded to this vault.
    /// @param shares     Vault shares minted to the depositor.
    /// @param weightBps  Weight of this vault in the current weight vector.
    event RouterDeposit(
        address indexed depositor,
        address indexed vault,
        uint256 amount,
        uint256 shares,
        uint256 weightBps
    );

    /// @notice Emitted when the voted weight vector is updated.
    /// @param vaults  New ordered list of vault addresses.
    /// @param bps     Parallel weight array (must sum to BPS_DENOMINATOR).
    event WeightsSet(address[] vaults, uint256[] bps);

    /// @notice Emitted when the default (below-quorum fallback) weight vector
    ///         is updated by ADMIN_ROLE.
    /// @param vaults  New ordered list of vault addresses.
    /// @param bps     Parallel weight array (must sum to BPS_DENOMINATOR).
    event DefaultWeightsSet(address[] vaults, uint256[] bps);

    /// @notice Emitted when the voted weight vector is cleared and the router
    ///         reverts to the default weight vector.
    event VotedWeightsCleared();

    /// @notice Emitted when the global router cap is updated.
    /// @param oldCap Previous value (0 = uncapped).
    /// @param newCap New value (0 = uncapped).
    event RouterCapSet(uint256 oldCap, uint256 newCap);

    /// @notice Emitted when a per-vault cap is updated.
    /// @param vault  Vault address.
    /// @param oldCap Previous cap (0 = uncapped).
    /// @param newCap New cap (0 = uncapped).
    event VaultCapSet(address indexed vault, uint256 oldCap, uint256 newCap);

    /// @notice Emitted when the quarantine address for foreign-token sweeps is updated.
    /// @param oldAddr Previous quarantine address.
    /// @param newAddr New quarantine address.
    event QuarantineAddressUpdated(address indexed oldAddr, address indexed newAddr);

    // ─── Errors ──────────────────────────────────────────────────────────────

    /// @notice Address argument is `address(0)`.
    error ZeroAddress();

    /// @notice Weight bps array does not sum to BPS_DENOMINATOR (10 000).
    error InvalidWeightSum();

    /// @notice Vaults and bps arrays have mismatched lengths.
    error LengthMismatch();

    /// @notice A vault in the weight list is not registered in the VaultRegistry.
    error VaultNotRegistered();

    /// @notice `minSharesPerLeg` length does not match the number of active legs.
    error MinSharesLengthMismatch();

    /// @notice `minAssetsPerLeg` length does not match the number of active legs.
    error MinAssetsLengthMismatch();

    /// @notice A vault returned fewer shares (deposit) or assets (redeem) than the
    ///         caller-supplied per-leg minimum.
    error SlippageExceeded();

    /// @notice The supplied `deadline` has passed (`block.timestamp > deadline`).
    error DeadlineExpired();

    /// @notice Total deposit amount exceeds the global router cap.
    error RouterCapExceeded();

    /// @notice Single-vault leg amount exceeds that vault's per-vault cap.
    error VaultCapExceeded();

    /// @notice No weight vector has been set; cannot deposit. Raised when the
    ///         voted vector is inactive AND no default weight vector has been
    ///         configured, so there is no effective allocation to route by.
    error NoWeightsSet();

    /// @notice A vault's registry status is not Active; deposit is blocked.
    /// @param vault  The vault address that is not Active.
    /// @param status The current non-Active status of the vault.
    error VaultNotActive(address vault, VaultRegistry.VaultStatus status);

    /// @notice A redeem leg targets a Paused vault. Redemption permits Active OR
    ///         Retired status (withdraw-only after retirement, F-02); only Paused
    ///         blocks the exit path.
    /// @param vault  The vault address whose status is Paused.
    error VaultPausedForRedeem(address vault);

    /// @notice The explicit `vaults[]` array supplied to `redeemFor` does not
    ///         match the length of `sharesPerLeg` (or `minAssetsPerLeg`). Each
    ///         redeem leg names exactly one vault address (NC-5 identity binding),
    ///         so the three arrays are strictly parallel.
    error RedeemVaultsLengthMismatch();

    /// @notice A vault named in `redeemFor`'s explicit `vaults[]` is not
    ///         registered in the VaultRegistry. The redeem path drives legs from
    ///         the caller-supplied vault set (F-03), so each named vault must be
    ///         a registered vault whose lifecycle status the router can read.
    /// @param vault The unregistered vault address named in a redeem leg.
    error RedeemVaultNotRegistered(address vault);

    /// @notice A vault's ERC-4626 `asset()` does not match the router's USDC.
    ///         Router refuses to weight or deposit into vaults whose underlying
    ///         asset is anything other than the configured router USDC.
    /// @param vault       The router-ineligible vault address.
    /// @param vaultAsset  The vault's reported `asset()` address.
    error VaultAssetMismatch(address vault, address vaultAsset);

    /// @notice A vault did not expose a callable ERC-4626 `asset()` view, so
    ///         router eligibility cannot be verified. The router refuses to
    ///         interact with such vaults.
    /// @param vault The vault address whose `asset()` call reverted.
    error VaultAssetUnreadable(address vault);

    /// @notice After `_executeLegs` completes the router's USDC balance delta
    ///         (relative to the snapshot taken before any legs ran) is non-zero,
    ///         meaning one or more vaults accepted less than their allocated
    ///         `legAmount`. The entire deposit is reverted so no USDC is
    ///         permanently stranded in the router.
    error UsdcCustodyInvariantViolated();

    /// @notice A vault's ERC-4626 `deposit()` call reverted, indicating a USDC
    ///         blacklist hit or fee-on-transfer failure for this leg. Wraps the
    ///         low-level revert so callers can distinguish this cause from the
    ///         generic `UsdcCustodyInvariantViolated` custody check (FS-RTR-1).
    /// @param vault  The vault whose deposit call reverted.
    error UsdcLegTransferFailed(address vault);

    /// @notice Caller is not the shareHolder and has insufficient ERC-20
    ///         allowance on the vault share token to redeem on its behalf.
    /// @param shareHolder  The owner of the vault shares.
    /// @param caller       The address that attempted the unauthorized redeem.
    error UnauthorizedRedeemer(address shareHolder, address caller);

    /// @notice A vault has not been marked router-eligible in the
    ///         VaultRegistry (`isRouterEligible(vault) == false`).
    ///         Production-readiness is registry state set by ADMIN_ROLE on
    ///         the registry — environments differ only by which vaults the
    ///         operator has opted in. A fresh registration is gated by
    ///         default until governance audits the vault and calls
    ///         `VaultRegistry.setRouterEligible(vault, true)`.
    ///         See `docs/development/single-production-codebase.md`.
    /// @param vault The vault address that lacks the eligibility flag.
    error VaultNotRouterEligible(address vault);

    /// @notice `applyMigrationDefaultWeights` was called by an address other
    ///         than the linked `VaultRegistry`. That entry point exists solely
    ///         so the registry can set the default-weight vector atomically with
    ///         a router-eligibility flip (the ADR-0002 migration interlock fix,
    ///         issue #1128); it carries no independent authority and is never
    ///         callable directly. Governance sets defaults via `setDefaultWeights`.
    error OnlyRegistry();

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param _usdc      USDC token address.
    /// @param _registry  VaultRegistry contract address.
    /// @param _admin     Address that receives `ADMIN_ROLE` at deploy time.
    constructor(address _usdc, address _registry, address _admin) {
        if (_usdc == address(0) || _registry == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }
        usdc = IERC20(_usdc);
        registry = VaultRegistry(_registry);
        quarantineAddress = ForeignTokenQuarantine.QUARANTINE;

        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _grantRole(ADMIN_ROLE, _admin);
    }

    // ─── Admin: weight management ────────────────────────────────────────────

    /// @notice Set the vault weight vector. All vaults must be registered in the
    ///         VaultRegistry and must be marked router-eligible there. The bps
    ///         values must sum to exactly BPS_DENOMINATOR.
    ///         Restricted to `ADMIN_ROLE`.
    /// @param vaults  Ordered list of vault addresses.
    /// @param bps     Parallel weight array in basis points (must sum to 10 000).
    function setWeights(address[] calldata vaults, uint256[] calldata bps)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (vaults.length != bps.length) revert LengthMismatch();

        uint256 total;
        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i] == address(0)) revert ZeroAddress();
            // Active-status guard (F-05/RTR-4/GOV-4): a weight vector is only ever
            // executable if every weighted vault is simultaneously router-eligible
            // AND Active. `getVault` reverts NotRegistered if unknown; this also
            // reverts VaultNotActive for any Paused/Retired vault so a
            // non-depositable vector can never be written and self-DoS deposits.
            _requireActiveAndEligible(vaults[i]);
            total += bps[i];
        }
        if (total != BPS_DENOMINATOR) revert InvalidWeightSum();

        delete _weightVaultList;
        delete _weightBps;

        for (uint256 i = 0; i < vaults.length; i++) {
            _weightVaultList.push(vaults[i]);
            _weightBps.push(bps[i]);
        }

        // A passed vote overrides the default vector. `defaultWeights` itself
        // is left untouched so it remains the post-vote fallback. ADR-0002.
        votedWeightsActive = true;

        emit WeightsSet(vaults, bps);
    }

    /// @notice Set the default (below-quorum fallback) weight vector. Used by
    ///         `previewDeposit`/`deposit` whenever the voted vector is not
    ///         active — when no proposal has ever passed, or governance has
    ///         reverted to the default after a proposal failed quorum. This
    ///         vector survives proposal execution unchanged. ADR-0002.
    ///
    ///         All vaults must be registered AND router-eligible, the bps must
    ///         sum to BPS_DENOMINATOR, and the length must equal the registry's
    ///         router-eligible vault count so the default can never go stale
    ///         relative to eligibility. Restricted to `ADMIN_ROLE` (reached via
    ///         the Safe -> Timelock -> ADMIN_ROLE path).
    /// @param vaults  Ordered list of vault addresses.
    /// @param bps     Parallel weight array in basis points (must sum to 10 000).
    function setDefaultWeights(address[] calldata vaults, uint256[] calldata bps)
        external
        onlyRole(ADMIN_ROLE)
    {
        _setDefaultWeights(vaults, bps);
    }

    /// @notice Registry-only entry point that writes the default-weight vector
    ///         atomically with a router-eligibility flip. Callable **only** by
    ///         the linked `VaultRegistry` (`VaultRegistry.migrateEligibility`),
    ///         which invokes it after it has already updated
    ///         `routerEligibleCount`, so the shared length check below sees the
    ///         new count and the two contracts never expose a stale
    ///         (count != vector length) state to any external observer. This is
    ///         the ADR-0002 migration interlock fix (H-A1, issue #1128): the
    ///         prior non-atomic `setRouterEligible` → `setDefaultWeights` path
    ///         deadlocks once a full-length default exists, because each half
    ///         reverts on the other's stale length.
    ///
    ///         Carries no independent authority: it runs the exact same
    ///         validation as `setDefaultWeights` (length == `routerEligibleCount`,
    ///         every leg Active AND router-eligible, bps sum == BPS_DENOMINATOR),
    ///         so it can never write a vector the admin path could not. A partial
    ///         update — a vector whose length disagrees with the registry's
    ///         freshly-updated count — is rejected here and reverts the whole
    ///         atomic transaction.
    /// @param vaults  Ordered list of vault addresses.
    /// @param bps     Parallel weight array in basis points (must sum to 10 000).
    function applyMigrationDefaultWeights(address[] calldata vaults, uint256[] calldata bps)
        external
    {
        if (msg.sender != address(registry)) revert OnlyRegistry();
        _setDefaultWeights(vaults, bps);
    }

    /// @dev Shared body for `setDefaultWeights` (ADMIN_ROLE) and
    ///      `applyMigrationDefaultWeights` (registry-only). Enforces the full
    ///      default-vector invariant so both entry points write identical state.
    function _setDefaultWeights(address[] calldata vaults, uint256[] calldata bps) internal {
        if (vaults.length != bps.length) revert LengthMismatch();
        // The default vector must span exactly the router-eligible vault set so
        // it can never carry a stale length relative to eligibility (the same
        // invariant VaultRegistry.setRouterEligible enforces from its side).
        if (vaults.length != registry.routerEligibleCount()) revert LengthMismatch();

        uint256 total;
        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i] == address(0)) revert ZeroAddress();
            // Active-status guard (F-05/RTR-4): the default vector is also a
            // routed vector, so it must hold the same "eligible AND Active"
            // invariant. Reverts VaultNotActive for any Paused/Retired vault.
            _requireActiveAndEligible(vaults[i]);
            total += bps[i];
        }
        if (total != BPS_DENOMINATOR) revert InvalidWeightSum();

        delete _defaultWeightVaultList;
        delete _defaultWeightBps;

        for (uint256 i = 0; i < vaults.length; i++) {
            _defaultWeightVaultList.push(vaults[i]);
            _defaultWeightBps.push(bps[i]);
        }

        emit DefaultWeightsSet(vaults, bps);
    }

    /// @notice Clear the voted weight vector and revert routing to
    ///         `defaultWeights`. Intended for governance to fall back to the
    ///         default after the most recent proposal failed quorum. Restricted
    ///         to `ADMIN_ROLE`. ADR-0002.
    function clearVotedWeights() external onlyRole(ADMIN_ROLE) {
        delete _weightVaultList;
        delete _weightBps;
        votedWeightsActive = false;
        emit VotedWeightsCleared();
    }

    /// @notice Update the global router cap. 0 means uncapped.
    ///         Restricted to `ADMIN_ROLE`.
    function setRouterCap(uint256 cap) external onlyRole(ADMIN_ROLE) {
        emit RouterCapSet(routerCap, cap);
        routerCap = cap;
    }

    /// @notice Update the per-vault cap for `vault`. 0 means uncapped.
    ///         Restricted to `ADMIN_ROLE`.
    function setVaultCap(address vault, uint256 cap) external onlyRole(ADMIN_ROLE) {
        if (vault == address(0)) revert ZeroAddress();
        emit VaultCapSet(vault, vaultCap[vault], cap);
        vaultCap[vault] = cap;
    }

    /// @notice Update the quarantine address for foreign-token sweeps. Restricted
    ///         to `ADMIN_ROLE` (held by TimelockController in production — INV-3).
    /// @param newAddr New quarantine address. Must not be address(0).
    function setQuarantineAddress(address newAddr) external onlyRole(ADMIN_ROLE) {
        if (newAddr == address(0)) revert ZeroAddress();
        address old = quarantineAddress;
        quarantineAddress = newAddr;
        emit QuarantineAddressUpdated(old, newAddr);
    }

    /// @notice Permissionlessly sweep a NON-protected foreign token held by the
    ///         router to the governed quarantine address (custody invariants
    ///         INV-1/INV-2).
    ///
    ///         The router moves zero USDC out via any admin path: under the
    ///         all-or-revert deposit/redeem semantics it never holds USDC across
    ///         transactions, and the old arbitrary-recipient `rescueUsdc` —
    ///         which forwarded USDC to a caller-supplied address — is DELETED
    ///         (INV-1). The only asset movement that remains is this permissionless
    ///         sweep of foreign (non-USDC) tokens to the timelock-gated
    ///         `quarantineAddress`; the destination is never caller-supplied.
    ///         Reverts when `token` is USDC.
    /// @param token Foreign ERC-20 to quarantine. Must not be the router's USDC.
    function sweepForeignToken(address token) external nonReentrant {
        if (token == address(usdc)) revert ForeignTokenQuarantine.TokenIsProtected(token);
        ForeignTokenQuarantine.sweep(token, quarantineAddress, msg.sender);
    }

    // ─── Preview ─────────────────────────────────────────────────────────────

    /// @notice Per-leg preview result.
    /// @param vault       Vault address.
    /// @param weightBps   Weight assigned to this leg.
    /// @param legAmount   USDC that would be sent to this vault.
    /// @param estShares   Estimated shares the depositor would receive (0 if unavailable).
    /// @param unavailable True if the vault is paused/retired or the call reverted.
    struct LegPreview {
        address vault;
        uint256 weightBps;
        uint256 legAmount;
        uint256 estShares;
        bool unavailable;
    }

    /// @notice Return per-vault estimated receipts for `amount` USDC without
    ///         executing any state changes. Non-depositable legs (paused/retired,
    ///         unregistered, router-ineligible, or over their per-vault cap) are
    ///         marked `unavailable = true` and return `estShares = 0`; the deposit
    ///         path skips exactly these legs and renormalises `amount` across the
    ///         remaining available legs. `legAmount` therefore reflects the
    ///         **renormalised** amount the leg would actually receive on execute,
    ///         so `previewDeposit` and the executed deposit never disagree on which
    ///         legs are available (RTR-5; findings F-13/NC-4).
    /// @param amount  Total USDC to preview.
    /// @return legs   One entry per vault in the current weight vector.
    function previewDeposit(uint256 amount) external view returns (LegPreview[] memory legs) {
        (address[] memory vaultList, uint256[] memory bpsList) = _effectiveWeightsMemory();
        uint256 n = vaultList.length;
        legs = new LegPreview[](n);

        // Identical availability + renormalisation pass to the deposit path, so a
        // leg preview reports `unavailable` for exactly the legs `_executeLegs`
        // skips, and `legAmount` for exactly the amount it would deposit.
        (bool[] memory available, uint256[] memory legAmounts) =
            _availabilityAndAmounts(vaultList, bpsList, amount);

        for (uint256 i = 0; i < n; i++) {
            legs[i].vault = vaultList[i];
            legs[i].weightBps = bpsList[i];
            legs[i].legAmount = legAmounts[i];

            if (!available[i]) {
                legs[i].unavailable = true;
                continue;
            }

            // Available legs quote against the renormalised legAmount. A revert
            // in the vault's own previewDeposit downgrades the leg to unavailable
            // (the runtime deposit would likewise fail this vault) — but note the
            // skip-set was already fixed above, so this only zeroes estShares.
            try IERC4626(vaultList[i]).previewDeposit(legAmounts[i]) returns (uint256 estShares) {
                legs[i].estShares = estShares;
            } catch {
                legs[i].unavailable = true;
            }
        }
    }

    /// @dev Compute, for the given weight vector and total `amount`, which legs
    ///      are depositable and the renormalised USDC each available leg receives.
    ///      A leg is available iff its registry status is `Active` and it is
    ///      router-eligible (asset == USDC + eligibility flag) — exactly the
    ///      availability dimension `previewDeposit` reports. The amount is split
    ///      across ONLY the available legs in proportion to their bps, with the
    ///      rounding remainder assigned to the last available leg so the router
    ///      holds zero USDC after a successful deposit. Unavailable legs get
    ///      amount 0. This single predicate is shared by `previewDeposit` and
    ///      `_executeLegs` so the two can never diverge on availability (RTR-5).
    ///
    ///      Per-vault caps are intentionally NOT an availability factor: a cap is a
    ///      hard per-tx operator bound (see F-12), not a "this vault is down"
    ///      signal, and silently redistributing a capped leg's allocation onto
    ///      other vaults would breach operator intent. A renormalised leg over its
    ///      cap therefore still reverts `VaultCapExceeded` at execute time rather
    ///      than being skipped.
    function _availabilityAndAmounts(
        address[] memory vaultList,
        uint256[] memory bpsList,
        uint256 amount
    ) internal view returns (bool[] memory available, uint256[] memory legAmounts) {
        uint256 n = vaultList.length;
        available = new bool[](n);
        legAmounts = new uint256[](n);

        // First pass: availability (status + eligibility) and the sum of the bps
        // of the available legs, which becomes the renormalisation denominator.
        uint256 availableBps;
        for (uint256 i = 0; i < n; i++) {
            if (_isDepositable(vaultList[i])) {
                available[i] = true;
                availableBps += bpsList[i];
            }
        }
        if (availableBps == 0) return (available, legAmounts);

        // Second pass: split `amount` across the available legs by their bps share
        // of `availableBps` (NOT BPS_DENOMINATOR), and find the last available leg
        // so the rounding remainder lands somewhere the router actually deposits.
        uint256 allocated;
        uint256 lastAvailable;
        for (uint256 i = 0; i < n; i++) {
            if (!available[i]) continue;
            legAmounts[i] = (amount * bpsList[i]) / availableBps;
            allocated += legAmounts[i];
            lastAvailable = i;
        }
        if (allocated < amount) {
            legAmounts[lastAvailable] += amount - allocated;
        }
    }

    /// @dev Non-reverting predicate: is `vault` depositable right now (registry
    ///      status Active AND router-eligible)? Mirrors the reverting checks in
    ///      `_executeLeg`/`_requireRouterEligible` without reverting, so it can be
    ///      used to compute the shared availability set.
    function _isDepositable(address vault) internal view returns (bool) {
        try registry.getVault(vault) returns (
            VaultRegistry.VaultMetadata memory, VaultRegistry.VaultStatus status
        ) {
            if (status != VaultRegistry.VaultStatus.Active) return false;
        } catch {
            return false;
        }
        return this.isRouterEligible(vault);
    }

    // ─── Deposit ─────────────────────────────────────────────────────────────

    /// @notice Split `amount` USDC across active vaults by the current weight
    ///         vector. All legs must succeed (all-or-revert). Shares are minted
    ///         directly to `msg.sender`.
    ///
    /// @param amount            Total USDC to deposit. Must be pre-approved.
    /// @param minSharesPerLeg   Minimum shares the caller accepts per leg.
    ///                          Length must equal the number of active legs (non-
    ///                          paused, non-retired). Pass an empty array to skip
    ///                          slippage protection.
    function deposit(uint256 amount, uint256[] calldata minSharesPerLeg)
        external
        nonReentrant
        returns (uint256[] memory sharesPerLeg)
    {
        return _depositTo(msg.sender, amount, minSharesPerLeg);
    }

    /// @notice Split `amount` USDC across active vaults by the current weight
    ///         vector. All legs must succeed (all-or-revert). Shares are minted
    ///         to `receiver` instead of `msg.sender`. Intended for gateway
    ///         integration where the gateway is the caller but shares belong to
    ///         the depositor's configured share receiver.
    ///
    /// @param receiver          Address that receives minted vault shares.
    /// @param amount            Total USDC to deposit. Must be pre-approved.
    /// @param minSharesPerLeg   Minimum shares the caller accepts per leg.
    ///                          Length must equal the number of active legs (non-
    ///                          paused, non-retired). Pass an empty array to skip
    ///                          slippage protection.
    function depositFor(address receiver, uint256 amount, uint256[] calldata minSharesPerLeg)
        external
        nonReentrant
        returns (uint256[] memory sharesPerLeg)
    {
        if (receiver == address(0)) revert ZeroAddress();
        return _depositTo(receiver, amount, minSharesPerLeg);
    }

    /// @notice Redeem vault shares from an explicit, caller-supplied set of
    ///         vaults. For each leg the router calls
    ///         `vaults[i].redeem(sharesPerLeg[i], assetRecipient, shareHolder)`,
    ///         routing USDC directly to `assetRecipient`. The caller (typically
    ///         the gateway) must either be `shareHolder` itself — the gateway
    ///         pulls the user's shares into its own custody for the call frame
    ///         and passes itself as `shareHolder` — or hold an ERC-20 allowance
    ///         from `shareHolder` on each vault's share token covering that leg's
    ///         share count; otherwise the call reverts with `UnauthorizedRedeemer`
    ///         (confused-deputy guard, audit finding M-5).
    ///
    ///         EXIT SEMANTICS (issue #967, F-02/F-03/NC-5):
    ///         - Legs are driven by the explicit `vaults[]` argument, NOT the
    ///           live weight vector. A holder can therefore always redeem a
    ///           position the router has since reweighted away from (F-03);
    ///           the router never silently skips or reorders a named vault.
    ///         - `sharesPerLeg[i]` is identity-bound to `vaults[i]`: the redeem
    ///           targets exactly the address the caller named, so a reweight
    ///           between sign and execution can never redirect a leg to a vault
    ///           the caller did not name (NC-5).
    ///         - Redemption succeeds when a leg's registry status is Active OR
    ///           Retired; only Paused blocks the exit (F-02). Retired vaults are
    ///           withdraw-only, never deposit targets — see ADR-0009.
    ///
    ///         SECURITY: users must NEVER grant a share-token approval directly to
    ///         this router. The router calls `vault.redeem` with itself as the
    ///         vault-level spender, so a standing user→router approval would let
    ///         any holder-authorized caller burn the user's shares to an arbitrary
    ///         `assetRecipient`. Only the gateway's transient self-custody flow
    ///         (approve inside its own `nonReentrant` frame, clear afterwards) may
    ///         approve the router.
    ///
    ///         All legs must succeed (all-or-revert). No intermediate USDC custody
    ///         is created in the router — each vault sends USDC directly to
    ///         `assetRecipient`.
    ///
    /// @param shareHolder       Address whose vault shares are redeemed (the `owner`
    ///                          passed to `vault.redeem`). Either equals the caller
    ///                          (gateway self-custody flow: shares pulled from the
    ///                          user and held only during the call frame), or must
    ///                          have approved the caller on each vault's share token
    ///                          for at least that leg's share count. Direct user
    ///                          approvals to this router are forbidden (see SECURITY
    ///                          note above).
    /// @param assetRecipient    Address that receives redeemed USDC. The router
    ///                          forwards each leg's USDC here; it never custodies USDC.
    /// @param vaults            Explicit, caller-supplied list of vault addresses to
    ///                          redeem from. Each must be registered in the
    ///                          VaultRegistry. Drives the redeem legs directly, so a
    ///                          reweighted-out or retired position remains reachable
    ///                          (F-03). `sharesPerLeg[i]`/`minAssetsPerLeg[i]` bind to
    ///                          `vaults[i]` (identity binding, NC-5).
    /// @param sharesPerLeg      Shares to redeem per leg (parallel to `vaults`).
    ///                          Length must match `vaults`. Zero-share legs are
    ///                          accepted (and skipped) so the caller can specify
    ///                          partial positions.
    /// @param minAssetsPerLeg   Per-leg minimum USDC out (slippage floor), parallel to
    ///                          `vaults`. Mirrors the deposit path's
    ///                          `minSharesPerLeg`: each non-zero leg reverts with
    ///                          `SlippageExceeded` if realized proceeds fall below the
    ///                          floor. Length must match `vaults`. A floor of 0
    ///                          disables the check for that leg.
    /// @param deadline          Unix timestamp after which the call reverts with
    ///                          `DeadlineExpired`. Pass `type(uint256).max` to disable.
    /// @return assetsPerLeg     USDC received per leg (parallel to `vaults`).
    function redeemFor(
        address shareHolder,
        address assetRecipient,
        address[] calldata vaults,
        uint256[] calldata sharesPerLeg,
        uint256[] calldata minAssetsPerLeg,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory assetsPerLeg) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (shareHolder == address(0)) revert ZeroAddress();
        if (assetRecipient == address(0)) revert ZeroAddress();

        // F-03: legs come from the caller's explicit vault set, not the live
        // weight vector, so a reweighted-out / retired position stays redeemable.
        uint256 n = vaults.length;
        if (n == 0) revert NoWeightsSet();
        if (sharesPerLeg.length != n) revert RedeemVaultsLengthMismatch();
        if (minAssetsPerLeg.length != n) revert RedeemVaultsLengthMismatch();

        assetsPerLeg = new uint256[](n);

        for (uint256 i = 0; i < n; i++) {
            uint256 shares = sharesPerLeg[i];
            if (shares == 0) continue;
            // NC-5: each leg binds to the caller-named vault address `vaults[i]`,
            // never to whichever vault happens to occupy index i in the weight
            // vector. Per-leg work is in a helper to bound stack depth.
            assetsPerLeg[i] =
                _redeemLeg(vaults[i], shareHolder, assetRecipient, shares, minAssetsPerLeg[i]);
        }
    }

    /// @dev Redeem a single leg: validate registry status and the confused-deputy
    ///      guard, call `vault.redeem`, then enforce the per-leg slippage floor
    ///      (finding L-8). Extracted from `redeemFor` to bound stack depth.
    /// @param vault       Vault whose shares are redeemed.
    /// @param shareHolder Owner of the shares (the `owner` passed to `vault.redeem`).
    /// @param assetRecipient Address that receives the leg's USDC.
    /// @param shares      Shares to redeem on this leg (caller guarantees > 0).
    /// @param minAssets   Per-leg minimum USDC out; reverts `SlippageExceeded` below it.
    /// @return assetsOut  Realized USDC for this leg.
    function _redeemLeg(
        address vault,
        address shareHolder,
        address assetRecipient,
        uint256 shares,
        uint256 minAssets
    ) private returns (uint256 assetsOut) {
        // Registry status (F-02): redemption permits Active OR Retired (Retired is
        // withdraw-only — existing holders keep redeeming, no new deposits, see
        // ADR-0009). Only Paused blocks the exit. `getVault` reverts
        // `NotRegistered` for an unknown vault; surface that as
        // `RedeemVaultNotRegistered` so a caller-named bad address fails loudly.
        VaultRegistry.VaultStatus vaultStatus;
        try registry.getVault(vault) returns (
            VaultRegistry.VaultMetadata memory, VaultRegistry.VaultStatus status
        ) {
            vaultStatus = status;
        } catch {
            revert RedeemVaultNotRegistered(vault);
        }
        if (vaultStatus == VaultRegistry.VaultStatus.Paused) {
            revert VaultPausedForRedeem(vault);
        }

        // Confused-deputy guard (issue #751): caller must be shareHolder or
        // have ERC-20 allowance on the vault share token. Without this check
        // any address can front-run a shareHolder's approval tx and call
        // redeemFor, burning shares at a caller-specified share count.
        if (msg.sender != shareHolder && IERC20(vault).allowance(shareHolder, msg.sender) < shares)
        {
            revert UnauthorizedRedeemer(shareHolder, msg.sender);
        }

        // Redeem: shareHolder must have approved msg.sender (the gateway) to
        // spend their vault shares; the gateway is the `owner` caller here.
        // vault.redeem sends USDC directly to assetRecipient.
        assetsOut = IERC4626(vault).redeem(shares, assetRecipient, shareHolder);

        // Per-leg slippage floor (finding L-8): reject settlement below the
        // caller-supplied minimum so a redeem cannot silently realize less
        // than expected. Parallel to the deposit path's `minSharesPerLeg`.
        if (assetsOut < minAssets) revert SlippageExceeded();
    }

    /// @dev Internal allocation logic shared by `deposit` and `depositFor`.
    function _depositTo(address receiver, uint256 amount, uint256[] calldata minSharesPerLeg)
        internal
        returns (uint256[] memory sharesPerLeg)
    {
        // Route by the effective weight vector: the voted vector when active,
        // otherwise the default (below-quorum fallback) vector. Snapshot into
        // memory so the storage pointers do not stay live across the whole
        // body (keeps locals under the stack limit). ADR-0002.
        (address[] memory vaultList, uint256[] memory bpsList) = _effectiveWeightsMemory();
        if (vaultList.length == 0) revert NoWeightsSet();

        // Global router cap check.
        if (routerCap != 0 && amount > routerCap) revert RouterCapExceeded();

        // AZ-RTR-2: snapshot the router's USDC balance before pulling the
        // caller's deposit. After all legs complete the balance must return to
        // this value — any pre-existing donated USDC is excluded from the
        // invariant because it appears in both the before and after snapshots.
        uint256 usdcBalanceBefore = usdc.balanceOf(address(this));

        // Collect USDC from caller into this contract.
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        uint256 n = vaultList.length;
        sharesPerLeg = new uint256[](n);

        // Validate minSharesPerLeg length if provided.
        if (minSharesPerLeg.length != 0 && minSharesPerLeg.length != n) {
            revert MinSharesLengthMismatch();
        }

        // Skip-and-renormalise: compute which legs are depositable and the
        // renormalised USDC each available leg receives. This is the SAME shared
        // pass `previewDeposit` runs, so preview-available ⇒ execute-deposits and
        // preview-unavailable ⇒ execute-skips — preview and execute never disagree
        // (RTR-5; findings F-13/NC-4). A single non-Active leg no longer reverts
        // the whole router deposit; the basket deposits the remaining legs.
        (bool[] memory available, uint256[] memory legAmounts) =
            _availabilityAndAmounts(vaultList, bpsList, amount);

        // When NO leg is depositable the basket is consistently unavailable: there
        // is nothing to route and `previewDeposit` reports every leg unavailable,
        // so the deposit reverts rather than stranding the caller's USDC.
        bool anyAvailable;
        for (uint256 i = 0; i < n; i++) {
            if (available[i]) {
                anyAvailable = true;
                break;
            }
        }
        if (!anyAvailable) revert NoWeightsSet();

        // Execute legs in a separate frame so its locals do not pile onto this
        // function's stack (Solidity stack-too-deep guard).
        _executeLegs(
            receiver,
            vaultList,
            bpsList,
            legAmounts,
            available,
            minSharesPerLeg,
            sharesPerLeg,
            usdcBalanceBefore
        );
    }

    /// @dev Execute one available vault leg per entry: approve and deposit, then
    ///      check the slippage floor. Unavailable legs (per the shared
    ///      `_availabilityAndAmounts` pass) are skipped — matching
    ///      `previewDeposit` (RTR-5). Available legs are guaranteed depositable by
    ///      that pass; `_executeLeg` re-asserts eligibility as defence in depth.
    ///      All available legs must succeed (all-or-revert across the surviving
    ///      set). Writes minted shares into `sharesPerLeg`.
    function _executeLegs(
        address receiver,
        address[] memory vaultList,
        uint256[] memory bpsList,
        uint256[] memory legAmounts,
        bool[] memory available,
        uint256[] calldata minSharesPerLeg,
        uint256[] memory sharesPerLeg,
        uint256 usdcBalanceBefore
    ) internal {
        for (uint256 i = 0; i < vaultList.length; i++) {
            if (!available[i]) continue; // skip non-depositable legs (RTR-5)

            uint256 sharesReceived = _executeLeg(receiver, vaultList[i], legAmounts[i], bpsList[i]);
            sharesPerLeg[i] = sharesReceived;

            // Slippage guard.
            if (minSharesPerLeg.length != 0 && sharesReceived < minSharesPerLeg[i]) {
                revert SlippageExceeded();
            }
        }

        // AZ-RTR-2: post-loop custody invariant — the router's USDC balance
        // must return to the pre-deposit snapshot taken before the caller's
        // funds were pulled in. Any pre-existing donated USDC is present in
        // both the before and after snapshots, so it cannot trigger a false
        // revert. If any vault accepted less than its allocated legAmount the
        // deposit reverts entirely, preventing USDC from being permanently
        // stranded with no recovery path.
        if (usdc.balanceOf(address(this)) != usdcBalanceBefore) {
            revert UsdcCustodyInvariantViolated();
        }
    }

    /// @dev Execute a single available leg: re-assert Active status + per-vault
    ///      cap + runtime router-eligibility (defence in depth — the leg was
    ///      already vetted by `_availabilityAndAmounts`, but a vault could change
    ///      state between the read and here), approve, deposit, and emit. Extracted
    ///      from `_executeLegs` to bound stack depth.
    /// @param receiver  Address that receives the minted shares.
    /// @param vault     Vault to deposit into (guaranteed available by the caller).
    /// @param legAmount Renormalised USDC for this leg.
    /// @param weightBps This leg's weight (event field only).
    /// @return sharesReceived Shares minted to `receiver`.
    function _executeLeg(address receiver, address vault, uint256 legAmount, uint256 weightBps)
        private
        returns (uint256 sharesReceived)
    {
        // Registry status check — revert unless this vault is Active.
        (, VaultRegistry.VaultStatus vaultStatus) = registry.getVault(vault);
        if (vaultStatus != VaultRegistry.VaultStatus.Active) {
            revert VaultNotActive(vault, vaultStatus);
        }

        // Per-vault cap check (against the renormalised amount).
        if (vaultCap[vault] != 0 && legAmount > vaultCap[vault]) revert VaultCapExceeded();

        // Defence in depth: re-validate router eligibility at deposit time so a
        // vault that became ineligible after weighting (e.g. registry flag revoked
        // or upgrade changing its `asset()`) cannot receive USDC.
        _requireRouterEligible(vault);

        // Approve vault to pull legAmount USDC.
        usdc.forceApprove(vault, legAmount);

        // FS-RTR-1: wrap vault.deposit() so a USDC blacklist hit or
        // fee-on-transfer revert surfaces as a named error instead of the
        // opaque UsdcCustodyInvariantViolated custody check. The try/catch
        // catches all EVM reverts from the external call, including those
        // triggered by USDC's internal transfer restrictions.
        try IERC4626(vault).deposit(legAmount, receiver) returns (uint256 shares) {
            sharesReceived = shares;
        } catch {
            revert UsdcLegTransferFailed(vault);
        }

        emit RouterDeposit(receiver, vault, legAmount, sharesReceived, weightBps);
    }

    // ─── Read surface ────────────────────────────────────────────────────────

    /// @notice Return the voted (active) weight vector (vault list and bps).
    ///         This is the raw voted vector and is empty until a proposal has
    ///         passed; use `getEffectiveWeights` for the vector the router
    ///         actually routes by.
    /// @return vaults  Ordered vault addresses.
    /// @return bps     Parallel weight array in basis points.
    function getWeights() external view returns (address[] memory vaults, uint256[] memory bps) {
        return (_weightVaultList, _weightBps);
    }

    /// @notice Return the default (below-quorum fallback) weight vector.
    /// @return vaults  Ordered vault addresses.
    /// @return bps     Parallel weight array in basis points.
    function getDefaultWeights()
        external
        view
        returns (address[] memory vaults, uint256[] memory bps)
    {
        return (_defaultWeightVaultList, _defaultWeightBps);
    }

    /// @notice Return the effective weight vector the router actually routes
    ///         by: the voted vector when active, otherwise the default vector.
    ///         This is the single source of truth the public allocation surface
    ///         (robotmoney.net/allocation) renders. ADR-0002.
    /// @return vaults  Ordered vault addresses.
    /// @return bps     Parallel weight array in basis points.
    function getEffectiveWeights()
        external
        view
        returns (address[] memory vaults, uint256[] memory bps)
    {
        (address[] storage vaultList, uint256[] storage bpsList) = _effectiveWeights();
        return (vaultList, bpsList);
    }

    /// @notice Number of legs in the default weight vector. Read by
    ///         `VaultRegistry.setRouterEligible` to block eligibility changes
    ///         that would leave the default with a stale length. ADR-0002.
    function defaultWeightsLength() external view returns (uint256) {
        return _defaultWeightVaultList.length;
    }

    /// @dev Return the storage vectors the router routes by: the voted vector
    ///      when `votedWeightsActive`, otherwise the default vector.
    function _effectiveWeights()
        internal
        view
        returns (address[] storage vaults, uint256[] storage bps)
    {
        if (votedWeightsActive) {
            return (_weightVaultList, _weightBps);
        }
        return (_defaultWeightVaultList, _defaultWeightBps);
    }

    /// @dev Memory copy of `_effectiveWeights`, used on the deposit path so the
    ///      storage pointers do not stay live across the whole function body.
    function _effectiveWeightsMemory()
        internal
        view
        returns (address[] memory vaults, uint256[] memory bps)
    {
        (address[] storage vaultList, uint256[] storage bpsList) = _effectiveWeights();
        return (vaultList, bpsList);
    }

    // ─── Router-eligibility surface ──────────────────────────────────────────

    /// @notice Return true if `vault` is router-eligible: it exposes an
    ///         ERC-4626 `asset()` view equal to the router's USDC AND the
    ///         VaultRegistry has marked the vault as router-eligible.
    ///         This view is intentionally distinct from VaultRegistry
    ///         lifecycle status (Active/Paused/Retired); clients (dapp,
    ///         rmpc) read both signals to compose accurate UI state.
    /// @param vault Address of the vault to check.
    /// @return eligible True iff the vault's ERC-4626 asset equals the router's
    ///                  USDC and the registry eligibility flag is set.
    function isRouterEligible(address vault) external view returns (bool eligible) {
        if (vault == address(0)) return false;
        // An EOA has no code; calling asset() on it would decode-revert.
        // Short-circuit so the view returns false instead of reverting.
        if (vault.code.length == 0) return false;
        try IERC4626(vault).asset() returns (address vaultAsset) {
            if (vaultAsset != address(usdc)) return false;
        } catch {
            return false;
        }
        // Registry-backed production-readiness gate (issue #475): the single
        // source of truth for router eligibility is the registry flag set by
        // ADMIN_ROLE on `VaultRegistry.setRouterEligible`. Same contracts in
        // every environment; only the flag's value differs.
        return registry.isRouterEligible(vault);
    }

    /// @notice Return true iff `vault` is router-eligible AND its registry
    ///         lifecycle status is `Active` — i.e. it can be written into a
    ///         weight vector and accept a routed deposit right now. This is the
    ///         exact predicate `setWeights`/`setDefaultWeights` enforce; governance
    ///         (`RouterGovernance.propose`) reads it so a proposal that would
    ///         render router deposits non-executable can never enter the voting
    ///         pipeline (GOV-4, no self-DoS). Never reverts: returns false for a
    ///         zero address, an EOA, an asset mismatch, an unregistered vault, or
    ///         any non-Active status.
    /// @param vault Address of the vault to check.
    /// @return ok True iff the vault is eligible AND Active.
    function isRouterEligibleAndActive(address vault) external view returns (bool ok) {
        if (!this.isRouterEligible(vault)) return false;
        try registry.getVault(vault) returns (
            VaultRegistry.VaultMetadata memory, VaultRegistry.VaultStatus status
        ) {
            return status == VaultRegistry.VaultStatus.Active;
        } catch {
            return false;
        }
    }

    /// @dev Revert unless `vault` is registered, its registry status is `Active`,
    ///      AND it is router-eligible (asset == USDC + eligibility flag). This is
    ///      the single guard that a weight vector is only ever written when every
    ///      leg is simultaneously eligible AND depositable (F-05/RTR-4/GOV-4):
    ///      eligibility and lifecycle status are independent signals, so checking
    ///      eligibility alone would let an eligible-but-Paused/Retired vault enter
    ///      the vector and brick `deposit()` later. Used by `setWeights` and
    ///      `setDefaultWeights` at configuration time.
    function _requireActiveAndEligible(address vault) internal view {
        // Reverts NotRegistered for unknown vaults.
        (, VaultRegistry.VaultStatus status) = registry.getVault(vault);
        if (status != VaultRegistry.VaultStatus.Active) {
            revert VaultNotActive(vault, status);
        }
        _requireRouterEligible(vault);
    }

    /// @dev Revert unless `vault` exposes an ERC-4626 `asset()` view equal to
    ///      `usdc` AND the VaultRegistry has marked the vault as
    ///      router-eligible. Used by `_executeLegs` to enforce
    ///      router-eligibility at runtime.
    function _requireRouterEligible(address vault) internal view {
        // No code at the target — the asset() call would revert without data
        // and bypass the try/catch ABI-decode path on some configurations.
        // Detect explicitly and surface a distinct error so registrations of
        // EOA-style "vaults" fail loudly.
        if (vault.code.length == 0) revert VaultAssetUnreadable(vault);
        try IERC4626(vault).asset() returns (address vaultAsset) {
            if (vaultAsset != address(usdc)) {
                revert VaultAssetMismatch(vault, vaultAsset);
            }
        } catch {
            revert VaultAssetUnreadable(vault);
        }
        // Single registry-backed eligibility gate (issue #475). No
        // per-environment subclass or code variant: the flag is set by
        // governance on the production registry.
        if (!registry.isRouterEligible(vault)) {
            revert VaultNotRouterEligible(vault);
        }
    }
}
