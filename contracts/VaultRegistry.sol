// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2, §10 — Vault Registry
// (See also: docs/prd.md §11 — Vault Catalog)
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

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
contract VaultRegistry is AccessControl {
    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Grants/revokes other roles, registers vaults, changes vault status.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Vault status ────────────────────────────────────────────────────────

    /// @notice Lifecycle status of a registered vault.
    enum VaultStatus {
        Active,
        Paused,
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

    // ─── Errors ──────────────────────────────────────────────────────────────

    /// @notice Vault address argument is `address(0)`.
    error ZeroAddress();

    /// @notice Vault address is already registered.
    error AlreadyRegistered();

    /// @notice Vault address is not registered; `getVault` and `setVaultStatus`
    ///         revert with this error when the address is unknown.
    error NotRegistered();

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

    /// @notice Update a vault's lifecycle status. Restricted to `ADMIN_ROLE`.
    /// @param vault      Address of an already-registered vault.
    /// @param newStatus  New lifecycle status (Active, Paused, or Retired).
    function setVaultStatus(address vault, VaultStatus newStatus) external onlyRole(ADMIN_ROLE) {
        if (!_registered[vault]) revert NotRegistered();
        _status[vault] = newStatus;
        emit VaultStatusChanged(vault, newStatus, block.timestamp);
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
}
