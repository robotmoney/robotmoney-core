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

/// @dev Minimal gateway agent surface used to hand deployer-owned agents to
///      the timelock (issue #1476).
interface IGatewayAgentOwnership {
    function agentOwner(address agent) external view returns (address);
    function transferAgentOwnership(address agent, address newOwner) external;
}

/// @title DeployTimelock
/// @dev Minimal read surface on RouterGovernance, so the manifest can record
///      the quorum the topology actually landed on without importing the whole
///      contract into this script.
interface IRouterGovernanceQuorum {
    function quorumThreshold() external view returns (uint256);
    function MIN_QUORUM_THRESHOLD() external view returns (uint256);
}

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
///         - Every gateway agent listed in AGENT_ADDRESSES is owned by the
///           TimelockController, not the deployer, and still holds AGENT_ROLE
///           (issue #1476). setPolicy / revokeAgent on those agents go
///           Safe -> Timelock -> gateway. The guarantee covers the listed
///           agents only: the gateway cannot enumerate an owner's agents, so
///           the list must name every agent the deployer owns (the stage
///           ceremony derives it from the gateway's AgentAuthorized logs).
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
///           IC_POLICY_ADDRESS      — InvestmentCommitteePolicy (issue #1319, one-
///                                    ceremony rule #1247 AC10 / INV-3). When set,
///                                    the same grant→verify→revoke handover runs on
///                                    it: ADMIN_ROLE + DEFAULT_ADMIN_ROLE move to the
///                                    timelock and are revoked from the deployer EOA
///                                    (the ADMIN_ADDRESS DeployInvestmentCommitteePolicy
///                                    granted them to). The gateway's ADMIN_ROLE on the
///                                    IC policy — granted separately so it can forward
///                                    committeeRegister calls — is untouched.
///           CONSENSUS_RECEIPT_ADDRESS — ConsensusRecommendationReceipt (issue #1319,
///                                    same rule). When set, ADMIN_ROLE +
///                                    DEFAULT_ADMIN_ROLE move to the timelock.
///           AGENT_ADDRESSES        — comma-separated gateway agents the deployer
///                                    owns (issue #1476): the deploy agent from
///                                    Deploy.s.sol, the stage ceremony's submitter.
///                                    Each is handed to the timelock with
///                                    transferAgentOwnership while the timelock
///                                    already holds gateway ADMIN_ROLE and before
///                                    the deployer's ADMIN_ROLE is revoked. Every
///                                    entry must be owned by the deployer, or the
///                                    handover reverts. Required, with no default:
///                                    an unset or empty value reverts before any
///                                    broadcast, and the literal `none` declares
///                                    a run whose deployer owns no gateway agent.
///           RECEIPT_ADMIN_ADDRESS  — the address that currently holds ADMIN_ROLE /
///                                    DEFAULT_ADMIN_ROLE on the receipt contract (the
///                                    RECEIPT_ADMIN_ADDRESS DeployInvestmentCommittee-
///                                    Policy granted them to — not necessarily the
///                                    deployer EOA). Only meaningful when
///                                    CONSENSUS_RECEIPT_ADDRESS is set; revoked from
///                                    here instead of msg.sender. Defaults to
///                                    msg.sender when unset.
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
        address icPolicy;
        address consensusReceipt;
        address receiptAdmin;
        /// Deployer-owned gateway agents handed to the timelock (issue #1476).
        address[] agents;
    }

    /// @notice Broadcast entrypoint. Reads env vars, deploys timelock, and
    ///         transfers ADMIN_ROLE on all five contracts (plus the optional
    ///         IC policy / consensus receipt handover — issue #1319).
    function run() external returns (Deployed memory d) {
        // Read first, so a run that leaves the list out stops on that input.
        d.agents = _readAgentList("AGENT_ADDRESSES");
        d.vault = vm.envAddress("VAULT_ADDRESS");
        d.gateway = vm.envAddress("GATEWAY_ADDRESS");
        d.registry = vm.envAddress("REGISTRY_ADDRESS");
        d.router = vm.envAddress("ROUTER_ADDRESS");
        d.governance = vm.envAddress("GOVERNANCE_ADDRESS");
        d.safe = vm.envAddress("SAFE_ADDRESS");
        d.emergency = vm.envAddress("EMERGENCY_ADDRESS");
        d.minDelay = vm.envUint("TIMELOCK_MIN_DELAY");
        d.icPolicy = vm.envOr("IC_POLICY_ADDRESS", address(0));
        d.consensusReceipt = vm.envOr("CONSENSUS_RECEIPT_ADDRESS", address(0));
        d.receiptAdmin = vm.envOr("RECEIPT_ADMIN_ADDRESS", address(0));

        _validate(d);

        vm.startBroadcast();
        d.timelock = _deployAndWire(d);
        vm.stopBroadcast();

        _writeJson(d);
        _logResult(d);
    }

    /// @notice In-process variant for Forge tests. Caller sets up prank context.
    ///         No JSON is written; no env vars are read. Does not exercise the
    ///         optional IC policy / consensus receipt handover — use
    ///         `runInProcessWithCommittee` for that. Hands over no gateway
    ///         agent — use `runInProcessWithAgents` for that.
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

    /// @notice In-process variant that also exercises the optional IC policy /
    ///         consensus receipt handover (issue #1319). Caller sets up prank
    ///         context. No JSON is written; no env vars are read.
    /// @param icPolicy_        InvestmentCommitteePolicy address, or address(0) to skip.
    /// @param consensusReceipt_ ConsensusRecommendationReceipt address, or address(0) to skip.
    /// @param receiptAdmin_    Current holder of ADMIN_ROLE/DEFAULT_ADMIN_ROLE on the
    ///                         receipt contract (RECEIPT_ADMIN_ADDRESS at its
    ///                         construction); address(0) defaults to msg.sender.
    function runInProcessWithCommittee(
        address vault_,
        address gateway_,
        address registry_,
        address router_,
        address governance_,
        address safe_,
        address emergency_,
        uint256 minDelay_,
        address icPolicy_,
        address consensusReceipt_,
        address receiptAdmin_
    ) external returns (Deployed memory d) {
        d.vault = vault_;
        d.gateway = gateway_;
        d.registry = registry_;
        d.router = router_;
        d.governance = governance_;
        d.safe = safe_;
        d.emergency = emergency_;
        d.minDelay = minDelay_;
        d.icPolicy = icPolicy_;
        d.consensusReceipt = consensusReceipt_;
        d.receiptAdmin = receiptAdmin_;

        _validate(d);
        d.timelock = _deployAndWire(d);
    }

    /// @notice In-process variant that also hands the listed deployer-owned
    ///         gateway agents to the timelock (issue #1476), the in-process
    ///         form of AGENT_ADDRESSES. Caller sets up prank context. No JSON
    ///         is written; no env vars are read.
    /// @param agents_ Gateway agents the deployer (the caller) owns.
    function runInProcessWithAgents(
        address vault_,
        address gateway_,
        address registry_,
        address router_,
        address governance_,
        address safe_,
        address emergency_,
        uint256 minDelay_,
        address[] calldata agents_
    ) external returns (Deployed memory d) {
        d.vault = vault_;
        d.gateway = gateway_;
        d.registry = registry_;
        d.router = router_;
        d.governance = governance_;
        d.safe = safe_;
        d.emergency = emergency_;
        d.minDelay = minDelay_;
        d.agents = agents_;

        _validate(d);
        d.timelock = _deployAndWire(d);
    }

    // ─── Internal ──────────────────────────────────────────────────────────────

    /// @dev The deployer-owned gateway agent list from env var `name` (issue
    ///      #1476). The variable must be set: a comma-separated list of
    ///      agents, or the literal `none` for a run whose deployer owns no
    ///      gateway agent. An unset or empty variable reverts, so a broadcast
    ///      run never treats a missing list as an empty one.
    function _readAgentList(string memory name) internal view returns (address[] memory) {
        require(
            vm.envExists(name),
            "AGENT_ADDRESSES must be set: the deployer-owned gateway agents, comma-separated, or none"
        );
        string memory raw = vm.envString(name);
        require(
            bytes(raw).length != 0,
            "AGENT_ADDRESSES is empty: list the deployer-owned gateway agents, or set none"
        );
        if (keccak256(bytes(raw)) == keccak256("none")) return new address[](0);
        return vm.envAddress(name, ",");
    }

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
        // Issue #1476: agent ownership carries setPolicy / revokeAgent authority,
        // so deployer-owned agents move to the timelock as part of the handover.
        // transferAgentOwnership only accepts an ADMIN_ROLE destination, so this
        // runs after the timelock's grant above and before the deployer's revoke
        // below. The agents keep AGENT_ROLE and their stored policy.
        _transferAgents(d, address(timelock));
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
        // Post-condition, read after the deployer lost every gateway role: no
        // listed agent is deployer-owned, and each still holds AGENT_ROLE.
        for (uint256 i = 0; i < d.agents.length; i++) {
            require(
                IGatewayAgentOwnership(d.gateway).agentOwner(d.agents[i]) != msg.sender,
                "Deployer still owns a listed gateway agent"
            );
            require(
                IAccessControl(d.gateway).hasRole(AGENT_ROLE, d.agents[i]),
                "Listed gateway agent lost AGENT_ROLE"
            );
        }

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
        //
        // R7 / §4.3: the router's ADMIN_ROLE is what gates `setWeights`, so
        // this block decides who can move allocation weights afterwards. Two
        // conditions must BOTH hold when it finishes, and neither is implied
        // by the other:
        //
        //   (a) RouterGovernance holds the role, or the approving body can
        //       approve and cannot act — every proposal that reaches quorum
        //       reverts inside `execute()`;
        //   (b) the deployer EOA does NOT hold it, or a single key can move
        //       weights directly and the whole propose/vote/delay path is
        //       decorative.
        //
        // Before the grant is asserted, because a governance contract that
        // cannot act is a broken deployment, not a safer one.
        require(
            IAccessControl(d.router).hasRole(ADMIN_ROLE, d.governance),
            "R7: RouterGovernance lacks router ADMIN_ROLE - execute() cannot reach setWeights"
        );

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

        // (b), stated as the capability rather than as the role: after this
        // point `setWeights` from the deployer EOA reverts. `setWeights` is
        // `onlyRole(ADMIN_ROLE)` on the router, so the role read IS the
        // capability — asserted separately from the revoke above so the
        // failure message names what an operator actually cares about.
        require(
            !IAccessControl(d.router).hasRole(ADMIN_ROLE, msg.sender),
            "R7: deployer EOA can still call router.setWeights directly"
        );
        // And the grant survived the handover: nothing above touched it, but
        // this is the invariant the ceremony exists to establish, so read it
        // back at the end rather than trusting the order of the lines.
        require(
            IAccessControl(d.router).hasRole(ADMIN_ROLE, d.governance),
            "R7: RouterGovernance lost router ADMIN_ROLE during handover"
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

        // InvestmentCommitteePolicy (optional — issue #1319, one-ceremony rule
        // #1247 AC10 / INV-3).
        //
        // DeployInvestmentCommitteePolicy grants DEFAULT_ADMIN_ROLE + ADMIN_ROLE
        // on the IC policy to ADMIN_ADDRESS, the same deployer EOA that runs this
        // script (msg.sender here). Mirror the five-core-contract handover
        // exactly. The gateway separately holds ADMIN_ROLE on the IC policy
        // (granted at wiring time so it can forward committeeRegister calls) —
        // that is a second, intentional holder and is left untouched.
        if (d.icPolicy != address(0)) {
            IAccessControl(d.icPolicy).grantRole(ADMIN_ROLE, address(timelock));
            require(
                IAccessControl(d.icPolicy).hasRole(ADMIN_ROLE, address(timelock)),
                "Timelock missing ADMIN_ROLE on IC policy"
            );
            IAccessControl(d.icPolicy).grantRole(DEFAULT_ADMIN_ROLE, address(timelock));
            require(
                IAccessControl(d.icPolicy).hasRole(DEFAULT_ADMIN_ROLE, address(timelock)),
                "Timelock missing DEFAULT_ADMIN_ROLE on IC policy"
            );
            IAccessControl(d.icPolicy).revokeRole(ADMIN_ROLE, msg.sender);
            require(
                !IAccessControl(d.icPolicy).hasRole(ADMIN_ROLE, msg.sender),
                "Deployer still has ADMIN_ROLE on IC policy"
            );
            IAccessControl(d.icPolicy).revokeRole(DEFAULT_ADMIN_ROLE, msg.sender);
            require(
                !IAccessControl(d.icPolicy).hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
                "Deployer still has DEFAULT_ADMIN_ROLE on IC policy"
            );
        }

        // ConsensusRecommendationReceipt (optional — issue #1319, same rule).
        //
        // DeployInvestmentCommitteePolicy grants DEFAULT_ADMIN_ROLE + ADMIN_ROLE
        // on the receipt contract to RECEIPT_ADMIN_ADDRESS, which is NOT
        // necessarily the deployer EOA (it defaults to ADMIN_ADDRESS for devnet
        // ceremonies but may be configured independently). Resolve the actual
        // current holder (d.receiptAdmin, defaulting to msg.sender when unset)
        // and revoke from there instead of assuming msg.sender.
        if (d.consensusReceipt != address(0)) {
            address currentReceiptAdmin = d.receiptAdmin == address(0) ? msg.sender : d.receiptAdmin;
            IAccessControl(d.consensusReceipt).grantRole(ADMIN_ROLE, address(timelock));
            require(
                IAccessControl(d.consensusReceipt).hasRole(ADMIN_ROLE, address(timelock)),
                "Timelock missing ADMIN_ROLE on consensus receipt"
            );
            IAccessControl(d.consensusReceipt).grantRole(DEFAULT_ADMIN_ROLE, address(timelock));
            require(
                IAccessControl(d.consensusReceipt).hasRole(DEFAULT_ADMIN_ROLE, address(timelock)),
                "Timelock missing DEFAULT_ADMIN_ROLE on consensus receipt"
            );
            IAccessControl(d.consensusReceipt).revokeRole(ADMIN_ROLE, currentReceiptAdmin);
            require(
                !IAccessControl(d.consensusReceipt).hasRole(ADMIN_ROLE, currentReceiptAdmin),
                "Configured receipt admin still has ADMIN_ROLE on consensus receipt"
            );
            IAccessControl(d.consensusReceipt).revokeRole(DEFAULT_ADMIN_ROLE, currentReceiptAdmin);
            require(
                !IAccessControl(d.consensusReceipt)
                    .hasRole(DEFAULT_ADMIN_ROLE, currentReceiptAdmin),
                "Configured receipt admin still has DEFAULT_ADMIN_ROLE on consensus receipt"
            );
        }
    }

    /// @dev Hand every listed agent from the deployer (msg.sender) to `timelock`.
    ///      A listed agent the deployer does not own is an input error and
    ///      reverts before any transfer of it is attempted.
    function _transferAgents(Deployed memory d, address timelock) internal {
        for (uint256 i = 0; i < d.agents.length; i++) {
            address agent = d.agents[i];
            require(agent != address(0), "AGENT_ADDRESSES entry is address(0)");
            require(
                IGatewayAgentOwnership(d.gateway).agentOwner(agent) == msg.sender,
                "AGENT_ADDRESSES entry is not owned by the deployer"
            );
            IGatewayAgentOwnership(d.gateway).transferAgentOwnership(agent, timelock);
            require(
                IGatewayAgentOwnership(d.gateway).agentOwner(agent) == timelock,
                "Timelock does not own a listed gateway agent after transfer"
            );
        }
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
        if (d.icPolicy != address(0)) {
            console2.log("  ic_policy   :", d.icPolicy);
        }
        if (d.consensusReceipt != address(0)) {
            console2.log("  consensus_receipt :", d.consensusReceipt);
        }
        for (uint256 i = 0; i < d.agents.length; i++) {
            console2.log("  agent -> timelock :", d.agents[i]);
        }
    }

    /// @dev The deployment manifest (R7). One JSON, four sections:
    ///      chain id, addresses, code hashes and the role table — so an
    ///      auditor reading it later can answer "which bytecode, at which
    ///      address, holding which role, on which chain" without a second
    ///      artifact and without an archive node. The code hashes are read
    ///      from the chain (`address.codehash`), not from build artifacts, so
    ///      the manifest describes what was actually deployed rather than what
    ///      the local `out/` directory happened to contain.
    function _writeJson(Deployed memory d) internal {
        string memory outPath;
        try vm.envString("DEPLOYMENT_OUT") returns (string memory s) {
            outPath = s;
        } catch {
            outPath = "artifacts/timelock.json";
        }
        _writeJsonTo(d, outPath);
    }

    /// @dev Writes the manifest `_writeJson` describes to `outPath`. Kept apart
    ///      from the `DEPLOYMENT_OUT` read so a caller can name the path
    ///      without setting a process-wide variable.
    function _writeJsonTo(Deployed memory d, string memory outPath) internal {
        string memory addrs = "manifest_addresses";
        vm.serializeAddress(addrs, "timelock", address(d.timelock));
        vm.serializeAddress(addrs, "safe", d.safe);
        vm.serializeAddress(addrs, "emergency", d.emergency);
        vm.serializeAddress(addrs, "vault", d.vault);
        vm.serializeAddress(addrs, "gateway", d.gateway);
        vm.serializeAddress(addrs, "registry", d.registry);
        vm.serializeAddress(addrs, "router", d.router);
        vm.serializeAddress(addrs, "ic_policy", d.icPolicy);
        vm.serializeAddress(addrs, "consensus_receipt", d.consensusReceipt);
        string memory addrsJson = vm.serializeAddress(addrs, "governance", d.governance);

        string memory hashes = "manifest_code_hashes";
        vm.serializeBytes32(hashes, "timelock", address(d.timelock).codehash);
        vm.serializeBytes32(hashes, "safe", d.safe.codehash);
        vm.serializeBytes32(hashes, "vault", d.vault.codehash);
        vm.serializeBytes32(hashes, "gateway", d.gateway.codehash);
        vm.serializeBytes32(hashes, "registry", d.registry.codehash);
        vm.serializeBytes32(hashes, "router", d.router.codehash);
        vm.serializeBytes32(hashes, "ic_policy", d.icPolicy.codehash);
        vm.serializeBytes32(hashes, "consensus_receipt", d.consensusReceipt.codehash);
        string memory hashesJson = vm.serializeBytes32(hashes, "governance", d.governance.codehash);

        string memory rolesJson = _serializeRoles(d);

        string memory obj = "timelock";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeUint(obj, "min_delay", d.minDelay);
        vm.serializeUint(
            obj, "quorum_threshold", IRouterGovernanceQuorum(d.governance).quorumThreshold()
        );
        vm.serializeUint(
            obj,
            "min_quorum_threshold",
            IRouterGovernanceQuorum(d.governance).MIN_QUORUM_THRESHOLD()
        );
        // Kept flat as well as inside `addresses`: existing readers (the
        // smoke-test fixture, the explorer env writer) index this file by these
        // top-level keys, and a manifest that breaks them is a manifest nobody
        // reads.
        vm.serializeAddress(obj, "timelock", address(d.timelock));
        vm.serializeAddress(obj, "safe", d.safe);
        vm.serializeAddress(obj, "emergency", d.emergency);
        vm.serializeAddress(obj, "vault", d.vault);
        vm.serializeAddress(obj, "gateway", d.gateway);
        vm.serializeAddress(obj, "registry", d.registry);
        vm.serializeAddress(obj, "router", d.router);
        vm.serializeAddress(obj, "governance", d.governance);
        vm.serializeString(obj, "addresses", addrsJson);
        vm.serializeString(obj, "code_hashes", hashesJson);
        // Issue #1476: the gateway agents this run handed to the timelock.
        vm.serializeAddress(obj, "timelock_owned_agents", d.agents);
        string memory json = vm.serializeString(obj, "roles", rolesJson);

        vm.writeJson(json, outPath);
        console2.log("Wrote timelock deployment manifest to", outPath);
    }

    /// @dev The role table, read back from the chain after the handover.
    ///      Every entry is a live `hasRole` read, so a manifest that records
    ///      the intended topology instead of the actual one cannot be written.
    function _serializeRoles(Deployed memory d) internal returns (string memory) {
        string memory roles = "manifest_roles";

        // Who administers each contract now.
        vm.serializeAddress(roles, "admin_role_holder", address(d.timelock));

        // The two R7 conditions, recorded as booleans an auditor can grep.
        vm.serializeBool(
            roles,
            "governance_has_router_admin_role",
            IAccessControl(d.router).hasRole(ADMIN_ROLE, d.governance)
        );
        vm.serializeBool(
            roles,
            "deployer_has_router_admin_role",
            IAccessControl(d.router).hasRole(ADMIN_ROLE, msg.sender)
        );
        vm.serializeBool(
            roles,
            "timelock_has_router_admin_role",
            IAccessControl(d.router).hasRole(ADMIN_ROLE, address(d.timelock))
        );
        vm.serializeBool(
            roles,
            "timelock_has_governance_admin_role",
            IAccessControl(d.governance).hasRole(ADMIN_ROLE, address(d.timelock))
        );
        vm.serializeBool(
            roles,
            "timelock_has_vault_admin_role",
            IAccessControl(d.vault).hasRole(ADMIN_ROLE, address(d.timelock))
        );
        vm.serializeBool(
            roles,
            "timelock_has_registry_admin_role",
            IAccessControl(d.registry).hasRole(ADMIN_ROLE, address(d.timelock))
        );
        vm.serializeBool(
            roles,
            "timelock_has_gateway_default_admin_role",
            IAccessControl(d.gateway).hasRole(DEFAULT_ADMIN_ROLE, address(d.timelock))
        );
        vm.serializeBool(
            roles,
            "emergency_key_has_vault_emergency_role",
            IAccessControl(d.vault).hasRole(EMERGENCY_ROLE, d.emergency)
        );
        vm.serializeBool(
            roles,
            "deployer_has_vault_emergency_role",
            IAccessControl(d.vault).hasRole(EMERGENCY_ROLE, msg.sender)
        );
        // Issue #1476: read live, so the manifest cannot claim a transfer that
        // did not land.
        bool deployerOwnsListedAgent;
        for (uint256 i = 0; i < d.agents.length; i++) {
            if (IGatewayAgentOwnership(d.gateway).agentOwner(d.agents[i]) == msg.sender) {
                deployerOwnsListedAgent = true;
            }
        }
        vm.serializeBool(roles, "deployer_owns_a_listed_gateway_agent", deployerOwnsListedAgent);
        // The bool above covers the listed agents only; the count says how many
        // that is, so an empty list does not read as a checked one.
        vm.serializeUint(roles, "gateway_agents_listed_count", d.agents.length);

        // The Safe's standing on the timelock itself.
        vm.serializeBool(
            roles,
            "safe_is_timelock_proposer",
            d.timelock.hasRole(d.timelock.PROPOSER_ROLE(), d.safe)
        );
        return vm.serializeBool(
            roles,
            "safe_is_timelock_executor",
            d.timelock.hasRole(d.timelock.EXECUTOR_ROLE(), d.safe)
        );
    }
}
