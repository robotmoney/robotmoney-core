// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (basket vault production path)
//            docs/prd.md §11.2, §11.3, §11.4 — rmPROTO, rmAGENT, rmRWA
//            robotmoney/devops issue 53 / core issue 1499, stage 13 step 4, core S4 (1486)
//
// Standalone eligibility step for the three basket vaults. NOT a stage and NOT a govern row (issue 1520): the basket vault stages now flip
// eligibility themselves, before the timelock handover, and govern carries the basket unpauses only. This script remains for a deployer that holds
// ADMIN_ROLE on the registry and wants the flips outside the stages. It uses `registry.migrateEligibility`
// once per basket. That call flips eligibility and re-sets the router default weight vector in
// one transaction. The separate setters deadlock with `StaleDefaultWeightsLength` once a default
// vector exists: `setRouterEligible` needs the vector to match the new count, and
// `PortfolioRouter.setDefaultWeights` needs the count to have moved already.
//
// The vector written here is equal weight over the eligible set. It is a placeholder that keeps the
// length invariant at each step. Stage 13 step 5 sets the real router default weights next.
//
// The broadcaster must hold ADMIN_ROLE on the registry. On Base mainnet that is the timelock, so
// the stage driver encodes these calls as timelock operations. The registry needs a linked router.
pragma solidity ^0.8.24;

import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";
import {console2} from "forge-std/console2.sol";

import {VaultRegistry} from "../VaultRegistry.sol";

/// @title ActivateBasketVaultEligibility
/// @notice Makes `ProtocolAssetVault` (rmPROTO), `AgentTokenVault` (rmAGENT) and
///         `RwaBasketVault` (rmRWA) router-eligible, one atomic `migrateEligibility` each.
///
///         Required env vars:
///           EXPECTED_CHAIN_ID       mandatory and equal to 8453 on Base mainnet
///           REGISTRY_ADDRESS        deployed VaultRegistry, router already linked
///           PROTOCOL_VAULT_ADDRESS  rmPROTO
///           AGENT_VAULT_ADDRESS     rmAGENT
///           RWA_VAULT_ADDRESS       rmRWA
contract ActivateBasketVaultEligibility is ExpectedChainGuard {
    uint256 internal constant BPS = 10_000;

    /// @notice Result returned to in-process callers (e.g. forge tests).
    struct Activated {
        address protocolVault;
        address agentVault;
        address rwaVault;
        address registry;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Activated memory a) {
        _requireExpectedChain("");

        address registry = _envAddressRequired("REGISTRY_ADDRESS");
        address protocolVault = _envAddressRequired("PROTOCOL_VAULT_ADDRESS");
        address agentVault = _envAddressRequired("AGENT_VAULT_ADDRESS");
        address rwaVault = _envAddressRequired("RWA_VAULT_ADDRESS");

        require(registry != address(0), "REGISTRY_ADDRESS=0");
        require(protocolVault != address(0), "PROTOCOL_VAULT_ADDRESS=0");
        require(agentVault != address(0), "AGENT_VAULT_ADDRESS=0");
        require(rwaVault != address(0), "RWA_VAULT_ADDRESS=0");

        vm.startBroadcast();
        a = _activate(VaultRegistry(registry), protocolVault, agentVault, rwaVault);
        vm.stopBroadcast();

        console2.log("ActivateBasketVaultEligibility complete");
        console2.log("  protocolVault router-eligible:", protocolVault);
        console2.log("  agentVault    router-eligible:", agentVault);
        console2.log("  rwaVault      router-eligible:", rwaVault);
    }

    /// @notice In-process variant for forge tests. No broadcast. The caller context must hold
    ///         ADMIN_ROLE on the registry (the test grants it to this script or pranks).
    function runInProcessWith(
        address registry_,
        address protocolVault_,
        address agentVault_,
        address rwaVault_
    ) external returns (Activated memory a) {
        require(registry_ != address(0), "registry=0");
        require(protocolVault_ != address(0), "protocolVault=0");
        require(agentVault_ != address(0), "agentVault=0");
        require(rwaVault_ != address(0), "rwaVault=0");

        return _activate(VaultRegistry(registry_), protocolVault_, agentVault_, rwaVault_);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _activate(
        VaultRegistry registry,
        address protocolVault,
        address agentVault,
        address rwaVault
    ) internal returns (Activated memory a) {
        require(
            address(registry.router()) != address(0),
            "registry has no linked router: link it at stage 4 first"
        );
        _migrate(registry, protocolVault);
        _migrate(registry, agentVault);
        _migrate(registry, rwaVault);
        a.protocolVault = protocolVault;
        a.agentVault = agentVault;
        a.rwaVault = rwaVault;
        a.registry = address(registry);
    }

    /// @dev One atomic flip. The new default vector is the current eligible set in registry order,
    ///      then `vault`, at equal weight (the remainder goes to the first leg). Skips a vault that
    ///      is already eligible so a rerun is safe.
    function _migrate(VaultRegistry registry, address vault) internal {
        if (registry.isRouterEligible(vault)) return;

        address[] memory listed = registry.listVaults();
        uint256 count;
        for (uint256 i = 0; i < listed.length; i++) {
            if (registry.isRouterEligible(listed[i])) count++;
        }
        address[] memory vaults = new address[](count + 1);
        uint256 k;
        for (uint256 i = 0; i < listed.length; i++) {
            if (registry.isRouterEligible(listed[i])) vaults[k++] = listed[i];
        }
        vaults[k] = vault;

        uint256 n = vaults.length;
        uint256[] memory bps = new uint256[](n);
        uint256 each = BPS / n;
        for (uint256 i = 0; i < n; i++) {
            bps[i] = each;
        }
        bps[0] += BPS - each * n;

        registry.migrateEligibility(vault, true, vaults, bps);
    }
}
