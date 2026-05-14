// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2, §10 — Vault Registry
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {VaultRegistry} from "../VaultRegistry.sol";

/// @title DeployVaultRegistry
/// @notice Foundry deploy script for the VaultRegistry contract.
///         Deploys VaultRegistry and registers RobotMoneyVault as an Active vault.
///         Idempotent: if the vault is already registered the registration step
///         is skipped without reverting.
///
///         The deployed registry address is appended to the shared devnet
///         deployment JSON so rmpc and the dapp can discover it without
///         manual editing.
///
///         Required env vars:
///           ADMIN_ADDRESS    — receives ADMIN_ROLE on the registry
///           VAULT_ADDRESS    — RobotMoneyVault to register
///           USDC_ADDRESS     — ERC-20 asset the vault denominates in
///
///         Optional env vars:
///           VAULT_NAME       — human-readable vault name
///                              (default: "Robot Money USDC")
///           DEPLOYMENT_OUT   — path for the output JSON
///                              (default: "deployments/registry-<chain_id>.json")
contract DeployVaultRegistry is Script {
    using stdJson for string;

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    struct Deployed {
        VaultRegistry registry;
        address admin;
        address vault;
        address asset;
        bool registered;
    }

    /// @notice Default vault name used when VAULT_NAME env var is unset.
    string public constant DEFAULT_VAULT_NAME = "Robot Money USDC";

    /// @notice Forge broadcast entrypoint. Reads env vars, deploys registry,
    ///         registers the vault (idempotently), and writes a deployment JSON.
    ///
    ///         In broadcast mode the broadcaster IS admin (the smoke-test devnet
    ///         runs the script with the admin private key), so msg.sender on
    ///         registerVault holds ADMIN_ROLE. No vm.prank is needed or allowed.
    /// @return d Struct containing the deployed registry and key parameters.
    function run() external returns (Deployed memory d) {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address vault = vm.envAddress("VAULT_ADDRESS");
        address asset = vm.envAddress("USDC_ADDRESS");
        string memory vaultName = _envStringOrDefault("VAULT_NAME", DEFAULT_VAULT_NAME);

        vm.startBroadcast();
        d.registry = new VaultRegistry(admin);
        d.admin = admin;
        d.vault = vault;
        d.asset = asset;
        // registerVault: broadcaster IS admin in broadcast mode — no prank needed.
        d.registered = _registerIfAbsent(d.registry, vault, asset, vaultName);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    ///         registerVault requires ADMIN_ROLE; this method pranks admin.
    /// @param admin_     Address to receive ADMIN_ROLE.
    /// @param vault_     RobotMoneyVault to register.
    /// @param asset_     ERC-20 asset the vault denominates in.
    /// @param vaultName_ Human-readable vault name.
    /// @return d Struct containing the deployed registry and key parameters.
    function runInProcessWith(
        address admin_,
        address vault_,
        address asset_,
        string memory vaultName_
    ) external returns (Deployed memory d) {
        require(admin_ != address(0), "ADMIN_ADDRESS=0");
        require(vault_ != address(0), "VAULT_ADDRESS=0");
        require(asset_ != address(0), "USDC_ADDRESS=0");

        d.registry = new VaultRegistry(admin_);
        d.admin = admin_;
        d.vault = vault_;
        d.asset = asset_;

        // registerVault requires ADMIN_ROLE which is held by admin_.
        // startPrank/stopPrank ensures the role is active across both the
        // listVaults view call and the registerVault state-change call inside
        // _registerIfAbsent (vm.prank only covers the next external call).
        vm.startPrank(admin_);
        d.registered = _registerIfAbsent(d.registry, vault_, asset_, vaultName_);
        vm.stopPrank();

        _logResult(d);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    /// @dev Register `vault` if it is not already in the registry.
    ///      Returns true if registration happened, false if already present.
    ///      Caller must ensure the call context holds ADMIN_ROLE.
    function _registerIfAbsent(
        VaultRegistry registry,
        address vault,
        address asset,
        string memory vaultName
    ) internal returns (bool registered) {
        address[] memory existing = registry.listVaults();
        for (uint256 i = 0; i < existing.length; i++) {
            if (existing[i] == vault) {
                console2.log("DeployVaultRegistry: vault already registered, skipping");
                return false;
            }
        }
        registry.registerVault(
            vault, VaultRegistry.VaultMetadata({name: vaultName, asset: asset, registeredAt: 0})
        );
        return true;
    }

    function _logResult(Deployed memory d) internal view {
        console2.log("VaultRegistry deployed and configured");
        console2.log("  registry  :", address(d.registry));
        console2.log("  admin     :", d.admin);
        console2.log("  vault     :", d.vault);
        console2.log("  asset     :", d.asset);
        console2.log("  registered:", d.registered);
    }

    function _envStringOrDefault(string memory key, string memory fallback_)
        internal
        view
        returns (string memory)
    {
        try vm.envString(key) returns (string memory v) {
            if (bytes(v).length > 0) return v;
            return fallback_;
        } catch {
            return fallback_;
        }
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath;
        try vm.envString("DEPLOYMENT_OUT") returns (string memory s) {
            outPath = s;
        } catch {
            outPath = string.concat("deployments/registry-", vm.toString(block.chainid), ".json");
        }

        string memory obj = "registry_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "registry", address(d.registry));
        vm.serializeAddress(obj, "admin", d.admin);
        vm.serializeAddress(obj, "vault", d.vault);
        vm.serializeAddress(obj, "asset", d.asset);
        string memory json = vm.serializeBool(obj, "vault_registered", d.registered);

        vm.writeJson(json, outPath);
        console2.log("Wrote registry deployment JSON to", outPath);
    }
}
