// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2 — Portfolio Router
// (See also: docs/adr/ADR-0002-router-default-weights-on-chain.md — on-chain
//            defaultWeights fallback for below-quorum router behaviour;
//            docs/prd.md §5 — Core Workflows (Router deposit flows);
//            docs/development/single-production-codebase.md — the principle
//            that drives expressing production-readiness as VaultRegistry
//            state instead of a per-environment code variant.)
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {VaultRegistry} from "./VaultRegistry.sol";

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
contract PortfolioRouter is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Grants/revokes roles, sets weights, caps, and registry address.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Basis-points denominator (10 000 = 100%).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @notice USDC token used as the deposit asset across all vaults.
    IERC20 public immutable usdc;

    /// @notice VaultRegistry from which vault addresses, lifecycle status, and
    ///         router-eligibility state are read.
    VaultRegistry public immutable registry;

    /// @notice Global ceiling on the total USDC that may flow through a single
    ///         `deposit()` call. 0 means no cap enforced.
    uint256 public routerCap;

    /// @notice Per-vault USDC ceiling for a single `deposit()` leg.
    ///         0 means no cap enforced for that vault.
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

    /// @notice Emitted when stranded USDC is recovered from the router by an
    ///         ADMIN_ROLE holder via `rescueUsdc`.
    /// @param to     Recipient of the recovered USDC.
    /// @param amount Amount of USDC transferred.
    event RescuedUsdc(address indexed to, uint256 amount);

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

    /// @notice A vault returned fewer shares than the depositor's minimum.
    error SlippageExceeded();

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

    /// @notice After `_executeLegs` completes the router's USDC balance is
    ///         non-zero, meaning one or more vaults accepted less than their
    ///         allocated `legAmount`. The entire deposit is reverted so no
    ///         USDC is permanently stranded in the router.
    error UsdcCustodyInvariantViolated();

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
            // Verify vault is registered — getVault reverts with NotRegistered if not.
            registry.getVault(vaults[i]);
            // Router-eligibility guard: asset compatibility AND the registry
            // eligibility flag must be set. See _requireRouterEligible.
            _requireRouterEligible(vaults[i]);
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
        if (vaults.length != bps.length) revert LengthMismatch();
        // The default vector must span exactly the router-eligible vault set so
        // it can never carry a stale length relative to eligibility (the same
        // invariant VaultRegistry.setRouterEligible enforces from its side).
        if (vaults.length != registry.routerEligibleCount()) revert LengthMismatch();

        uint256 total;
        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i] == address(0)) revert ZeroAddress();
            registry.getVault(vaults[i]);
            _requireRouterEligible(vaults[i]);
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

    /// @notice Transfer the entire USDC balance held by this contract to `to`.
    ///         Intended as an emergency recovery path for USDC that becomes
    ///         stranded in the router through edge cases not covered by the
    ///         `UsdcCustodyInvariantViolated` deposit guard (e.g. direct
    ///         transfers, or USDC approved but not pulled by a vault that
    ///         reverted silently in a legacy path). Restricted to `ADMIN_ROLE`.
    /// @param to  Recipient of all stranded USDC held by the router.
    function rescueUsdc(address to) external onlyRole(ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = usdc.balanceOf(address(this));
        if (amount == 0) return;
        usdc.safeTransfer(to, amount);
        emit RescuedUsdc(to, amount);
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
    ///         executing any state changes. Paused or retired vaults are marked
    ///         `unavailable = true` and return `estShares = 0`.
    /// @param amount  Total USDC to preview.
    /// @return legs   One entry per vault in the current weight vector.
    function previewDeposit(uint256 amount) external view returns (LegPreview[] memory legs) {
        (address[] storage vaultList, uint256[] storage bpsList) = _effectiveWeights();
        uint256 n = vaultList.length;
        legs = new LegPreview[](n);

        for (uint256 i = 0; i < n; i++) {
            address vault = vaultList[i];
            uint256 legAmount = (amount * bpsList[i]) / BPS_DENOMINATOR;

            legs[i].vault = vault;
            legs[i].weightBps = bpsList[i];
            legs[i].legAmount = legAmount;

            // Check vault status from registry.
            try registry.getVault(vault) returns (
                VaultRegistry.VaultMetadata memory, VaultRegistry.VaultStatus status
            ) {
                if (status != VaultRegistry.VaultStatus.Active) {
                    legs[i].unavailable = true;
                    continue;
                }
            } catch {
                legs[i].unavailable = true;
                continue;
            }

            // Attempt to get previewDeposit from the vault.
            try IERC4626(vault).previewDeposit(legAmount) returns (uint256 estShares) {
                legs[i].estShares = estShares;
            } catch {
                legs[i].unavailable = true;
            }
        }
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

        // Collect USDC from caller into this contract.
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        uint256 n = vaultList.length;
        sharesPerLeg = new uint256[](n);

        // Validate minSharesPerLeg length if provided.
        if (minSharesPerLeg.length != 0 && minSharesPerLeg.length != n) {
            revert MinSharesLengthMismatch();
        }

        // Pre-compute all leg amounts so the remainder can be assigned to the
        // final leg before any vault interaction begins.
        uint256[] memory legAmounts = new uint256[](n);
        uint256 allocated;
        for (uint256 i = 0; i < n; i++) {
            legAmounts[i] = (amount * bpsList[i]) / BPS_DENOMINATOR;
            allocated += legAmounts[i];
        }
        // Assign rounding remainder to the final leg so the router holds zero
        // USDC after a successful deposit (pass-through invariant).
        if (allocated < amount) {
            legAmounts[n - 1] += amount - allocated;
        }

        // Execute legs in a separate frame so its locals do not pile onto this
        // function's stack (Solidity stack-too-deep guard).
        _executeLegs(receiver, vaultList, bpsList, legAmounts, minSharesPerLeg, sharesPerLeg);
    }

    /// @dev Execute one vault leg per entry: enforce Active status, per-vault
    ///      cap, runtime router-eligibility, approve and deposit, then check
    ///      the slippage floor. All-or-revert. Writes minted shares into
    ///      `sharesPerLeg`.
    function _executeLegs(
        address receiver,
        address[] memory vaultList,
        uint256[] memory bpsList,
        uint256[] memory legAmounts,
        uint256[] calldata minSharesPerLeg,
        uint256[] memory sharesPerLeg
    ) internal {
        for (uint256 i = 0; i < vaultList.length; i++) {
            address vault = vaultList[i];
            uint256 legAmount = legAmounts[i];

            // Registry status check — revert unless this vault is Active.
            (, VaultRegistry.VaultStatus vaultStatus) = registry.getVault(vault);
            if (vaultStatus != VaultRegistry.VaultStatus.Active) {
                revert VaultNotActive(vault, vaultStatus);
            }

            // Per-vault cap check.
            if (vaultCap[vault] != 0 && legAmount > vaultCap[vault]) revert VaultCapExceeded();

            // Defence in depth: re-validate router eligibility at deposit time
            // so a vault that became ineligible after weighting (e.g. registry
            // flag revoked or upgrade changing its `asset()`) cannot receive
            // USDC. setWeights enforces this at configuration time; this
            // re-check guards the runtime path.
            _requireRouterEligible(vault);

            // Approve vault to pull legAmount USDC.
            usdc.forceApprove(vault, legAmount);

            // deposit() returns shares minted to receiver.
            uint256 sharesReceived = IERC4626(vault).deposit(legAmount, receiver);
            sharesPerLeg[i] = sharesReceived;

            // Slippage guard.
            if (minSharesPerLeg.length != 0 && sharesReceived < minSharesPerLeg[i]) {
                revert SlippageExceeded();
            }

            emit RouterDeposit(receiver, vault, legAmount, sharesReceived, bpsList[i]);
        }

        // Post-loop custody invariant: the router must hold zero USDC after all
        // legs have been executed. If any vault accepted less than its allocated
        // legAmount the deposit reverts entirely, preventing USDC from being
        // permanently stranded with no recovery path.
        if (usdc.balanceOf(address(this)) != 0) {
            revert UsdcCustodyInvariantViolated();
        }
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

    /// @dev Revert unless `vault` exposes an ERC-4626 `asset()` view equal to
    ///      `usdc` AND the VaultRegistry has marked the vault as
    ///      router-eligible. Used by `setWeights` and `_depositTo` to enforce
    ///      router-eligibility at both configuration and runtime.
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
