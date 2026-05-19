// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2 — Portfolio Router
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";

/// @title DeployPortfolioRouter
/// @notice Foundry deploy script for the PortfolioRouter contract.
///         Deploys PortfolioRouter, sets initial weights (10 000 bps to
///         RobotMoneyVault — the sole active vault), and writes the router
///         address to a deployment JSON alongside the registry address.
///
///         The smoke-test devnet startup sequence runs this script so that
///         `rmpc get-router` and the dapp router view return real data in CI.
///
///         Required env vars:
///           ADMIN_ADDRESS      — receives ADMIN_ROLE on the router
///           REGISTRY_ADDRESS   — deployed VaultRegistry address
///           VAULT_ADDRESS      — RobotMoneyVault (sole active vault, 10 000 bps)
///           USDC_ADDRESS       — ERC-20 asset the router accepts
///
///         Optional env vars:
///           DEPLOYMENT_OUT     — path for the output JSON
///                                (default: "deployments/router-<chain_id>.json")
contract DeployPortfolioRouter is Script {
    using stdJson for string;

    /// @notice BPS weight assigned to RobotMoneyVault as the sole active vault.
    uint256 public constant INITIAL_VAULT_WEIGHT_BPS = 10_000;

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    struct Deployed {
        PortfolioRouter router;
        VaultRegistry registry;
        address admin;
        address vault;
        address usdc;
    }

    /// @notice Forge broadcast entrypoint. Reads env vars, deploys the router,
    ///         sets initial weights, and writes a deployment JSON.
    ///
    ///         In broadcast mode the broadcaster IS admin (the smoke-test devnet
    ///         runs the script with the admin private key), so msg.sender on
    ///         setWeights holds ADMIN_ROLE. No vm.prank is needed or allowed.
    /// @return d Struct containing the deployed router and key parameters.
    function run() external returns (Deployed memory d) {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address registry = vm.envAddress("REGISTRY_ADDRESS");
        address vault = vm.envAddress("VAULT_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");

        vm.startBroadcast();
        d = _deploy(admin, registry, vault, usdc);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    ///         setWeights requires ADMIN_ROLE; this method pranks admin.
    /// @param admin_     Address to receive ADMIN_ROLE.
    /// @param registry_  Deployed VaultRegistry address.
    /// @param vault_     RobotMoneyVault to seed with 10 000 bps.
    /// @param usdc_      ERC-20 asset the router accepts.
    /// @return d Struct containing the deployed router and key parameters.
    function runInProcessWith(address admin_, address registry_, address vault_, address usdc_)
        external
        returns (Deployed memory d)
    {
        require(admin_ != address(0), "ADMIN_ADDRESS=0");
        require(registry_ != address(0), "REGISTRY_ADDRESS=0");
        require(vault_ != address(0), "VAULT_ADDRESS=0");
        require(usdc_ != address(0), "USDC_ADDRESS=0");

        vm.startPrank(admin_);
        d = _deploy(admin_, registry_, vault_, usdc_);
        vm.stopPrank();

        _logResult(d);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    /// @dev Deploy router and set initial weights. Caller must ensure ADMIN_ROLE
    ///      is active on the call context (broadcast or prank).
    function _deploy(address admin_, address registry_, address vault_, address usdc_)
        internal
        returns (Deployed memory d)
    {
        d.registry = VaultRegistry(registry_);
        d.admin = admin_;
        d.vault = vault_;
        d.usdc = usdc_;

        d.router = new PortfolioRouter(usdc_, registry_, admin_);

        // Issue #447 attestation gate: RobotMoneyVault does not implement
        // `IPrototypeAware.isPrototype()`, so the router would reject it
        // from setWeights with `VaultEligibilityNotAttested` unless we
        // explicitly attest it here. The attestation makes the trust
        // decision auditable on-chain instead of relying on the silent
        // try/catch fall-through that the audit flagged as MEDIUM.
        d.router.setNonPrototypeAttested(vault_, true);

        // Set initial weights: 10 000 bps (100%) to RobotMoneyVault.
        address[] memory vaults = new address[](1);
        vaults[0] = vault_;
        uint256[] memory bps = new uint256[](1);
        bps[0] = INITIAL_VAULT_WEIGHT_BPS;
        d.router.setWeights(vaults, bps);
    }

    function _logResult(Deployed memory d) internal view {
        console2.log("PortfolioRouter deployed and configured");
        console2.log("  router    :", address(d.router));
        console2.log("  registry  :", address(d.registry));
        console2.log("  admin     :", d.admin);
        console2.log("  vault     :", d.vault);
        console2.log("  usdc      :", d.usdc);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath;
        try vm.envString("DEPLOYMENT_OUT") returns (string memory s) {
            outPath = s;
        } catch {
            outPath = string.concat("deployments/router-", vm.toString(block.chainid), ".json");
        }

        string memory obj = "router_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "router", address(d.router));
        vm.serializeAddress(obj, "registry", address(d.registry));
        vm.serializeAddress(obj, "admin", d.admin);
        vm.serializeAddress(obj, "vault", d.vault);
        string memory json = vm.serializeAddress(obj, "usdc", d.usdc);

        vm.writeJson(json, outPath);
        console2.log("Wrote router deployment JSON to", outPath);
    }
}
