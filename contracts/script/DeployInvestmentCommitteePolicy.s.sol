// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md — Investment Committee Policy
// Implements: issue #1048 — InvestmentCommitteePolicy.sol deploy script
// Implements: issue #1049 — gateway wiring (setICPolicy + IC ADMIN_ROLE grant)
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";

/// @title DeployInvestmentCommitteePolicy
/// @notice Foundry deploy script for the InvestmentCommitteePolicy contract.
///
///         Deploys InvestmentCommitteePolicy with the given admin and gateway
///         addresses, wires the IC policy into the gateway (`setICPolicy`),
///         and grants the gateway IC's `ADMIN_ROLE` so it can forward
///         `committeeRegister` calls to the IC contract on behalf of the admin.
///         Writes a deployment JSON readable by the smoke-test fixture and
///         off-chain tooling.
///
///         Required env vars:
///           ADMIN_ADDRESS    — receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE on IC;
///                              must also hold ADMIN_ROLE on the gateway (for
///                              setICPolicy and gateway grantRole).
///           GATEWAY_ADDRESS  — deployed RobotMoneyGateway address; all committee
///                              writes (register, voteSubmit) must originate here.
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
    ///         InvestmentCommitteePolicy contract, wires it into the gateway,
    ///         and writes a deployment JSON.
    /// @return d Struct containing the deployed contract and key parameters.
    function run() external returns (Deployed memory d) {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address gateway = vm.envAddress("GATEWAY_ADDRESS");

        vm.startBroadcast();
        d = _deploy(admin, gateway);
        _wireGateway(d);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    /// @param admin_   Address to receive DEFAULT_ADMIN_ROLE and ADMIN_ROLE on IC.
    ///                 Must also hold ADMIN_ROLE on the gateway.
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
        // Note: _wireGateway requires the broadcaster/pranker to hold ADMIN_ROLE
        // on the gateway. Callers of this in-process variant must set up the
        // appropriate prank context and call _wireGateway separately if needed.
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _deploy(address admin_, address gateway_) internal returns (Deployed memory d) {
        d.admin = admin_;
        d.gateway = gateway_;
        d.policy = new InvestmentCommitteePolicy(admin_, gateway_);
    }

    /// @notice Wire the deployed IC policy into the gateway.
    ///         1. Call `gateway.setICPolicy(policy)` — requires ADMIN_ROLE on gateway.
    ///         2. Grant IC's `ADMIN_ROLE` to the gateway so it can forward
    ///            `committeeRegister` calls — requires DEFAULT_ADMIN_ROLE on IC
    ///            (held by the admin set at IC construction time).
    ///         Must be called in a context where `msg.sender` holds ADMIN_ROLE on
    ///         the gateway AND DEFAULT_ADMIN_ROLE on the IC contract (i.e. the
    ///         same admin address supplied to both constructors).
    function _wireGateway(Deployed memory d) internal {
        RobotMoneyGateway gw = RobotMoneyGateway(d.gateway);
        // 1. Register the IC policy address in the gateway.
        gw.setICPolicy(address(d.policy));
        console2.log("  gateway.setICPolicy:", address(d.policy));

        // 2. Grant the gateway IC's ADMIN_ROLE so it can call registerAgent
        //    on behalf of the admin when `committeeRegister` is invoked.
        d.policy.grantRole(d.policy.ADMIN_ROLE(), d.gateway);
        console2.log("  IC ADMIN_ROLE granted to gateway:", d.gateway);
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
            outPath = string.concat("deployments/ic-policy-", vm.toString(block.chainid), ".json");
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
