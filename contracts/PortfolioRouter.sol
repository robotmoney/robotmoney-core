// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2 — Portfolio Router
// (See also: docs/prd.md §5 — Multi-vault product direction)
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {VaultRegistry} from "./VaultRegistry.sol";

/// @dev Minimal introspection interface used to detect vaults that
///      self-declare prototype status via `isPrototype()`. Implemented by
///      `contracts/vaults/BasketVault.sol` and inherited by every
///      `BasketVault` subclass. Defined here as a local interface so
///      `PortfolioRouter` has no compile-time dependency on the prototype
///      vaults themselves — any contract that exposes `isPrototype()
///      returns (bool)` participates in the production-readiness gate.
interface IPrototypeAware {
    function isPrototype() external view returns (bool);
}

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

    /// @notice VaultRegistry from which vault addresses and status are read.
    VaultRegistry public immutable registry;

    /// @notice Global ceiling on the total USDC that may flow through a single
    ///         `deposit()` call. 0 means no cap enforced.
    uint256 public routerCap;

    /// @notice Per-vault USDC ceiling for a single `deposit()` leg.
    ///         0 means no cap enforced for that vault.
    mapping(address => uint256) public vaultCap;

    /// @notice Per-vault override that allows a prototype vault (one that
    ///         returns `true` from `isPrototype()`) to be included in the
    ///         router weight vector and receive deposits. False by default —
    ///         a fresh deployment cannot accidentally route real USDC into a
    ///         slot0-priced prototype basket vault. Intended for devnet /
    ///         test deployments that intentionally exercise prototype
    ///         vaults, and for the eventual case where governance has
    ///         completed TWAP hardening but the contract still declares
    ///         itself a prototype. See issue #427 and
    ///         docs/code-reviews/review-codex-20260518-234945.md.
    mapping(address => bool) public prototypeOverride;

    /// @notice Ordered list of vaults included in the weight vector.
    address[] private _weightVaultList;

    /// @notice Weight in basis points for each vault in `_weightVaultList`.
    ///         Parallel array — must always sum to BPS_DENOMINATOR.
    uint256[] private _weightBps;

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

    /// @notice Emitted when the weight vector is updated.
    /// @param vaults  New ordered list of vault addresses.
    /// @param bps     Parallel weight array (must sum to BPS_DENOMINATOR).
    event WeightsSet(address[] vaults, uint256[] bps);

    /// @notice Emitted when the global router cap is updated.
    /// @param oldCap Previous value (0 = uncapped).
    /// @param newCap New value (0 = uncapped).
    event RouterCapSet(uint256 oldCap, uint256 newCap);

    /// @notice Emitted when a per-vault cap is updated.
    /// @param vault  Vault address.
    /// @param oldCap Previous cap (0 = uncapped).
    /// @param newCap New cap (0 = uncapped).
    event VaultCapSet(address indexed vault, uint256 oldCap, uint256 newCap);

    /// @notice Emitted when the prototype-eligibility override for `vault` is
    ///         toggled. `allowed = true` permits the prototype vault to be
    ///         weighted and to receive deposits; `false` (the default)
    ///         blocks router inclusion.
    /// @param vault    Vault address whose override flag changed.
    /// @param oldValue Previous override value.
    /// @param newValue New override value.
    event PrototypeOverrideSet(address indexed vault, bool oldValue, bool newValue);

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

    /// @notice No weight vector has been set; cannot deposit.
    error NoWeightsSet();

    /// @notice A vault's registry status is not Active; deposit is blocked.
    /// @param vault  The vault address that is not Active.
    /// @param status The current non-Active status of the vault.
    error VaultNotActive(address vault, VaultRegistry.VaultStatus status);

    /// @notice A vault's ERC-4626 `asset()` does not match the router's USDC.
    ///         Router refuses to weight or deposit into vaults whose underlying
    ///         asset is anything other than the configured router USDC. This is
    ///         the router-eligibility guard described in issue #426 / the
    ///         coin-theft path audit (review-codex-20260518-234945.md §2).
    /// @param vault       The router-ineligible vault address.
    /// @param vaultAsset  The vault's reported `asset()` address.
    error VaultAssetMismatch(address vault, address vaultAsset);

    /// @notice A vault did not expose a callable ERC-4626 `asset()` view, so
    ///         router eligibility cannot be verified. The router refuses to
    ///         interact with such vaults.
    /// @param vault The vault address whose `asset()` call reverted.
    error VaultAssetUnreadable(address vault);

    /// @notice A vault self-declares as a prototype (via `isPrototype()
    ///         returns true`) and has no explicit `prototypeOverride[vault]
    ///         = true`. Prototype basket vaults price NAV from Uniswap V3
    ///         `slot0`, which is manipulable inside a single block. They
    ///         MUST NOT receive router-routed USDC in production until TWAP
    ///         hardening is complete. Devnet / test deployments may opt in
    ///         by calling `setPrototypeOverride(vault, true)`. See issue
    ///         #427 and docs/code-reviews/review-codex-20260518-234945.md.
    /// @param vault The prototype vault address that was rejected.
    error VaultIsPrototype(address vault);

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
    ///         VaultRegistry. The bps values must sum to exactly BPS_DENOMINATOR.
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
            // Router-eligibility guard: the vault's ERC-4626 asset() must equal
            // the router's USDC. A registered but ineligible vault (wrong asset,
            // non-4626, or unreadable asset()) cannot be set as an active
            // weighted route. See review-codex-20260518-234945.md §2.
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

        emit WeightsSet(vaults, bps);
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

    /// @notice Explicitly opt `vault` in (`allowed = true`) or out
    ///         (`allowed = false`) of router eligibility despite the vault
    ///         self-declaring as a prototype via `isPrototype() == true`.
    ///         The default is `false` for every address — a fresh
    ///         production deployment cannot accidentally weight a
    ///         slot0-priced basket vault. Intended for devnet / test
    ///         deployments, and for the post-TWAP-hardening transition
    ///         where governance has audited the prototype and accepts the
    ///         remaining risk. Restricted to `ADMIN_ROLE`.
    /// @param vault   Vault address to mark as router-eligible despite
    ///                prototype status.
    /// @param allowed New override value. `true` lifts the prototype gate
    ///                for this single vault; `false` re-engages it.
    function setPrototypeOverride(address vault, bool allowed) external onlyRole(ADMIN_ROLE) {
        if (vault == address(0)) revert ZeroAddress();
        emit PrototypeOverrideSet(vault, prototypeOverride[vault], allowed);
        prototypeOverride[vault] = allowed;
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
        uint256 n = _weightVaultList.length;
        legs = new LegPreview[](n);

        for (uint256 i = 0; i < n; i++) {
            address vault = _weightVaultList[i];
            uint256 legAmount = (amount * _weightBps[i]) / BPS_DENOMINATOR;

            legs[i].vault = vault;
            legs[i].weightBps = _weightBps[i];
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
        if (_weightVaultList.length == 0) revert NoWeightsSet();

        // Global router cap check.
        if (routerCap != 0 && amount > routerCap) revert RouterCapExceeded();

        // Collect USDC from caller into this contract.
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        uint256 n = _weightVaultList.length;
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
            legAmounts[i] = (amount * _weightBps[i]) / BPS_DENOMINATOR;
            allocated += legAmounts[i];
        }
        // Assign rounding remainder to the final leg so the router holds zero
        // USDC after a successful deposit (pass-through invariant).
        if (allocated < amount) {
            legAmounts[n - 1] += amount - allocated;
        }

        for (uint256 i = 0; i < n; i++) {
            address vault = _weightVaultList[i];
            uint256 legAmount = legAmounts[i];

            // Registry status check — revert unless this vault is Active.
            (, VaultRegistry.VaultStatus vaultStatus) = registry.getVault(vault);
            if (vaultStatus != VaultRegistry.VaultStatus.Active) {
                revert VaultNotActive(vault, vaultStatus);
            }

            // Per-vault cap check.
            if (vaultCap[vault] != 0 && legAmount > vaultCap[vault]) revert VaultCapExceeded();

            // Defence in depth: re-validate router eligibility at deposit time
            // so a vault that became ineligible after weighting (e.g. upgrade
            // changing its `asset()`) cannot receive USDC. setWeights enforces
            // this at configuration time; this re-check guards the runtime path.
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

            emit RouterDeposit(receiver, vault, legAmount, sharesReceived, _weightBps[i]);
        }
    }

    // ─── Read surface ────────────────────────────────────────────────────────

    /// @notice Return the current weight vector (vault list and bps).
    /// @return vaults  Ordered vault addresses.
    /// @return bps     Parallel weight array in basis points.
    function getWeights() external view returns (address[] memory vaults, uint256[] memory bps) {
        return (_weightVaultList, _weightBps);
    }

    // ─── Router-eligibility surface ──────────────────────────────────────────

    /// @notice Return true if `vault` is router-eligible: it exposes an
    ///         ERC-4626 `asset()` view and that asset equals the router's USDC.
    ///         This is intentionally distinct from VaultRegistry status —
    ///         registry status describes lifecycle (Active/Paused/Retired)
    ///         while router eligibility describes asset compatibility with the
    ///         router's deposit flow. Clients (dapp, rmpc) read both to
    ///         present accurate state.
    /// @param vault Address of the vault to check.
    /// @return eligible True if the vault's ERC-4626 asset equals the router's
    ///                  USDC; false if the asset differs or `asset()` reverts.
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
        // Prototype gate: a vault that self-declares `isPrototype() == true`
        // is router-ineligible unless an explicit per-vault override is
        // set. Vaults that do not implement `isPrototype()` are treated as
        // non-prototype (the call reverts and we fall through). See issue
        // #427.
        if (_isPrototype(vault) && !prototypeOverride[vault]) {
            return false;
        }
        return true;
    }

    /// @dev Revert unless `vault` exposes an ERC-4626 `asset()` view equal to
    ///      `usdc`. Used by `setWeights` and `_depositTo` to enforce
    ///      router-eligibility. See review-codex-20260518-234945.md §2.
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
        // Prototype gate: refuse vaults that self-declare prototype status
        // unless governance has explicitly opted them in. This is the
        // production-readiness gate for slot0-priced basket vaults — see
        // issue #427 and docs/code-reviews/review-codex-20260518-234945.md.
        if (_isPrototype(vault) && !prototypeOverride[vault]) {
            revert VaultIsPrototype(vault);
        }
    }

    /// @dev Try the optional `isPrototype()` view. Returns `true` only when
    ///      the vault explicitly self-declares as a prototype. Vaults that
    ///      do not implement the view (the call reverts) are treated as
    ///      non-prototype so that the eligibility gate is opt-in from the
    ///      vault side — non-BasketVault ERC-4626 strategies are unaffected.
    function _isPrototype(address vault) internal view returns (bool) {
        try IPrototypeAware(vault).isPrototype() returns (bool flag) {
            return flag;
        } catch {
            return false;
        }
    }
}
