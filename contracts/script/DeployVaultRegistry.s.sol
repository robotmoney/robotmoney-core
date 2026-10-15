// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2, §10 — Vault Registry
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {VaultRegistry} from "../VaultRegistry.sol";
import {UpgradeAuthority} from "./UpgradeAuthority.sol";
import {RMUSDC_VAULT_NAME} from "./DeployVault.s.sol";

/// @title DeployVaultRegistry
/// @notice Foundry deploy script for the VaultRegistry contract.
///         Deploys VaultRegistry and registers RobotMoneyVault as an Active vault.
///         Idempotent: if the vault is already registered the registration step
///         is skipped without reverting.
///
///         The deployed registry address is written to the manifest at
///         DEPLOYMENT_OUT so rmpc and the dapp discover it without manual editing.
///
///         Required env vars:
///           ADMIN_ADDRESS    — receives ADMIN_ROLE on the registry
///           VAULT_ADDRESS    — RobotMoneyVault to register
///         The registered name is RMUSDC_VAULT_NAME (DeployVault.s.sol), a script constant like each basket
///         script's VAULT_NAME (issue 1705 C9: one registry-name source for all four vaults).
///         USDC is the canonical Base USDC constant on every chain.
///         Also required: DEPLOYMENT_OUT (output JSON path), EXPECTED_CHAIN_ID
///         (mandatory and equal to 8453 on Base mainnet).
///         SAFE_ADDRESS, TIMELOCK_MIN_DELAY, UPGRADE_MODE: the upgrade authority and release mode
///         of the registry proxy (`UpgradeAuthority`, issue 1808). The manifest `registry` is the
///         ERC-1967 proxy; `registry_implementation` is its implementation.
contract DeployVaultRegistry is UpgradeAuthority {
    /// @dev Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "registry.json";

    using stdJson for string;

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    struct Deployed {
        VaultRegistry registry;
        address admin;
        address vault;
        address asset;
        bool registered;
        address registryImplementation;
        UpgradeConfig upgrade;
    }

    /// @notice Forge broadcast entrypoint. Reads env vars, deploys registry,
    ///         registers the vault (idempotently), and writes a deployment JSON.
    ///
    ///         In broadcast mode the broadcaster IS admin (the deployer signs
    ///         the broadcast), so msg.sender on
    ///         registerVault holds ADMIN_ROLE. No vm.prank is needed or allowed.
    /// @return d Struct containing the deployed registry and key parameters.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        address admin = _envAddressRequired("ADMIN_ADDRESS");
        address vault = _envAddressRequired("VAULT_ADDRESS");
        address asset = BASE_USDC;
        string memory vaultName = RMUSDC_VAULT_NAME;
        // The registry stores these two addresses without reading them; a wrong-chain
        // or mistyped address would register a vault with no code behind it.
        require(vault.code.length > 0, "VAULT_ADDRESS has no code on this chain");
        require(asset.code.length > 0, "USDC_ADDRESS has no code on this chain");

        UpgradeConfig memory u = _readUpgradeConfig("");

        vm.startBroadcast();
        _deployRegistry(d, admin, u);
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

        _deployRegistry(d, admin_, _inProcessUpgradeConfig());
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

    /// @dev Deploy the registry implementation and its ERC-1967 proxy, initialized atomically.
    function _deployRegistry(Deployed memory d, address admin_, UpgradeConfig memory u) internal {
        d.upgrade = u;
        d.registryImplementation = address(new VaultRegistry());
        d.registry = VaultRegistry(
            _deployProxy(
                d.registryImplementation,
                abi.encodeCall(VaultRegistry.initialize, (admin_, u.timelock, u.mode))
            )
        );
    }

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

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");

        string memory obj = "registry_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "registry", address(d.registry));
        vm.serializeAddress(obj, "registry_implementation", d.registryImplementation);
        vm.serializeAddress(obj, "upgrade_timelock", d.upgrade.timelock);
        vm.serializeString(obj, "upgrade_mode", upgradeModeName(d.upgrade.mode));
        vm.serializeAddress(obj, "admin", d.admin);
        vm.serializeAddress(obj, "vault", d.vault);
        vm.serializeAddress(obj, "asset", d.asset);
        string memory json = vm.serializeBool(obj, "vault_registered", d.registered);

        vm.writeJson(json, outPath);
        console2.log("Wrote registry deployment JSON to", outPath);
    }
}
