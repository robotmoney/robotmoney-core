// SPDX-License-Identifier: MIT
// Canonical: docs/technical/governance-decisions.md §3.6 — setWeights call path
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Implements: issue #364, issue #1698 (the weight setter applies a consensus receipt; voting deleted)
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {UpgradeAuthority} from "./UpgradeAuthority.sol";

/// @title DeployRouterGovernance
/// @notice Foundry deploy script for RouterGovernance, the router's weight setter.
///         Deploys it with the deployer as `ADMIN_ROLE` and `WEIGHT_SETTER_ROLE`
///         holder (the timelock stage hands both to the TimelockController) and
///         wires the three grants `applyReceipt` and the fallback need:
///
///         - router `ADMIN_ROLE`, so `setDefaultWeights` forwards;
///         - router `WEIGHT_SETTER_ROLE`, the only gate on `setWeights`, after
///           which the deployer's own copy is dropped;
///         - `RECEIPT_RELEASER_ROLE` on the ConsensusRecommendationReceipt, so
///           `applyReceipt` can release the receipt it applies. It is a narrow,
///           single-purpose role: RouterGovernance never holds the receipt
///           `ADMIN_ROLE`, which the timelock alone holds (issue 1888).
///
///         Every grant is read back: a silent failure produces a deployment that
///         looks complete and fails only when the first receipt is applied.
///         The stage runs after `receipt` because the receipt register must
///         exist, and before `timelock`, while the deployer still holds the
///         router and receipt admin roles.
///
///         Required env vars (unset or malformed reverts, there is no default):
///           ADMIN_ADDRESS             — receives ADMIN_ROLE and WEIGHT_SETTER_ROLE
///           ROUTER_ADDRESS            — deployed PortfolioRouter
///           CONSENSUS_RECEIPT_ADDRESS — deployed ConsensusRecommendationReceipt
///           EXPECTED_CHAIN_ID         — mandatory and equal to 8453 on Base mainnet
///           DEPLOYMENT_OUT            — path for the output JSON
///           SAFE_ADDRESS, TIMELOCK_MIN_DELAY, UPGRADE_MODE — the upgrade authority and release
///                                       mode of the governance proxy (`UpgradeAuthority`,
///                                       issue 1808). RouterGovernance's roles carry no upgrade
///                                       power. The manifest `governance` is the ERC-1967 proxy;
///                                       `governance_implementation` is its implementation.
contract DeployRouterGovernance is UpgradeAuthority {
    /// @dev Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "governance.json";

    bytes32 internal constant RECEIPT_RELEASER_ROLE = keccak256("RECEIPT_RELEASER_ROLE");

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    struct Deployed {
        RouterGovernance governance;
        PortfolioRouter router;
        address receipts;
        address admin;
        address governanceImplementation;
        UpgradeConfig upgrade;
    }

    /// @notice Forge broadcast entrypoint. Reads env vars, deploys
    ///         RouterGovernance, wires it, and writes a deployment JSON.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        address admin = _envAddressRequired("ADMIN_ADDRESS");
        address router = _envAddressRequired("ROUTER_ADDRESS");
        address receipts = _envAddressRequired("CONSENSUS_RECEIPT_ADDRESS");
        require(router.code.length > 0, "ROUTER_ADDRESS has no code on this chain");
        require(receipts.code.length > 0, "CONSENSUS_RECEIPT_ADDRESS has no code on this chain");

        // `msg.sender` is the broadcasting account under `forge script`, and it
        // is that account whose router and receipt admin roles the grants use.
        UpgradeConfig memory u = _readUpgradeConfig("");
        vm.startBroadcast();
        d = _deploy(msg.sender, admin, router, receipts, u);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    /// @param admin_    Address to receive ADMIN_ROLE and WEIGHT_SETTER_ROLE; must
    ///                  hold router ADMIN_ROLE, router WEIGHT_SETTER_ROLE and the
    ///                  receipt register's ADMIN_ROLE.
    /// @param router_   Deployed PortfolioRouter address.
    /// @param receipts_ Deployed ConsensusRecommendationReceipt address.
    function runInProcessWith(address admin_, address router_, address receipts_)
        external
        returns (Deployed memory d)
    {
        require(admin_ != address(0), "ADMIN_ADDRESS=0");
        require(router_ != address(0), "ROUTER_ADDRESS=0");
        require(receipts_ != address(0), "CONSENSUS_RECEIPT_ADDRESS=0");
        // Under `vm.startPrank` the script's outgoing calls carry `admin_` as
        // their sender, NOT this function's `msg.sender` (the test contract).
        UpgradeConfig memory u = _inProcessUpgradeConfig();
        vm.startPrank(admin_);
        d = _deploy(admin_, admin_, router_, receipts_, u);
        vm.stopPrank();
        _logResult(d);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _deploy(
        address granter_,
        address admin_,
        address router_,
        address receipts_,
        UpgradeConfig memory u
    ) internal returns (Deployed memory d) {
        d.admin = admin_;
        d.router = PortfolioRouter(router_);
        d.receipts = receipts_;
        d.upgrade = u;
        d.governanceImplementation = address(new RouterGovernance());
        d.governance = RouterGovernance(
            _deployProxy(
                d.governanceImplementation,
                abi.encodeCall(
                    RouterGovernance.initialize, (router_, receipts_, admin_, u.timelock, u.mode)
                )
            )
        );

        _grantRouterAdmin(d, granter_);
        _grantWeightSetter(d, granter_);
        _grantReceiptRelease(d);
    }

    /// @dev Router `ADMIN_ROLE`, so `setDefaultWeights` forwards. Read back.
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

    /// @dev Router `WEIGHT_SETTER_ROLE`, the sole gate on `setWeights`, then drop
    ///      the granter's own copy so no key but RouterGovernance can set active
    ///      weights. Both effects are read back.
    function _grantWeightSetter(Deployed memory d, address granter_) internal {
        IAccessControl router = IAccessControl(address(d.router));
        bytes32 role = d.router.WEIGHT_SETTER_ROLE();
        address governance = address(d.governance);

        router.grantRole(role, governance);
        require(
            router.hasRole(role, governance),
            "RouterGovernance missing router WEIGHT_SETTER_ROLE: applyReceipt would revert in setWeights"
        );
        if (router.hasRole(role, granter_)) router.revokeRole(role, granter_);
        require(!router.hasRole(role, granter_), "deployer still holds router WEIGHT_SETTER_ROLE");
    }

    /// @dev Receipt `RECEIPT_RELEASER_ROLE`, so `applyReceipt` can release the receipt it
    ///      applies in the same call. Read back. The granter holds the receipt `ADMIN_ROLE`
    ///      until the timelock stage.
    function _grantReceiptRelease(Deployed memory d) internal {
        IAccessControl(d.receipts).grantRole(RECEIPT_RELEASER_ROLE, address(d.governance));
        require(
            IAccessControl(d.receipts).hasRole(RECEIPT_RELEASER_ROLE, address(d.governance)),
            "RouterGovernance missing RECEIPT_RELEASER_ROLE: applyReceipt would revert in releaseReceipt"
        );
    }

    function _logResult(Deployed memory d) internal pure {
        console2.log("RouterGovernance deployed and configured");
        console2.log("  governance:", address(d.governance));
        console2.log("  router    :", address(d.router));
        console2.log("  receipts  :", d.receipts);
        console2.log("  admin     :", d.admin);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");

        string memory obj = "governance_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "governance", address(d.governance));
        vm.serializeAddress(obj, "governance_implementation", d.governanceImplementation);
        vm.serializeAddress(obj, "upgrade_timelock", d.upgrade.timelock);
        vm.serializeString(obj, "upgrade_mode", upgradeModeName(d.upgrade.mode));
        vm.serializeAddress(obj, "router", address(d.router));
        vm.serializeAddress(obj, "consensus_receipt", d.receipts);
        string memory json = vm.serializeAddress(obj, "admin", d.admin);

        vm.writeJson(json, outPath);
        console2.log("Wrote governance deployment JSON to", outPath);
    }
}
