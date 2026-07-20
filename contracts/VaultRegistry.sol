// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2, §10 — Vault Registry
// (See also: docs/prd.md §11 — Vault Catalog;
//            docs/adr/ADR-0002-router-default-weights-on-chain.md — the
//            router-eligible count and stale-defaultWeights-length guard)
pragma solidity ^0.8.24;

import {AdminFloorAccessControl} from "./lib/AdminFloorAccessControl.sol";

/// @dev Minimal view the registry needs from `PortfolioRouter` to keep the
///      default weight vector's length consistent with router eligibility.
///      Declared as an interface (not an import) to avoid a circular
///      compile-time dependency between the two contracts.
interface IRouterDefaultWeights {
    /// @notice Number of legs in the router's default weight vector.
    function defaultWeightsLength() external view returns (uint256);

    /// @notice Registry-only entry point that sets the router's default-weight
    ///         vector. Called by `migrateEligibility` after this registry has
    ///         already updated `routerEligibleCount`, so the router's own
    ///         length check sees the new count and the eligibility flip + weight
    ///         write land in one transaction. ADR-0002 migration interlock fix
    ///         (H-A1, issue #1128).
    function applyMigrationDefaultWeights(address[] calldata vaults, uint256[] calldata bps)
        external;
}

/// @dev Minimal view the registry needs to drive the vault deposit-halt leg of
///      the unified governance `retire()` action (DI-2). Declared as an
///      interface (not an import) to avoid a circular compile-time dependency
///      between the registry and the vault. The vault gates both calls to its
///      linked registry, so the registry's authority over the vault is narrow
///      (deposit-halt only, not full `ADMIN_ROLE`).
interface IRetirableVault {
    /// @notice Hard-stop direct deposits on the vault.
    function retire() external;
    /// @notice Re-open direct deposits on the vault (governance abort).
    function unretire() external;
}

/// @title VaultRegistry
/// @notice On-chain registry of authorised Robot Money vaults.
///
/// Protocol operators call `registerVault` once per vault; all downstream
/// clients (rmpc, dapp, indexer) discover vaults via `listVaults()`.
/// `VaultRegistered` and `VaultStatusChanged` events let the explorer
/// indexer stay current without manual config updates.
///
/// Access model: `ADMIN_ROLE` is required for `registerVault` and
/// `setVaultStatus`. This role is self-administered (its own role-admin)
/// so the deployer is the sole initial admin, matching the gateway's
/// access-control pattern.
contract VaultRegistry is AdminFloorAccessControl {
    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Grants/revokes other roles, registers vaults, changes vault status.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Vault status ────────────────────────────────────────────────────────

    /// @notice Lifecycle status of a registered vault.
    enum VaultStatus {
        Active,
        Paused,
        /// @dev Retired: withdraw-only. Existing depositors keep standard
        ///      ERC-4626 `redeem` at any time and `PortfolioRouter` routes no
        ///      new deposits here. There is deliberately NO on-chain migration:
        ///      the protocol never force- or admin-migrates depositor funds to a
        ///      successor vault. Any migration is user-initiated and user-signed
        ///      at the app layer (redeem, then deposit). See
        ///      docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md.
        Retired
    }

    // ─── Vault metadata ──────────────────────────────────────────────────────

    /// @notice Metadata stored on-chain for every registered vault.
    /// @param name          Human-readable name (e.g. "Robot Money USDC").
    /// @param asset         ERC-20 asset address the vault denominates in.
    /// @param registeredAt  Block timestamp when `registerVault` was called.
    struct VaultMetadata {
        string name;
        address asset;
        uint256 registeredAt;
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @dev Full metadata per vault address.
    mapping(address => VaultMetadata) private _metadata;

    /// @dev Current lifecycle status per vault address.
    mapping(address => VaultStatus) private _status;

    /// @dev Ordered list of all registered vault addresses (registration order preserved).
    address[] private _vaults;

    /// @dev Quick existence check to avoid scanning `_vaults` on duplicate-register guard.
    mapping(address => bool) private _registered;

    /// @notice Per-vault router-eligibility flag. False by default. Toggled by
    ///         `ADMIN_ROLE` via `setRouterEligible` to express that a registered
    ///         vault has cleared production-readiness gating (audit, oracle
    ///         hardening, etc.) and may be weighted by `PortfolioRouter`.
    ///
    ///         Router eligibility is registry **state** — it is the single,
    ///         operator-set signal `PortfolioRouter` consults to decide whether
    ///         a vault can enter the weight vector and receive USDC. Expressing
    ///         readiness as state (not as a code variant such as a
    ///         test/demo-only subclass that overrides a hard-coded flag) is the
    ///         single-production-codebase principle in
    ///         `docs/development/single-production-codebase.md`: the same
    ///         contracts deploy unchanged into every environment; environments
    ///         differ only by configuration and seeded state.
    mapping(address => bool) private _routerEligible;

    /// @notice Count of vaults currently marked router-eligible. Mirrors the
    ///         number of `true` entries in `_routerEligible`. The
    ///         `PortfolioRouter` default weight vector must span exactly this
    ///         many legs (see `setRouterEligible`). ADR-0002.
    uint256 public routerEligibleCount;

    /// @notice Optional `PortfolioRouter` whose default weight vector length is
    ///         kept consistent with `routerEligibleCount`. When set (non-zero)
    ///         and the router already carries a non-empty default vector,
    ///         `setRouterEligible` reverts on any change that would leave that
    ///         vector with a stale length. Set once by ADMIN_ROLE after both
    ///         contracts are deployed. ADR-0002.
    IRouterDefaultWeights public router;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when a new vault is registered.
    /// @param vault   Address of the registered vault contract.
    /// @param name    Human-readable vault name.
    /// @param asset   ERC-20 asset the vault denominates in.
    event VaultRegistered(address indexed vault, string name, address indexed asset);

    /// @notice Emitted when a vault's lifecycle status is changed.
    /// @param vault      Address of the vault whose status changed.
    /// @param newStatus  New lifecycle status.
    /// @param timestamp  Block timestamp at the moment of the status change.
    event VaultStatusChanged(
        address indexed vault, VaultStatus indexed newStatus, uint256 timestamp
    );

    /// @notice Emitted when the router-eligibility flag for `vault` changes.
    ///         `PortfolioRouter` reads this flag (via `isRouterEligible`) to
    ///         decide whether the vault may be weighted and receive USDC.
    /// @param vault    Address of the vault whose flag changed.
    /// @param oldValue Previous eligibility value.
    /// @param newValue New eligibility value.
    event RouterEligibilityChanged(address indexed vault, bool oldValue, bool newValue);

    /// @notice Emitted when the linked `PortfolioRouter` reference is set.
    /// @param oldRouter Previous router address (0 = unset).
    /// @param newRouter New router address (0 = unset).
    event RouterSet(address indexed oldRouter, address indexed newRouter);

    // ─── Errors ──────────────────────────────────────────────────────────────

    /// @notice Vault address argument is `address(0)`.
    error ZeroAddress();

    /// @notice Vault address is already registered.
    error AlreadyRegistered();

    /// @notice Vault address is not registered; `getVault` and `setVaultStatus`
    ///         revert with this error when the address is unknown.
    error NotRegistered();

    /// @notice A `setRouterEligible` change would leave the linked router's
    ///         non-empty default weight vector with a length that no longer
    ///         matches `routerEligibleCount`. Re-set `defaultWeights` to the new
    ///         eligible set first (or clear it), then change eligibility.
    /// @param expectedLength New router-eligible count after the change.
    /// @param defaultLength  Current default weight vector length.
    error StaleDefaultWeightsLength(uint256 expectedLength, uint256 defaultLength);

    /// @notice `setRouter(address(0))` was called while the currently-linked
    ///         router still carries a non-empty default weight vector. Clear or
    ///         re-set `defaultWeights` on the router first, then unlink.
    /// @param defaultLength  Current default weight vector length on the router.
    error RouterUnlinkBlocked(uint256 defaultLength);

    /// @notice `migrateEligibility` was called while no `PortfolioRouter` is
    ///         linked. The atomic eligibility+weights entry point only makes
    ///         sense against a linked router whose default vector it re-sets in
    ///         the same call; with no router, use plain `setRouterEligible`.
    error RouterNotLinked();

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param admin Address that receives `ADMIN_ROLE` at deploy time.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ─── Write surface ───────────────────────────────────────────────────────

    /// @notice Register a new vault. The vault is set to `Active` status immediately.
    ///         Restricted to `ADMIN_ROLE`.
    /// @param vault    Address of the vault contract to register (must not be zero or
    ///                 already registered).
    /// @param metadata Human-readable name and asset address for the vault.
    function registerVault(address vault, VaultMetadata calldata metadata)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (vault == address(0)) revert ZeroAddress();
        if (_registered[vault]) revert AlreadyRegistered();

        _registered[vault] = true;
        _vaults.push(vault);
        _metadata[vault] = VaultMetadata({
            name: metadata.name, asset: metadata.asset, registeredAt: block.timestamp
        });
        _status[vault] = VaultStatus.Active;

        emit VaultRegistered(vault, metadata.name, metadata.asset);
    }

    // ─── Unified governance retire (DI-2) ─────────────────────────────────────
    //
    // Canonical design: docs/architecture.md §4.7 "Decided target (per decision
    // #925, graduated-authority model)" and docs/prd.md §6 Vault lifecycle +
    // §12 INV-3.
    //
    // `setVaultStatus(vault, Retired)` alone stops only the *router* from sending
    // new deposits; the vault still accepts *direct* deposits until its own
    // deposit-halt is flipped. `retire(vault)` closes that drift by doing both in
    // one timelock-gated call: it sets registry status to `Retired` AND calls the
    // vault deposit-halt leg (`IRetirableVault.retire()`). Emergency
    // `RobotMoneyVault.shutdownVault` stays `EMERGENCY_ROLE`, vault-only, with no
    // registry/lifecycle change — the hot key never makes a lifecycle decision.

    /// @notice Unified governance retire: atomically set the vault's registry
    ///         status to `Retired` AND halt the vault's direct deposits in a
    ///         single call. Restricted to `ADMIN_ROLE` (held by the
    ///         TimelockController in production — DeployTimelock, INV-3), so a
    ///         direct hot-key call reverts. This is the deliberate, governance
    ///         lifecycle decision (decision #925); the emergency
    ///         `RobotMoneyVault.shutdownVault` overlay is unaffected.
    ///         Withdrawals/redemptions stay open at the vault throughout
    ///         (ERC-4626 `redeem` is never revoked; ADR-0009).
    /// @param vault Address of an already-registered vault.
    function retire(address vault) external onlyRole(ADMIN_ROLE) {
        if (!_registered[vault]) revert NotRegistered();
        _status[vault] = VaultStatus.Retired;
        IRetirableVault(vault).retire();
        emit VaultStatusChanged(vault, VaultStatus.Retired, block.timestamp);
    }

    /// @notice Abort a deprecation: atomically set the vault's registry status
    ///         back to `Active` AND re-open the vault's direct deposits. The
    ///         governance counterpart to `retire`, mirroring the
    ///         `Retired → Active` abort in docs/architecture.md §4.7. Restricted
    ///         to `ADMIN_ROLE` (TimelockController in production).
    /// @param vault Address of an already-registered vault.
    function reactivate(address vault) external onlyRole(ADMIN_ROLE) {
        if (!_registered[vault]) revert NotRegistered();
        _status[vault] = VaultStatus.Active;
        IRetirableVault(vault).unretire();
        emit VaultStatusChanged(vault, VaultStatus.Active, block.timestamp);
    }

    /// @notice Update a vault's lifecycle status, driving the vault's own
    ///         deposit-halt flag in the same call so registry status and the vault
    ///         flag never drift (LIFE-1; finding F-04 residual / AZ-REG-1).
    ///         Restricted to `ADMIN_ROLE`.
    ///
    ///         Closing the back-door: previously this set only registry `_status`,
    ///         leaving the vault's `retired` deposit-halt flag untouched — so
    ///         `setVaultStatus(_, Retired)` recorded "Retired" in the registry
    ///         while the vault still accepted direct deposits, and
    ///         `setVaultStatus(_, Paused)` halted nothing on the vault. Now any
    ///         non-`Active` status drives `IRetirableVault.retire()` (hard-stop
    ///         direct deposits) and `Active` drives `unretire()`, mirroring the
    ///         atomic `retire()` / `reactivate()` paths. Both vault legs are
    ///         idempotent and registry-gated.
    ///
    ///         AZ-REG-1 fix: vault calls are no longer wrapped in try/catch. A
    ///         failed retire hook propagates to the caller so the registry never
    ///         records a vault as `Retired` while its deposit-halt leg is
    ///         unset — deposits would otherwise continue against a supposedly-
    ///         retired vault. Every vault type in the protocol implements
    ///         `IRetirableVault`; a registered address that lacks the hook
    ///         fails the call intentionally.
    /// @param vault      Address of an already-registered vault.
    /// @param newStatus  New lifecycle status (Active, Paused, or Retired).
    function setVaultStatus(address vault, VaultStatus newStatus) external onlyRole(ADMIN_ROLE) {
        if (!_registered[vault]) revert NotRegistered();
        _status[vault] = newStatus;

        // Drive the vault's deposit-halt flag so it can never disagree with the
        // registry status (LIFE-1 / F-04 / AZ-REG-1). Active re-opens direct
        // deposits; any non-Active status (Paused or Retired) hard-stops them.
        // The empty-code guard skips addresses with no contract code. Calls are
        // made directly (no try/catch) so a hook failure propagates to the
        // caller: a failed retire must NOT be silently absorbed while the
        // registry records the vault as Retired (AZ-REG-1 — deposits would
        // continue against a supposedly-retired vault). Every vault type in the
        // protocol implements IRetirableVault; a registered address that lacks
        // the hook fails the call intentionally.
        if (vault.code.length > 0) {
            if (newStatus == VaultStatus.Active) {
                IRetirableVault(vault).unretire();
            } else {
                IRetirableVault(vault).retire();
            }
        }

        emit VaultStatusChanged(vault, newStatus, block.timestamp);
    }

    /// @notice Mark `vault` as router-eligible (`eligible = true`) or
    ///         ineligible (`eligible = false`). `PortfolioRouter` refuses to
    ///         weight or deposit into a vault whose flag is `false` — the
    ///         default for every freshly registered vault. ADMIN_ROLE flips
    ///         the flag once production-readiness gating (audit, oracle
    ///         hardening, etc.) is complete.
    ///
    ///         This is the single, registry-backed expression of
    ///         production-readiness called for by the
    ///         single-production-codebase principle
    ///         (`docs/development/single-production-codebase.md`). The same
    ///         contracts ship into test, demo, and production environments;
    ///         only this flag's value differs.
    /// @param vault    Address of an already-registered vault.
    /// @param eligible New router-eligibility value.
    function setRouterEligible(address vault, bool eligible) external onlyRole(ADMIN_ROLE) {
        if (!_registered[vault]) revert NotRegistered();
        bool old = _routerEligible[vault];
        if (old == eligible) {
            // No-op: count and any default vector stay consistent. Still emit
            // for observability symmetry.
            emit RouterEligibilityChanged(vault, old, eligible);
            return;
        }

        uint256 newCount = eligible ? routerEligibleCount + 1 : routerEligibleCount - 1;

        // Block stale-length state: if a router is linked and already carries a
        // non-empty default weight vector, that vector must be re-set to span
        // the new eligible set before (or atomically with) this change. The
        // empty default (length 0) is exempt — it means "no default configured
        // yet", which is always consistent. ADR-0002.
        if (address(router) != address(0)) {
            uint256 defaultLength = router.defaultWeightsLength();
            if (defaultLength != 0 && defaultLength != newCount) {
                revert StaleDefaultWeightsLength(newCount, defaultLength);
            }
        }

        routerEligibleCount = newCount;
        emit RouterEligibilityChanged(vault, old, eligible);
        _routerEligible[vault] = eligible;
    }

    /// @notice Atomically flip `vault`'s router-eligibility **and** re-set the
    ///         linked router's default-weight vector in one transaction. This is
    ///         the ADR-0002 migration interlock fix (H-A1, issue #1128).
    ///
    ///         The non-atomic path deadlocks once the router carries a
    ///         full-length default vector: `setRouterEligible` reverts
    ///         `StaleDefaultWeightsLength` because the vector length no longer
    ///         matches the new count, while `PortfolioRouter.setDefaultWeights`
    ///         reverts `LengthMismatch` because the count has not moved yet —
    ///         each half is blocked on the other. This call breaks the deadlock
    ///         by moving the count and the vector together, so the
    ///         `routerEligibleCount == defaultWeights.length` invariant is never
    ///         observed in an inconsistent state.
    ///
    ///         The eligibility flip is applied to this registry's state first,
    ///         then the router's registry-only
    ///         `applyMigrationDefaultWeights` re-runs the full default-vector
    ///         validation against the updated count. A default vector whose
    ///         length disagrees with the new count is rejected there and reverts
    ///         this whole transaction, so no partial update can persist. Requires
    ///         a linked router. Restricted to `ADMIN_ROLE`.
    /// @param vault         Address of an already-registered vault.
    /// @param eligible      New router-eligibility value for `vault`.
    /// @param defaultVaults Ordered vault list for the new default vector; its
    ///                      length must equal the post-flip eligible count.
    /// @param defaultBps    Parallel bps weights (must sum to BPS_DENOMINATOR).
    function migrateEligibility(
        address vault,
        bool eligible,
        address[] calldata defaultVaults,
        uint256[] calldata defaultBps
    ) external onlyRole(ADMIN_ROLE) {
        if (!_registered[vault]) revert NotRegistered();
        if (address(router) == address(0)) revert RouterNotLinked();

        bool old = _routerEligible[vault];
        uint256 newCount = routerEligibleCount;
        if (old != eligible) {
            newCount = eligible ? newCount + 1 : newCount - 1;
            routerEligibleCount = newCount;
            _routerEligible[vault] = eligible;
            emit RouterEligibilityChanged(vault, old, eligible);
        }

        // Re-set the router's default vector against the now-updated count.
        // No StaleDefaultWeightsLength guard here — that guard exists to block
        // the non-atomic path; the router's own length check (vector length ==
        // routerEligibleCount) enforces the same invariant atomically and
        // reverts the whole call on any mismatch.
        router.applyMigrationDefaultWeights(defaultVaults, defaultBps);
    }

    /// @notice Link the `PortfolioRouter` whose default weight vector length is
    ///         kept consistent with `routerEligibleCount`. Pass `address(0)` to
    ///         unlink. Restricted to `ADMIN_ROLE`. ADR-0002.
    ///
    ///         Unlinking (passing `address(0)`) is blocked while the currently-
    ///         linked router still carries a non-empty default weight vector.
    ///         Clear or re-set `defaultWeights` on the router first. This
    ///         prevents the bypass sequence: unlink → revoke eligibility → re-link
    ///         which would otherwise leave the vector pointing to an ineligible
    ///         vault without tripping the stale-length guard.
    /// @param newRouter Address of the `PortfolioRouter` (or 0 to unlink).
    function setRouter(address newRouter) external onlyRole(ADMIN_ROLE) {
        if (newRouter == address(0) && address(router) != address(0)) {
            uint256 defaultLength = router.defaultWeightsLength();
            if (defaultLength != 0) {
                revert RouterUnlinkBlocked(defaultLength);
            }
        }
        emit RouterSet(address(router), newRouter);
        router = IRouterDefaultWeights(newRouter);
    }

    // ─── Read surface ────────────────────────────────────────────────────────

    /// @notice Return full metadata and current status for a registered vault.
    /// @param vault Address of the vault to query.
    /// @return metadata Stored `VaultMetadata` (name, asset, registeredAt).
    /// @return status   Current `VaultStatus`.
    function getVault(address vault)
        external
        view
        returns (VaultMetadata memory metadata, VaultStatus status)
    {
        if (!_registered[vault]) revert NotRegistered();
        return (_metadata[vault], _status[vault]);
    }

    /// @notice Return all registered vault addresses in registration order.
    /// @return addresses Ordered array of every vault ever registered.
    function listVaults() external view returns (address[] memory addresses) {
        return _vaults;
    }

    /// @notice Number of registered vaults. Always equals `listVaults().length`.
    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    /// @notice Return the current router-eligibility flag for `vault`.
    ///         Returns `false` for unregistered vaults and for registered
    ///         vaults that have not been opted in by `setRouterEligible`.
    /// @param vault Address of the vault to query.
    /// @return eligible True iff governance has marked the vault as
    ///                  router-eligible.
    function isRouterEligible(address vault) external view returns (bool eligible) {
        return _routerEligible[vault];
    }
}
