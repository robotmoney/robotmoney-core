// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
// Implements: issue #414, issue #422
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    IAccessControlEnumerable
} from "@openzeppelin/contracts/access/extensions/IAccessControlEnumerable.sol";

import {ProposerFloorTimelock} from "../ProposerFloorTimelock.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {UpgradeAuthority} from "./UpgradeAuthority.sol";
import {GovernedUUPS} from "../lib/GovernedUUPS.sol";

/// @dev Safe 1.4.1 read surface used by the full deploy-time Safe checks.
interface ISafeFull {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function isOwner(address owner) external view returns (bool);
    function VERSION() external view returns (string memory);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
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
///         handover on the Robot Money vaults-system contracts (RobotMoneyVault,
///         VaultRegistry, PortfolioRouter, RouterGovernance, ConsensusRecommendationReceipt)
///         from the deployer EOA to the TimelockController + an independent
///         emergency hot key.
///
///         After this script runs (ACL-1 / F-01):
///         - TimelockController holds ADMIN_ROLE on every vault, the registry, the router,
///           RouterGovernance and the consensus receipt. The deploy touches no gateway: the
///           gateway system has its own run and its own handover (issue 1892, SYS-1).
///         - The deployer EOA holds NO privileged role of any kind:
///           no ADMIN_ROLE on any contract and
///           no vault EMERGENCY_ROLE.
///         - The deploy registers no gateway agent and hands none over. An agent
///           is registered only by its depositor through commit/reveal consent
///           (ACL-9), so the handover carries no agent list.
///         - The vault EMERGENCY_ROLE is held by the independent EMERGENCY_ADDRESS
///           hot key, not the deployer.
///         - The Safe multisig (SAFE_ADDRESS) holds PROPOSER_ROLE and
///           CANCELLER_ROLE on the TimelockController, and no other account
///           does: no single signer can propose or cancel (security-model §4).
///         - EXECUTOR_ROLE is open: it is held by address(0), so any address
///           can execute an operation whose delay has elapsed. One policy, no
///           switch (core 1521).
///         - Direct ADMIN_ROLE calls from any EOA revert with
///           AccessControlUnauthorizedAccount.
///         - Admin operations must be routed through
///           TimelockController.schedule → delay → execute.
///
///         - The timelock is a ProposerFloorTimelock (issue #1645 question 1,
///           CS-3): the last PROPOSER_ROLE holder cannot be revoked through the
///           delay or renounced in an instant Safe transaction. The Safe gives
///           up the role only after a second proposer holds it.
///
///         Required env vars:
///           VAULT_ADDRESS          — RobotMoneyVault
///           REGISTRY_ADDRESS       — VaultRegistry
///           ROUTER_ADDRESS         — PortfolioRouter
///           GOVERNANCE_ADDRESS     — RouterGovernance
///           SAFE_ADDRESS           — Safe multisig (becomes PROPOSER + CANCELLER)
///           EMERGENCY_ADDRESS      — independent hot key that receives the vault
///                                    EMERGENCY_ROLE (must differ from the deployer
///                                    EOA; ACL-1 / F-01)
///           SAFE_OWNERS            — comma-separated owners the Safe must have
///           SAFE_THRESHOLD         — threshold the Safe must have (>= 2)
///           TIMELOCK_MIN_DELAY     — minimum delay in seconds. On chain id 8453 it must
///                                    be >= 172800 (48 hours, security-model.md §4).
///                                    On any other chain (the Twin chain 918453) it must
///                                    be >= 1. No flag lifts the 8453 floor.
///           EXPECTED_CHAIN_ID      — mandatory and equal to 8453 on Base mainnet
///           DEPLOYMENT_OUT         — output JSON path (no default)
///           CONSENSUS_RECEIPT_ADDRESS — ConsensusRecommendationReceipt (issue #1319,
///                                    same rule). ADMIN_ROLE +
///                                    DEFAULT_ADMIN_ROLE move to the timelock, which then
///                                    holds the receipt ADMIN_ROLE alone. RouterGovernance
///                                    keeps only RECEIPT_RELEASER_ROLE (issue 1888).
///           RECEIPT_ADMIN_ADDRESS  — the address that currently holds ADMIN_ROLE /
///                                    DEFAULT_ADMIN_ROLE on the receipt contract (the
///                                    RECEIPT_ADMIN_ADDRESS DeployConsensusRecommendation-
///                                    Receipt granted them to — not necessarily the
///                                    deployer EOA). Required on every chain together
///                                    with CONSENSUS_RECEIPT_ADDRESS; revoked from
///                                    here instead of msg.sender. No default.
///
/// @dev After deploying, the broadcaster (current ADMIN_ROLE holder) is no
///      longer the admin on any contract. Verify with:
///        cast call <vault> "hasRole(bytes32,address)" $(cast keccak "ADMIN_ROLE") <timelock>
///
///         Upgrade authority (issue 1808): every core contract is an ERC-1967 proxy whose only
///         upgrade and freeze authority, `upgradeTimelock()`, was fixed at its initialization to
///         the CREATE2 address of THIS timelock (`UpgradeAuthority.predictTimelock`). This stage
///         deploys the timelock there through the canonical CREATE2 factory, checks its roles
///         and delay, and asserts every handed-over contract names it, before any role moves.
contract DeployTimelock is UpgradeAuthority {
    /// @dev Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "timelock.json";

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant WEIGHT_SETTER_ROLE = keccak256("WEIGHT_SETTER_ROLE");
    bytes32 public constant WEIGHT_SETTER_ROTATOR_ROLE = keccak256("WEIGHT_SETTER_ROTATOR_ROLE");
    bytes32 public constant WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE =
        keccak256("WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    bytes32 public constant DEPOSIT_PAUSER_ROLE = keccak256("DEPOSIT_PAUSER_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 public constant RECEIPT_RELEASER_ROLE = keccak256("RECEIPT_RELEASER_ROLE");
    /// @dev OZ `AccessControl.DEFAULT_ADMIN_ROLE` is `bytes32(0)`.
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;
    /// @dev security-model.md §4: production timelock delay floor, 48 hours. Enforced
    ///      by a require on chain id 8453 only. The timelock itself is stock OpenZeppelin.
    uint256 public constant MIN_PRODUCTION_DELAY = 172_800;
    /// @dev Issue 1727 (owner decision 2026-10-10): the delay floor of a rehearsal, an explicit mode selected by the env var DEPLOYMENT_KIND=rehearsal (the publish-contracts
    ///      sheet line of the same name). A rehearsal delay is 900 s up to 172799 s, on every chain, so the delay on chain always agrees with the kind. The default (variable
    ///      absent or "production") keeps the 8453 floor above unchanged. The kind is also recorded in timelock.json.
    uint256 public constant MIN_REHEARSAL_DELAY = 900;

    /// @dev Recorded in timelock.json as `executorPolicy` / `cancellerPolicy`.
    ///      `open`: EXECUTOR_ROLE is held by address(0). `safe-only`: only the Safe
    ///      (threshold >= 2) holds PROPOSER_ROLE and CANCELLER_ROLE.
    string public constant EXECUTOR_POLICY = "open";
    string public constant CANCELLER_POLICY = "safe-only";

    /// @dev Safe 1.4.1 canonical deployments (identical on Base and on the Twin chain,
    ///      whose state is a Base snapshot).
    address public constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address public constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    /// @dev Runtime codehash of the SafeProxy 1.4.1 the canonical factory deploys
    ///      (read from a live Base Safe proxy). A stub, a mock or any other proxy differs.
    bytes32 public constant SAFE_PROXY_1_4_1_CODEHASH =
        0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c;
    /// @dev Safe storage slots: keccak256("guard_manager.guard.address") and
    ///      keccak256("fallback_manager.handler.address").
    bytes32 public constant SAFE_GUARD_SLOT =
        0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 public constant SAFE_FALLBACK_HANDLER_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    /// @notice SAFE_OWNERS and SAFE_THRESHOLD: what the Safe at SAFE_ADDRESS must look like.
    struct SafeSpec {
        address[] owners;
        uint256 threshold;
    }

    /// @dev The optional receipt handover inputs, grouped so
    ///      `runInProcessWithReceipt` stays inside the non-viaIR stack limit
    ///      (`forge coverage` compiles without the optimizer or viaIR).
    struct ReceiptHandover {
        address consensusReceipt;
        address receiptAdmin;
    }

    struct Deployed {
        TimelockController timelock;
        /// Every vault handed over (VAULT_ADDRESSES), all treated the same way.
        address[] vaults;
        address registry;
        address router;
        address governance;
        address safe;
        address emergency;
        uint256 minDelay;
        /// Issue 1727: true only when DEPLOYMENT_KIND=rehearsal was set. Never true by default.
        bool rehearsal;
        address consensusReceipt;
        address receiptAdmin;
    }

    /// @notice Broadcast entrypoint. Reads env vars, deploys timelock, and
    ///         transfers ADMIN_ROLE on the vaults-system contracts (plus the optional
    ///         consensus receipt handover — issue #1319).
    function run() external returns (Deployed memory d) {
        return _runFrom("");
    }

    // ─── Internal ──────────────────────────────────────────────────────────────

    /// @dev The body of `run()`. Every env var it reads is named `prefix`
    ///      followed by a name from the lists above; `run()` passes an empty
    ///      prefix. A test passes a prefix of its own, because env vars are
    ///      process-wide and forge runs tests in parallel.
    function _runFrom(string memory prefix) internal returns (Deployed memory d) {
        d.vaults = _readVaultList(string.concat(prefix, "VAULT_ADDRESSES"));
        d.registry = _envAddressRequired(string.concat(prefix, "REGISTRY_ADDRESS"));
        d.router = _envAddressRequired(string.concat(prefix, "ROUTER_ADDRESS"));
        d.governance = _envAddressRequired(string.concat(prefix, "GOVERNANCE_ADDRESS"));
        d.safe = _envAddressRequired(string.concat(prefix, "SAFE_ADDRESS"));
        d.emergency = _envAddressRequired(string.concat(prefix, "EMERGENCY_ADDRESS"));
        d.minDelay = _envUintRequired(string.concat(prefix, "TIMELOCK_MIN_DELAY"));
        d.rehearsal = _readRehearsal(prefix);
        uint256 safeThreshold = _envUintRequired(string.concat(prefix, "SAFE_THRESHOLD"));
        address[] memory safeOwners = _readAddressList(string.concat(prefix, "SAFE_OWNERS"));
        // One deployment scheme: these inputs are required on every chain. No input
        // silently skips the receipt handover or defaults to the deployer.
        d.consensusReceipt = _envAddressRequired(string.concat(prefix, "CONSENSUS_RECEIPT_ADDRESS"));
        d.receiptAdmin = _envAddressRequired(string.concat(prefix, "RECEIPT_ADMIN_ADDRESS"));
        require(d.consensusReceipt != address(0), "CONSENSUS_RECEIPT_ADDRESS=0");
        require(d.receiptAdmin != address(0), "RECEIPT_ADMIN_ADDRESS=0");
        _envStringRequired(string.concat(prefix, "DEPLOYMENT_OUT"));

        // Strict on 8453 (unset EXPECTED_CHAIN_ID no longer disables it). The delay
        // floor lives in `_validate`, so every entry point enforces it.
        _requireExpectedChain(prefix);

        _validate(d, SafeSpec({owners: safeOwners, threshold: safeThreshold}));

        vm.startBroadcast();
        d.timelock = _deployAndWire(d);
        vm.stopBroadcast();

        _writeJson(d, string.concat(prefix, "DEPLOYMENT_OUT"));
        _logResult(d);
    }

    /// @notice In-process variant for Forge tests. Caller sets up prank context.
    ///         No JSON is written; no env vars are read. Does not exercise the
    ///         optional consensus receipt handover — use
    ///         `runInProcessWithReceipt` for that. The deploy hands over
    ///         no gateway agent (ACL-9).
    function runInProcess(
        address vault_,
        address registry_,
        address router_,
        address governance_,
        address safe_,
        address emergency_,
        uint256 minDelay_,
        SafeSpec memory safeSpec_
    ) external returns (Deployed memory d) {
        d.vaults = _single(vault_);
        d.registry = registry_;
        d.router = router_;
        d.governance = governance_;
        d.safe = safe_;
        d.emergency = emergency_;
        d.minDelay = minDelay_;

        _validate(d, safeSpec_);
        d.timelock = _deployAndWire(d);
    }

    /// @notice In-process variant for the one deployment scheme: hands over every
    ///         vault in `vaults_` (the in-process form of VAULT_ADDRESSES). Caller
    ///         sets up prank context. No JSON is written; no env vars are read.
    function runInProcessVaults(
        address[] memory vaults_,
        address registry_,
        address router_,
        address governance_,
        address safe_,
        address emergency_,
        uint256 minDelay_,
        SafeSpec memory safeSpec_
    ) external returns (Deployed memory d) {
        d.vaults = vaults_;
        d.registry = registry_;
        d.router = router_;
        d.governance = governance_;
        d.safe = safe_;
        d.emergency = emergency_;
        d.minDelay = minDelay_;

        _validate(d, safeSpec_);
        d.timelock = _deployAndWire(d);
    }

    /// @dev One-element vault list for the single-vault in-process entry points.
    function _single(address v) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = v;
    }

    /// @notice In-process variant that also exercises the optional consensus receipt
    ///         handover (issue #1319). Caller sets up prank
    ///         context. No JSON is written; no env vars are read.
    /// @param receipt_ `consensusReceipt`: ConsensusRecommendationReceipt address, or
    ///        address(0) to skip. `receiptAdmin`: current holder of
    ///        ADMIN_ROLE/DEFAULT_ADMIN_ROLE on the receipt contract
    ///        (RECEIPT_ADMIN_ADDRESS at its construction); address(0) defaults to
    ///        msg.sender.
    function runInProcessWithReceipt(
        address vault_,
        address registry_,
        address router_,
        address governance_,
        address safe_,
        address emergency_,
        uint256 minDelay_,
        ReceiptHandover memory receipt_,
        SafeSpec memory safeSpec_
    ) external returns (Deployed memory d) {
        d.vaults = _single(vault_);
        d.registry = registry_;
        d.router = router_;
        d.governance = governance_;
        d.safe = safe_;
        d.emergency = emergency_;
        d.minDelay = minDelay_;
        d.consensusReceipt = receipt_.consensusReceipt;
        d.receiptAdmin = receipt_.receiptAdmin;

        _validate(d, safeSpec_);
        d.timelock = _deployAndWire(d);
    }

    /// @dev DEPLOYMENT_KIND (issue 1727): absent or "production" is production, "rehearsal" is the explicit rehearsal mode, anything else reverts.
    function _readRehearsal(string memory prefix) internal view returns (bool) {
        string memory kind =
            vm.envOr(string.concat(prefix, "DEPLOYMENT_KIND"), string("production"));
        if (keccak256(bytes(kind)) == keccak256("production")) return false;
        if (keccak256(bytes(kind)) == keccak256("rehearsal")) return true;
        revert("DEPLOYMENT_KIND must be production or rehearsal");
    }

    /// @dev VAULT_ADDRESSES: required, no default, comma-separated, at least one vault.
    function _readVaultList(string memory name) internal view returns (address[] memory) {
        require(vm.envExists(name), "VAULT_ADDRESSES must be set: every vault, comma-separated");
        require(bytes(vm.envString(name)).length != 0, "VAULT_ADDRESSES is empty");
        return vm.envAddress(name, ",");
    }

    /// @dev A required comma-separated address list from env var `name`.
    function _readAddressList(string memory name) internal view returns (address[] memory) {
        require(vm.envExists(name), string.concat(name, " must be set"));
        require(bytes(vm.envString(name)).length != 0, string.concat(name, " is empty"));
        return vm.envAddress(name, ",");
    }

    /// @param spec SAFE_OWNERS and SAFE_THRESHOLD: the owners and threshold the Safe must have.
    function _validate(Deployed memory d, SafeSpec memory spec) internal view {
        require(d.vaults.length > 0, "VAULT_ADDRESSES is empty");
        for (uint256 i = 0; i < d.vaults.length; i++) {
            require(d.vaults[i] != address(0), "VAULT_ADDRESSES contains the zero address");
            for (uint256 j = 0; j < i; j++) {
                require(d.vaults[i] != d.vaults[j], "VAULT_ADDRESSES contains a duplicate");
            }
        }
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

        // Delay floor, keyed to the chain id (security-model.md §4). A require, never a
        // different code path: 8453 refuses anything under 48 hours, every other chain
        // (the Twin chain 918453, anvil) accepts any non-zero delay. The contract is
        // stock OpenZeppelin and carries no floor of its own.
        if (d.rehearsal) {
            // Issue 1727: a rehearsal-kind run carries a short delay on any chain, and never a production one.
            require(
                d.minDelay >= MIN_REHEARSAL_DELAY && d.minDelay < MIN_PRODUCTION_DELAY,
                "rehearsal TIMELOCK_MIN_DELAY outside 900..172799"
            );
        } else if (block.chainid == BASE_MAINNET_CHAIN_ID) {
            require(
                d.minDelay >= MIN_PRODUCTION_DELAY,
                "TIMELOCK_MIN_DELAY below 172800 (48h) on Base mainnet"
            );
        }

        _requireRealSafe(d.safe, spec.owners, spec.threshold);
    }

    /// @dev The full Safe check. The address must be a SafeProxy 1.4.1 (code and
    ///      codehash) that delegates to the canonical SafeL2 singleton (slot 0), with
    ///      exactly the expected owners and threshold, no modules, no guard and the
    ///      canonical CompatibilityFallbackHandler. A stub, a mock or an EOA fails.
    function _requireRealSafe(address safe, address[] memory owners, uint256 threshold)
        internal
        view
    {
        // An EOA at SAFE_ADDRESS would let one key control every ADMIN_ROLE operation.
        require(
            safe.code.length > 0, "SAFE_ADDRESS is an EOA: deploy a Safe multisig contract first"
        );
        require(
            safe.codehash == SAFE_PROXY_1_4_1_CODEHASH,
            "SAFE_ADDRESS is not a SafeProxy 1.4.1: codehash mismatch"
        );
        // SafeProxy keeps its singleton in storage slot 0: it must be the L2 singleton.
        require(
            address(uint160(uint256(vm.load(safe, bytes32(0))))) == SAFE_L2_SINGLETON,
            "SAFE_ADDRESS does not delegate to the canonical SafeL2 singleton"
        );
        require(SAFE_L2_SINGLETON.code.length > 0, "SafeL2 singleton has no code on this chain");

        require(owners.length >= 2, "SAFE_OWNERS must list at least 2 owners");
        require(threshold >= 2, "SAFE_THRESHOLD < 2: configure at least 2-of-N quorum");
        require(threshold <= owners.length, "SAFE_THRESHOLD exceeds SAFE_OWNERS");

        ISafeFull s = ISafeFull(safe);
        require(
            keccak256(bytes(s.VERSION())) == keccak256("1.4.1"), "SAFE_ADDRESS VERSION is not 1.4.1"
        );
        require(s.getThreshold() == threshold, "Safe threshold != SAFE_THRESHOLD");

        address[] memory actual = s.getOwners();
        require(actual.length == owners.length, "Safe owner count != SAFE_OWNERS");
        for (uint256 i = 0; i < owners.length; i++) {
            require(owners[i] != address(0), "SAFE_OWNERS contains the zero address");
            for (uint256 j = 0; j < i; j++) {
                require(owners[i] != owners[j], "SAFE_OWNERS contains a duplicate");
            }
            require(s.isOwner(owners[i]), "SAFE_OWNERS entry is not a Safe owner");
        }

        // No module may bypass the owner quorum.
        (address[] memory modules,) = s.getModulesPaginated(address(0x1), 10);
        require(modules.length == 0, "Safe has an enabled module");
        // No transaction guard: a guard can veto or rewrite every Safe transaction.
        require(vm.load(safe, SAFE_GUARD_SLOT) == bytes32(0), "Safe has a transaction guard set");
        // The canonical fallback handler, stored by setup().
        require(
            address(uint160(uint256(vm.load(safe, SAFE_FALLBACK_HANDLER_SLOT))))
                == SAFE_FALLBACK_HANDLER,
            "Safe fallback handler is not the canonical CompatibilityFallbackHandler"
        );
    }

    function _deployAndWire(Deployed memory d) internal returns (TimelockController timelock) {
        // 1. Deploy TimelockController.
        //    proposers = [safe], executors = [address(0)], admin = address(0)
        //    OZ grants CANCELLER_ROLE to each proposer, so the Safe is the only
        //    proposer and canceller. address(0) as executor opens EXECUTOR_ROLE
        //    to any caller once the delay has elapsed (security-model §4; core 1521).
        //    admin = address(0) means the timelock is self-administered
        //    (the safe can change delay/roles only through the timelock).
        //    It is deployed through the canonical CREATE2 factory at the address every core
        //    proxy already names as its upgrade authority (issue 1808, UpgradeAuthority).
        timelock = _deployTimelockAtPrediction(d.safe, d.minDelay);
        _requireUpgradeAuthority(d, address(timelock));

        // 2. Grant ADMIN_ROLE to the timelock on the vaults-system contracts, then
        //    revoke ADMIN_ROLE from msg.sender (the deployer).
        //    Order: grant → verify → revoke to ensure we never lose admin.

        // Link the registry to the vault so the unified governance retire action
        // (VaultRegistry.retire) can drive the vault's deposit-halt leg. This is
        // the set-once ADMIN_ROLE-gated `setRegistry`, so it must run while the
        // deployer still holds ADMIN_ROLE on the vault (i.e. before the revoke
        // below). The vault gates `retire()`/`unretire()` to this registry only.
        for (uint256 i = 0; i < d.vaults.length; i++) {
            address vault_ = d.vaults[i];
            IRetirableVaultLink(vault_).setRegistry(d.registry);
            require(
                IRetirableVaultLink(vault_).registry() == d.registry, "Vault registry link not set"
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
            IAccessControl(vault_).grantRole(EMERGENCY_ROLE, d.emergency);
            require(
                IAccessControl(vault_).hasRole(EMERGENCY_ROLE, d.emergency),
                "Emergency key missing EMERGENCY_ROLE on vault"
            );
            IAccessControl(vault_).revokeRole(EMERGENCY_ROLE, msg.sender);
            require(
                !IAccessControl(vault_).hasRole(EMERGENCY_ROLE, msg.sender),
                "Deployer still has EMERGENCY_ROLE on vault"
            );

            IAccessControl(vault_).grantRole(ADMIN_ROLE, address(timelock));
            require(
                IAccessControl(vault_).hasRole(ADMIN_ROLE, address(timelock)),
                "Timelock missing ADMIN_ROLE on vault"
            );
            IAccessControl(vault_).revokeRole(ADMIN_ROLE, msg.sender);
            require(
                !IAccessControl(vault_).hasRole(ADMIN_ROLE, msg.sender),
                "Deployer still has ADMIN_ROLE on vault"
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
        // R7 / §4.3: the router's WEIGHT_SETTER_ROLE is what gates `setWeights`, so
        // this block decides who can move allocation weights afterwards. Two
        // conditions must BOTH hold when it finishes, and neither is implied
        // by the other:
        //
        //   (a) RouterGovernance holds the role, or every applyReceipt the
        //       Safe schedules reverts inside `setWeights`;
        //   (b) the deployer EOA does NOT hold it, or a single key can move
        //       weights directly and the Safe -> timelock -> applyReceipt path
        //       is decorative.
        //
        // Before the grant is asserted, because a governance contract that
        // cannot act is a broken deployment, not a safer one.
        require(
            IAccessControl(d.router).hasRole(ADMIN_ROLE, d.governance),
            "R7: RouterGovernance lacks router ADMIN_ROLE - setDefaultWeights cannot forward"
        );

        require(
            IAccessControl(d.router).hasRole(WEIGHT_SETTER_ROLE, d.governance),
            "R7: RouterGovernance lacks router WEIGHT_SETTER_ROLE - applyReceipt cannot reach setWeights"
        );
        // Defence in depth: DeployRouterGovernance already drops the deployer's
        // WEIGHT_SETTER_ROLE. Drop it here too, while the deployer still holds
        // ADMIN_ROLE (the role admin), so a skipped stage cannot leave it behind.
        if (IAccessControl(d.router).hasRole(WEIGHT_SETTER_ROLE, msg.sender)) {
            IAccessControl(d.router).revokeRole(WEIGHT_SETTER_ROLE, msg.sender);
        }

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
        // `onlyRole(WEIGHT_SETTER_ROLE)` on the router, so the role read IS the
        // capability — asserted separately from the revoke above so the
        // failure message names what an operator actually cares about.
        require(
            !IAccessControl(d.router).hasRole(WEIGHT_SETTER_ROLE, msg.sender),
            "R7: deployer EOA can still call router.setWeights directly"
        );
        // `setWeights` is gated by WEIGHT_SETTER_ROLE, held only by
        // RouterGovernance. The timelock gets ADMIN_ROLE (setDefaultWeights)
        // and must not hold the active weight setter.
        require(
            !IAccessControl(d.router).hasRole(WEIGHT_SETTER_ROLE, address(timelock)),
            "R7: timelock holds router WEIGHT_SETTER_ROLE - it could bypass RouterGovernance"
        );
        // And the grant survived the handover: nothing above touched it, but
        // this is the invariant the ceremony exists to establish, so read it
        // back at the end rather than trusting the order of the lines.
        require(
            IAccessControl(d.router).hasRole(ADMIN_ROLE, d.governance),
            "R7: RouterGovernance lost router ADMIN_ROLE during handover"
        );

        // Rotation roles (ADR-0002, core 1616). Both are self-administered, so the
        // deployer, as their only holder, hands them over: the rotator role to the
        // Safe (propose, cancel) and the executor role to the timelock (execute after
        // the delay). The timelock must not hold the rotator role and the Safe must not
        // hold the executor role, or one actor could rotate the weight setter alone.
        IAccessControl(d.router).grantRole(WEIGHT_SETTER_ROTATOR_ROLE, d.safe);
        IAccessControl(d.router).grantRole(WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, address(timelock));
        IAccessControl(d.router).revokeRole(WEIGHT_SETTER_ROTATOR_ROLE, msg.sender);
        IAccessControl(d.router).revokeRole(WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, msg.sender);
        require(
            IAccessControl(d.router).hasRole(WEIGHT_SETTER_ROTATOR_ROLE, d.safe)
                && !IAccessControl(d.router).hasRole(WEIGHT_SETTER_ROTATOR_ROLE, msg.sender)
                && !IAccessControl(d.router).hasRole(WEIGHT_SETTER_ROTATOR_ROLE, address(timelock)),
            "R7: router rotator role is not the Safe alone"
        );
        require(
            IAccessControl(d.router)
                    .hasRole(WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, address(timelock))
                && !IAccessControl(d.router)
                    .hasRole(WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, msg.sender)
                && !IAccessControl(d.router).hasRole(WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, d.safe),
            "R7: router rotation executor role is not the timelock alone"
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
        // The governance contract's own WEIGHT_SETTER_ROLE gates applyReceipt
        // (issue 1698). It is self-administered, so the deployer, as its only
        // holder, hands it to the timelock and drops its copy: afterwards a
        // receipt is applied only by a Safe-scheduled timelock operation.
        IAccessControl(d.governance).grantRole(WEIGHT_SETTER_ROLE, address(timelock));
        IAccessControl(d.governance).revokeRole(WEIGHT_SETTER_ROLE, msg.sender);
        require(
            IAccessControl(d.governance).hasRole(WEIGHT_SETTER_ROLE, address(timelock))
                && !IAccessControl(d.governance).hasRole(WEIGHT_SETTER_ROLE, msg.sender),
            "R7: governance WEIGHT_SETTER_ROLE (applyReceipt) is not the timelock alone"
        );

        // ConsensusRecommendationReceipt (optional — issue #1319, same rule).
        //
        // DeployConsensusRecommendationReceipt grants DEFAULT_ADMIN_ROLE + ADMIN_ROLE
        // on the receipt contract to RECEIPT_ADMIN_ADDRESS, which is NOT
        // necessarily the deployer EOA (it is a required input and may differ
        // from ADMIN_ADDRESS). Resolve the actual current holder (d.receiptAdmin)
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
            // A wrong RECEIPT_ADMIN_ADDRESS must not leave the deployer EOA as the
            // receipt's admin: the revoke above targets the configured address,
            // which may not be the one that actually holds the role. Assert the
            // deployer's state regardless of what was configured (devops review
            // 2026-09-30, finding R-02; on a fork the handover passed while the
            // deployer kept both roles).
            require(
                !IAccessControl(d.consensusReceipt).hasRole(ADMIN_ROLE, msg.sender),
                "Deployer still has ADMIN_ROLE on consensus receipt: RECEIPT_ADMIN_ADDRESS names the wrong account"
            );
            require(
                !IAccessControl(d.consensusReceipt).hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
                "Deployer still has DEFAULT_ADMIN_ROLE on consensus receipt: RECEIPT_ADMIN_ADDRESS names the wrong account"
            );
            // applyReceipt releases the receipt it applies (issue 1698): the
            // governance contract must point at this register and hold its narrow
            // RECEIPT_RELEASER_ROLE (granted by DeployRouterGovernance), never its
            // ADMIN_ROLE. The timelock is the only ADMIN_ROLE holder (issue 1888).
            require(
                address(RouterGovernance(d.governance).receipts()) == d.consensusReceipt,
                "R7: RouterGovernance.receipts() is not CONSENSUS_RECEIPT_ADDRESS"
            );
            require(
                IAccessControl(d.consensusReceipt).hasRole(RECEIPT_RELEASER_ROLE, d.governance),
                "R7: RouterGovernance lacks RECEIPT_RELEASER_ROLE - applyReceipt cannot release"
            );
            require(
                !IAccessControl(d.consensusReceipt).hasRole(ADMIN_ROLE, d.governance),
                "R7: RouterGovernance holds the receipt ADMIN_ROLE - only the timelock may"
            );
        }
    }

    /// @dev Deploy the core timelock at `predictTimelock(safe, minDelay)` through the CREATE2
    ///      factory. CREATE2 binds the init code, so code already at that address can only be
    ///      this same timelock (anyone may have deployed it first): it is reused, and its roles
    ///      and delay are checked either way.
    function _deployTimelockAtPrediction(address safe, uint256 minDelay)
        internal
        returns (TimelockController timelock)
    {
        address predicted = predictTimelock(safe, minDelay);
        if (predicted.code.length == 0) {
            (bool ok,) = CREATE2_FACTORY.call(
                abi.encodePacked(TIMELOCK_SALT, timelockInitCode(safe, minDelay))
            );
            require(ok && predicted.code.length != 0, "timelock CREATE2 deployment failed");
        }
        timelock = TimelockController(payable(predicted));
        // The core timelock is a ProposerFloorTimelock (issue #1645 question 1, CS-3). The floor
        // counted the one proposer the constructor granted: a count of 1 is what makes the Safe's
        // own PROPOSER_ROLE irrevocable until a second proposer exists.
        require(
            ProposerFloorTimelock(payable(predicted)).proposerCount() == 1,
            "timelock proposer floor did not count the Safe"
        );
        require(
            timelock.getMinDelay() == minDelay, "timelock minDelay differs from TIMELOCK_MIN_DELAY"
        );
        require(
            timelock.hasRole(timelock.PROPOSER_ROLE(), safe)
                && timelock.hasRole(timelock.CANCELLER_ROLE(), safe)
                && timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)),
            "timelock roles are not proposer/canceller = Safe, executor = anyone"
        );
        require(
            !timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), msg.sender),
            "deployer holds the timelock admin role"
        );
    }

    /// @dev Issue 1808: every handed-over core proxy names this timelock as its only upgrade and
    ///      freeze authority. A proxy that names any other address (the deployer, a placeholder,
    ///      another deployment's timelock) stops the handover before any role moves.
    function _requireUpgradeAuthority(Deployed memory d, address timelock) internal view {
        for (uint256 i = 0; i < d.vaults.length; i++) {
            _requireNamesTimelock(d.vaults[i], timelock);
        }
        _requireNamesTimelock(d.registry, timelock);
        _requireNamesTimelock(d.router, timelock);
        _requireNamesTimelock(d.governance, timelock);
        if (d.consensusReceipt != address(0)) _requireNamesTimelock(d.consensusReceipt, timelock);
    }

    function _requireNamesTimelock(address proxy, address timelock) internal view {
        require(
            GovernedUUPS(proxy).upgradeTimelock() == timelock,
            string.concat(vm.toString(proxy), ": upgradeTimelock is not the deployed timelock")
        );
    }

    function _logResult(Deployed memory d) internal pure {
        console2.log(
            "ProposerFloorTimelock (TimelockController with the last-proposer floor) deployed and ADMIN_ROLE transferred on all four contracts"
        );
        console2.log("  timelock    :", address(d.timelock));
        console2.log("  safe        :", d.safe);
        console2.log("  emergency   :", d.emergency);
        console2.log("  min_delay   :", d.minDelay);
        for (uint256 i = 0; i < d.vaults.length; i++) {
            console2.log("  vault       :", d.vaults[i]);
        }
        console2.log("  registry    :", d.registry);
        console2.log("  router      :", d.router);
        console2.log("  governance  :", d.governance);
        if (d.consensusReceipt != address(0)) {
            console2.log("  consensus_receipt :", d.consensusReceipt);
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
    ///      `outVar` names the env var that holds the output path.
    function _writeJson(Deployed memory d, string memory outVar) internal {
        string memory outPath = _envStringRequired(outVar);
        _writeJsonTo(d, outPath);
    }

    /// @dev Writes the manifest `_writeJson` describes to `outPath`. Kept apart
    ///      from the `DEPLOYMENT_OUT` read so a caller can name the path
    ///      without setting a process-wide variable.
    function _writeJsonTo(Deployed memory d, string memory outPath) internal {
        string memory addrsJson = _serializeAddressSection(d);
        string memory hashesJson = _serializeCodeHashSection(d);

        string memory rolesJson = _serializeRoles(d);

        string memory obj = "timelock";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeUint(obj, "min_delay", d.minDelay);
        vm.serializeString(obj, "deployment_kind", d.rehearsal ? "rehearsal" : "production");
        // Issue #1698: the receipt register the weight setter applies from, as the chain reads
        // it back.
        vm.serializeAddress(
            obj, "governance_receipt", address(RouterGovernance(d.governance).receipts())
        );
        // Kept flat as well as inside `addresses`: existing readers (the
        // smoke-test fixture, the explorer env writer) index this file by these
        // top-level keys, and a manifest that breaks them is a manifest nobody
        // reads.
        vm.serializeAddress(obj, "timelock", address(d.timelock));
        vm.serializeAddress(obj, "safe", d.safe);
        vm.serializeAddress(obj, "emergency", d.emergency);
        // The policy the timelock was built with, for the stage 12 verifier to
        // compare against the chain. One policy: no sheet key selects it.
        vm.serializeString(obj, "executorPolicy", EXECUTOR_POLICY);
        vm.serializeString(obj, "cancellerPolicy", CANCELLER_POLICY);
        vm.serializeAddress(obj, "vault", d.vaults[0]);
        vm.serializeAddress(obj, "vaults", d.vaults);
        vm.serializeAddress(obj, "registry", d.registry);
        vm.serializeAddress(obj, "router", d.router);
        vm.serializeAddress(obj, "governance", d.governance);
        vm.serializeString(obj, "addresses", addrsJson);
        vm.serializeString(obj, "code_hashes", hashesJson);
        // One handover entry per vault in VAULT_ADDRESSES, read back from the chain.
        vm.serializeString(obj, "vault_handover", _serializeVaultHandovers(d));
        string memory json = vm.serializeString(obj, "roles", rolesJson);

        vm.writeJson(json, outPath);
        console2.log("Wrote timelock deployment manifest to", outPath);
    }

    /// @dev The `addresses` section of the manifest. Split out of `_writeJsonTo`
    ///      to keep that function inside the non-viaIR stack limit (`forge coverage`).
    function _serializeAddressSection(Deployed memory d) internal returns (string memory) {
        string memory addrs = "manifest_addresses";
        vm.serializeAddress(addrs, "timelock", address(d.timelock));
        vm.serializeAddress(addrs, "safe", d.safe);
        vm.serializeAddress(addrs, "emergency", d.emergency);
        vm.serializeAddress(addrs, "vault", d.vaults[0]);
        vm.serializeAddress(addrs, "vaults", d.vaults);
        vm.serializeAddress(addrs, "registry", d.registry);
        vm.serializeAddress(addrs, "router", d.router);
        vm.serializeAddress(addrs, "consensus_receipt", d.consensusReceipt);
        return vm.serializeAddress(addrs, "governance", d.governance);
    }

    /// @dev The `code_hashes` section of the manifest, read from the chain.
    function _serializeCodeHashSection(Deployed memory d) internal returns (string memory) {
        string memory hashes = "manifest_code_hashes";
        vm.serializeBytes32(hashes, "timelock", address(d.timelock).codehash);
        vm.serializeBytes32(hashes, "safe", d.safe.codehash);
        vm.serializeBytes32(hashes, "vault", d.vaults[0].codehash);
        vm.serializeBytes32(hashes, "registry", d.registry.codehash);
        vm.serializeBytes32(hashes, "router", d.router.codehash);
        vm.serializeBytes32(hashes, "router_implementation", _implementationCodeHash(d.router));
        vm.serializeBytes32(hashes, "consensus_receipt", d.consensusReceipt.codehash);
        return vm.serializeBytes32(hashes, "governance", d.governance.codehash);
    }

    /// @dev ADR-0014: keccak256 of the code of `proxy`'s ERC-1967 implementation, or zero when the
    ///      slot is empty (a direct contract). Behind a proxy `proxy.codehash` is the generic
    ///      ERC1967Proxy, the same for every proxy and unchanged by an upgrade, so this is the hash
    ///      that names the reviewed logic: the dapp's implementation pin (scripts/stage/mainnet-dapp.ts)
    ///      and rmpc's `proxy_implementation_hashes`.
    function _implementationCodeHash(address proxy) internal view returns (bytes32) {
        address impl = _implementationOf(proxy);
        return impl == address(0) ? bytes32(0) : keccak256(impl.code);
    }

    /// @dev The per-vault handover record: one object per vault in VAULT_ADDRESSES,
    ///      keyed `vault_<index>`. Every field is a live read from the chain.
    function _serializeVaultHandovers(Deployed memory d) internal returns (string memory out) {
        string memory all = "manifest_vault_handover";
        out = "{}";
        for (uint256 i = 0; i < d.vaults.length; i++) {
            address vault_ = d.vaults[i];
            IAccessControl v = IAccessControl(vault_);
            string memory k = string.concat("manifest_vault_handover_", vm.toString(i));
            vm.serializeAddress(k, "address", vault_);
            vm.serializeBytes32(k, "code_hash", vault_.codehash);
            vm.serializeBytes32(k, "implementation_code_hash", _implementationCodeHash(vault_));
            vm.serializeAddress(k, "registry", IRetirableVaultLink(vault_).registry());
            vm.serializeBool(
                k, "registry_linked", IRetirableVaultLink(vault_).registry() == d.registry
            );
            vm.serializeAddress(k, "admin", address(d.timelock));
            vm.serializeBool(
                k, "timelock_has_admin_role", v.hasRole(ADMIN_ROLE, address(d.timelock))
            );
            vm.serializeAddress(k, "emergency", d.emergency);
            vm.serializeBool(
                k, "emergency_key_has_emergency_role", v.hasRole(EMERGENCY_ROLE, d.emergency)
            );
            vm.serializeBool(k, "deployer_has_admin_role", v.hasRole(ADMIN_ROLE, msg.sender));
            string memory entry = vm.serializeBool(
                k, "deployer_has_emergency_role", v.hasRole(EMERGENCY_ROLE, msg.sender)
            );
            out = vm.serializeString(all, string.concat("vault_", vm.toString(i)), entry);
        }
    }

    /// @dev Folds the per-vault role reads into three booleans for the manifest.
    function _vaultRoleAggregates(Deployed memory d)
        internal
        view
        returns (bool allTimelockAdmin, bool allEmergencyKey, bool deployerHoldsVaultRole)
    {
        allTimelockAdmin = true;
        allEmergencyKey = true;
        for (uint256 i = 0; i < d.vaults.length; i++) {
            IAccessControl v = IAccessControl(d.vaults[i]);
            if (!v.hasRole(ADMIN_ROLE, address(d.timelock))) allTimelockAdmin = false;
            if (!v.hasRole(EMERGENCY_ROLE, d.emergency)) allEmergencyKey = false;
            if (v.hasRole(ADMIN_ROLE, msg.sender) || v.hasRole(EMERGENCY_ROLE, msg.sender)) {
                deployerHoldsVaultRole = true;
            }
        }
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
        // Issue 1888: the weight setter releases the receipt it applies through the narrow
        // release role, and never holds the receipt ADMIN_ROLE.
        vm.serializeBool(
            roles,
            "governance_has_receipt_release_role",
            d.consensusReceipt != address(0)
                && IAccessControl(d.consensusReceipt).hasRole(RECEIPT_RELEASER_ROLE, d.governance)
        );
        // Enumerated holders of the receipt ADMIN_ROLE are the timelock alone (issue 1888).
        vm.serializeBool(
            roles,
            "receipt_admin_held_by_timelock_alone",
            d.consensusReceipt != address(0)
                && IAccessControlEnumerable(d.consensusReceipt).getRoleMemberCount(ADMIN_ROLE) == 1
                && IAccessControl(d.consensusReceipt).hasRole(ADMIN_ROLE, address(d.timelock))
        );
        vm.serializeBool(
            roles,
            "governance_has_receipt_admin_role",
            d.consensusReceipt != address(0)
                && IAccessControl(d.consensusReceipt).hasRole(ADMIN_ROLE, d.governance)
        );
        // Aggregates over every vault; the per-vault rows are in `vault_handover`.
        // Computed in helpers so this function stays inside the non-viaIR stack
        // limit that `forge coverage` compiles under.
        (bool allTimelockAdmin, bool allEmergencyKey, bool deployerHoldsVaultRole) =
            _vaultRoleAggregates(d);
        vm.serializeBool(roles, "timelock_has_vault_admin_role", allTimelockAdmin);
        vm.serializeUint(roles, "vaults_handed_over_count", d.vaults.length);
        vm.serializeBool(
            roles,
            "timelock_has_registry_admin_role",
            IAccessControl(d.registry).hasRole(ADMIN_ROLE, address(d.timelock))
        );
        vm.serializeBool(roles, "emergency_key_has_vault_emergency_role", allEmergencyKey);
        vm.serializeBool(roles, "deployer_has_vault_emergency_role", deployerHoldsVaultRole);
        // The Safe's standing on the timelock itself.
        vm.serializeBool(
            roles,
            "safe_is_timelock_proposer",
            d.timelock.hasRole(d.timelock.PROPOSER_ROLE(), d.safe)
        );
        vm.serializeBool(
            roles,
            "safe_is_timelock_canceller",
            d.timelock.hasRole(d.timelock.CANCELLER_ROLE(), d.safe)
        );
        return vm.serializeBool(
            roles,
            "timelock_executor_is_open",
            d.timelock.hasRole(d.timelock.EXECUTOR_ROLE(), address(0))
        );
    }
}
