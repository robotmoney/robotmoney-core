// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Implements: Plan tracking issue #109 "Router-weight governance" phase
// Implements: issue #364
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

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
///         It also grants the freshly deployed RouterGovernance `ADMIN_ROLE`
///         on the PortfolioRouter. Without that grant the approving body can
///         approve and cannot act: a proposal reaches quorum, clears its
///         execution delay, and then `execute()` reverts inside
///         `router.setWeights`, leaving the deployer EOA as the only address
///         that can move allocation weights — the exact inversion
///         project-fusion.md §4.3 names as the governance-topology gap. The
///         caller must therefore hold `ADMIN_ROLE` on the router, which the
///         deployer does until `DeployTimelock` hands it to the timelock.
///
///         Required env vars:
///           ADMIN_ADDRESS      — receives ADMIN_ROLE on the governance contract
///           ROUTER_ADDRESS     — deployed PortfolioRouter address
///
///         Optional env vars:
///           VOTING_PERIOD      — voting period in seconds (default: 3600 — 1 hour)
///           EXECUTION_DELAY    — delay from voting end to execution in seconds
///                                (default: 3600 — 1 hour, the contract's MIN_EXECUTION_DELAY)
///           QUORUM_THRESHOLD   — minimum FOR voting power for quorum
///                                (default: 2; must be greater than 1)
///           DEPLOYMENT_OUT     — path for the output JSON
///                                (default: "deployments/governance-<chain_id>.json")
///           SKIP_ROUTER_ADMIN_GRANT — set to true ONLY when the router's
///                                ADMIN_ROLE has already moved to the timelock
///                                and the grant will be scheduled through it.
///                                The script then refuses to pretend the wiring
///                                is complete and says so loudly.
contract DeployRouterGovernance is Script {
    using stdJson for string;

    /// @notice Default voting period: 1 hour in seconds.
    uint64 public constant DEFAULT_VOTING_PERIOD = 3600;

    /// @notice Default execution delay: 1 hour in seconds. Must be >=
    ///         RouterGovernance.MIN_EXECUTION_DELAY (1 hour), or the
    ///         constructor reverts with ExecutionDelayBelowMinimum().
    uint64 public constant DEFAULT_EXECUTION_DELAY = 3600;

    /// @notice Default quorum threshold requires more than one unit of voting
    ///         power, preserving Fusion's separate approving-body control.
    uint256 public constant DEFAULT_QUORUM_THRESHOLD = 2;

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
        // The quorum floor is checked FIRST, before any other env read. Two
        // reasons, both deliberate: a refusal costs nothing, and a test of the
        // refusal then needs to set only QUORUM_THRESHOLD — which nothing else
        // reads — instead of also setting ADMIN_ADDRESS/ROUTER_ADDRESS.
        // `vm.setEnv` mutates process-global state shared by concurrently
        // scheduled test files, and this repo has already been burned by
        // exactly that race on ADMIN_ADDRESS (see AgentTokenVault.t.sol's
        // note and Deploy.t.sol::test_deploy_envDriven_runInProcessSucceeds).
        uint256 quorumThreshold = vm.envOr("QUORUM_THRESHOLD", DEFAULT_QUORUM_THRESHOLD);
        require(quorumThreshold > 1, "QUORUM_THRESHOLD must be greater than 1");

        address admin = vm.envAddress("ADMIN_ADDRESS");
        address router = vm.envAddress("ROUTER_ADDRESS");

        uint64 votingPeriod = uint64(vm.envOr("VOTING_PERIOD", uint256(DEFAULT_VOTING_PERIOD)));
        uint64 executionDelay =
            uint64(vm.envOr("EXECUTION_DELAY", uint256(DEFAULT_EXECUTION_DELAY)));

        // `msg.sender` is the broadcasting account under `forge script`, and it
        // is that account whose router ADMIN_ROLE the grant below depends on.
        vm.startBroadcast();
        d = _deploy(msg.sender, admin, router, votingPeriod, executionDelay, quorumThreshold);
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
        // Same floor as run(). The in-process path is the one fork tests and
        // fixtures use, so leaving it unguarded would let a hollow single-voter
        // quorum back in through the door the broadcast path closes.
        require(quorumThreshold_ > 1, "QUORUM_THRESHOLD must be greater than 1");

        // Under `vm.startPrank` the script's outgoing calls carry `admin_` as
        // their sender, NOT this function's `msg.sender` (which is the test
        // contract). The grant's precondition is therefore about `admin_`.
        vm.startPrank(admin_);
        d = _deploy(admin_, admin_, router_, votingPeriod_, executionDelay_, quorumThreshold_);
        vm.stopPrank();

        _logResult(d);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _deploy(
        address granter_,
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

        _grantRouterAdmin(d, granter_);
    }

    /// @dev Give the governance contract the router `ADMIN_ROLE` its
    ///      `execute()` needs, then read the role back. The read-back is the
    ///      point: a silent failure here produces a deployment that looks
    ///      complete, passes every liveness check, and only fails days later
    ///      when the first real proposal tries to land its weights.
    /// @param granter_ The account whose ADMIN_ROLE on the router authorises
    ///                  the grant — the broadcaster under `run()`, the pranked
    ///                  admin in-process.
    function _grantRouterAdmin(Deployed memory d, address granter_) internal {
        bytes32 routerAdminRole = d.router.ADMIN_ROLE();
        address governance = address(d.governance);

        if (vm.envOr("SKIP_ROUTER_ADMIN_GRANT", false)) {
            // Deliberate opt-out: the router's ADMIN_ROLE has already left the
            // deployer. Refuse to leave the operator believing the topology is
            // wired; the grant is now a timelock proposal they must schedule.
            console2.log(
                "SKIP_ROUTER_ADMIN_GRANT=true: RouterGovernance has NOT been granted router"
                " ADMIN_ROLE. execute() WILL revert until you schedule"
                " router.grantRole(ADMIN_ROLE, governance) through the TimelockController."
            );
            return;
        }

        require(
            IAccessControl(address(d.router)).hasRole(routerAdminRole, granter_),
            "caller lacks router ADMIN_ROLE: cannot wire governance (set SKIP_ROUTER_ADMIN_GRANT=true to route the grant through the timelock instead)"
        );

        IAccessControl(address(d.router)).grantRole(routerAdminRole, governance);
        require(
            IAccessControl(address(d.router)).hasRole(routerAdminRole, governance),
            "RouterGovernance missing router ADMIN_ROLE: execute() would revert in setWeights"
        );
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
