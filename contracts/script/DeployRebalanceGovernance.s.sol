// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.1 (from receipt to plan), §5.6 (duration, costBudgetBps);
//            PrototypeHarness.sol (_deployGovernance).
// Deploy 4 (owner exception 2026-11-12): the one-vault prototype through the real deploy tool, as a rehearsal.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {RebalanceGovernance} from "../test/prototype/src/RebalanceGovernance.sol";
import {PlanParams, Roles} from "../test/prototype/src/FundTypes.sol";
import {FundSystemBase} from "./FundSystemBase.sol";

/// @title DeployRebalanceGovernance
/// @notice The `fund-governance` stage (Deploy 4): `RebalanceGovernance` behind its ERC-1967 proxy, initialized with the
///         fund, the fund system's own receipt register, the deployer as ADMIN_ROLE and TARGET_SETTER_ROLE until the
///         handover (the timelock then applies receipts alone), the default plan parameters and the predicted fund-system
///         timelock as its only upgrade authority. The wiring stage grants it the register's RECEIPT_RELEASER_ROLE and
///         the fund's GOVERNANCE_ROLE.
///
///         Required env vars (no defaults): ADMIN_ADDRESS, FUND_ADDRESS, FUND_RECEIPT_ADDRESS, PLAN_DURATION,
///         PLAN_COST_BUDGET_BPS, SAFE_ADDRESS, TIMELOCK_MIN_DELAY, UPGRADE_MODE, DEPLOYMENT_OUT.
contract DeployRebalanceGovernance is FundSystemBase {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "fund-governance.json";

    struct Deployed {
        address governance;
        address governanceImplementation;
        address fund;
        address receipts;
        PlanParams plan;
        UpgradeConfig upgrade;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        address admin = _envNonZeroAddress("ADMIN_ADDRESS");
        d.fund = _envContract("FUND_ADDRESS");
        d.receipts = _envContract("FUND_RECEIPT_ADDRESS");
        d.plan = PlanParams({
            duration: uint64(_envUintMax("PLAN_DURATION", type(uint64).max)),
            costBudgetBps: uint16(_envUintMax("PLAN_COST_BUDGET_BPS", type(uint16).max))
        });
        d.upgrade = _readUpgradeConfig("");
        _envStringRequired("DEPLOYMENT_OUT");

        vm.startBroadcast();
        d.governanceImplementation = address(new RebalanceGovernance());
        d.governance = _deployProxy(
            d.governanceImplementation,
            abi.encodeCall(
                RebalanceGovernance.initialize,
                (d.fund, d.receipts, admin, d.plan, d.upgrade.timelock, d.upgrade.mode)
            )
        );
        vm.stopBroadcast();

        RebalanceGovernance g = RebalanceGovernance(d.governance);
        require(g.hasRole(Roles.ADMIN_ROLE, admin), "governance: deployer lacks ADMIN_ROLE");
        require(g.upgradeTimelock() == d.upgrade.timelock, "governance: upgradeTimelock");
        require(address(g.fund()) == d.fund && address(g.receipts()) == d.receipts, "governance: fund or receipts");
        require(_implementationOf(d.governance) == d.governanceImplementation, "governance: implementation slot");
        _writeDeploymentJson(d);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");
        string memory obj = "fund_governance_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "governance", d.governance);
        vm.serializeAddress(obj, "governance_implementation", d.governanceImplementation);
        vm.serializeAddress(obj, "fund", d.fund);
        vm.serializeAddress(obj, "receipts", d.receipts);
        vm.serializeUint(obj, "plan_duration", d.plan.duration);
        vm.serializeUint(obj, "plan_cost_budget_bps", d.plan.costBudgetBps);
        vm.serializeAddress(obj, "upgrade_timelock", d.upgrade.timelock);
        string memory json = vm.serializeString(obj, "upgrade_mode", upgradeModeName(d.upgrade.mode));
        vm.writeJson(json, outPath);
        console2.log("Wrote fund-governance deployment JSON to", outPath);
    }
}
