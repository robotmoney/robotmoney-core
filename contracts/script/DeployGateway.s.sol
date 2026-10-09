// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499 — core S3, stage "gateway"
// (See also: docs/architecture.md §6 — Roles)
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";

/// @title DeployGateway
/// @notice Stage 5 of the core deploy (libs, vault, registry, router, gateway).
///         Deploys RobotMoneyGateway bound to the vault AND the router, asserts
///         `gateway.router()` is the deployed router and not zero. The deploy authorizes no
///         agent: an agent belongs to a depositor, who authorizes it through commitAuthorization
///         and revealAuthorization (architecture 5.2 and 6.3). The router must exist first: the gateway stores it as an immutable,
///         so a gateway deployed with a zero router can never route (core 1493).
///
///         The IC policy and the consensus receipt bind the gateway address, so they run in
///         their own stage AFTER this one (`DeployInvestmentCommitteePolicy`).
///
/// @dev Required env vars (all required on every chain, no defaults):
///        EXPECTED_CHAIN_ID     — mandatory and equal to 8453 on Base mainnet
///        ADMIN_ADDRESS         — receives DEFAULT_ADMIN_ROLE + ADMIN_ROLE
///        PAUSER_ADDRESS        — receives DEPOSIT_PAUSER_ROLE (must differ from ADMIN)
///        SHARE_RECEIVER_ADDRESS — recipient of minted rmUSDC shares
///        VAULT_ADDRESS         — the rmUSDC RobotMoneyVault
///        ROUTER_ADDRESS        — the PortfolioRouter from the router stage, non-zero
///        DEPLOYMENT_OUT        — output JSON path
///      USDC is the canonical Base USDC constant on every chain.
contract DeployGateway is ExpectedChainGuard {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "gateway.json";

    struct Params {
        address admin;
        address pauser;
        address shareReceiver;
        address vault;
        address router;
        address usdcAddress;
    }

    struct Deployed {
        RobotMoneyGateway gateway;
        address usdc;
        address vault;
        address router;
        address admin;
        address pauser;
        address shareReceiver;
        bytes32 gatewayRuntimeHash;
    }

    /// @notice Forge broadcast entrypoint.
    /// @return d The deployed gateway and its wiring.
    function run() external returns (Deployed memory d) {
        Params memory p = _readEnvParamsFrom("");
        vm.startBroadcast();
        d = _deployGateway(p);
        vm.stopBroadcast();
        _writeDeploymentJson(d);
    }

    /// @notice In-process variant, env-driven.
    /// @return d The deployed gateway and its wiring.
    function runInProcess() external returns (Deployed memory d) {
        Params memory p = _readEnvParamsFrom("");
        d = _deployGateway(p);
    }

    /// @notice Direct-parameter variant for forge tests. Skips env resolution.
    /// @param admin_ Gateway admin.
    /// @param pauser_ Address granted the pauser role.
    /// @param shareReceiver_ Address that receives vault shares.
    /// @param usdc_ USDC token address.
    /// @param vault_ Robot Money vault address.
    /// @param router_ Router address the gateway may call.
    /// @return d The deployed gateway and its wiring.
    function runInProcessWith(
        address admin_,
        address pauser_,
        address shareReceiver_,
        address usdc_,
        address vault_,
        address router_
    ) external returns (Deployed memory d) {
        Params memory p;
        p.admin = admin_;
        p.pauser = pauser_;
        p.shareReceiver = shareReceiver_;
        p.vault = vault_;
        p.router = router_;
        p.usdcAddress = usdc_;
        d = _deployGateway(p);
    }

    /// @dev `prefix` is "" in production. Tests pass their own prefix because env vars are
    ///      process-wide and forge runs tests in parallel.
    function _readEnvParamsFrom(string memory prefix) internal view returns (Params memory p) {
        _requireExpectedChain(prefix);
        p.admin = _envAddressRequired(string.concat(prefix, "ADMIN_ADDRESS"));
        p.pauser = _envAddressRequired(string.concat(prefix, "PAUSER_ADDRESS"));
        p.shareReceiver = _envAddressRequired(string.concat(prefix, "SHARE_RECEIVER_ADDRESS"));
        p.vault = _envAddressRequired(string.concat(prefix, "VAULT_ADDRESS"));
        p.router = _envAddressRequired(string.concat(prefix, "ROUTER_ADDRESS"));
        p.usdcAddress = BASE_USDC;
    }

    function _deployGateway(Params memory p) internal returns (Deployed memory d) {
        d.admin = p.admin;
        d.pauser = p.pauser;
        d.shareReceiver = p.shareReceiver;

        require(d.admin != address(0), "ADMIN_ADDRESS=0");
        require(d.pauser != address(0), "PAUSER_ADDRESS=0");
        require(d.shareReceiver != address(0), "SHARE_RECEIVER_ADDRESS=0");
        // Distinctness is a deploy-time precondition. AccessRoles enforces it on chain too,
        // but failing fast gives a better operator message.
        require(d.admin != d.pauser, "ADMIN==PAUSER");

        require(p.usdcAddress != address(0), "USDC_ADDRESS=0");
        require(p.usdcAddress.code.length > 0, "USDC_ADDRESS has no code");
        require(p.vault != address(0), "VAULT_ADDRESS=0");
        require(p.vault.code.length > 0, "VAULT_ADDRESS has no code on this chain");
        require(p.router != address(0), "ROUTER_ADDRESS=0");
        require(p.router.code.length > 0, "ROUTER_ADDRESS has no code on this chain");
        d.usdc = p.usdcAddress;
        d.vault = p.vault;
        d.router = p.router;

        d.gateway =
            new RobotMoneyGateway(IERC20(d.usdc), IERC4626(d.vault), d.admin, d.pauser, d.router);

        // The core 1493 defect, closed: the immutable router must be the one the router
        // stage deployed, and never zero.
        require(d.gateway.router() != address(0), "gateway.router is zero");
        require(d.gateway.router() == d.router, "gateway.router != ROUTER_ADDRESS");

        // Pin the gateway runtime hash.
        d.gatewayRuntimeHash = keccak256(address(d.gateway).code);

        console2.log("RobotMoneyGateway deployed with the router");
        console2.log("  gateway          :", address(d.gateway));
        console2.log("  router           :", d.router);
        console2.log("  vault            :", d.vault);
        console2.log("  admin            :", d.admin);
        console2.log("  pauser           :", d.pauser);
        console2.log("  shareReceiver    :", d.shareReceiver);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");

        string memory obj = "gateway_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "usdc", d.usdc);
        vm.serializeAddress(obj, "vault", d.vault);
        vm.serializeAddress(obj, "gateway", address(d.gateway));
        vm.serializeAddress(obj, "gateway_router", d.router);
        vm.serializeAddress(obj, "admin", d.admin);
        vm.serializeAddress(obj, "pauser", d.pauser);
        vm.serializeAddress(obj, "share_receiver", d.shareReceiver);
        string memory json = vm.serializeBytes32(obj, "gateway_runtime_hash", d.gatewayRuntimeHash);

        vm.writeJson(json, outPath);
        console2.log("Wrote gateway deployment JSON to", outPath);
    }
}
