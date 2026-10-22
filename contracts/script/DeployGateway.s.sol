// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499 — core S3, stage "gateway"
// (See also: docs/architecture.md §6 — Roles)
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {UpgradeAuthority} from "./UpgradeAuthority.sol";

/// @title DeployGateway
/// @notice The gateway system's deploy stage. Deploys the deposit-only RobotMoneyGateway behind a governed proxy.
///         The gateway binds no vault and no router (core 1895). The deploy authorizes no
///         agent: an agent belongs to a depositor, who authorizes it through commitAuthorization
///         and revealAuthorization (architecture 5.2 and 6.3).
///
///         The consensus receipt does not bind the gateway: it deploys in its own stage
///         (`DeployConsensusRecommendationReceipt`).
///
/// @dev Required env vars (all required on every chain, no defaults):
///        EXPECTED_CHAIN_ID     — mandatory and equal to 8453 on Base mainnet
///        ADMIN_ADDRESS         — receives DEFAULT_ADMIN_ROLE + ADMIN_ROLE
///        PAUSER_ADDRESS        — receives DEPOSIT_PAUSER_ROLE (must differ from ADMIN)
///        SHARE_RECEIVER_ADDRESS — recipient of minted rmUSDC shares
///        DEPLOYMENT_OUT        — output JSON path
///      USDC is the canonical Base USDC constant on every chain.
///
///      GATEWAY_UPGRADE_TIMELOCK, UPGRADE_MODE: the upgrade authority and release mode of
///      the gateway proxy (`UpgradeAuthority`, issue 1808). The gateway system names its own
///      upgrade timelock: nonzero, with code on the chain. The vaults timelock is never
///      predicted or defaulted (architecture section 10, gateway governance is open). The manifest `gateway` is the
///      ERC-1967 proxy and `gateway_runtime_hash` is the code at that address (the proxy).
///      `gateway_implementation` and `gateway_implementation_runtime_hash` name the logic the
///      proxy runs: a signing client must check both (upgradeability stage 3).
contract DeployGateway is UpgradeAuthority {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "gateway.json";

    /// @notice The env var that names the gateway's own upgrade timelock (explicit, nonzero, never the vaults timelock).
    string public constant TIMELOCK_ENV = "GATEWAY_UPGRADE_TIMELOCK";

    struct Params {
        address admin;
        address pauser;
        address shareReceiver;
        address usdcAddress;
    }

    struct Deployed {
        RobotMoneyGateway gateway;
        address usdc;
        address admin;
        address pauser;
        address shareReceiver;
        bytes32 gatewayRuntimeHash;
        address gatewayImplementation;
        bytes32 gatewayImplementationRuntimeHash;
        UpgradeConfig upgrade;
    }

    /// @notice Forge broadcast entrypoint.
    /// @return d The deployed gateway and its wiring.
    function run() external returns (Deployed memory d) {
        Params memory p = _readEnvParamsFrom("");
        UpgradeConfig memory u = _readExplicitUpgradeConfig("", TIMELOCK_ENV);
        vm.startBroadcast();
        d = _deployGateway(p, u);
        vm.stopBroadcast();
        _writeDeploymentJson(d);
    }

    /// @notice In-process variant, env-driven.
    /// @return d The deployed gateway and its wiring.
    function runInProcess() external returns (Deployed memory d) {
        Params memory p = _readEnvParamsFrom("");
        d = _deployGateway(p, _inProcessUpgradeConfig());
    }

    /// @notice Direct-parameter variant for forge tests. Skips env resolution.
    /// @param admin_ Gateway admin.
    /// @param pauser_ Address granted the pauser role.
    /// @param shareReceiver_ Address that receives vault shares.
    /// @param usdc_ USDC token address.
    /// @return d The deployed gateway and its wiring.
    function runInProcessWith(
        address admin_,
        address pauser_,
        address shareReceiver_,
        address usdc_
    ) external returns (Deployed memory d) {
        Params memory p;
        p.admin = admin_;
        p.pauser = pauser_;
        p.shareReceiver = shareReceiver_;
        p.usdcAddress = usdc_;
        d = _deployGateway(p, _inProcessUpgradeConfig());
    }

    /// @dev `prefix` is "" in production. Tests pass their own prefix because env vars are
    ///      process-wide and forge runs tests in parallel.
    function _readEnvParamsFrom(string memory prefix) internal view returns (Params memory p) {
        _requireExpectedChain(prefix);
        p.admin = _envAddressRequired(string.concat(prefix, "ADMIN_ADDRESS"));
        p.pauser = _envAddressRequired(string.concat(prefix, "PAUSER_ADDRESS"));
        p.shareReceiver = _envAddressRequired(string.concat(prefix, "SHARE_RECEIVER_ADDRESS"));
        p.usdcAddress = BASE_USDC;
    }

    function _deployGateway(Params memory p, UpgradeConfig memory u)
        internal
        returns (Deployed memory d)
    {
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
        d.usdc = p.usdcAddress;

        d.upgrade = u;
        d.gatewayImplementation = address(new RobotMoneyGateway());
        d.gateway = RobotMoneyGateway(
            _deployProxy(
                d.gatewayImplementation,
                abi.encodeCall(
                    RobotMoneyGateway.initialize,
                    (IERC20(d.usdc), d.admin, d.pauser, u.timelock, u.mode)
                )
            )
        );

        // Pin the code at the gateway address (the proxy) and the logic it runs.
        d.gatewayRuntimeHash = keccak256(address(d.gateway).code);
        d.gatewayImplementationRuntimeHash = d.gatewayImplementation.codehash;

        console2.log("RobotMoneyGateway deployed");
        console2.log("  gateway          :", address(d.gateway));
        console2.log("  admin            :", d.admin);
        console2.log("  pauser           :", d.pauser);
        console2.log("  shareReceiver    :", d.shareReceiver);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");

        string memory obj = "gateway_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "usdc", d.usdc);
        vm.serializeAddress(obj, "gateway", address(d.gateway));
        vm.serializeAddress(obj, "admin", d.admin);
        vm.serializeAddress(obj, "pauser", d.pauser);
        vm.serializeAddress(obj, "share_receiver", d.shareReceiver);
        vm.serializeAddress(obj, "gateway_implementation", d.gatewayImplementation);
        vm.serializeBytes32(
            obj, "gateway_implementation_runtime_hash", d.gatewayImplementationRuntimeHash
        );
        vm.serializeAddress(obj, "upgrade_timelock", d.upgrade.timelock);
        vm.serializeString(obj, "upgrade_mode", upgradeModeName(d.upgrade.mode));
        string memory json = vm.serializeBytes32(obj, "gateway_runtime_hash", d.gatewayRuntimeHash);

        vm.writeJson(json, outPath);
        console2.log("Wrote gateway deployment JSON to", outPath);
    }
}
