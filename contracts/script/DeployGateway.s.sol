// SPDX-License-Identifier: MIT
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops) — core S3, stage "gateway"
// (See also: docs/architecture.md §6 — Roles)
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";

/// @title DeployGateway
/// @notice Stage 5 of the core deploy (libs, vault, registry, router, gateway).
///         Deploys RobotMoneyGateway bound to the vault AND the router, asserts
///         `gateway.router()` is the deployed router and not zero, then authorizes the
///         deploy agent. The router must exist first: the gateway stores it as an immutable,
///         so a gateway deployed with a zero router can never route (core 1493).
///
///         The IC policy and the consensus receipt bind the gateway address, so they run in
///         their own stage AFTER this one (`DeployInvestmentCommitteePolicy`).
///
/// @dev Required env vars (all required on every chain, no defaults):
///        EXPECTED_CHAIN_ID     — mandatory and equal to 8453 on Base mainnet
///        ADMIN_ADDRESS         — receives DEFAULT_ADMIN_ROLE + ADMIN_ROLE
///        PAUSER_ADDRESS        — receives PAUSER_ROLE (must differ from ADMIN)
///        AGENT_ADDRESS         — receives AGENT_ROLE  (must differ from both)
///        SHARE_RECEIVER_ADDRESS — recipient of minted rmUSDC shares
///        VAULT_ADDRESS         — the rmUSDC RobotMoneyVault
///        ROUTER_ADDRESS        — the PortfolioRouter from the router stage, non-zero
///        AGENT_VALID_UNTIL, AGENT_MAX_PER_PAYMENT, AGENT_MAX_PER_WINDOW,
///        AGENT_MAX_WITHDRAW_PER_PAYMENT, AGENT_MAX_WITHDRAW_PER_WINDOW — agent policy
///        DEPLOYMENT_OUT        — output JSON path
///      USDC is the canonical Base USDC constant on every chain.
contract DeployGateway is ExpectedChainGuard {
    /// @notice In-process test seam defaults. Env runs require every agent cap.
    uint256 public constant DEFAULT_MAX_PER_PAYMENT = 10_000 * 1e6;
    uint256 public constant DEFAULT_MAX_PER_WINDOW = 100_000 * 1e6;
    uint256 public constant DEFAULT_MAX_WITHDRAW_PER_PAYMENT = 10_000 * 1e6;
    uint256 public constant DEFAULT_MAX_WITHDRAW_PER_WINDOW = 100_000 * 1e6;
    uint64 public constant DEFAULT_VALID_UNTIL_OFFSET = 30 days;

    struct Params {
        address admin;
        address pauser;
        address agent;
        address shareReceiver;
        address vault;
        address router;
        uint64 validUntil;
        uint256 maxPerPayment;
        uint256 maxPerWindow;
        uint256 maxWithdrawPerPayment;
        uint256 maxWithdrawPerWindow;
        address usdcAddress;
    }

    struct Deployed {
        RobotMoneyGateway gateway;
        address usdc;
        address vault;
        address router;
        address admin;
        address pauser;
        address agent;
        address shareReceiver;
        bytes32 gatewayRuntimeHash;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        Params memory p = _readEnvParamsFrom("");
        vm.startBroadcast();
        d = _deployGateway(p);
        // Agent authorization comes after the gateway. The broadcaster IS d.admin and holds
        // DEFAULT_ADMIN_ROLE, so no prank is needed or allowed.
        _authorizeDeployAgent(d, p);
        vm.stopBroadcast();
        _writeDeploymentJson(d);
    }

    /// @notice In-process variant, env-driven. Pranks the admin for the authorization.
    function runInProcess() external returns (Deployed memory d) {
        Params memory p = _readEnvParamsFrom("");
        d = _deployGateway(p);
        vm.startPrank(d.admin);
        _authorizeDeployAgent(d, p);
        vm.stopPrank();
    }

    /// @notice Direct-parameter variant for forge tests. Skips env resolution.
    function runInProcessWith(
        address admin_,
        address pauser_,
        address agent_,
        address shareReceiver_,
        address usdc_,
        address vault_,
        address router_
    ) external returns (Deployed memory d) {
        Params memory p;
        p.admin = admin_;
        p.pauser = pauser_;
        p.agent = agent_;
        p.shareReceiver = shareReceiver_;
        p.vault = vault_;
        p.router = router_;
        p.validUntil = uint64(block.timestamp + DEFAULT_VALID_UNTIL_OFFSET);
        p.maxPerPayment = DEFAULT_MAX_PER_PAYMENT;
        p.maxPerWindow = DEFAULT_MAX_PER_WINDOW;
        p.maxWithdrawPerPayment = DEFAULT_MAX_WITHDRAW_PER_PAYMENT;
        p.maxWithdrawPerWindow = DEFAULT_MAX_WITHDRAW_PER_WINDOW;
        p.usdcAddress = usdc_;
        d = _deployGateway(p);
        vm.startPrank(d.admin);
        _authorizeDeployAgent(d, p);
        vm.stopPrank();
    }

    /// @dev `prefix` is "" in production. Tests pass their own prefix because env vars are
    ///      process-wide and forge runs tests in parallel.
    function _readEnvParamsFrom(string memory prefix) internal view returns (Params memory p) {
        _requireExpectedChain(prefix);
        p.admin = _envAddressRequired(string.concat(prefix, "ADMIN_ADDRESS"));
        p.pauser = _envAddressRequired(string.concat(prefix, "PAUSER_ADDRESS"));
        p.agent = _envAddressRequired(string.concat(prefix, "AGENT_ADDRESS"));
        p.shareReceiver = _envAddressRequired(string.concat(prefix, "SHARE_RECEIVER_ADDRESS"));
        p.vault = _envAddressRequired(string.concat(prefix, "VAULT_ADDRESS"));
        p.router = _envAddressRequired(string.concat(prefix, "ROUTER_ADDRESS"));
        p.validUntil = uint64(_envUintRequired(string.concat(prefix, "AGENT_VALID_UNTIL")));
        p.maxPerPayment = _envUintRequired(string.concat(prefix, "AGENT_MAX_PER_PAYMENT"));
        p.maxPerWindow = _envUintRequired(string.concat(prefix, "AGENT_MAX_PER_WINDOW"));
        p.maxWithdrawPerPayment =
            _envUintRequired(string.concat(prefix, "AGENT_MAX_WITHDRAW_PER_PAYMENT"));
        p.maxWithdrawPerWindow =
            _envUintRequired(string.concat(prefix, "AGENT_MAX_WITHDRAW_PER_WINDOW"));
        p.usdcAddress = BASE_USDC;
    }

    function _deployGateway(Params memory p) internal returns (Deployed memory d) {
        d.admin = p.admin;
        d.pauser = p.pauser;
        d.agent = p.agent;
        d.shareReceiver = p.shareReceiver;

        require(d.admin != address(0), "ADMIN_ADDRESS=0");
        require(d.pauser != address(0), "PAUSER_ADDRESS=0");
        require(d.agent != address(0), "AGENT_ADDRESS=0");
        require(d.shareReceiver != address(0), "SHARE_RECEIVER_ADDRESS=0");
        // Distinctness is a deploy-time precondition. AccessRoles enforces it on chain too,
        // but failing fast gives a better operator message.
        require(d.admin != d.pauser, "ADMIN==PAUSER");
        require(d.admin != d.agent, "ADMIN==AGENT");
        require(d.pauser != d.agent, "PAUSER==AGENT");

        require(p.usdcAddress != address(0), "USDC_ADDRESS=0");
        require(p.usdcAddress.code.length > 0, "USDC_ADDRESS has no code");
        require(p.vault != address(0), "VAULT_ADDRESS=0");
        require(p.vault.code.length > 0, "VAULT_ADDRESS has no code on this chain");
        require(p.router != address(0), "ROUTER_ADDRESS=0");
        require(p.router.code.length > 0, "ROUTER_ADDRESS has no code on this chain");
        d.usdc = p.usdcAddress;
        d.vault = p.vault;
        d.router = p.router;

        d.gateway = new RobotMoneyGateway(
            IERC20(d.usdc), IERC4626(d.vault), d.admin, d.pauser, d.router
        );

        // The core 1493 defect, closed: the immutable router must be the one the router
        // stage deployed, and never zero.
        require(d.gateway.router() != address(0), "gateway.router is zero");
        require(d.gateway.router() == d.router, "gateway.router != ROUTER_ADDRESS");

        // Pin the gateway runtime hash. Agent funding is the caller's responsibility.
        d.gatewayRuntimeHash = keccak256(address(d.gateway).code);

        console2.log("RobotMoneyGateway deployed with the router");
        console2.log("  gateway          :", address(d.gateway));
        console2.log("  router           :", d.router);
        console2.log("  vault            :", d.vault);
        console2.log("  admin            :", d.admin);
        console2.log("  pauser           :", d.pauser);
        console2.log("  agent            :", d.agent);
        console2.log("  shareReceiver    :", d.shareReceiver);
    }

    /// @dev Builds the agent policy, calls authorizeAgent, then runs role-separation checks.
    ///      msg.sender must hold DEFAULT_ADMIN_ROLE (d.admin or the broadcast deployer).
    function _authorizeDeployAgent(Deployed memory d, Params memory p) internal {
        address[] memory noDestinations = new address[](0);
        address assetRecipient = p.maxWithdrawPerPayment > 0 ? d.shareReceiver : address(0);
        IGateway.AgentPolicy memory policy = IGateway.AgentPolicy({
            active: true,
            validUntil: p.validUntil,
            maxPerPayment: p.maxPerPayment,
            maxPerWindow: p.maxPerWindow,
            shareReceiver: d.shareReceiver,
            allowedDestinations: noDestinations,
            assetRecipient: assetRecipient,
            maxWithdrawPerPayment: p.maxWithdrawPerPayment,
            maxWithdrawPerWindow: p.maxWithdrawPerWindow,
            allowedSourceVaults: noDestinations
        });

        d.gateway.authorizeAgent(d.agent, policy);

        require(d.gateway.hasRole(d.gateway.AGENT_ROLE(), d.agent), "agent missing AGENT_ROLE");
        require(!d.gateway.hasRole(d.gateway.ADMIN_ROLE(), d.agent), "agent has ADMIN_ROLE");
        require(!d.gateway.hasRole(d.gateway.PAUSER_ROLE(), d.agent), "agent has PAUSER_ROLE");
        require(d.gateway.hasRole(d.gateway.ADMIN_ROLE(), d.admin), "admin missing ADMIN_ROLE");
        require(d.gateway.hasRole(d.gateway.PAUSER_ROLE(), d.pauser), "pauser missing PAUSER_ROLE");
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
        vm.serializeAddress(obj, "agent", d.agent);
        vm.serializeAddress(obj, "share_receiver", d.shareReceiver);
        string memory json = vm.serializeBytes32(obj, "gateway_runtime_hash", d.gatewayRuntimeHash);

        vm.writeJson(json, outPath);
        console2.log("Wrote gateway deployment JSON to", outPath);
    }
}
