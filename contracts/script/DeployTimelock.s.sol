// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
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

/// @dev Minimal vault interface used to link the registry into the vault so the
///      unified governance `retire()` action (DI-2) can drive the vault's
///      deposit-halt leg. `setRegistry` is set-once and ADMIN_ROLE-gated.
interface IRetirableVaultLink {
    function setRegistry(address newRegistry) external;
    function registry() external view returns (address);
}

/// @title DeployTimelock
/// @notice Deploy an OZ TimelockController and complete the privileged-role
///         handover on all five Robot Money contracts (RobotMoneyVault,
///         RobotMoneyGateway, VaultRegistry, PortfolioRouter, RouterGovernance)
///         from the deployer EOA to the TimelockController + an independent
///         emergency hot key.
///
///         After this script runs (ACL-1 / F-01):
///         - TimelockController holds ADMIN_ROLE on all five contracts AND the
///           Gateway DEFAULT_ADMIN_ROLE (so it can rotate roles / authorizeAgent).
///         - The deployer EOA holds NO privileged role of any kind:
///           no ADMIN_ROLE on any contract, no Gateway DEFAULT_ADMIN_ROLE, and
///           no vault EMERGENCY_ROLE.
///         - The vault EMERGENCY_ROLE is held by the independent EMERGENCY_ADDRESS
///           hot key, not the deployer.
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
///           EMERGENCY_ADDRESS      — independent hot key that receives the vault
///                                    EMERGENCY_ROLE (must differ from the deployer
///                                    EOA; ACL-1 / F-01)
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
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    /// @dev OZ `AccessControl.DEFAULT_ADMIN_ROLE` is `bytes32(0)`.
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    struct Deployed {
        TimelockController timelock;
        address vault;
        address gateway;
        address registry;
        address router;
        address governance;
        address safe;
        address emergency;
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
        d.emergency = vm.envAddress("EMERGENCY_ADDRESS");
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
        address emergency_,
        uint256 minDelay_
    ) external returns (Deployed memory d) {
        d.vault = vault_;
        d.gateway = gateway_;
        d.registry = registry_;
        d.router = router_;
        d.governance = governance_;
        d.safe = safe_;
        d.emergency = emergency_;
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
        require(d.emergency != address(0), "EMERGENCY_ADDRESS=0");
        require(d.minDelay > 0, "TIMELOCK_MIN_DELAY=0");

        // ACL-1 / F-01: the emergency hot key must be independent of the deployer
        // EOA. After handover the deployer holds NO privileged role; routing the
        // vault EMERGENCY_ROLE back to the deployer would re-create the very
        // EOA-retains-a-privileged-role gap this script closes.
        require(d.emergency != msg.sender, "EMERGENCY_ADDRESS == deployer EOA");

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

        // ACL-7 / NC-10: GATE THE GRANT-DoS. The Gateway's agent registration is
        // permissionless (anyone may `commitAuthorization`/`revealAuthorization`),
        // and the role-separation invariant forbids one account from holding both
        // AGENT_ROLE and an ADMIN/PAUSER-tier role. An attacker who front-runs the
        // handover by pre-binding an INTENDED admin/pauser address as an AGENT
        // would make the subsequent `grantRole(ADMIN_ROLE, …)` revert with
        // `RoleSeparationViolated`, bricking the handover with a confusing,
        // late-stage failure.
        //
        // Assert UP FRONT — before any gateway grant — that every address about to
        // receive an ADMIN/PAUSER-tier role on the Gateway is AGENT-free. The
        // freshly-deployed `timelock` cannot have been pre-bound, but we assert it
        // anyway (defence in depth and a clear, typed early failure). This turns a
        // griefing vector into an explicit deploy-time precondition.
        require(
            !IAccessControl(d.gateway).hasRole(AGENT_ROLE, address(timelock)),
            "ACL-7: timelock pre-bound as gateway AGENT - handover would brick"
        );
        require(
            !IAccessControl(d.gateway).hasRole(AGENT_ROLE, d.safe),
            "ACL-7: safe pre-bound as gateway AGENT - handover would brick"
        );

        // 2. Grant ADMIN_ROLE to the timelock on all five contracts, then
        //    revoke ADMIN_ROLE from msg.sender (the deployer).
        //    Order: grant → verify → revoke to ensure we never lose admin.

        // Link the registry to the vault so the unified governance retire action
        // (VaultRegistry.retire) can drive the vault's deposit-halt leg. This is
        // the set-once ADMIN_ROLE-gated `setRegistry`, so it must run while the
        // deployer still holds ADMIN_ROLE on the vault (i.e. before the revoke
        // below). The vault gates `retire()`/`unretire()` to this registry only.
        IRetirableVaultLink(d.vault).setRegistry(d.registry);
        require(
            IRetirableVaultLink(d.vault).registry() == d.registry, "Vault registry link not set"
        );

        // RobotMoneyVault
        //
        // ACL-1 / F-01: the deployer EOA also holds the vault EMERGENCY_ROLE
        // (granted as `_emergencyResponder` at construction). Move it to the
        // independent emergency hot key, then revoke it from the deployer, BEFORE
        // revoking the deployer's ADMIN_ROLE — EMERGENCY_ROLE's admin is
        // ADMIN_ROLE (see RobotMoneyVault `_setRoleAdmin`), so the deployer must
        // still hold ADMIN_ROLE to perform the grant/revoke. After this block no
        // EOA except the dedicated emergency hot key holds any vault role.
        IAccessControl(d.vault).grantRole(EMERGENCY_ROLE, d.emergency);
        require(
            IAccessControl(d.vault).hasRole(EMERGENCY_ROLE, d.emergency),
            "Emergency key missing EMERGENCY_ROLE on vault"
        );
        IAccessControl(d.vault).revokeRole(EMERGENCY_ROLE, msg.sender);
        require(
            !IAccessControl(d.vault).hasRole(EMERGENCY_ROLE, msg.sender),
            "Deployer still has EMERGENCY_ROLE on vault"
        );

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
        //
        // ACL-1 / F-01: unlike the other four contracts (whose roles are all
        // administered by ADMIN_ROLE), the Gateway grants the deployer
        // DEFAULT_ADMIN_ROLE at construction, and every Gateway role's admin —
        // except AGENT_ROLE, redirected to ADMIN_ROLE in the constructor — is
        // DEFAULT_ADMIN_ROLE. A naked ADMIN_ROLE-only handover would leave the
        // deployer EOA holding the Gateway root (re-grant ADMIN, mint rogue
        // agents, block the Timelock from rotating roles). So hand over BOTH
        // ADMIN_ROLE and DEFAULT_ADMIN_ROLE to the Timelock and revoke both from
        // the deployer.
        //
        // Fix-interaction (audit F-01): the AGENT_ROLE re-admin to ADMIN_ROLE is
        // performed in the Gateway constructor, so revoking DEFAULT_ADMIN_ROLE
        // here does NOT brick agent onboarding — the Timelock (ADMIN_ROLE) can
        // still `authorizeAgent` / grant AGENT_ROLE.
        IAccessControl(d.gateway).grantRole(ADMIN_ROLE, address(timelock));
        require(
            IAccessControl(d.gateway).hasRole(ADMIN_ROLE, address(timelock)),
            "Timelock missing ADMIN_ROLE on gateway"
        );
        IAccessControl(d.gateway).grantRole(DEFAULT_ADMIN_ROLE, address(timelock));
        require(
            IAccessControl(d.gateway).hasRole(DEFAULT_ADMIN_ROLE, address(timelock)),
            "Timelock missing DEFAULT_ADMIN_ROLE on gateway"
        );
        IAccessControl(d.gateway).revokeRole(ADMIN_ROLE, msg.sender);
        require(
            !IAccessControl(d.gateway).hasRole(ADMIN_ROLE, msg.sender),
            "Deployer still has ADMIN_ROLE on gateway"
        );
        IAccessControl(d.gateway).revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
        require(
            !IAccessControl(d.gateway).hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "Deployer still has DEFAULT_ADMIN_ROLE on gateway"
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
        console2.log("  emergency   :", d.emergency);
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
        vm.serializeAddress(obj, "emergency", d.emergency);
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
