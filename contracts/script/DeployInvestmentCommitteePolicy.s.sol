// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md — Investment Committee Policy
// Implements: issue #1048 — InvestmentCommitteePolicy.sol deploy script
// Implements: issue #1049 — gateway wiring (setICPolicy + IC ADMIN_ROLE grant)
// Implements: issue #1247 — ConsensusRecommendationReceipt deploys in the SAME ceremony
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";

/// @title DeployInvestmentCommitteePolicy
/// @notice Foundry deploy script for the InvestmentCommitteePolicy contract.
///
///         Deploys InvestmentCommitteePolicy AND ConsensusRecommendationReceipt in
///         one ceremony (issue #1247 AC10 — one greenfield rollout, no
///         migration, no registered agent to preserve), wires both into the
///         gateway (`setICPolicy`, `setConsensusReceipt`), and grants the
///         gateway IC's `ADMIN_ROLE` so it can forward `committeeRegister`
///         calls on behalf of the admin. Writes a deployment JSON readable by
///         the smoke-test fixture and off-chain tooling.
///
///         **The receipt contract's `ADMIN_ROLE` goes to `RECEIPT_ADMIN_ADDRESS`
///         and nowhere else.** In production that is the `TimelockController`
///         (INV-3). The gateway is deliberately NOT granted it: routing
///         `releaseReceipt` through the gateway would need a second holder and
///         defeat INV-3, so the timelock calls the receipt contract directly.
///         See `docs/architecture.md` §4.9.
///
///         Required env vars:
///           ADMIN_ADDRESS    — receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE on IC;
///                              must also hold ADMIN_ROLE on the gateway (for
///                              setICPolicy and gateway grantRole).
///           GATEWAY_ADDRESS  — deployed RobotMoneyGateway address; all committee
///                              writes (register, voteSubmit, receipt record)
///                              must originate here.
///
///         Optional env vars:
///           RECEIPT_ADMIN_ADDRESS — sole holder of ADMIN_ROLE on the receipt
///                              contract; the TimelockController in production.
///                              Defaults to ADMIN_ADDRESS for devnet ceremonies.
///           DEPLOYMENT_OUT   — path for the output JSON
///                              (default: "deployments/ic-policy-<chain_id>.json")
contract DeployInvestmentCommitteePolicy is Script {
    using stdJson for string;

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    struct Deployed {
        InvestmentCommitteePolicy policy;
        ConsensusRecommendationReceipt receipts;
        address admin;
        address receiptAdmin;
        address gateway;
    }

    /// @notice Forge broadcast entrypoint. Reads env vars, deploys the
    ///         InvestmentCommitteePolicy contract, wires it into the gateway,
    ///         and writes a deployment JSON.
    /// @return d Struct containing the deployed contract and key parameters.
    function run() external returns (Deployed memory d) {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address gateway = vm.envAddress("GATEWAY_ADDRESS");
        address receiptAdmin = vm.envOr("RECEIPT_ADMIN_ADDRESS", admin);

        vm.startBroadcast();
        d = _deploy(admin, receiptAdmin, gateway);
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
        return runInProcessWith(admin_, admin_, gateway_);
    }

    /// @notice In-process variant that separates the IC admin from the receipt
    ///         contract's `ADMIN_ROLE` holder (the timelock). No broadcast, no
    ///         JSON written.
    /// @param admin_        Address to receive DEFAULT_ADMIN_ROLE and ADMIN_ROLE on IC.
    /// @param receiptAdmin_ Sole holder of ADMIN_ROLE on the receipt contract.
    /// @param gateway_      Deployed RobotMoneyGateway address.
    /// @return d Struct containing the deployed contracts and key parameters.
    function runInProcessWith(address admin_, address receiptAdmin_, address gateway_)
        public
        returns (Deployed memory d)
    {
        require(admin_ != address(0), "ADMIN_ADDRESS=0");
        require(receiptAdmin_ != address(0), "RECEIPT_ADMIN_ADDRESS=0");
        require(gateway_ != address(0), "GATEWAY_ADDRESS=0");

        d = _deploy(admin_, receiptAdmin_, gateway_);
        _logResult(d);
        // Note: _wireGateway requires the broadcaster/pranker to hold ADMIN_ROLE
        // on the gateway. Callers of this in-process variant must set up the
        // appropriate prank context and call _wireGateway separately if needed.
    }

    /// @notice In-process gateway wiring for forge tests. `msg.sender` must
    ///         hold `ADMIN_ROLE` on the gateway AND `DEFAULT_ADMIN_ROLE` on the
    ///         IC contract, exactly as the broadcast path requires.
    /// @param d Result of `runInProcessWith`.
    function wireGatewayInProcess(Deployed memory d) public {
        _wireGateway(d);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _deploy(address admin_, address receiptAdmin_, address gateway_)
        internal
        returns (Deployed memory d)
    {
        d.admin = admin_;
        d.receiptAdmin = receiptAdmin_;
        d.gateway = gateway_;
        d.policy = new InvestmentCommitteePolicy(admin_, gateway_);
        // One ceremony: the receipt contract reads COMMITTEE_AGENT_ROLE off the
        // IC policy, so it keeps no registry of its own (issue #1247 task 4.0).
        d.receipts = new ConsensusRecommendationReceipt(receiptAdmin_, gateway_, address(d.policy));
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

        // 3. Register the receipt contract in the gateway.
        //    NOTE: the gateway is deliberately NOT granted ADMIN_ROLE on the
        //    receipt contract. INV-3 requires the TimelockController to hold
        //    it, and a second holder would defeat that; the timelock calls
        //    `releaseReceipt` directly (docs/architecture.md §4.9).
        gw.setConsensusReceipt(address(d.receipts));
        console2.log("  gateway.setConsensusReceipt:", address(d.receipts));
    }

    function _logResult(Deployed memory d) internal pure {
        console2.log("InvestmentCommitteePolicy + ConsensusRecommendationReceipt deployed");
        console2.log("  policy       :", address(d.policy));
        console2.log("  receipts     :", address(d.receipts));
        console2.log("  admin        :", d.admin);
        console2.log("  receiptAdmin :", d.receiptAdmin);
        console2.log("  gateway      :", d.gateway);
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
        vm.serializeAddress(obj, "consensus_receipt", address(d.receipts));
        vm.serializeAddress(obj, "admin", d.admin);
        vm.serializeAddress(obj, "receipt_admin", d.receiptAdmin);
        string memory json = vm.serializeAddress(obj, "gateway", d.gateway);

        vm.writeJson(json, outPath);
        console2.log("Wrote IC policy deployment JSON to", outPath);
    }
}
