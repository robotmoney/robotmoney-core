// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2 — Portfolio Router
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";

/// @title DeployPortfolioRouter
/// @notice Foundry deploy script for the PortfolioRouter contract.
///         Stage 4 of the core deploy (libs, vault, registry, router, gateway).
///         Deploys PortfolioRouter, sets the initial DEFAULT weights (10 000 bps to
///         RobotMoneyVault — the sole active vault; no voted vector), calls `registry.setRouter(router)`,
///         and writes the router address to a deployment JSON alongside the registry
///         address. The router comes BEFORE the gateway: the gateway stores the router as
///         an immutable (core 1493).
///
///         The stage driver runs this script on every chain so that
///         `rmpc get-router` and the dapp router view return real data.
///
///         Required env vars:
///           ADMIN_ADDRESS      — receives ADMIN_ROLE and WEIGHT_SETTER_ROLE on the router
///           REGISTRY_ADDRESS   — deployed VaultRegistry address
///           VAULT_ADDRESS      — RobotMoneyVault (sole active vault, 10 000 bps)
///
///         USDC is the canonical Base USDC constant on every chain.
///         Also required: DEPLOYMENT_OUT (output JSON path), EXPECTED_CHAIN_ID
///         (mandatory and equal to 8453 on Base mainnet).
contract DeployPortfolioRouter is ExpectedChainGuard {
    /// @dev Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "router.json";

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
    ///         In broadcast mode the broadcaster IS admin (the deployer signs
    ///         the broadcast), so msg.sender on
    ///         setDefaultWeights holds ADMIN_ROLE. No vm.prank is needed or allowed.
    /// @return d Struct containing the deployed router and key parameters.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        address admin = _envAddressRequired("ADMIN_ADDRESS");
        address registry = _envAddressRequired("REGISTRY_ADDRESS");
        address vault = _envAddressRequired("VAULT_ADDRESS");
        address usdc = BASE_USDC;
        require(registry.code.length > 0, "REGISTRY_ADDRESS has no code on this chain");
        require(vault.code.length > 0, "VAULT_ADDRESS has no code on this chain");
        require(usdc.code.length > 0, "USDC_ADDRESS has no code on this chain");

        vm.startBroadcast();
        d = _deploy(admin, registry, vault, usdc);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    ///         setDefaultWeights requires ADMIN_ROLE; this method pranks admin.
    /// @param admin_     Address to receive ADMIN_ROLE and WEIGHT_SETTER_ROLE.
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

    /// @dev Deploy router and set initial weights. Caller must ensure ADMIN_ROLE and WEIGHT_SETTER_ROLE
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

        // Single registry-backed eligibility gate (issue #475): mark the
        // vault router-eligible in the VaultRegistry. PortfolioRouter
        // refuses to weight or deposit into a vault whose registry
        // eligibility flag is false. Same contracts every environment —
        // only the registry flag differs. See
        // docs/development/single-production-codebase.md.
        d.registry.setRouterEligible(vault_, true);

        // Initial weights: 10 000 bps (100%) to RobotMoneyVault, on the DEFAULT vector (ADMIN_ROLE,
        // held by the deployer here; the registry has no router linked yet, so the eligible count is 1).
        // NEVER `setWeights`: that writes the voted vector and flips `votedWeightsActive`, which then
        // overrides every later default (the basket stages' migrateEligibility, a receipt-driven
        // setDefaultWeights) so the sheet launch vector would never be the effective routing (issue 1743).
        address[] memory vaults = new address[](1);
        vaults[0] = vault_;
        uint256[] memory bps = new uint256[](1);
        bps[0] = INITIAL_VAULT_WEIGHT_BPS;
        d.router.setDefaultWeights(vaults, bps);
        require(!d.router.votedWeightsActive(), "voted weights active after the router stage");

        // Link the router into the registry at the router stage (core S3). This is the one
        // and only `registry.setRouter` call of the deploy: the gateway stage that follows
        // takes this router as its immutable, and the timelock stage hands the registry over
        // with the link already in place. Eligibility was set above, before the link, so the
        // registry's stale-default-length guard is inactive.
        d.registry.setRouter(address(d.router));
        require(address(d.registry.router()) == address(d.router), "registry.router != router");
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
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");

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
