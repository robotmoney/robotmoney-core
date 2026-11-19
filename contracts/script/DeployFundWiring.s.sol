// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.1, §5.4, E1 (FLOW_ROLE bound once), RB-1 (plan roles bound
//            once); PrototypeHarness.sol (_wireRoles).
// Deploy 4 (owner exception 2026-11-12): the one-vault prototype through the real deploy tool, as a rehearsal.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {RobotMoneyFund} from "../RobotMoneyFund.sol";
import {Roles} from "../FundTypes.sol";
import {KeeperAccount} from "../KeeperAccount.sol";
import {FundSystemBase} from "./FundSystemBase.sol";

/// @title DeployFundWiring
/// @notice The `fund-wiring` stage (Deploy 4), while the deployer still holds every admin role:
///         - the fund's GOVERNANCE_ROLE and REBALANCER_ROLE, bound once (`bindRebalanceRoles`, self-administered after);
///         - the fund's FLOW_ROLE, bound once to the queue (`bindFlowRole`, E1);
///         - the receipt register's RECEIPT_RELEASER_ROLE to the governance contract (its applyReceipt releases the
///           receipt in the same call, §5.1). The receipt SUBMITTER is registered later by the Safe through the timelock.
///         Then it reads back that the keeper holds KEEPER_ROLE on the queue and the rebalancer (granted at their
///         initialization) and that no plan role went anywhere else.
///
///         Required env vars (no defaults): FUND_ADDRESS, REBALANCER_ADDRESS, FUND_GOVERNANCE_ADDRESS, QUEUE_ADDRESS,
///         FUND_RECEIPT_ADDRESS, KEEPER_ADDRESS, DEPLOYMENT_OUT.
contract DeployFundWiring is FundSystemBase {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "fund-wiring.json";
    bytes32 public constant RECEIPT_RELEASER_ROLE = keccak256("RECEIPT_RELEASER_ROLE");

    struct Wired {
        address fund;
        address rebalancer;
        address governance;
        address queue;
        address receipts;
        address keeper;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Wired memory w) {
        _requireExpectedChain("");
        w.fund = _envContract("FUND_ADDRESS");
        w.rebalancer = _envContract("REBALANCER_ADDRESS");
        w.governance = _envContract("FUND_GOVERNANCE_ADDRESS");
        w.queue = _envContract("QUEUE_ADDRESS");
        w.receipts = _envContract("FUND_RECEIPT_ADDRESS");
        w.keeper = _envNonZeroAddress("KEEPER_ADDRESS");
        _envStringRequired("DEPLOYMENT_OUT");

        vm.startBroadcast();
        RobotMoneyFund(w.fund).bindRebalanceRoles(w.governance, w.rebalancer);
        RobotMoneyFund(w.fund).bindFlowRole(w.queue);
        IAccessControl(w.receipts).grantRole(RECEIPT_RELEASER_ROLE, w.governance);
        vm.stopBroadcast();

        _check(w);
        _checkKeeperAccount(w.keeper);
        _writeDeploymentJson(w);
    }

    function _check(Wired memory w) internal view {
        RobotMoneyFund f = RobotMoneyFund(w.fund);
        require(
            f.hasRole(Roles.GOVERNANCE_ROLE, w.governance),
            "wiring: governance lacks GOVERNANCE_ROLE"
        );
        require(
            f.hasRole(Roles.REBALANCER_ROLE, w.rebalancer),
            "wiring: rebalancer lacks REBALANCER_ROLE"
        );
        require(
            f.hasRole(Roles.FLOW_ROLE, w.queue) && f.flowQueue() == w.queue,
            "wiring: queue lacks FLOW_ROLE"
        );
        require(!f.hasRole(Roles.FLOW_ROLE, msg.sender), "wiring: deployer holds FLOW_ROLE");
        require(
            !f.hasRole(Roles.REBALANCER_ROLE, msg.sender), "wiring: deployer holds REBALANCER_ROLE"
        );
        require(
            !f.hasRole(Roles.GOVERNANCE_ROLE, msg.sender), "wiring: deployer holds GOVERNANCE_ROLE"
        );
        require(
            IAccessControl(w.receipts).hasRole(RECEIPT_RELEASER_ROLE, w.governance),
            "wiring: governance cannot release receipts"
        );
        require(
            IAccessControl(w.queue).hasRole(Roles.KEEPER_ROLE, w.keeper),
            "wiring: keeper lacks queue KEEPER_ROLE"
        );
        require(
            IAccessControl(w.rebalancer).hasRole(Roles.KEEPER_ROLE, w.keeper),
            "wiring: keeper lacks rebalancer KEEPER_ROLE"
        );
    }

    /// @dev E56: a keeper with code is the smart account. Its `owners()` and `botKeys()` must answer and the account must
    ///      have an owner, so the deploy tool can record them. A keeper without code is an EOA, recorded as such.
    function _checkKeeperAccount(address keeper) internal view {
        if (keeper.code.length == 0) return;
        KeeperAccount k = KeeperAccount(keeper);
        require(k.owners().length != 0, "wiring: keeper account has no owner");
        k.botKeys();
    }

    function _writeDeploymentJson(Wired memory w) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");
        string memory obj = "fund_wiring";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "fund", w.fund);
        vm.serializeAddress(obj, "rebalancer", w.rebalancer);
        vm.serializeAddress(obj, "governance", w.governance);
        vm.serializeAddress(obj, "queue", w.queue);
        vm.serializeAddress(obj, "consensus_receipt", w.receipts);
        vm.serializeAddress(obj, "keeper", w.keeper);
        // E56: what the deploy tool records of the keeper. The verifier reads the same views from the chain.
        if (w.keeper.code.length == 0) {
            vm.serializeString(obj, "keeper_type", "eoa");
        } else {
            vm.serializeString(obj, "keeper_type", "smart-account");
            vm.serializeAddress(obj, "keeper_owners", KeeperAccount(w.keeper).owners());
            vm.serializeAddress(obj, "keeper_bot_keys", KeeperAccount(w.keeper).botKeys());
        }
        string memory json = vm.serializeAddress(obj, "keeper", w.keeper);
        vm.writeJson(json, outPath);
        console2.log("Wrote fund-wiring JSON to", outPath);
    }
}
