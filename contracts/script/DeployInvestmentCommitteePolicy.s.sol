// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md — Investment Committee Policy
// Implements: issue #1048 — InvestmentCommitteePolicy.sol deploy script
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";

/// @title DeployInvestmentCommitteePolicy
/// @notice Foundry deploy script for the InvestmentCommitteePolicy contract.
///
///         Deploys InvestmentCommitteePolicy with the given admin and gateway
///         addresses and writes a deployment JSON readable by the smoke-test
///         fixture and off-chain tooling.
///
///         Required env vars:
///           ADMIN_ADDRESS    — receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE;
///                              may then call registerAgent / revokeAgent.
///           GATEWAY_ADDRESS  — deployed RobotMoneyGateway address; all
///                              committee writes (register, voteSubmit) must
///                              originate from this address.
///
///         Optional env vars:
///           DEPLOYMENT_OUT   — path for the output JSON
///                              (default: "deployments/ic-policy-<chain_id>.json")
contract DeployInvestmentCommitteePolicy is Script {
    using stdJson for string;

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    struct Deployed {
        InvestmentCommitteePolicy policy;
        address admin;
        address gateway;
    }

    /// @notice Forge broadcast entrypoint. Reads env vars, deploys the
    ///         InvestmentCommitteePolicy contract, and writes a deployment JSON.
    /// @return d Struct containing the deployed contract and key parameters.
    function run() external returns (Deployed memory d) {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address gateway = vm.envAddress("GATEWAY_ADDRESS");

        vm.startBroadcast();
        d = _deploy(admin, gateway);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    /// @param admin_   Address to receive DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
    /// @param gateway_ Deployed RobotMoneyGateway address.
    /// @return d Struct containing the deployed contract and key parameters.
    function runInProcessWith(address admin_, address gateway_)
        external
        returns (Deployed memory d)
    {
        require(admin_ != address(0), "ADMIN_ADDRESS=0");
        require(gateway_ != address(0), "GATEWAY_ADDRESS=0");

        d = _deploy(admin_, gateway_);
        _logResult(d);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _deploy(address admin_, address gateway_) internal returns (Deployed memory d) {
        d.admin = admin_;
        d.gateway = gateway_;
        d.policy = new InvestmentCommitteePolicy(admin_, gateway_);
    }

    function _logResult(Deployed memory d) internal pure {
        console2.log("InvestmentCommitteePolicy deployed");
        console2.log("  policy  :", address(d.policy));
        console2.log("  admin   :", d.admin);
        console2.log("  gateway :", d.gateway);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath;
        try vm.envString("DEPLOYMENT_OUT") returns (string memory s) {
            outPath = s;
        } catch {
            outPath =
                string.concat("deployments/ic-policy-", vm.toString(block.chainid), ".json");
        }

        string memory obj = "ic_policy_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "policy", address(d.policy));
        vm.serializeAddress(obj, "admin", d.admin);
        string memory json = vm.serializeAddress(obj, "gateway", d.gateway);

        vm.writeJson(json, outPath);
        console2.log("Wrote IC policy deployment JSON to", outPath);
    }
}
