// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Canonical: docs/technical/governance-decisions.md §3.6 — setWeights call path
// Implements: issue #1698 — the weight setter applies a consensus receipt in one call; voting deleted
// Implements: issue #364
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";

/// @title DeployRouterGovernance
/// @notice Foundry deploy script for the RouterGovernance contract, the
///         router's weight setter. Deploys RouterGovernance with the deployer as
///         ADMIN_ROLE and writes a deployment JSON readable by the smoke-test
///         fixture.
///
///         The smoke-test devnet startup sequence runs this script after
///         DeployPortfolioRouter so that the dapp's allocation surface reads
///         live on-chain data in CI.
///
///         It also grants the freshly deployed RouterGovernance `ADMIN_ROLE`
///         and `WEIGHT_SETTER_ROLE` on the PortfolioRouter, and drops the
///         deployer's `WEIGHT_SETTER_ROLE`. Without the grants the weight
///         setter cannot act: `applyReceipt` reverts inside
///         `router.setWeights`, leaving the deployer EOA as the only address
///         that can move allocation weights — the exact inversion
///         project-fusion.md §4.3 names as the governance-topology gap. The
///         caller must therefore hold `ADMIN_ROLE` on the router, which the
///         deployer does until `DeployTimelock` hands it to the timelock.
///
///         There is no voting (issue #1698): no voter list, voting power,
///         quorum, voting period or execution delay is read or set. The
///         receipt register the weight setter releases from
///         (`ConsensusRecommendationReceipt`) is deployed later, in the
///         ic-policy stage, so stage 11 (`DeployTimelock`) wires it with
///         `RouterGovernance.setReceiptContract` and grants the weight setter
///         `ADMIN_ROLE` on it, before handing ADMIN_ROLE here to the timelock.
///
///         Required env vars:
///           ADMIN_ADDRESS      — receives ADMIN_ROLE on the governance contract
///           ROUTER_ADDRESS     — deployed PortfolioRouter address
///           EXPECTED_CHAIN_ID  — mandatory and equal to 8453 on Base mainnet
///           DEPLOYMENT_OUT     — path for the output JSON (required, no default)
///
///         The router role grants always run: no flag skips them.
contract DeployRouterGovernance is ExpectedChainGuard {
    /// @dev Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "governance.json";

    using stdJson for string;

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    struct Deployed {
        RouterGovernance governance;
        PortfolioRouter router;
        address admin;
    }

    /// @notice Forge broadcast entrypoint. Reads env vars, deploys
    ///         RouterGovernance, and writes a deployment JSON.
    /// @return d Struct containing the deployed governance and the router.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");

        address admin = _envAddressRequired("ADMIN_ADDRESS");
        address router = _envAddressRequired("ROUTER_ADDRESS");
        require(router.code.length > 0, "ROUTER_ADDRESS has no code on this chain");

        // `msg.sender` is the broadcasting account under `forge script`, and it
        // is that account whose router ADMIN_ROLE the grant below depends on.
        vm.startBroadcast();
        d = _deploy(msg.sender, admin, router);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    /// @param admin_  Address to receive ADMIN_ROLE.
    /// @param router_ Deployed PortfolioRouter address.
    /// @return d Struct containing the deployed governance and the router.
    function runInProcessWith(address admin_, address router_)
        external
        returns (Deployed memory d)
    {
        require(admin_ != address(0), "ADMIN_ADDRESS=0");
        require(router_ != address(0), "ROUTER_ADDRESS=0");

        // Under `vm.startPrank` the script's outgoing calls carry `admin_` as
        // their sender, NOT this function's `msg.sender` (which is the test
        // contract). The grant's precondition is therefore about `admin_`.
        vm.startPrank(admin_);
        d = _deploy(admin_, admin_, router_);
        vm.stopPrank();

        _logResult(d);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _deploy(address granter_, address admin_, address router_)
        internal
        returns (Deployed memory d)
    {
        d.admin = admin_;
        d.router = PortfolioRouter(router_);

        d.governance = new RouterGovernance(router_, admin_);

        _grantRouterAdmin(d, granter_);
        _grantWeightSetter(d, granter_);
    }

    /// @dev Give the governance contract the router `ADMIN_ROLE` its
    ///      `setDefaultWeights` and `clearVotedWeights` need, then read the role
    ///      back. The read-back is the point: a silent failure here produces a
    ///      deployment that looks complete, passes every liveness check, and
    ///      only fails days later when the first receipt is applied.
    /// @param granter_ The account whose ADMIN_ROLE on the router authorises
    ///                  the grant — the broadcaster under `run()`, the pranked
    ///                  admin in-process.
    function _grantRouterAdmin(Deployed memory d, address granter_) internal {
        bytes32 routerAdminRole = d.router.ADMIN_ROLE();
        address governance = address(d.governance);

        require(
            IAccessControl(address(d.router)).hasRole(routerAdminRole, granter_),
            "caller lacks router ADMIN_ROLE: cannot wire governance (run this script before DeployTimelock hands the router ADMIN_ROLE away)"
        );

        IAccessControl(address(d.router)).grantRole(routerAdminRole, governance);
        require(
            IAccessControl(address(d.router)).hasRole(routerAdminRole, governance),
            "RouterGovernance missing router ADMIN_ROLE: setDefaultWeights would revert"
        );
    }

    /// @dev Give the governance contract `WEIGHT_SETTER_ROLE`, the sole gate on
    ///      `setWeights`, then drop the granter's own copy so no key but
    ///      governance can set active weights. Both effects are read back.
    function _grantWeightSetter(Deployed memory d, address granter_) internal {
        IAccessControl router = IAccessControl(address(d.router));
        bytes32 role = d.router.WEIGHT_SETTER_ROLE();
        address governance = address(d.governance);

        router.grantRole(role, governance);
        require(
            router.hasRole(role, governance),
            "RouterGovernance missing router WEIGHT_SETTER_ROLE: applyReceipt() would revert in setWeights"
        );
        if (router.hasRole(role, granter_)) router.revokeRole(role, granter_);
        require(!router.hasRole(role, granter_), "deployer still holds router WEIGHT_SETTER_ROLE");
    }

    function _logResult(Deployed memory d) internal pure {
        console2.log("RouterGovernance deployed and configured");
        console2.log("  governance    :", address(d.governance));
        console2.log("  router        :", address(d.router));
        console2.log("  admin         :", d.admin);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");

        string memory obj = "governance_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "governance", address(d.governance));
        vm.serializeAddress(obj, "router", address(d.router));
        string memory json = vm.serializeAddress(obj, "admin", d.admin);

        vm.writeJson(json, outPath);
        console2.log("Wrote governance deployment JSON to", outPath);
    }
}
