// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
// Implements: issue #414 — on-chain timelocked multisig enforcement
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {ProposerFloorTimelock} from "../ProposerFloorTimelock.sol";
import {CoreStages} from "./helpers/CoreStages.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {AccessRoles} from "../gateway/AccessRoles.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {RoleHolders} from "./helpers/RoleHolders.sol";
import {claimTmpPath, releaseTmpPath, uniqueTmpPath} from "./helpers/TmpPaths.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";
import {GovernedUUPS} from "../lib/GovernedUUPS.sol";

/// @dev Fork-style unit tests for DeployTimelock.s.sol (issue #414).
///
///      These tests run in-process using Forge cheatcodes so they do not
///      require a live fork RPC. They exercise all six acceptance-criteria
///      scenarios:
///
///      AC1  TimelockController holds ADMIN_ROLE on all five contracts.
///      AC2  Direct ADMIN_ROLE call from Safe EOA reverts with
///           AccessControlUnauthorizedAccount.
///      AC3  TimelockController-routed call (schedule → mine delay → execute)
///           mines and executes the operation successfully.
///      AC4  Pre-delay execute reverts.
///      AC5  TimelockController.getMinDelay() is verifiable on-chain.
///      AC6  ADMIN_ROLE grant routed through Timelock succeeds.
///
/// Unified governance `retire()` (DI-2, decision #925; docs/architecture.md §4.7)
/// is a governance-tier action gated by this same TimelockController (the timelock
/// holds ADMIN_ROLE on VaultRegistry and RobotMoneyVault — asserted by the AC1
/// tests below). The `test_retire_*` / `test_shutdownVault_unchanged_*` tests in
/// the "#942" section prove the retire action is reachable ONLY via the
/// schedule → mine delay → execute path, reverts on a direct ADMIN_ROLE EOA call,
/// atomically flips registry status `Retired` + the vault deposit-halt in one
/// executed call, and leaves the emergency `shutdownVault` overlay unchanged.
contract DeployTimelockTest is SafeGovernance {
    // ─── Roles ────────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    // ─── Test addresses ───────────────────────────────────────────────────────

    address internal admin = makeAddr("admin");
    // `safe` is set in setUp() to a real SafeL2 1.4.1 proxy built by SafeFixture.
    // DeployTimelock runs the full Safe checks on it (code, codehash, singleton,
    // owners, threshold, modules, guard, fallback handler).
    address internal safe;
    // Independent emergency hot key that receives the vault EMERGENCY_ROLE at
    // handover (ACL-1 / F-01). Distinct from the deployer (address(script)).
    address internal emergency = makeAddr("emergency");
    address internal stranger = makeAddr("stranger");
    address internal newAdmin = makeAddr("newAdmin");

    // ─── Contracts ────────────────────────────────────────────────────────────

    TestERC20 internal usdc;
    RobotMoneyVault internal vault;
    RobotMoneyGateway internal gateway;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal governance;

    DeployTimelock internal script;
    DeployTimelock.Deployed internal d;

    /// The deployer: the address that holds every role before the handover and
    /// that the script revokes them from. See setUp for why it is the script's
    /// own address.
    address internal deployer;

    /// Who holds what after the handover, replayed from every RoleGranted /
    /// RoleRevoked log since before the contracts were built (the contracts are
    /// not AccessControlEnumerable, so this is the only complete list).
    mapping(address => address[]) internal adminHolders;
    address[] internal gatewayRootHolders;
    address[] internal executorHolders;
    address[] internal vaultEmergencyHolders;
    /// Contracts on which the logs show the deployer losing ADMIN_ROLE.
    mapping(address => bool) internal deployerAdminRevoked;
    bool internal deployerRootRevoked;

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant MIN_DELAY = 2 days;

    function setUp() public {
        vm.recordLogs();
        usdc = new TestERC20();
        script = new DeployTimelock();
        deployer = address(script);

        // A real SafeL2 1.4.1 proxy from the vendored sources, 2-of-3, so DeployTimelock's
        // full Safe checks pass on a genuine Safe (no stub, no mock).
        _installSafeSet();
        safe = _newDefaultSafe();
        // Issue 1808: every proxy names the timelock the handover deploys (CREATE2, bound to
        // the Safe and the delay) as its upgrade authority.
        CoreProxies.useUpgradeConfig(
            script.predictTimelock(safe, MIN_DELAY), GovernedUUPS.UpgradeMode.Upgradeable
        );

        // In a real `forge script --broadcast` run one address does both jobs:
        // the broadcaster sends every grant and revoke, and it is also the
        // `msg.sender` the script revokes from. In process they come apart. The
        // script's calls to the target contracts come from address(script),
        // while `msg.sender` inside runInProcess is whoever called it. So the
        // deployer here is address(script): it gets every role at construction,
        // and runInProcess is called FROM address(script) (vm.prank below), so
        // the address the script revokes from is the one that holds the roles.
        // Calling it from this test contract instead would revoke from an
        // address that never held anything and leave the script contract as a
        // second admin on every contract (issue #1447).
        //
        // RobotMoneyVault and RobotMoneyGateway are instantiated as real
        // contracts (issue #420 — replacing the registry placeholder that was
        // used as a stub for both).  Vault is constructed first so that the
        // gateway can validate vault.asset() == address(usdc) at deploy time.
        vault = CoreProxies.robotMoneyVault(
            usdc,
            type(uint256).max, // tvlCap (no cap for tests)
            type(uint256).max, // perDepositCap
            0, // exitFeeBps
            safe, // feeRecipient (non-zero; reuses the safe test address)
            address(script), // admin — script must hold ADMIN_ROLE to wire timelock
            address(script) // emergencyResponder
        );
        gateway = CoreProxies.robotMoneyGateway(
            usdc,
            vault,
            address(script), // admin — script holds ADMIN_ROLE to wire timelock
            admin, // pauser — must be distinct from admin (RoleSeparationViolated guard)
            address(0) // router (not exercised in these tests)
        );
        registry = CoreProxies.vaultRegistry(address(script));
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), address(script));
        governance =
            CoreProxies.routerGovernance(address(router), makeAddr("receipts"), address(script));
        // R7: DeployTimelock now refuses a handover that would leave the
        // approving body unable to act, so the fixture must reflect what
        // DeployRouterGovernance does at deploy time — grant governance
        // ADMIN_ROLE on the router.
        vm.prank(deployer);
        router.grantRole(ADMIN_ROLE, address(governance));
        vm.prank(deployer);
        router.grantRole(keccak256("WEIGHT_SETTER_ROLE"), address(governance));

        vm.prank(deployer);
        d = script.runInProcess(
            address(vault),
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY,
            _fixtureSpec()
        );

        Vm.Log[] memory logs = vm.getRecordedLogs();
        address[5] memory governed = _governed();
        for (uint256 i = 0; i < governed.length; i++) {
            adminHolders[governed[i]] = RoleHolders.holders(logs, governed[i], ADMIN_ROLE);
            deployerAdminRevoked[governed[i]] =
                RoleHolders.wasRevoked(logs, governed[i], ADMIN_ROLE, deployer);
        }
        deployerRootRevoked =
            RoleHolders.wasRevoked(logs, address(gateway), DEFAULT_ADMIN_ROLE, deployer);
        gatewayRootHolders = RoleHolders.holders(logs, address(gateway), DEFAULT_ADMIN_ROLE);
        vaultEmergencyHolders = RoleHolders.holders(logs, address(vault), EMERGENCY_ROLE);
        executorHolders = RoleHolders.holders(logs, address(d.timelock), d.timelock.EXECUTOR_ROLE());
    }

    function _governed() internal view returns (address[5] memory) {
        return
            [
                address(vault),
                address(gateway),
                address(registry),
                address(router),
                address(governance)
            ];
    }

    // ─── AC1: Timelock holds ADMIN_ROLE on all five contracts ─────────────────

    /// @notice After DeployTimelock, the TimelockController holds ADMIN_ROLE on
    ///         each contract.
    function test_timelock_holdsAdminRoleOnRegistry() public view {
        assertTrue(
            IAccessControl(address(registry)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on registry"
        );
    }

    function test_timelock_holdsAdminRoleOnRouter() public view {
        assertTrue(
            IAccessControl(address(router)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on router"
        );
    }

    function test_timelock_holdsAdminRoleOnGovernance() public view {
        assertTrue(
            IAccessControl(address(governance)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on governance"
        );
    }

    /// @notice After DeployTimelock, the TimelockController holds ADMIN_ROLE on
    ///         the real RobotMoneyVault instance (not a registry placeholder).
    function test_timelock_holdsAdminRoleOnVault() public view {
        assertTrue(
            IAccessControl(address(vault)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on vault"
        );
    }

    /// @notice After DeployTimelock, the TimelockController holds ADMIN_ROLE on
    ///         the real RobotMoneyGateway instance (not a registry placeholder).
    function test_timelock_holdsAdminRoleOnGateway() public view {
        assertTrue(
            IAccessControl(address(gateway)).hasRole(ADMIN_ROLE, address(d.timelock)),
            "timelock missing ADMIN_ROLE on gateway"
        );
    }

    /// @notice After role transfer, the deployer — the address that held
    ///         ADMIN_ROLE and sent the handover — no longer holds it anywhere.
    ///         Each check is preceded by proof that the deployer DID hold the
    ///         role, so it cannot pass against an address that never had it.
    function test_deployer_heldAndLostAdminRoleOnEveryGovernedContract() public view {
        address[5] memory governed = _governed();
        for (uint256 i = 0; i < governed.length; i++) {
            assertTrue(
                deployerAdminRevoked[governed[i]],
                "the handover never revoked ADMIN_ROLE from the deployer (it never held it?)"
            );
        }
        assertTrue(deployerRootRevoked, "the handover never revoked the deployer's gateway root");
    }

    function test_deployer_noLongerHasAdminRoleOnAnyGovernedContract() public view {
        address[5] memory governed = _governed();
        for (uint256 i = 0; i < governed.length; i++) {
            assertFalse(
                IAccessControl(governed[i]).hasRole(ADMIN_ROLE, deployer),
                "deployer still has ADMIN_ROLE on a governed contract"
            );
        }
        assertFalse(
            gateway.hasRole(DEFAULT_ADMIN_ROLE, deployer),
            "deployer still has DEFAULT_ADMIN_ROLE on gateway"
        );
        assertFalse(
            vault.hasRole(EMERGENCY_ROLE, deployer), "deployer still has EMERGENCY_ROLE on vault"
        );
    }

    /// @notice After the handover the timelock is the ONLY ADMIN_ROLE holder on
    ///         every governed contract, the router excepted: RouterGovernance
    ///         also holds router ADMIN_ROLE, by design (R7 — it is what lets an
    ///         executed proposal reach setWeights). The member lists are the
    ///         complete sets, replayed from every RoleGranted/RoleRevoked log
    ///         since before construction, not a check of a few named addresses.
    function test_handover_timelockIsTheOnlyAdminOnEveryGovernedContract() public view {
        address[5] memory governed = _governed();
        for (uint256 i = 0; i < governed.length; i++) {
            address[] memory h = adminHolders[governed[i]];
            bool isRouter = governed[i] == address(router);
            assertEq(h.length, isRouter ? 2 : 1, "unexpected number of ADMIN_ROLE holders");
            for (uint256 j = 0; j < h.length; j++) {
                bool allowed =
                    h[j] == address(d.timelock) || (isRouter && h[j] == address(governance));
                assertTrue(allowed, "an address other than the timelock holds ADMIN_ROLE");
                assertTrue(
                    IAccessControl(governed[i]).hasRole(ADMIN_ROLE, h[j]),
                    "replay disagrees with hasRole"
                );
            }
            assertTrue(
                IAccessControl(governed[i]).hasRole(ADMIN_ROLE, address(d.timelock)),
                "timelock missing ADMIN_ROLE"
            );
            // The named suspects, read directly as well.
            assertFalse(
                IAccessControl(governed[i]).hasRole(ADMIN_ROLE, address(script)),
                "script kept ADMIN_ROLE"
            );
            assertFalse(
                IAccessControl(governed[i]).hasRole(ADMIN_ROLE, address(this)),
                "test kept ADMIN_ROLE"
            );
            assertFalse(
                IAccessControl(governed[i]).hasRole(ADMIN_ROLE, admin), "pauser holds ADMIN_ROLE"
            );
        }
    }

    /// @notice No address other than the timelock holds the gateway root
    ///         (DEFAULT_ADMIN_ROLE), and only the independent hot key holds the
    ///         vault EMERGENCY_ROLE.
    function test_handover_timelockIsTheOnlyGatewayRootHolder() public view {
        assertEq(
            gatewayRootHolders.length, 1, "gateway DEFAULT_ADMIN_ROLE has more than one holder"
        );
        assertEq(gatewayRootHolders[0], address(d.timelock), "gateway root is not the timelock");
        assertFalse(
            gateway.hasRole(DEFAULT_ADMIN_ROLE, address(script)), "script kept gateway root"
        );
        assertFalse(gateway.hasRole(DEFAULT_ADMIN_ROLE, address(this)), "test holds gateway root");
        assertEq(vaultEmergencyHolders.length, 1, "vault EMERGENCY_ROLE has more than one holder");
        assertEq(vaultEmergencyHolders[0], emergency, "vault EMERGENCY_ROLE is not the hot key");
    }

    // ─── AC2: Safe holds PROPOSER_ROLE and EXECUTOR_ROLE ─────────────────────

    function test_safe_holdsProposerRole() public view {
        assertTrue(
            d.timelock.hasRole(d.timelock.PROPOSER_ROLE(), safe), "safe missing PROPOSER_ROLE"
        );
    }

    function test_safe_holdsCancellerRole() public view {
        assertTrue(
            d.timelock.hasRole(d.timelock.CANCELLER_ROLE(), safe), "safe missing CANCELLER_ROLE"
        );
    }

    /// @notice One policy (core 1521): EXECUTOR_ROLE is open, held by address(0).
    function test_executorPolicy_executorRoleIsOpen() public view {
        assertTrue(d.timelock.hasRole(d.timelock.EXECUTOR_ROLE(), address(0)), "executor not open");
        assertFalse(d.timelock.hasRole(d.timelock.EXECUTOR_ROLE(), safe), "safe holds executor");
    }

    /// @notice The complete EXECUTOR_ROLE member set, replayed from every RoleGranted and
    ///         RoleRevoked log since before construction, is exactly {address(0)}. No named
    ///         key (emergency, deployer, Safe, admin) and no unnamed address may execute.
    function test_executorPolicy_onlyAddressZeroHoldsExecutorRole() public view {
        assertEq(executorHolders.length, 1, "EXECUTOR_ROLE must have exactly one holder");
        assertEq(executorHolders[0], address(0), "EXECUTOR_ROLE holder is not address(0)");
        address[6] memory named = [emergency, deployer, safe, admin, address(script), address(this)];
        for (uint256 i = 0; i < named.length; i++) {
            assertFalse(d.timelock.hasRole(d.timelock.EXECUTOR_ROLE(), named[i]), "named executor");
        }
    }

    /// @notice The Safe is the only proposer and canceller: no deployer, emergency key or
    ///         stranger holds either role, so no single signer can propose or cancel.
    function test_executorPolicy_safeIsTheOnlyProposerAndCanceller() public view {
        bytes32 proposer = d.timelock.PROPOSER_ROLE();
        bytes32 canceller = d.timelock.CANCELLER_ROLE();
        address[4] memory others = [deployer, emergency, stranger, address(0)];
        for (uint256 i = 0; i < others.length; i++) {
            assertFalse(d.timelock.hasRole(proposer, others[i]), "extra proposer");
            assertFalse(d.timelock.hasRole(canceller, others[i]), "extra canceller");
        }
    }

    /// @notice An address that is neither the Safe nor an owner cannot schedule or cancel.
    function test_executorPolicy_strangerCannotScheduleOrCancel() public {
        // stranger is the shared fixture address.
        bytes32 proposer = d.timelock.PROPOSER_ROLE();
        bytes32 canceller = d.timelock.CANCELLER_ROLE();
        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, proposer
            )
        );
        d.timelock.schedule(address(0xBEEF), 0, "", bytes32(0), bytes32(uint256(1)), 2 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, canceller
            )
        );
        d.timelock.cancel(bytes32(uint256(1)));
        vm.stopPrank();
    }

    // ─── Issue #1645 question 1 / CS-3: the last proposer floor ───────────────

    /// @notice The deployed timelock is a ProposerFloorTimelock. With the Safe as the only
    ///         proposer, `revokeRole(PROPOSER_ROLE, safe)` scheduled through the delay is refused
    ///         at execute with `LastProposerFloor`, and the Safe's instant `renounceRole` is
    ///         refused the same way, so the governed contracts can never lose every proposer.
    ///         After a second proposer is granted through the delay the Safe's role can go, and
    ///         the floor then protects the remaining holder. Every Safe step is a real
    ///         two-signature execTransaction; the exact inner reason is read on the open
    ///         executor path and through the Safe's own simulateAndRevert.
    function test_lastProposerCannotBeRevokedOrRenounced() public {
        ProposerFloorTimelock tl = ProposerFloorTimelock(payable(address(d.timelock)));
        bytes32 proposer = tl.PROPOSER_ROLE();
        assertEq(tl.proposerCount(), 1, "the Safe is the only proposer after the handover");

        // 1. revokeRole through the delay: the Safe schedules it, execute is refused.
        bytes memory revokeSafe = abi.encodeCall(IAccessControl.revokeRole, (proposer, safe));
        bytes32 salt = keccak256("last-proposer-revoke");
        _govSchedule(safe, d.timelock, address(d.timelock), revokeSafe, salt, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY + 1);
        // EXECUTOR_ROLE is open, so the exact inner reason shows on a direct execute...
        vm.expectRevert(ProposerFloorTimelock.LastProposerFloor.selector);
        d.timelock.execute(address(d.timelock), 0, revokeSafe, bytes32(0), salt);
        // ...and the Safe's own execute is refused with GS013 (the Safe hides the inner error).
        bytes memory exec = abi.encodeCall(
            d.timelock.execute, (address(d.timelock), 0, revokeSafe, bytes32(0), salt)
        );
        bytes memory sigs = _twoOwnerSignatures(_safeDigest(safe, address(d.timelock), exec));
        vm.expectRevert(bytes(GS013));
        _safeExecWith(safe, address(d.timelock), exec, sigs);
        assertTrue(tl.hasRole(proposer, safe), "the Safe lost PROPOSER_ROLE");
        assertEq(tl.proposerCount(), 1, "proposer count changed on a refused revoke");

        // 2. renounceRole: an instant Safe transaction, refused by the contract.
        bytes memory renounce = abi.encodeCall(IAccessControl.renounceRole, (proposer, safe));
        _assertSafeCallReverts(
            safe,
            address(d.timelock),
            renounce,
            abi.encodeWithSelector(ProposerFloorTimelock.LastProposerFloor.selector)
        );
        sigs = _twoOwnerSignatures(_safeDigest(safe, address(d.timelock), renounce));
        vm.expectRevert(bytes(GS013));
        _safeExecWith(safe, address(d.timelock), renounce, sigs);
        assertTrue(tl.hasRole(proposer, safe), "the Safe renounced PROPOSER_ROLE");
        assertEq(tl.proposerCount(), 1, "proposer count changed on a refused renounce");

        // 3. A second proposer first: then the Safe's role goes through the delay, and the
        //    floor moves to the remaining holder.
        _govRun(
            safe,
            d.timelock,
            address(d.timelock),
            abi.encodeCall(IAccessControl.grantRole, (proposer, newAdmin)),
            keccak256("second-proposer-grant"),
            MIN_DELAY
        );
        assertEq(tl.proposerCount(), 2, "second proposer not counted");
        _govRun(
            safe,
            d.timelock,
            address(d.timelock),
            revokeSafe,
            keccak256("safe-revoke-with-second-proposer"),
            MIN_DELAY
        );
        assertFalse(tl.hasRole(proposer, safe), "the Safe still holds PROPOSER_ROLE");
        assertEq(tl.proposerCount(), 1, "the remaining proposer is not counted");
        // The remaining proposer is an EOA here, so its own renounce is a plain call.
        vm.expectRevert(ProposerFloorTimelock.LastProposerFloor.selector);
        vm.prank(newAdmin);
        tl.renounceRole(proposer, newAdmin);
        assertTrue(tl.hasRole(proposer, newAdmin), "the last proposer renounced");
    }

    // ─── AC3: Direct ADMIN_ROLE call from Safe EOA reverts ────────────────────

    /// @notice A direct call to setVaultStatus from the Safe (which previously
    ///         held ADMIN_ROLE) must revert with AccessControlUnauthorizedAccount
    ///         now that ADMIN_ROLE is held by the TimelockController.
    ///
    ///         We use registerVault as a representative ADMIN_ROLE gated call
    ///         on VaultRegistry. setVaultStatus requires the vault to be registered
    ///         first; registerVault is simpler to use here.
    function test_directAdminCall_revertsFromSafe() public {
        VaultRegistry.VaultMetadata memory meta = VaultRegistry.VaultMetadata({
            name: "Test Vault", asset: address(usdc), registeredAt: block.timestamp
        });

        _expectDirectSafeCallRefused(
            safe,
            address(registry),
            abi.encodeCall(VaultRegistry.registerVault, (makeAddr("vault"), meta))
        );
        assertFalse(registry.hasRole(ADMIN_ROLE, safe), "the Safe holds no admin role");
    }

    /// @notice Any random EOA that never held ADMIN_ROLE also cannot call
    ///         ADMIN_ROLE gated functions.
    function test_directAdminCall_revertsFromStranger() public {
        VaultRegistry.VaultMetadata memory meta = VaultRegistry.VaultMetadata({
            name: "Test Vault", asset: address(usdc), registeredAt: block.timestamp
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, ADMIN_ROLE
            )
        );
        vm.prank(stranger);
        registry.registerVault(makeAddr("vault"), meta);
    }

    // ─── AC4: TimelockController-routed operation executes after delay ─────────

    /// @notice Schedule a registerVault call through TimelockController, assert
    ///         pre-delay execute reverts, mine the delay, then execute and verify
    ///         the vault is registered.
    function test_timelockRouted_registerVault_succeedsAfterDelay() public {
        address newVault = makeAddr("newVault");
        VaultRegistry.VaultMetadata memory meta = VaultRegistry.VaultMetadata({
            name: "Timelocked Vault", asset: address(usdc), registeredAt: block.timestamp
        });

        bytes memory callData = abi.encodeCall(VaultRegistry.registerVault, (newVault, meta));

        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("test-salt-1");

        // Schedule from the Safe (PROPOSER_ROLE): two owner signatures, real execTransaction.
        _govSchedule(safe, d.timelock, address(registry), callData, salt, MIN_DELAY);

        // Compute operation id.
        bytes32 opId = d.timelock.hashOperation(address(registry), 0, callData, predecessor, salt);

        // Pre-delay: operation is in Waiting state — execute must revert.
        assertEq(
            uint256(d.timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Waiting),
            "expected Waiting state pre-delay"
        );

        _expectExecuteRefused(safe, d.timelock, address(registry), callData, salt);

        // Advance time past the min delay.
        vm.warp(block.timestamp + MIN_DELAY + 1);

        // Now operation is Ready.
        assertEq(
            uint256(d.timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Ready),
            "expected Ready state after delay"
        );

        // Execute from the Safe (EXECUTOR_ROLE).
        _govExecute(safe, d.timelock, address(registry), callData, salt);

        // Verify the operation succeeded.
        assertEq(registry.vaultCount(), 1, "vault should be registered");
        address[] memory vaults = registry.listVaults();
        assertEq(vaults[0], newVault, "wrong vault registered");
    }

    // ─── AC5: getMinDelay() is verifiable on-chain ────────────────────────────

    function test_getMinDelay_returnsConfiguredValue() public view {
        assertEq(d.timelock.getMinDelay(), MIN_DELAY, "min delay mismatch");
    }

    // ─── AC6: ADMIN_ROLE grant through Timelock succeeds ─────────────────────

    /// @notice Schedule an ADMIN_ROLE grant for a new address through the
    ///         TimelockController, mine the delay, execute, and verify the
    ///         new address has ADMIN_ROLE on VaultRegistry.
    function test_timelockRouted_adminRoleGrant_succeedsAfterDelay() public {
        bytes memory callData = abi.encodeCall(IAccessControl.grantRole, (ADMIN_ROLE, newAdmin));

        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("test-admin-grant");

        _govSchedule(safe, d.timelock, address(registry), callData, salt, MIN_DELAY);

        vm.warp(block.timestamp + MIN_DELAY + 1);

        _govExecute(safe, d.timelock, address(registry), callData, salt);

        assertTrue(
            IAccessControl(address(registry)).hasRole(ADMIN_ROLE, newAdmin),
            "newAdmin should have ADMIN_ROLE on registry after timelock execution"
        );
    }

    // ─── INV-3: fee setters are governance- (timelock-) gated (issue #929) ─────
    //
    // After DeployTimelock, ADMIN_ROLE on RobotMoneyVault is held only by the
    // TimelockController. INV-3 requires the fee recipient and fee parameters to
    // change ONLY through the timelock; a direct call from any hot key — even the
    // Safe multisig that proposes/executes timelock operations — must revert
    // because the Safe does not hold ADMIN_ROLE on the vault itself.

    /// @notice INV-3: a direct (non-timelock) setFeeRecipient call from the Safe
    ///         hot key reverts — the Safe holds PROPOSER/EXECUTOR on the timelock,
    ///         not ADMIN_ROLE on the vault.
    function test_INV3_setFeeRecipient_directHotKeyCallReverts() public {
        address newRecipient = makeAddr("newFeeRecipient");
        _expectDirectSafeCallRefused(
            safe, address(vault), abi.encodeCall(vault.setFeeRecipient, (newRecipient))
        );
        assertFalse(vault.hasRole(ADMIN_ROLE, safe), "the Safe holds no admin role");
    }

    /// @notice INV-3: a direct (non-timelock) setExitFeeBps call from the Safe hot
    ///         key reverts for the same reason.
    function test_INV3_setExitFeeBps_directHotKeyCallReverts() public {
        _expectDirectSafeCallRefused(
            safe, address(vault), abi.encodeCall(vault.setExitFeeBps, (50))
        );
        assertFalse(vault.hasRole(ADMIN_ROLE, safe), "the Safe holds no admin role");
    }

    /// @notice INV-3: setFeeRecipient succeeds ONLY when routed through the
    ///         TimelockController (schedule → delay → execute).
    function test_INV3_setFeeRecipient_succeedsViaTimelock() public {
        address newRecipient = makeAddr("newFeeRecipient");
        bytes memory callData = abi.encodeCall(RobotMoneyVault.setFeeRecipient, (newRecipient));
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("inv3-fee-recipient");

        _govSchedule(safe, d.timelock, address(vault), callData, salt, MIN_DELAY);

        // Pre-delay execution must revert.
        _expectExecuteRefused(safe, d.timelock, address(vault), callData, salt);

        vm.warp(block.timestamp + MIN_DELAY + 1);
        _govExecute(safe, d.timelock, address(vault), callData, salt);

        assertEq(vault.feeRecipient(), newRecipient, "fee recipient must update via timelock");
    }

    /// @notice INV-3: setExitFeeBps succeeds ONLY when routed through the
    ///         TimelockController.
    function test_INV3_setExitFeeBps_succeedsViaTimelock() public {
        uint256 newFee = 75;
        bytes memory callData = abi.encodeCall(RobotMoneyVault.setExitFeeBps, (newFee));
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("inv3-exit-fee");

        _govSchedule(safe, d.timelock, address(vault), callData, salt, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY + 1);
        _govExecute(safe, d.timelock, address(vault), callData, salt);

        assertEq(vault.exitFeeBps(), newFee, "exit fee must update via timelock");
    }

    // ─── AC3: quarantine address is timelock-gated (issue #929) ──────────────
    //
    // After DeployTimelock, ADMIN_ROLE on RobotMoneyVault is held only by the
    // TimelockController. The quarantine address for foreign-token sweeps may
    // only change via the timelock; a direct hot-key call must revert.

    /// @notice AC3: a direct (non-timelock) setQuarantineAddress call from the
    ///         Safe hot key reverts — the Safe holds only PROPOSER/EXECUTOR on
    ///         the timelock, not ADMIN_ROLE on the vault.
    function test_AC3_setQuarantineAddress_directHotKeyCallReverts() public {
        address newQuarantine = makeAddr("newQuarantine");
        _expectDirectSafeCallRefused(
            safe, address(vault), abi.encodeCall(vault.setQuarantineAddress, (newQuarantine))
        );
        assertFalse(vault.hasRole(ADMIN_ROLE, safe), "the Safe holds no admin role");
    }

    /// @notice AC3: setQuarantineAddress succeeds ONLY when routed through the
    ///         TimelockController (schedule → delay → execute). After the update,
    ///         foreign-token sweeps on the vault go to the new address, not the
    ///         old constant — proving the governed quarantine model is end-to-end.
    function test_AC3_setQuarantineAddress_succeedsViaTimelock() public {
        address newQuarantine = makeAddr("newQuarantine");
        bytes memory callData =
            abi.encodeCall(RobotMoneyVault.setQuarantineAddress, (newQuarantine));
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("ac3-quarantine-addr");

        _govSchedule(safe, d.timelock, address(vault), callData, salt, MIN_DELAY);

        // Pre-delay execution must revert.
        _expectExecuteRefused(safe, d.timelock, address(vault), callData, salt);

        vm.warp(block.timestamp + MIN_DELAY + 1);
        _govExecute(safe, d.timelock, address(vault), callData, salt);

        assertEq(
            vault.quarantineAddress(), newQuarantine, "quarantine address must update via timelock"
        );
    }

    // ─── #942: unified governance retire() is timelock-gated (DI-2) ───────────
    //
    // After DeployTimelock, ADMIN_ROLE on VaultRegistry is held only by the
    // TimelockController, and the registry is linked to the vault (setRegistry in
    // the deploy script). The unified governance retire() must therefore be
    // reachable ONLY via schedule → mine delay → execute; a direct ADMIN_ROLE
    // EOA call must revert.

    /// @dev Register a vault through the timelock so later retire() tests have a
    ///      registered target. Returns nothing — registers `address(vault)`.
    function _registerVaultViaTimelock() internal {
        VaultRegistry.VaultMetadata memory meta = VaultRegistry.VaultMetadata({
            name: "Retire Target", asset: address(usdc), registeredAt: block.timestamp
        });
        bytes memory callData = abi.encodeCall(VaultRegistry.registerVault, (address(vault), meta));
        bytes32 salt = keccak256("retire-register");
        _govSchedule(safe, d.timelock, address(registry), callData, salt, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY + 1);
        _govExecute(safe, d.timelock, address(registry), callData, salt);
    }

    /// @notice #942 AC2: a direct (non-timelock) retire() call from the Safe hot
    ///         key reverts — the Safe holds PROPOSER/EXECUTOR on the timelock, not
    ///         ADMIN_ROLE on the registry.
    function test_retire_directHotKeyCallReverts() public {
        _registerVaultViaTimelock();
        _expectDirectSafeCallRefused(
            safe, address(registry), abi.encodeCall(registry.retire, (address(vault)))
        );
        assertFalse(registry.hasRole(ADMIN_ROLE, safe), "the Safe holds no admin role");
    }

    /// @notice #942 AC2: a stranger EOA likewise cannot call retire().
    function test_retire_directStrangerCallReverts() public {
        _registerVaultViaTimelock();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, ADMIN_ROLE
            )
        );
        registry.retire(address(vault));
    }

    /// @notice #942 AC3: retire() routed through the TimelockController (schedule →
    ///         delay → execute) atomically sets registry status to `Retired` AND
    ///         halts vault deposits in one transaction. Pre-delay execution must
    ///         revert, proving the action is reachable only after the delay.
    function test_retire_succeedsViaTimelock_atomicallyHaltsDeposits() public {
        _registerVaultViaTimelock();

        // Pre-condition: registry status Active, vault not retired.
        (, VaultRegistry.VaultStatus pre) = registry.getVault(address(vault));
        assertEq(uint256(pre), uint256(VaultRegistry.VaultStatus.Active), "Active pre-retire");
        assertFalse(vault.retired(), "vault not retired pre-retire");

        bytes memory callData = abi.encodeCall(VaultRegistry.retire, (address(vault)));
        bytes32 salt = keccak256("retire-exec");

        _govSchedule(safe, d.timelock, address(registry), callData, salt, MIN_DELAY);

        // Pre-delay execution must revert.
        _expectExecuteRefused(safe, d.timelock, address(registry), callData, salt);

        vm.warp(block.timestamp + MIN_DELAY + 1);
        _govExecute(safe, d.timelock, address(registry), callData, salt);

        // Both layers flipped atomically in the one executed call: registry
        // status Retired AND the vault deposit-halt flag set.
        (, VaultRegistry.VaultStatus post) = registry.getVault(address(vault));
        assertEq(
            uint256(post),
            uint256(VaultRegistry.VaultStatus.Retired),
            "registry status must be Retired after timelock retire"
        );
        assertTrue(vault.retired(), "vault deposit-halt leg must be set after timelock retire");
        // maxDeposit() is 0 regardless of adapters once retired; assert the
        // retired branch holds.
        assertEq(vault.maxDeposit(address(this)), 0, "deposits halted after timelock retire");
    }

    /// @notice #942: `shutdownVault` is unchanged — still EMERGENCY-tier,
    ///         vault-only, with NO registry state change. After the #965/F-01
    ///         handover the vault's EMERGENCY_ROLE is held by the independent
    ///         `emergency` hot key (NOT the deployer/script and NOT the timelock);
    ///         exercising it directly proves the emergency overlay still works and
    ///         touches no registry state.
    function test_shutdownVault_unchanged_makesNoRegistryChange() public {
        _registerVaultViaTimelock();

        // EMERGENCY_ROLE holder (the independent emergency hot key) can shut the
        // vault down directly.
        vm.prank(emergency);
        vault.shutdownVault();

        assertTrue(vault.shutdown(), "shutdownVault must set the emergency flag");
        assertFalse(vault.retired(), "shutdownVault must NOT set the lifecycle retired flag");
        (, VaultRegistry.VaultStatus status) = registry.getVault(address(vault));
        assertEq(
            uint256(status),
            uint256(VaultRegistry.VaultStatus.Active),
            "shutdownVault must make no registry/lifecycle change"
        );
    }

    // ─── ACL-1 / F-01: deployer EOA holds NO privileged role after handover ───
    //
    // The handover (this script) must leave the deployer EOA with none of
    // {DEFAULT_ADMIN_ROLE, ADMIN_ROLE, EMERGENCY_ROLE, DEPOSIT_PAUSER_ROLE} on the
    // Gateway or any vault. The deep deploy-assertion lives in
    // contracts/test/fv/DeployAssertions.t.sol::test_ACL1_*; these tests pin the
    // individual legs and the fix-interaction guarantees.
    //
    // In setUp the deployer EOA is `address(script)`: it holds every role at
    // construction, sends every grant and revoke, and is the `msg.sender` the
    // script revokes from, as the broadcaster is in a real run. `admin` is the
    // gateway PAUSER but never held DEFAULT_ADMIN there; `emergency` is the
    // independent emergency hot key. The complete post-handover member sets are
    // asserted in test_handover_* above.

    /// @notice ACL-1: the Timelock receives BOTH ADMIN_ROLE and DEFAULT_ADMIN_ROLE
    ///         on the Gateway (so it can rotate roles), and holds
    ///         ADMIN_ROLE on the vault.
    function test_ACL1_timelockHoldsGatewayRootAfterHandover() public view {
        assertTrue(
            gateway.hasRole(ADMIN_ROLE, address(d.timelock)), "timelock missing Gateway ADMIN_ROLE"
        );
        assertTrue(
            gateway.hasRole(DEFAULT_ADMIN_ROLE, address(d.timelock)),
            "timelock missing Gateway DEFAULT_ADMIN_ROLE"
        );
        assertTrue(
            vault.hasRole(ADMIN_ROLE, address(d.timelock)), "timelock missing vault ADMIN_ROLE"
        );
    }

    /// @notice AC: the vault EMERGENCY_ROLE is held by the independent hot key
    ///         (not the timelock — emergency response stays a fast hot-key path).
    function test_ACL1_vaultEmergencyRoleHeldByIndependentHotKey() public view {
        assertTrue(
            vault.hasRole(EMERGENCY_ROLE, emergency),
            "independent emergency hot key missing vault EMERGENCY_ROLE"
        );
        assertFalse(
            vault.hasRole(EMERGENCY_ROLE, address(d.timelock)),
            "timelock must not hold the vault EMERGENCY_ROLE"
        );
    }

    /// @notice ACL-9: after the handover no role, the timelock included, can
    ///         grant, revoke or renounce AGENT_ROLE through the public methods.
    function test_ACL9_timelockCannotManageAgentRoleAfterHandover() public {
        address newAgent = makeAddr("post-handover-agent");
        vm.startPrank(address(d.timelock));
        vm.expectRevert(AccessRoles.AgentRoleNotManageable.selector);
        gateway.grantRole(AGENT_ROLE, newAgent);
        vm.expectRevert(AccessRoles.AgentRoleNotManageable.selector);
        gateway.revokeRole(AGENT_ROLE, newAgent);
        vm.stopPrank();
    }

    /// @notice ACL-9: the gateway has no admin registration shortcut. The old
    ///         selectors are absent, so a timelock-routed call to them reverts.
    function test_ACL9_noAdminRegistrationSelectorExists() public {
        IGateway.AgentPolicy memory p = _agentPolicy();
        bytes memory callData = abi.encodeWithSignature(
            "authorizeAgent(address,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))",
            makeAddr("rejected-agent"),
            p
        );
        vm.prank(address(d.timelock));
        (bool ok,) = address(gateway).call(callData);
        assertFalse(ok, "authorizeAgent must not exist");
    }

    /// @notice Negative regression for the fix-interaction warning: a NAKED
    ///         DEFAULT_ADMIN_ROLE revoke that did NOT redirect AGENT_ROLE's admin
    ///         to ADMIN_ROLE would leave AGENT_ROLE ungrantable forever. We build
    ///         a throwaway gateway whose AGENT_ROLE admin is the default
    ///         (DEFAULT_ADMIN_ROLE), revoke that root from the only holder, and
    ///         assert AGENT_ROLE can no longer be granted — proving the
    ///         constructor's `_setRoleAdmin(AGENT_ROLE, ADMIN_ROLE)` is what keeps
    ///         the real gateway safe.
    function test_ACL1_nakedDefaultAdminRevoke_bricksAgentRoleWithoutReadmin() public {
        NaiveAgentGateway naive = new NaiveAgentGateway(address(this));
        // Sanity: AGENT_ROLE admin is the default root (the bug condition).
        assertEq(
            naive.getRoleAdmin(AGENT_ROLE),
            DEFAULT_ADMIN_ROLE,
            "pre-condition: AGENT_ROLE admin is DEFAULT_ADMIN_ROLE"
        );
        // Naked revoke of the root from its only holder.
        naive.revokeRole(DEFAULT_ADMIN_ROLE, address(this));
        assertFalse(naive.hasRole(DEFAULT_ADMIN_ROLE, address(this)), "root not revoked");

        // AGENT_ROLE is now ungrantable: nobody holds its admin (DEFAULT_ADMIN).
        address wouldBeAgent = makeAddr("bricked-agent");
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(this),
                DEFAULT_ADMIN_ROLE
            )
        );
        naive.grantRole(AGENT_ROLE, wouldBeAgent);
    }

    /// @dev Minimal active AgentPolicy used by the authorize tests.
    function _agentPolicy() internal returns (IGateway.AgentPolicy memory p) {
        address[] memory empty = new address[](0);
        p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: 1e6,
            maxPerWindow: 1e6,
            shareReceiver: makeAddr("share-receiver"),
            allowedDestinations: empty,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
    }

    // ─── Revert cases — script validation ────────────────────────────────────

    function test_deploy_revertsOnZeroSafe() public {
        vm.startPrank(admin);
        vm.expectRevert(bytes("SAFE_ADDRESS=0"));
        script.runInProcess(
            address(registry),
            address(registry),
            address(registry),
            address(router),
            address(governance),
            address(0), // safe = zero
            emergency,
            MIN_DELAY,
            _fixtureSpec()
        );
        vm.stopPrank();
    }

    function test_deploy_revertsOnZeroMinDelay() public {
        vm.startPrank(admin);
        vm.expectRevert(bytes("TIMELOCK_MIN_DELAY=0"));
        script.runInProcess(
            address(registry),
            address(registry),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            0, // zero delay
            _fixtureSpec()
        );
        vm.stopPrank();
    }

    // ─── AC: SAFE_ADDRESS must be a real Safe (issue #422, core S1) ────────────

    function _runWithSafe(address safe_, address[] memory owners_, uint256 threshold_) internal {
        script.runInProcess(
            address(registry),
            address(registry),
            address(registry),
            address(router),
            address(governance),
            safe_,
            emergency,
            MIN_DELAY,
            DeployTimelock.SafeSpec({owners: owners_, threshold: threshold_})
        );
    }

    function test_deploy_revertsWhenSafeIsEOA() public {
        address eoaSafe = makeAddr("eoaSafe");
        assertEq(eoaSafe.code.length, 0, "pre-condition: address must be an EOA");
        address[] memory owners = _fixtureOwners();
        vm.expectRevert(bytes("SAFE_ADDRESS is an EOA: deploy a Safe multisig contract first"));
        _runWithSafe(eoaSafe, owners, FIXTURE_THRESHOLD);
    }

    /// @notice A 10-byte code stub is not a Safe.
    function test_deploy_rejectsTenByteCodeStub() public {
        address stub = makeAddr("tenByteStub");
        vm.etch(stub, hex"60016000526001601ff3");
        assertEq(stub.code.length, 10);
        address[] memory owners = _fixtureOwners();
        vm.expectRevert(bytes("SAFE_ADDRESS is not a SafeProxy 1.4.1: codehash mismatch"));
        _runWithSafe(stub, owners, FIXTURE_THRESHOLD);
    }

    /// @notice A Safe proxy that does not delegate to the canonical SafeL2 singleton.
    function test_deploy_rejectsWrongSingleton() public {
        address other = _newDefaultSafe();
        vm.store(other, bytes32(0), bytes32(uint256(uint160(makeAddr("other-singleton")))));
        address[] memory owners = _fixtureOwners();
        vm.expectRevert(bytes("SAFE_ADDRESS does not delegate to the canonical SafeL2 singleton"));
        _runWithSafe(other, owners, FIXTURE_THRESHOLD);
    }

    function test_deploy_rejectsWrongOwners() public {
        address[] memory strangers = new address[](3);
        strangers[0] = makeAddr("stranger-owner-1");
        strangers[1] = makeAddr("stranger-owner-2");
        strangers[2] = makeAddr("stranger-owner-3");
        address wrongSafe = _newSafe(strangers, 2);
        address[] memory owners = _fixtureOwners();
        vm.expectRevert(bytes("SAFE_OWNERS entry is not a Safe owner"));
        _runWithSafe(wrongSafe, owners, FIXTURE_THRESHOLD);
    }

    function test_deploy_rejectsOwnerCountMismatch() public {
        address[] memory two = new address[](2);
        two[0] = makeAddr("safe-owner-1");
        two[1] = makeAddr("safe-owner-2");
        address defaultSafe = _newDefaultSafe();
        vm.expectRevert(bytes("Safe owner count != SAFE_OWNERS"));
        _runWithSafe(defaultSafe, two, 2);
    }

    /// @notice The Safe's real threshold is 1: rejected against SAFE_THRESHOLD=2.
    function test_deploy_revertsWhenSafeThresholdTooLow() public {
        address[] memory owners = _fixtureOwners();
        address lowSafe = _newSafe(owners, 1);
        vm.expectRevert(bytes("Safe threshold != SAFE_THRESHOLD"));
        _runWithSafe(lowSafe, owners, 2);
    }

    /// @notice SAFE_THRESHOLD itself must be a real quorum.
    function test_deploy_revertsWhenExpectedThresholdBelowTwo() public {
        address[] memory owners = _fixtureOwners();
        address lowSafe = _newSafe(owners, 1);
        vm.expectRevert(bytes("SAFE_THRESHOLD < 2: configure at least 2-of-N quorum"));
        _runWithSafe(lowSafe, owners, 1);
    }

    function test_deploy_revertsWhenSafeThresholdIsWrongNumber() public {
        address[] memory owners = _fixtureOwners();
        address threeSafe = _newSafe(owners, 3);
        vm.expectRevert(bytes("Safe threshold != SAFE_THRESHOLD"));
        _runWithSafe(threeSafe, owners, 2);
    }

    function test_deploy_rejectsEnabledModule() public {
        address withModule = _newDefaultSafe();
        address module = makeAddr("evil-module");
        // modules[SENTINEL(1)] = module; modules[module] = SENTINEL (mapping at slot 1).
        vm.store(
            withModule,
            keccak256(abi.encode(address(0x1), uint256(1))),
            bytes32(uint256(uint160(module)))
        );
        vm.store(withModule, keccak256(abi.encode(module, uint256(1))), bytes32(uint256(1)));
        address[] memory owners = _fixtureOwners();
        vm.expectRevert(bytes("Safe has an enabled module"));
        _runWithSafe(withModule, owners, FIXTURE_THRESHOLD);
    }

    function test_deploy_rejectsGuard() public {
        address guarded = _newDefaultSafe();
        bytes32 guardSlot = script.SAFE_GUARD_SLOT();
        vm.store(guarded, guardSlot, bytes32(uint256(uint160(makeAddr("guard")))));
        address[] memory owners = _fixtureOwners();
        vm.expectRevert(bytes("Safe has a transaction guard set"));
        _runWithSafe(guarded, owners, FIXTURE_THRESHOLD);
    }

    function test_deploy_rejectsWrongFallbackHandler() public {
        address[] memory owners = _fixtureOwners();
        address odd = _newSafeWith(owners, 2, makeAddr("odd-handler"));
        vm.expectRevert(
            bytes("Safe fallback handler is not the canonical CompatibilityFallbackHandler")
        );
        _runWithSafe(odd, owners, FIXTURE_THRESHOLD);
    }

    function test_deploy_rejectsDuplicateOwnersInList() public {
        address[] memory dup = new address[](3);
        dup[0] = makeAddr("safe-owner-1");
        dup[1] = makeAddr("safe-owner-1");
        dup[2] = makeAddr("safe-owner-3");
        address defaultSafe = _newDefaultSafe();
        vm.expectRevert(bytes("SAFE_OWNERS contains a duplicate"));
        _runWithSafe(defaultSafe, dup, 2);
    }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/// @dev Delay floor keyed to chain id, and a real Safe accepted end to end (core S1).
///      Each test builds a fresh, un-handed-over topology.
contract DeployTimelockChainFloorTest is SafeGovernance {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    uint256 internal constant TWIN_CHAIN_ID = 918453;
    uint256 internal constant BASE_CHAIN_ID = 8453;

    DeployTimelock internal script;
    address internal deployer;
    address internal safe;
    address internal emergency = makeAddr("floor-emergency");
    RobotMoneyVault internal vault;
    RobotMoneyGateway internal gateway;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal governance;

    function setUp() public {
        TestERC20 usdc = new TestERC20();
        script = new DeployTimelock();
        deployer = address(script);
        _installSafeSet();
        safe = _newDefaultSafe();
        usdc_ = usdc;
    }

    TestERC20 internal usdc_;

    /// @dev Issue 1808: the proxies name the timelock for `delay` (CREATE2, bound to the Safe
    ///      and the delay), so the stack is built for the delay the test runs with.
    function _build(uint256 delay) internal {
        CoreProxies.useUpgradeConfig(
            script.predictTimelock(safe, delay), GovernedUUPS.UpgradeMode.Upgradeable
        );
        vault = CoreProxies.robotMoneyVault(
            usdc_, type(uint256).max, type(uint256).max, 0, safe, deployer, deployer
        );
        gateway = CoreProxies.robotMoneyGateway(
            usdc_, vault, deployer, makeAddr("floor-pauser"), address(0)
        );
        registry = CoreProxies.vaultRegistry(deployer);
        router = CoreProxies.portfolioRouter(address(usdc_), address(registry), deployer);
        governance = CoreProxies.routerGovernance(address(router), makeAddr("receipts"), deployer);
        vm.prank(deployer);
        router.grantRole(ADMIN_ROLE, address(governance));
        vm.prank(deployer);
        router.grantRole(keccak256("WEIGHT_SETTER_ROLE"), address(governance));
    }

    function _run(uint256 delay) internal returns (DeployTimelock.Deployed memory) {
        if (address(vault) == address(0)) _build(delay);
        address[] memory owners = _fixtureOwners();
        vm.prank(deployer);
        return script.runInProcess(
            address(vault),
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            delay,
            DeployTimelock.SafeSpec({owners: owners, threshold: FIXTURE_THRESHOLD})
        );
    }

    /// @notice On chain id 8453 a 60 second delay reverts.
    function test_delay60_revertsOnBase() public {
        vm.chainId(BASE_CHAIN_ID);
        _build(60);
        vm.expectRevert(bytes("TIMELOCK_MIN_DELAY below 172800 (48h) on Base mainnet"));
        _run(60);
    }

    function test_delayJustBelowFloor_revertsOnBase() public {
        vm.chainId(BASE_CHAIN_ID);
        _build(172_799);
        vm.expectRevert(bytes("TIMELOCK_MIN_DELAY below 172800 (48h) on Base mainnet"));
        _run(172_799);
    }

    function test_delayAtFloor_passesOnBase() public {
        vm.chainId(BASE_CHAIN_ID);
        DeployTimelock.Deployed memory d = _run(172_800);
        assertEq(d.timelock.getMinDelay(), 172_800);
    }

    /// @notice On the Twin chain (918453) the same 60 second delay passes.
    function test_delay60_passesOnTwinChain() public {
        vm.chainId(TWIN_CHAIN_ID);
        DeployTimelock.Deployed memory d = _run(60);
        assertEq(d.timelock.getMinDelay(), 60);
    }

    function test_delay1_passesOnTwinChain() public {
        vm.chainId(TWIN_CHAIN_ID);
        DeployTimelock.Deployed memory d = _run(1);
        assertEq(d.timelock.getMinDelay(), 1);
    }

    /// @notice A SafeL2 1.4.1 proxy made by the factory is accepted.
    function test_factoryMadeSafeL2_isAccepted() public {
        DeployTimelock.Deployed memory d = _run(2 days);
        assertTrue(IAccessControl(address(vault)).hasRole(ADMIN_ROLE, address(d.timelock)));
    }
}

/// @dev A deliberately NAIVE gateway: plain AccessControl with AGENT_ROLE whose
///      admin is left at the default (DEFAULT_ADMIN_ROLE), i.e. WITHOUT the
///      `_setRoleAdmin(AGENT_ROLE, ADMIN_ROLE)` redirect the real
///      RobotMoneyGateway constructor performs. Models the pre-fix gateway so the
///      negative test can prove that a naked DEFAULT_ADMIN_ROLE revoke would
///      brick AGENT_ROLE (fix-interaction warning, F-01).
contract NaiveAgentGateway is AccessControl {
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    constructor(address root) {
        // Only the default root is granted; AGENT_ROLE's admin stays
        // DEFAULT_ADMIN_ROLE (the bug condition). No _setRoleAdmin redirect.
        _grantRole(DEFAULT_ADMIN_ROLE, root);
    }
}

// ─── R7: the deployment manifest ──────────────────────────────────────────────

/// @dev Exposes the script's internal manifest writer. `_writeJson` runs only
///      inside `run()`, which needs a broadcast context and a live chain — so
///      without this seam the manifest is the one part of the deploy script
///      that ships untested, and a serialization mistake in it surfaces as a
///      malformed artifact during a real ceremony.
///      Tests write through `exposedWriteJsonTo` with an explicit path: env
///      vars are process-wide and forge runs test contracts in parallel, so
///      two test contracts that each set `DEPLOYMENT_OUT` can write to each
///      other's file.
contract ManifestHarness is DeployTimelock {
    function exposedWriteJsonTo(Deployed memory d, string memory outPath) external {
        _writeJsonTo(d, outPath);
    }

    /// @dev The body of `run()`, reading every env var under `prefix`.
    function exposedRunFrom(string memory prefix) external returns (Deployed memory) {
        return _runFrom(prefix);
    }
}

/// @notice The manifest must answer, from one file: which chain, which
///         addresses, which bytecode, holding which roles.
contract DeployTimelockManifestTest is SafeGovernance {
    using stdJson for string;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    ManifestHarness internal harness;
    string internal manifest;
    string internal outPath;

    function setUp() public {
        // Build the topology the way DeployTimelockTest does, run the real
        // handover, then write the manifest for the resulting state.
        TestERC20 usdc = new TestERC20();
        DeployTimelock script = new DeployTimelock();
        address deployer = address(script);
        _installSafeSet();
        address safe = _newDefaultSafe();
        address emergency = makeAddr("manifest-emergency");
        CoreProxies.useUpgradeConfig(
            script.predictTimelock(safe, 2 days), GovernedUUPS.UpgradeMode.Upgradeable
        );

        RobotMoneyVault vault = CoreProxies.robotMoneyVault(
            usdc, type(uint256).max, type(uint256).max, 0, safe, deployer, deployer
        );
        RobotMoneyGateway gateway = CoreProxies.robotMoneyGateway(
            usdc, vault, deployer, makeAddr("manifest-pauser"), address(0)
        );
        VaultRegistry registry = CoreProxies.vaultRegistry(deployer);
        PortfolioRouter router =
            CoreProxies.portfolioRouter(address(usdc), address(registry), deployer);
        RouterGovernance governance =
            CoreProxies.routerGovernance(address(router), makeAddr("receipts"), deployer);

        vm.prank(deployer);
        router.grantRole(ADMIN_ROLE, address(governance));

        vm.prank(deployer);
        router.grantRole(keccak256("WEIGHT_SETTER_ROLE"), address(governance));

        // Call the script FROM the script's own address so the roles it revokes
        // from `msg.sender` are the roles it actually holds.
        vm.prank(deployer);
        DeployTimelock.Deployed memory d = script.runInProcess(
            address(vault),
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            2 days,
            _fixtureSpec()
        );

        harness = new ManifestHarness();
        // One claimed directory per test: setUp runs once per test, in parallel, so a shared name is raced.
        outPath = claimTmpPath(vm, "r7-manifest");

        // `_writeJsonTo` reads `msg.sender` for the deployer role rows, so the
        // harness call must carry the same deployer identity.
        vm.prank(deployer);
        harness.exposedWriteJsonTo(d, outPath);
        manifest = vm.readFile(outPath);
        releaseTmpPath(vm, outPath);
    }

    function test_manifestRecordsTheChainId() public view {
        assertEq(manifest.readUint(".chain_id"), block.chainid);
    }

    function test_manifestRecordsAddresses() public view {
        assertTrue(
            manifest.readAddress(".addresses.router") != address(0), "router address missing"
        );
        assertTrue(
            manifest.readAddress(".addresses.governance") != address(0),
            "governance address missing"
        );
        // The flat keys existing readers index by are preserved.
        assertEq(manifest.readAddress(".router"), manifest.readAddress(".addresses.router"));
    }

    /// @notice Code hashes are what make the manifest an identity record rather
    ///         than an address list: two deployments at the same address on two
    ///         chains are distinguishable only by bytecode.
    function test_manifestRecordsCodeHashes() public view {
        bytes32 routerHash = manifest.readBytes32(".code_hashes.router");
        assertTrue(routerHash != bytes32(0), "router code hash missing");
        assertEq(routerHash, manifest.readAddress(".addresses.router").codehash);
        assertTrue(manifest.readBytes32(".code_hashes.governance") != bytes32(0));
        assertTrue(manifest.readBytes32(".code_hashes.timelock") != bytes32(0));
    }

    /// @notice ADR-0014 (security round 1): behind a proxy `.codehash` is the generic ERC1967Proxy, the
    ///         same for every proxy, so the dapp's code-hash pins prove nothing about the logic. The
    ///         manifest also records keccak256 of the code of each proxy's live implementation (zero
    ///         for a direct contract): the dapp's implementation pins (scripts/stage/mainnet-dapp.ts).
    function test_manifestRecordsImplementationCodeHashes() public view {
        address router = manifest.readAddress(".addresses.router");
        assertEq(
            manifest.readBytes32(".code_hashes.router_implementation"),
            _implementationCodeHashOf(router),
            "router implementation code hash"
        );
        address[] memory vaults = manifest.readAddressArray(".addresses.vaults");
        assertGt(vaults.length, 0, "no vault in the manifest");
        for (uint256 i = 0; i < vaults.length; i++) {
            string memory key = string.concat(
                ".vault_handover.vault_", vm.toString(i), ".implementation_code_hash"
            );
            assertEq(manifest.readBytes32(key), _implementationCodeHashOf(vaults[i]), key);
        }
    }

    function _implementationCodeHashOf(address proxy) internal view returns (bytes32) {
        address impl = address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
        if (impl == address(0)) return bytes32(0);
        assertTrue(impl.code.length > 0, "implementation has no code");
        return keccak256(impl.code);
    }

    /// @notice Issue #1698: the manifest records the receipt register the weight setter applies
    ///         from, read back from the governance contract (`receipts()` is immutable).
    function test_manifestRecordsTheReceiptRegisterGovernanceAppliesFrom() public view {
        address governance = manifest.readAddress(".addresses.governance");
        assertEq(
            manifest.readAddress(".governance_receipt"),
            address(RouterGovernance(governance).receipts())
        );
        assertTrue(manifest.readAddress(".governance_receipt") != address(0), "no register");
    }

    /// @notice The two R7 conditions, recorded as booleans an auditor can grep.
    function test_manifestRecordsTheR7RoleConditions() public view {
        assertTrue(
            manifest.readBool(".roles.governance_has_router_admin_role"),
            "manifest says governance cannot reach setWeights"
        );
        assertFalse(
            manifest.readBool(".roles.deployer_has_router_admin_role"),
            "manifest says the deployer EOA can still move weights"
        );
        assertTrue(manifest.readBool(".roles.timelock_has_router_admin_role"));
        assertTrue(manifest.readBool(".roles.safe_is_timelock_proposer"));
        assertTrue(manifest.readBool(".roles.safe_is_timelock_canceller"));
        assertTrue(manifest.readBool(".roles.timelock_executor_is_open"));
    }

    /// @notice The policy the timelock was built with is in the manifest (core 1521).
    function test_executorPolicy_manifestRecordsPolicy() public view {
        assertEq(manifest.readString(".executorPolicy"), "open");
        assertEq(manifest.readString(".cancellerPolicy"), "safe-only");
    }

    /// @notice Every manifest test in this file passes its output path to
    ///         `exposedWriteJsonTo`. None sets `DEPLOYMENT_OUT`: env vars are
    ///         process-wide and forge runs test contracts in parallel, so a
    ///         shared variable lets one test write to another test's path.
    function test_manifestTests_passAnExplicitPath_neverSetDeploymentOut() public view {
        string memory src = vm.readFile("contracts/test/DeployTimelock.t.sol");
        string memory setter = string.concat("vm.setEnv(", '"', "DEPLOYMENT_", "OUT", '"');
        assertFalse(vm.contains(src, setter), "a test sets the shared DEPLOYMENT_OUT variable");
    }

    /// @notice There is no voting (issue 1698), so the manifest records no quorum.
    function test_manifestRecordsNoQuorum() public view {
        assertFalse(vm.keyExistsJson(manifest, ".quorum_threshold"), "quorum in manifest");
        assertFalse(vm.keyExistsJson(manifest, ".min_quorum_threshold"), "quorum floor in manifest");
    }

    /// @notice The manifest carries no agent handover fields (ACL-9).
    function test_manifestRecordsNoAgentHandover() public view {
        assertFalse(vm.keyExistsJson(manifest, ".timelock_owned_agents"));
        assertFalse(vm.keyExistsJson(manifest, ".roles.gateway_agents_listed_count"));
        assertFalse(vm.keyExistsJson(manifest, ".roles.deployer_owns_a_listed_gateway_agent"));
    }
}

/// @notice `run()` drives its own body, `_runFrom`, through
///         the broadcast path against a core stack (CoreStages). Every env var it
///         reads carries a prefix only this test sets, because env vars are
///         process-wide and forge runs tests in parallel.
abstract contract DeployTimelockRunEntrypointBase is SafeGovernance {
    using stdJson for string;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    /// @dev Overridden by subclasses so tests that mutate shared env vars
    ///      (vm.setEnv is process-wide) each get their own namespace.
    function _prefix() internal pure virtual returns (string memory) {
        return "RM_1476_RUN_ENTRYPOINT_";
    }
    /// @dev Set in setUp from `uniqueTmpPath` with a tag that carries `_prefix()`: the subclasses below share this base, and every test contract is deployed at one address, so only `_prefix()` tells their files apart. Each subclass has its own prefix.
    string internal OUT_PATH;

    ManifestHarness internal harness;
    address internal deployer;
    address internal deployAgent = makeAddr("run-deploy-agent");
    CoreStages.Stack internal dep;
    RobotMoneyGateway internal gateway;
    address internal safe;

    function _set(string memory name, string memory value) internal {
        vm.setEnv(string.concat(_prefix(), name), value);
    }

    /// @dev The TIMELOCK_MIN_DELAY the test's successful `run()` uses: the stack is bound to the
    ///      timelock for that delay (issue 1808).
    function _stackDelay() internal pure virtual returns (uint256) {
        return 172_800;
    }

    /// @dev Removes this test's own manifest once the test ends. The path is unique to this contract (see `OUT_PATH`), so nothing else is touched.
    modifier removesOwnManifest() {
        _;
        if (vm.exists(OUT_PATH)) vm.removeFile(OUT_PATH);
    }

    function setUp() public {
        harness = new ManifestHarness();
        // In a real `forge script`, run() is called by the broadcaster, and
        // the broadcast sends every call from that same account. The default
        // broadcaster is tx.origin, so it is the deployer here. Broadcasting
        // is not allowed under a prank, so a relay placed at tx.origin makes
        // the call into run()'s body instead.
        deployer = tx.origin;
        vm.etch(deployer, address(new RunEntrypointRelay()).code);
        // Issue 1808: the Safe comes first, so every proxy of the stack (the CoreStages ones
        // too) names the timelock `run()` deploys for this Safe and `_stackDelay()`.
        _installSafeSet();
        address[] memory owners = _fixtureOwners();
        safe = _newSafe(owners, FIXTURE_THRESHOLD);
        CoreProxies.useUpgradeConfig(
            harness.predictTimelock(safe, _stackDelay()), GovernedUUPS.UpgradeMode.Upgradeable
        );
        TestERC20 usdc = new TestERC20();
        dep = new CoreStages()
            .run(
                deployer,
                makeAddr("run-pauser"),
                deployAgent,
                makeAddr("run-receiver"),
                address(usdc)
            );
        gateway = dep.gateway;
        VaultRegistry registry = CoreProxies.vaultRegistry(deployer);
        PortfolioRouter router =
            CoreProxies.portfolioRouter(address(usdc), address(registry), deployer);
        // The receipt contract is a required input on every chain. The deployer
        // holds its admin roles until the handover. The receipt register exists
        // before governance, which releases receipts through it (issue 1698).
        ConsensusRecommendationReceipt receipt =
            CoreProxies.consensusRecommendationReceipt(deployer);
        RouterGovernance governance =
            CoreProxies.routerGovernance(address(router), address(receipt), deployer);
        bytes32 releaserRole = receipt.RECEIPT_RELEASER_ROLE();
        vm.prank(deployer);
        receipt.grantRole(releaserRole, address(governance));
        vm.prank(deployer);
        router.grantRole(ADMIN_ROLE, address(governance));
        vm.prank(deployer);
        router.grantRole(keccak256("WEIGHT_SETTER_ROLE"), address(governance));

        _set("VAULT_ADDRESSES", vm.toString(address(dep.vault)));
        _set("GATEWAY_ADDRESS", vm.toString(address(gateway)));
        _set("REGISTRY_ADDRESS", vm.toString(address(registry)));
        _set("ROUTER_ADDRESS", vm.toString(address(router)));
        _set("GOVERNANCE_ADDRESS", vm.toString(address(governance)));
        _set("SAFE_ADDRESS", vm.toString(safe));
        _set(
            "SAFE_OWNERS",
            string.concat(
                vm.toString(owners[0]), ",", vm.toString(owners[1]), ",", vm.toString(owners[2])
            )
        );
        _set("SAFE_THRESHOLD", vm.toString(FIXTURE_THRESHOLD));
        _set("EMERGENCY_ADDRESS", vm.toString(makeAddr("run-emergency")));
        _set("TIMELOCK_MIN_DELAY", "172800");
        OUT_PATH = uniqueTmpPath(vm, string.concat("1476-run-entrypoint", _prefix()));
        _set("DEPLOYMENT_OUT", OUT_PATH);
        _set("CONSENSUS_RECEIPT_ADDRESS", vm.toString(address(receipt)));
        _set("RECEIPT_ADMIN_ADDRESS", vm.toString(deployer));
    }
}

/// @notice The broadcast-path happy case (issue #1476), on the shared fixture.
contract DeployTimelockRunEntrypointTest is DeployTimelockRunEntrypointBase {
    using stdJson for string;

    function test_run_handsOverRolesAndRecordsNoAgent() public removesOwnManifest {
        DeployTimelock.Deployed memory d = RunEntrypointRelay(deployer).runFrom(harness, _prefix());

        assertTrue(gateway.hasRole(ADMIN_ROLE, address(d.timelock)), "timelock missing ADMIN_ROLE");
        assertFalse(gateway.hasRole(ADMIN_ROLE, deployer), "deployer kept gateway ADMIN_ROLE");
        assertTrue(gateway.hasRole(AGENT_ROLE, deployAgent), "deploy agent lost AGENT_ROLE");
        assertTrue(gateway.agentOwner(deployAgent) != address(d.timelock), "timelock took an agent");

        string memory manifest = vm.readFile(OUT_PATH);
        assertFalse(vm.keyExistsJson(manifest, ".timelock_owned_agents"), "agent list in manifest");
    }
}

/// @dev Calls run()'s body from the address it is deployed or etched at, so
///      that address is both the script's msg.sender and its broadcaster.
contract RunEntrypointRelay {
    function runFrom(ManifestHarness harness, string memory prefix)
        external
        returns (DeployTimelock.Deployed memory)
    {
        return harness.exposedRunFrom(prefix);
    }
}

/// @dev devops review 2026-09-30: inputs the ceremony used to accept silently.
///      One contract per test: each mutates env vars the base setUp also sets,
///      and forge runs tests in parallel over a process-wide environment.
contract DeployTimelockDelayFloorTest is DeployTimelockRunEntrypointBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_REVIEW_R04_FLOOR_";
    }

    /// @notice R-04: on chain id 8453 a delay under 48 hours is refused on the
    ///         broadcast path. No flag lifts it.
    function test_run_revertsBelowDelayFloorOnBase() public removesOwnManifest {
        vm.chainId(8453);
        _set("EXPECTED_CHAIN_ID", "8453");
        _set("TIMELOCK_MIN_DELAY", "60");
        vm.expectRevert(bytes("TIMELOCK_MIN_DELAY below 172800 (48h) on Base mainnet"));
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
    }
}

/// @dev Ported from dev #1541: the floor is exact on the broadcast path, 172799 reverts and
///      172800 passes through `run()` on chain id 8453.
contract DeployTimelockDelayBoundaryTest is DeployTimelockRunEntrypointBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_S1_FLOOR_BOUNDARY_";
    }

    function test_run_floorBoundaryOnBase() public removesOwnManifest {
        vm.chainId(8453);
        _set("EXPECTED_CHAIN_ID", "8453");
        _set("TIMELOCK_MIN_DELAY", "172799");
        vm.expectRevert(bytes("TIMELOCK_MIN_DELAY below 172800 (48h) on Base mainnet"));
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
        _set("TIMELOCK_MIN_DELAY", "172800");
        DeployTimelock.Deployed memory d = RunEntrypointRelay(deployer).runFrom(harness, _prefix());
        assertEq(d.timelock.getMinDelay(), 172_800, "floor delay not applied");
    }
}

/// @dev Issue 1727: the rehearsal kind (env DEPLOYMENT_KIND=rehearsal, the sheet line of the same name). On chain id 8453 it lowers the delay floor to 900 s and keeps
///      the delay below the production floor; the default and an explicit "production" keep 172800 s unchanged. Anything else reverts.
///      One scenario per contract: vm.setEnv is process-wide and forge runs the tests of a contract in parallel.
abstract contract DeployTimelockKindBase is DeployTimelockRunEntrypointBase {
    function _base(string memory kind, string memory delay) internal {
        vm.chainId(8453);
        _set("EXPECTED_CHAIN_ID", "8453");
        _set("DEPLOYMENT_KIND", kind);
        _set("TIMELOCK_MIN_DELAY", delay);
    }
}

contract DeployTimelockRehearsalKindTest is DeployTimelockKindBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_1727_REHEARSAL_KIND_";
    }

    function _stackDelay() internal pure override returns (uint256) {
        return 900;
    }

    /// @notice 899 and 172800 are refused in the rehearsal kind, 900 passes and records the kind. A rehearsal never carries a production delay: the chain could not tell them apart.
    function test_rehearsalKind_boundariesOnBase() public removesOwnManifest {
        _base("rehearsal", "899");
        vm.expectRevert(bytes("rehearsal TIMELOCK_MIN_DELAY outside 900..172799"));
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
        _set("TIMELOCK_MIN_DELAY", "172800");
        vm.expectRevert(bytes("rehearsal TIMELOCK_MIN_DELAY outside 900..172799"));
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
        _set("TIMELOCK_MIN_DELAY", "900");
        DeployTimelock.Deployed memory d = RunEntrypointRelay(deployer).runFrom(harness, _prefix());
        assertEq(d.timelock.getMinDelay(), 900, "rehearsal delay not applied");
        assertTrue(d.rehearsal, "the kind is not recorded");
    }
}

contract DeployTimelockProductionKindTest is DeployTimelockKindBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_1727_PRODUCTION_KIND_";
    }

    /// @notice An explicit "production" keeps the 8453 floor: 900 s is refused, 172800 s passes.
    function test_productionKind_floorUnchangedOnBase() public removesOwnManifest {
        _base("production", "900");
        vm.expectRevert(bytes("TIMELOCK_MIN_DELAY below 172800 (48h) on Base mainnet"));
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
        _set("TIMELOCK_MIN_DELAY", "172800");
        DeployTimelock.Deployed memory d = RunEntrypointRelay(deployer).runFrom(harness, _prefix());
        assertEq(d.timelock.getMinDelay(), 172_800);
        assertFalse(d.rehearsal);
    }
}

contract DeployTimelockUnknownKindTest is DeployTimelockKindBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_1727_UNKNOWN_KIND_";
    }

    function test_unknownKind_reverts() public removesOwnManifest {
        _base("Rehearsal", "900");
        vm.expectRevert(bytes("DEPLOYMENT_KIND must be production or rehearsal"));
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
    }
}

contract DeployTimelockTwinChainDelayTest is DeployTimelockRunEntrypointBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_REVIEW_R04_TWIN_";
    }

    function _stackDelay() internal pure override returns (uint256) {
        return 60;
    }

    /// @notice On the Twin chain (918453) the same short delay is a plain parameter.
    function test_run_shortDelayAllowedOnTwinChain() public removesOwnManifest {
        vm.chainId(918453);
        _set("TIMELOCK_MIN_DELAY", "60");
        DeployTimelock.Deployed memory d = RunEntrypointRelay(deployer).runFrom(harness, _prefix());
        assertEq(d.timelock.getMinDelay(), 60, "short delay not honoured on the Twin chain");
    }
}

contract DeployTimelockStrictChainGuardTest is DeployTimelockRunEntrypointBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_S1_STRICT_CHAIN_";
    }

    /// @notice On 8453 an unset EXPECTED_CHAIN_ID no longer disables the guard.
    function test_run_revertsOnBaseWhenExpectedChainUnset() public removesOwnManifest {
        vm.chainId(8453);
        vm.expectRevert(bytes("EXPECTED_CHAIN_ID must be set to 8453 on Base mainnet"));
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
    }

    function test_run_revertsOnBaseWhenExpectedChainIsOther() public removesOwnManifest {
        vm.chainId(8453);
        _set("EXPECTED_CHAIN_ID", "918453");
        vm.expectRevert(bytes("EXPECTED_CHAIN_ID must be set to 8453 on Base mainnet"));
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
    }
}

/// @notice Required inputs: unset or malformed values revert on every chain. One contract per
///         test with its own prefix: forge runs the tests of a contract in parallel over a
///         process-wide environment, so two tests that mutate inputs would leak into each other.
contract DeployTimelockRequiredReceiptTest is DeployTimelockRunEntrypointBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_S1_REQUIRED_RECEIPT_";
    }

    function test_run_revertsWhenReceiptUnset() public removesOwnManifest {
        _set("CONSENSUS_RECEIPT_ADDRESS", vm.toString(address(0)));
        vm.expectRevert(bytes("CONSENSUS_RECEIPT_ADDRESS=0"));
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
    }
}

contract DeployTimelockRequiredSafeOwnersTest is DeployTimelockRunEntrypointBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_S1_REQUIRED_OWNERS_";
    }

    function test_run_revertsWhenSafeOwnersMalformed() public removesOwnManifest {
        _set("SAFE_OWNERS", "not-an-address");
        vm.expectRevert();
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
    }
}

contract DeployTimelockRequiredDelayTest is DeployTimelockRunEntrypointBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_S1_REQUIRED_DELAY_";
    }

    function test_run_revertsWhenDelayMalformed() public removesOwnManifest {
        _set("TIMELOCK_MIN_DELAY", "two-days");
        vm.expectRevert(
            bytes(
                "RM_S1_REQUIRED_DELAY_TIMELOCK_MIN_DELAY is malformed: expected an unsigned integer"
            )
        );
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
    }
}

contract DeployTimelockExpectedChainTest is DeployTimelockRunEntrypointBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_REVIEW_B6_CHAIN_";
    }

    /// @notice R-01/B6: EXPECTED_CHAIN_ID must match the chain the RPC serves.
    function test_run_revertsOnExpectedChainMismatch() public removesOwnManifest {
        _set("EXPECTED_CHAIN_ID", vm.toString(block.chainid + 1));
        vm.expectRevert(bytes("EXPECTED_CHAIN_ID does not match the RPC's chain id"));
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
    }
}

contract DeployTimelockReceiptAdminTest is DeployTimelockRunEntrypointBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_REVIEW_R02_RECEIPT_";
    }

    /// @notice R-02: a RECEIPT_ADMIN_ADDRESS that names the wrong account must not
    ///         leave the deployer holding the receipt contract's admin roles.
    function test_run_revertsWhenReceiptAdminAddressIsWrong() public removesOwnManifest {
        ReceiptRoleStub receipt = new ReceiptRoleStub(deployer);
        receipt.setUpgradeTimelock(harness.predictTimelock(safe, _stackDelay()));
        _set("CONSENSUS_RECEIPT_ADDRESS", vm.toString(address(receipt)));
        _set("RECEIPT_ADMIN_ADDRESS", vm.toString(makeAddr("not-the-receipt-admin")));
        vm.expectRevert(
            bytes(
                "Deployer still has ADMIN_ROLE on consensus receipt: RECEIPT_ADMIN_ADDRESS names the wrong account"
            )
        );
        RunEntrypointRelay(deployer).runFrom(harness, _prefix());
        assertTrue(receipt.hasRole(ADMIN_ROLE, deployer), "stub precondition");
    }
}

/// @dev Stands in for ConsensusRecommendationReceipt's role surface: the
///      handover only needs `hasRole` / `grantRole` / `revokeRole`, and (issue 1808)
///      `upgradeTimelock`, which must name the timelock the handover deploys.
contract ReceiptRoleStub is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    address public upgradeTimelock;

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    function setUpgradeTimelock(address timelock) external {
        upgradeTimelock = timelock;
    }
}

// ─── S5 (core 1487): the timelock stage hands over every vault ────────────────

interface IVaultLinkRead {
    function registry() external view returns (address);
    function setRegistry(address newRegistry) external;
    function retired() external view returns (bool);
}

/// @notice The one deployment scheme ships four vaults (rmUSDC, rmPROTO, rmAGENT, rmRWA). The
///         timelock stage treats each the same way: setRegistry once, EMERGENCY to the emergency
///         key, ADMIN to the timelock, deployer revoked. These tests use the real vault contracts,
///         a real Safe and the real timelock.
contract DeployTimelockFourVaultsTest is SafeGovernance {
    using stdJson for string;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    uint256 public constant MIN_DELAY = 2 days;

    ManifestHarness internal script;
    address internal deployer;
    address internal safe;
    address internal emergency = makeAddr("four-emergency");
    TestERC20 internal usdc;
    address[] internal vaults;
    VaultRegistry internal registry;
    RobotMoneyGateway internal gateway;
    PortfolioRouter internal router;
    RouterGovernance internal governance;
    DeployTimelock.Deployed internal d;

    function setUp() public {
        usdc = new TestERC20();
        script = new ManifestHarness();
        deployer = address(script);
        _installSafeSet();
        safe = _newDefaultSafe();
        CoreProxies.useUpgradeConfig(
            script.predictTimelock(safe, MIN_DELAY), GovernedUUPS.UpgradeMode.Upgradeable
        );

        address swapRouter = makeAddr("four-swap-router");
        RobotMoneyVault rmUsdc = CoreProxies.robotMoneyVault(
            usdc, type(uint256).max, type(uint256).max, 0, safe, deployer, deployer
        );
        vaults.push(address(rmUsdc));
        vaults.push(
            address(
                CoreProxies.protocolAssetVault(
                    IERC20(address(usdc)),
                    ISwapRouter(swapRouter),
                    type(uint256).max,
                    type(uint256).max,
                    0,
                    safe,
                    deployer,
                    deployer
                )
            )
        );
        vaults.push(
            address(
                CoreProxies.agentTokenVault(
                    IERC20(address(usdc)),
                    ISwapRouter(swapRouter),
                    type(uint256).max,
                    type(uint256).max,
                    0,
                    safe,
                    deployer,
                    deployer
                )
            )
        );
        vaults.push(
            address(
                CoreProxies.rwaBasketVault(
                    IERC20(address(usdc)),
                    ISwapRouter(swapRouter),
                    type(uint256).max,
                    type(uint256).max,
                    0,
                    safe,
                    deployer,
                    deployer
                )
            )
        );

        gateway = CoreProxies.robotMoneyGateway(
            usdc, rmUsdc, deployer, makeAddr("four-pauser"), address(0)
        );
        registry = CoreProxies.vaultRegistry(deployer);
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), deployer);
        governance = CoreProxies.routerGovernance(address(router), makeAddr("receipts"), deployer);
        vm.prank(deployer);
        router.grantRole(ADMIN_ROLE, address(governance));
        vm.prank(deployer);
        router.grantRole(keccak256("WEIGHT_SETTER_ROLE"), address(governance));

        // Register every vault while the deployer still administers the registry (the vault
        // stages and registry stage do this in the ceremony).
        for (uint256 i = 0; i < vaults.length; i++) {
            vm.prank(deployer);
            registry.registerVault(
                vaults[i],
                VaultRegistry.VaultMetadata({
                    name: "four-vault", asset: address(usdc), registeredAt: 0
                })
            );
        }

        vm.prank(deployer);
        d = script.runInProcessVaults(
            vaults,
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY,
            _fixtureSpec()
        );
    }

    function test_deployerHoldsNoRoleOnAnyVault() public view {
        for (uint256 i = 0; i < vaults.length; i++) {
            assertFalse(IAccessControl(vaults[i]).hasRole(ADMIN_ROLE, deployer), "deployer ADMIN");
            assertFalse(
                IAccessControl(vaults[i]).hasRole(EMERGENCY_ROLE, deployer), "deployer EMERGENCY"
            );
            assertFalse(IAccessControl(vaults[i]).hasRole(0x00, deployer), "deployer DEFAULT_ADMIN");
        }
    }

    function test_everyVaultHasTimelockAdminEmergencyKeyAndRegistry() public view {
        for (uint256 i = 0; i < vaults.length; i++) {
            assertTrue(IAccessControl(vaults[i]).hasRole(ADMIN_ROLE, address(d.timelock)), "admin");
            assertTrue(IAccessControl(vaults[i]).hasRole(EMERGENCY_ROLE, emergency), "emergency");
            assertEq(IVaultLinkRead(vaults[i]).registry(), address(registry), "registry link");
        }
    }

    function test_secondSetRegistryRevertsOnEveryVault() public {
        for (uint256 i = 0; i < vaults.length; i++) {
            vm.prank(address(d.timelock));
            vm.expectRevert();
            IVaultLinkRead(vaults[i]).setRegistry(makeAddr("other-registry"));
        }
    }

    function test_registryRetireSucceedsOnEveryVault() public {
        for (uint256 i = 0; i < vaults.length; i++) {
            bytes memory callData = abi.encodeCall(VaultRegistry.retire, (vaults[i]));
            bytes32 salt = keccak256(abi.encode("retire", i));
            _govSchedule(safe, d.timelock, address(registry), callData, salt, MIN_DELAY);
            vm.warp(block.timestamp + MIN_DELAY + 1);
            _govExecute(safe, d.timelock, address(registry), callData, salt);
            (, VaultRegistry.VaultStatus st) = registry.getVault(vaults[i]);
            assertEq(uint256(st), uint256(VaultRegistry.VaultStatus.Retired), "status");
            assertTrue(IVaultLinkRead(vaults[i]).retired(), "vault deposit-halt");
        }
    }

    function test_emptyVaultListReverts() public {
        address[] memory none = new address[](0);
        vm.prank(deployer);
        vm.expectRevert(bytes("VAULT_ADDRESSES is empty"));
        script.runInProcessVaults(
            none,
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY,
            _fixtureSpec()
        );
    }

    function test_duplicateVaultReverts() public {
        address[] memory dup = new address[](2);
        dup[0] = vaults[0];
        dup[1] = vaults[0];
        vm.prank(deployer);
        vm.expectRevert(bytes("VAULT_ADDRESSES contains a duplicate"));
        script.runInProcessVaults(
            dup,
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY,
            _fixtureSpec()
        );
    }

    function test_manifestHasAHandoverEntryForEachVault() public {
        string memory out = claimTmpPath(vm, "s5-four-vault-manifest");
        vm.prank(deployer);
        script.exposedWriteJsonTo(d, out);
        string memory manifest = vm.readFile(out);
        address[] memory listed = manifest.readAddressArray(".vaults");
        assertEq(listed.length, vaults.length, "vaults array length");
        assertEq(manifest.readUint(".roles.vaults_handed_over_count"), vaults.length);
        for (uint256 i = 0; i < vaults.length; i++) {
            string memory base = string.concat(".vault_handover.vault_", vm.toString(i));
            assertEq(listed[i], vaults[i], "listed vault");
            assertEq(manifest.readAddress(string.concat(base, ".address")), vaults[i]);
            assertEq(manifest.readAddress(string.concat(base, ".registry")), address(registry));
            assertTrue(manifest.readBool(string.concat(base, ".registry_linked")));
            assertTrue(manifest.readBool(string.concat(base, ".timelock_has_admin_role")));
            assertTrue(manifest.readBool(string.concat(base, ".emergency_key_has_emergency_role")));
            assertFalse(manifest.readBool(string.concat(base, ".deployer_has_admin_role")));
            assertFalse(manifest.readBool(string.concat(base, ".deployer_has_emergency_role")));
        }
        releaseTmpPath(vm, out);
    }
}

/// @notice VAULT_ADDRESSES is required on the broadcast path: unset reverts (empty reverts in process).
contract DeployTimelockVaultListInputTest is DeployTimelockRunEntrypointBase {
    function _prefix() internal pure override returns (string memory) {
        return "RM_S5_VAULT_LIST_";
    }

    function test_run_revertsWhenVaultAddressesUnset() public removesOwnManifest {
        // A prefix nothing else sets, so the run reaches the vault list and finds it missing.
        vm.expectRevert(bytes("VAULT_ADDRESSES must be set: every vault, comma-separated"));
        RunEntrypointRelay(deployer).runFrom(harness, "RM_S5_NEVER_");
    }
}
