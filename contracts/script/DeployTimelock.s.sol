// SPDX-License-Identifier: MIT
// Canonical: docs/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
// Implements: issue #414, issue #422
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";

/// @dev Minimal Safe interface — only `getThreshold()` is required for the
///      deploy-time guard that rejects EOA or low-threshold Safe addresses.
interface ISafeMinimal {
    function getThreshold() external view returns (uint256);
}

/// @title DeployTimelock
/// @notice Deploy an OZ TimelockController and transfer ADMIN_ROLE on all five
///         Robot Money contracts (RobotMoneyVault, RobotMoneyGateway,
///         VaultRegistry, PortfolioRouter, RouterGovernance) from the current
///         admin EOA to the TimelockController.
///
///         After this script runs:
///         - TimelockController holds ADMIN_ROLE on all five contracts.
///         - The Safe multisig (SAFE_ADDRESS) holds PROPOSER_ROLE and
///           EXECUTOR_ROLE on the TimelockController.
///         - Direct ADMIN_ROLE calls from any EOA revert with
///           AccessControlUnauthorizedAccount.
///         - Admin operations must be routed through
///           TimelockController.schedule → delay → execute.
///
///         Required env vars:
///           VAULT_ADDRESS          — RobotMoneyVault
///           GATEWAY_ADDRESS        — RobotMoneyGateway
///           REGISTRY_ADDRESS       — VaultRegistry
///           ROUTER_ADDRESS         — PortfolioRouter
///           GOVERNANCE_ADDRESS     — RouterGovernance
///           SAFE_ADDRESS           — Safe multisig (becomes PROPOSER + EXECUTOR)
///           TIMELOCK_MIN_DELAY     — minimum delay in seconds (e.g. 172800 = 2 days)
///
///         Optional env vars:
///           DEPLOYMENT_OUT         — output JSON path; default artifacts/timelock.json
///
/// @dev After deploying, the broadcaster (current ADMIN_ROLE holder) is no
///      longer the admin on any contract. Verify with:
///        cast call <vault> "hasRole(bytes32,address)" $(cast keccak "ADMIN_ROLE") <timelock>
contract DeployTimelock is Script {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    struct Deployed {
        TimelockController timelock;
        address vault;
        address gateway;
        address registry;
        address router;
        address governance;
        address safe;
        uint256 minDelay;
    }

    /// @notice Broadcast entrypoint. Reads env vars, deploys timelock, and
    ///         transfers ADMIN_ROLE on all five contracts.
    function run() external returns (Deployed memory d) {
        d.vault = vm.envAddress("VAULT_ADDRESS");
        d.gateway = vm.envAddress("GATEWAY_ADDRESS");
        d.registry = vm.envAddress("REGISTRY_ADDRESS");
        d.router = vm.envAddress("ROUTER_ADDRESS");
        d.governance = vm.envAddress("GOVERNANCE_ADDRESS");
        d.safe = vm.envAddress("SAFE_ADDRESS");
        d.minDelay = vm.envUint("TIMELOCK_MIN_DELAY");

        _validate(d);

        vm.startBroadcast();
        d.timelock = _deployAndWire(d);
        vm.stopBroadcast();

        _writeJson(d);
        _logResult(d);
    }

    /// @notice In-process variant for Forge tests. Caller sets up prank context.
    ///         No JSON is written; no env vars are read.
    function runInProcess(
        address vault_,
        address gateway_,
        address registry_,
        address router_,
        address governance_,
        address safe_,
        uint256 minDelay_
    ) external returns (Deployed memory d) {
        d.vault = vault_;
        d.gateway = gateway_;
        d.registry = registry_;
        d.router = router_;
        d.governance = governance_;
        d.safe = safe_;
        d.minDelay = minDelay_;

        _validate(d);
        d.timelock = _deployAndWire(d);
    }

    // ─── Internal ──────────────────────────────────────────────────────────────

    function _validate(Deployed memory d) internal view {
        require(d.vault != address(0), "VAULT_ADDRESS=0");
        require(d.gateway != address(0), "GATEWAY_ADDRESS=0");
        require(d.registry != address(0), "REGISTRY_ADDRESS=0");
        require(d.router != address(0), "ROUTER_ADDRESS=0");
        require(d.governance != address(0), "GOVERNANCE_ADDRESS=0");
        require(d.safe != address(0), "SAFE_ADDRESS=0");
        require(d.minDelay > 0, "TIMELOCK_MIN_DELAY=0");

        // AC: SAFE_ADDRESS must have deployed bytecode (not an EOA).
        // An EOA at SAFE_ADDRESS would let a single private key control all
        // ADMIN_ROLE operations — defeating the multisig security model.
        require(
            d.safe.code.length > 0, "SAFE_ADDRESS is an EOA: deploy a Safe multisig contract first"
        );

        // AC: The Safe at SAFE_ADDRESS must have threshold >= 2.
        // A 1-of-N threshold provides no meaningful quorum protection.
        uint256 threshold = ISafeMinimal(d.safe).getThreshold();
        require(threshold >= 2, "SAFE_ADDRESS threshold < 2: configure at least 2-of-N quorum");
    }

    function _deployAndWire(Deployed memory d) internal returns (TimelockController timelock) {
        // 1. Deploy TimelockController.
        //    proposers = [safe], executors = [safe], admin = address(0)
        //    admin = address(0) means the timelock is self-administered
        //    (the safe can change delay/roles only through the timelock).
        address[] memory proposers = new address[](1);
        proposers[0] = d.safe;
        address[] memory executors = new address[](1);
        executors[0] = d.safe;

        timelock = new TimelockController(d.minDelay, proposers, executors, address(0));

        // 2. Grant ADMIN_ROLE to the timelock on all five contracts, then
        //    revoke ADMIN_ROLE from msg.sender (the deployer).
        //    Order: grant → verify → revoke to ensure we never lose admin.

        // RobotMoneyVault
        IAccessControl(d.vault).grantRole(ADMIN_ROLE, address(timelock));
        require(
            IAccessControl(d.vault).hasRole(ADMIN_ROLE, address(timelock)),
            "Timelock missing ADMIN_ROLE on vault"
        );
        IAccessControl(d.vault).revokeRole(ADMIN_ROLE, msg.sender);
        require(
            !IAccessControl(d.vault).hasRole(ADMIN_ROLE, msg.sender),
            "Deployer still has ADMIN_ROLE on vault"
        );

        // RobotMoneyGateway
        IAccessControl(d.gateway).grantRole(ADMIN_ROLE, address(timelock));
        require(
            IAccessControl(d.gateway).hasRole(ADMIN_ROLE, address(timelock)),
            "Timelock missing ADMIN_ROLE on gateway"
        );
        IAccessControl(d.gateway).revokeRole(ADMIN_ROLE, msg.sender);
        require(
            !IAccessControl(d.gateway).hasRole(ADMIN_ROLE, msg.sender),
            "Deployer still has ADMIN_ROLE on gateway"
        );

        // VaultRegistry
        IAccessControl(d.registry).grantRole(ADMIN_ROLE, address(timelock));
        require(
            IAccessControl(d.registry).hasRole(ADMIN_ROLE, address(timelock)),
            "Timelock missing ADMIN_ROLE on registry"
        );
        IAccessControl(d.registry).revokeRole(ADMIN_ROLE, msg.sender);
        require(
            !IAccessControl(d.registry).hasRole(ADMIN_ROLE, msg.sender),
            "Deployer still has ADMIN_ROLE on registry"
        );

        // PortfolioRouter
        IAccessControl(d.router).grantRole(ADMIN_ROLE, address(timelock));
        require(
            IAccessControl(d.router).hasRole(ADMIN_ROLE, address(timelock)),
            "Timelock missing ADMIN_ROLE on router"
        );
        IAccessControl(d.router).revokeRole(ADMIN_ROLE, msg.sender);
        require(
            !IAccessControl(d.router).hasRole(ADMIN_ROLE, msg.sender),
            "Deployer still has ADMIN_ROLE on router"
        );

        // RouterGovernance
        IAccessControl(d.governance).grantRole(ADMIN_ROLE, address(timelock));
        require(
            IAccessControl(d.governance).hasRole(ADMIN_ROLE, address(timelock)),
            "Timelock missing ADMIN_ROLE on governance"
        );
        IAccessControl(d.governance).revokeRole(ADMIN_ROLE, msg.sender);
        require(
            !IAccessControl(d.governance).hasRole(ADMIN_ROLE, msg.sender),
            "Deployer still has ADMIN_ROLE on governance"
        );
    }

    function _logResult(Deployed memory d) internal pure {
        console2.log("TimelockController deployed and ADMIN_ROLE transferred on all five contracts");
        console2.log("  timelock    :", address(d.timelock));
        console2.log("  safe        :", d.safe);
        console2.log("  min_delay   :", d.minDelay);
        console2.log("  vault       :", d.vault);
        console2.log("  gateway     :", d.gateway);
        console2.log("  registry    :", d.registry);
        console2.log("  router      :", d.router);
        console2.log("  governance  :", d.governance);
    }

    function _writeJson(Deployed memory d) internal {
        string memory outPath;
        try vm.envString("DEPLOYMENT_OUT") returns (string memory s) {
            outPath = s;
        } catch {
            outPath = "artifacts/timelock.json";
        }

        string memory obj = "timelock";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "timelock", address(d.timelock));
        vm.serializeAddress(obj, "safe", d.safe);
        vm.serializeUint(obj, "min_delay", d.minDelay);
        vm.serializeAddress(obj, "vault", d.vault);
        vm.serializeAddress(obj, "gateway", d.gateway);
        vm.serializeAddress(obj, "registry", d.registry);
        vm.serializeAddress(obj, "router", d.router);
        string memory json = vm.serializeAddress(obj, "governance", d.governance);

        vm.writeJson(json, outPath);
        console2.log("Wrote timelock deployment JSON to", outPath);
    }
}
