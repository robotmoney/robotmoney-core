// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Implements: docs/implementation-plan.md "Router-weight governance" phase
// Implements: issue #364
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";

/// @title DeployRouterGovernance
/// @notice Foundry deploy script for the RouterGovernance contract.
///         Deploys RouterGovernance with the deployer as ADMIN_ROLE and
///         writes a deployment JSON readable by the smoke-test fixture.
///
///         The smoke-test devnet startup sequence runs this script after
///         DeployPortfolioRouter so that the dapp's Governance tab reads
///         live on-chain data in CI.
///
///         Required env vars:
///           ADMIN_ADDRESS      — receives ADMIN_ROLE on the governance contract
///           ROUTER_ADDRESS     — deployed PortfolioRouter address
///
///         Optional env vars:
///           VOTING_PERIOD      — voting period in seconds (default: 3600 — 1 hour)
///           EXECUTION_DELAY    — delay from voting end to execution in seconds (default: 0)
///           QUORUM_THRESHOLD   — minimum FOR voting power for quorum (default: 1)
///           DEPLOYMENT_OUT     — path for the output JSON
///                                (default: "deployments/governance-<chain_id>.json")
contract DeployRouterGovernance is Script {
    using stdJson for string;

    /// @notice Default voting period: 1 hour in seconds.
    uint64 public constant DEFAULT_VOTING_PERIOD = 3600;

    /// @notice Default execution delay: 0 seconds (immediate after quorum).
    uint64 public constant DEFAULT_EXECUTION_DELAY = 0;

    /// @notice Default quorum threshold: 1 unit of voting power.
    uint256 public constant DEFAULT_QUORUM_THRESHOLD = 1;

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    struct Deployed {
        RouterGovernance governance;
        PortfolioRouter router;
        address admin;
        uint64 votingPeriod;
        uint64 executionDelay;
        uint256 quorumThreshold;
    }

    /// @notice Forge broadcast entrypoint. Reads env vars, deploys
    ///         RouterGovernance, and writes a deployment JSON.
    /// @return d Struct containing the deployed governance and key parameters.
    function run() external returns (Deployed memory d) {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address router = vm.envAddress("ROUTER_ADDRESS");

        uint64 votingPeriod = uint64(vm.envOr("VOTING_PERIOD", uint256(DEFAULT_VOTING_PERIOD)));
        uint64 executionDelay =
            uint64(vm.envOr("EXECUTION_DELAY", uint256(DEFAULT_EXECUTION_DELAY)));
        uint256 quorumThreshold = vm.envOr("QUORUM_THRESHOLD", DEFAULT_QUORUM_THRESHOLD);

        vm.startBroadcast();
        d = _deploy(admin, router, votingPeriod, executionDelay, quorumThreshold);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    /// @param admin_           Address to receive ADMIN_ROLE.
    /// @param router_          Deployed PortfolioRouter address.
    /// @param votingPeriod_    Voting period in seconds.
    /// @param executionDelay_  Delay from voting end to execution in seconds.
    /// @param quorumThreshold_ Minimum FOR voting power for quorum.
    /// @return d Struct containing the deployed governance and key parameters.
    function runInProcessWith(
        address admin_,
        address router_,
        uint64 votingPeriod_,
        uint64 executionDelay_,
        uint256 quorumThreshold_
    ) external returns (Deployed memory d) {
        require(admin_ != address(0), "ADMIN_ADDRESS=0");
        require(router_ != address(0), "ROUTER_ADDRESS=0");

        vm.startPrank(admin_);
        d = _deploy(admin_, router_, votingPeriod_, executionDelay_, quorumThreshold_);
        vm.stopPrank();

        _logResult(d);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _deploy(
        address admin_,
        address router_,
        uint64 votingPeriod_,
        uint64 executionDelay_,
        uint256 quorumThreshold_
    ) internal returns (Deployed memory d) {
        d.admin = admin_;
        d.router = PortfolioRouter(router_);
        d.votingPeriod = votingPeriod_;
        d.executionDelay = executionDelay_;
        d.quorumThreshold = quorumThreshold_;

        d.governance =
            new RouterGovernance(router_, admin_, votingPeriod_, executionDelay_, quorumThreshold_);
    }

    function _logResult(Deployed memory d) internal pure {
        console2.log("RouterGovernance deployed and configured");
        console2.log("  governance    :", address(d.governance));
        console2.log("  router        :", address(d.router));
        console2.log("  admin         :", d.admin);
        console2.log("  votingPeriod  :", d.votingPeriod);
        console2.log("  executionDelay:", d.executionDelay);
        console2.log("  quorumThreshold:", d.quorumThreshold);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath;
        try vm.envString("DEPLOYMENT_OUT") returns (string memory s) {
            outPath = s;
        } catch {
            outPath = string.concat("deployments/governance-", vm.toString(block.chainid), ".json");
        }

        string memory obj = "governance_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "governance", address(d.governance));
        vm.serializeAddress(obj, "router", address(d.router));
        vm.serializeAddress(obj, "admin", d.admin);
        vm.serializeUint(obj, "voting_period", d.votingPeriod);
        vm.serializeUint(obj, "execution_delay", d.executionDelay);
        string memory json = vm.serializeUint(obj, "quorum_threshold", d.quorumThreshold);

        vm.writeJson(json, outPath);
        console2.log("Wrote governance deployment JSON to", outPath);
    }
}
