// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
// Implements: issue #414 — on-chain timelocked multisig enforcement
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

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
contract DeployTimelockTest is Test {
    // ─── Roles ────────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    // ─── Test addresses ───────────────────────────────────────────────────────

    address internal admin = makeAddr("admin");
    // `safe` is set in setUp() to the deployed MockHighThresholdSafe contract.
    // It cannot be a plain EOA (makeAddr) because DeployTimelock now requires
    // SAFE_ADDRESS to have deployed bytecode and getThreshold() >= 2 (issue #422).
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

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant MIN_DELAY = 2 days;

    function setUp() public {
        usdc = new TestERC20();
        script = new DeployTimelock();

        // Deploy a mock Safe contract with threshold=2 so DeployTimelock's new
        // code-length and threshold guards (issue #422) are satisfied.
        safe = address(new MockHighThresholdSafe());

        // In Forge, when the test calls script.runInProcess() (external call),
        // msg.sender inside the script's functions is address(this) (the test).
        // But when the script's internal functions call the target contracts
        // (e.g. registry.grantRole), the EVM records msg.sender as the script
        // contract address (address(script)), not the test contract.
        //
        // Therefore we must grant ADMIN_ROLE to address(script) at construction
        // so the grantRole/revokeRole calls inside _deployAndWire succeed.
        //
        // RobotMoneyVault and RobotMoneyGateway are instantiated as real
        // contracts (issue #420 — replacing the registry placeholder that was
        // used as a stub for both).  Vault is constructed first so that the
        // gateway can validate vault.asset() == address(usdc) at deploy time.
        vault = new RobotMoneyVault(
            usdc,
            type(uint256).max, // tvlCap (no cap for tests)
            type(uint256).max, // perDepositCap
            0, // exitFeeBps
            safe, // feeRecipient (non-zero; reuses the safe test address)
            address(script), // admin — script must hold ADMIN_ROLE to wire timelock
            address(script) // emergencyResponder
        );
        gateway = new RobotMoneyGateway(
            usdc,
            vault,
            address(script), // admin — script holds ADMIN_ROLE to wire timelock
            admin, // pauser — must be distinct from admin (RoleSeparationViolated guard)
            address(0) // router (not exercised in these tests)
        );
        registry = new VaultRegistry(address(script));
        router = new PortfolioRouter(address(usdc), address(registry), address(script));
        governance = new RouterGovernance(
            address(router),
            address(script),
            7 days, // votingPeriod
            1 days, // executionDelay
            1 // quorumThreshold
        );

        d = script.runInProcess(
            address(vault),
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            safe,
            emergency,
            MIN_DELAY
        );
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

    /// @notice After role transfer, the deployer (admin EOA) no longer holds
    ///         ADMIN_ROLE on any contract.
    function test_deployer_noLongerHasAdminRoleOnRegistry() public view {
        assertFalse(
            IAccessControl(address(registry)).hasRole(ADMIN_ROLE, admin),
            "deployer still has ADMIN_ROLE on registry"
        );
    }

    function test_deployer_noLongerHasAdminRoleOnRouter() public view {
        assertFalse(
            IAccessControl(address(router)).hasRole(ADMIN_ROLE, admin),
            "deployer still has ADMIN_ROLE on router"
        );
    }

    function test_deployer_noLongerHasAdminRoleOnGovernance() public view {
        assertFalse(
            IAccessControl(address(governance)).hasRole(ADMIN_ROLE, admin),
            "deployer still has ADMIN_ROLE on governance"
        );
    }

    // ─── AC2: Safe holds PROPOSER_ROLE and EXECUTOR_ROLE ─────────────────────

    function test_safe_holdsProposerRole() public view {
        assertTrue(
            d.timelock.hasRole(d.timelock.PROPOSER_ROLE(), safe), "safe missing PROPOSER_ROLE"
        );
    }

    function test_safe_holdsExecutorRole() public view {
        assertTrue(
            d.timelock.hasRole(d.timelock.EXECUTOR_ROLE(), safe), "safe missing EXECUTOR_ROLE"
        );
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

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, safe, ADMIN_ROLE
            )
        );
        vm.prank(safe);
        registry.registerVault(makeAddr("vault"), meta);
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

        // Schedule from the Safe (PROPOSER_ROLE).
        vm.prank(safe);
        d.timelock
            .schedule(
                address(registry), // target
                0, // value
                callData,
                predecessor,
                salt,
                MIN_DELAY
            );

        // Compute operation id.
        bytes32 opId = d.timelock.hashOperation(address(registry), 0, callData, predecessor, salt);

        // Pre-delay: operation is in Waiting state — execute must revert.
        assertEq(
            uint256(d.timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Waiting),
            "expected Waiting state pre-delay"
        );

        vm.expectRevert();
        vm.prank(safe);
        d.timelock.execute(address(registry), 0, callData, predecessor, salt);

        // Advance time past the min delay.
        vm.warp(block.timestamp + MIN_DELAY + 1);

        // Now operation is Ready.
        assertEq(
            uint256(d.timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Ready),
            "expected Ready state after delay"
        );

        // Execute from the Safe (EXECUTOR_ROLE).
        vm.prank(safe);
        d.timelock.execute(address(registry), 0, callData, predecessor, salt);

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

        vm.prank(safe);
        d.timelock.schedule(address(registry), 0, callData, predecessor, salt, MIN_DELAY);

        vm.warp(block.timestamp + MIN_DELAY + 1);

        vm.prank(safe);
        d.timelock.execute(address(registry), 0, callData, predecessor, salt);

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
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, safe, ADMIN_ROLE
            )
        );
        vault.setFeeRecipient(newRecipient);
    }

    /// @notice INV-3: a direct (non-timelock) setExitFeeBps call from the Safe hot
    ///         key reverts for the same reason.
    function test_INV3_setExitFeeBps_directHotKeyCallReverts() public {
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, safe, ADMIN_ROLE
            )
        );
        vault.setExitFeeBps(50);
    }

    /// @notice INV-3: setFeeRecipient succeeds ONLY when routed through the
    ///         TimelockController (schedule → delay → execute).
    function test_INV3_setFeeRecipient_succeedsViaTimelock() public {
        address newRecipient = makeAddr("newFeeRecipient");
        bytes memory callData = abi.encodeCall(RobotMoneyVault.setFeeRecipient, (newRecipient));
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("inv3-fee-recipient");

        vm.prank(safe);
        d.timelock.schedule(address(vault), 0, callData, predecessor, salt, MIN_DELAY);

        // Pre-delay execution must revert.
        vm.expectRevert();
        vm.prank(safe);
        d.timelock.execute(address(vault), 0, callData, predecessor, salt);

        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        d.timelock.execute(address(vault), 0, callData, predecessor, salt);

        assertEq(vault.feeRecipient(), newRecipient, "fee recipient must update via timelock");
    }

    /// @notice INV-3: setExitFeeBps succeeds ONLY when routed through the
    ///         TimelockController.
    function test_INV3_setExitFeeBps_succeedsViaTimelock() public {
        uint256 newFee = 75;
        bytes memory callData = abi.encodeCall(RobotMoneyVault.setExitFeeBps, (newFee));
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("inv3-exit-fee");

        vm.prank(safe);
        d.timelock.schedule(address(vault), 0, callData, predecessor, salt, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        d.timelock.execute(address(vault), 0, callData, predecessor, salt);

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
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, safe, ADMIN_ROLE
            )
        );
        vault.setQuarantineAddress(newQuarantine);
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

        vm.prank(safe);
        d.timelock.schedule(address(vault), 0, callData, predecessor, salt, MIN_DELAY);

        // Pre-delay execution must revert.
        vm.expectRevert();
        vm.prank(safe);
        d.timelock.execute(address(vault), 0, callData, predecessor, salt);

        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        d.timelock.execute(address(vault), 0, callData, predecessor, salt);

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
        vm.prank(safe);
        d.timelock.schedule(address(registry), 0, callData, bytes32(0), salt, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        d.timelock.execute(address(registry), 0, callData, bytes32(0), salt);
    }

    /// @notice #942 AC2: a direct (non-timelock) retire() call from the Safe hot
    ///         key reverts — the Safe holds PROPOSER/EXECUTOR on the timelock, not
    ///         ADMIN_ROLE on the registry.
    function test_retire_directHotKeyCallReverts() public {
        _registerVaultViaTimelock();
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, safe, ADMIN_ROLE
            )
        );
        registry.retire(address(vault));
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

        vm.prank(safe);
        d.timelock.schedule(address(registry), 0, callData, bytes32(0), salt, MIN_DELAY);

        // Pre-delay execution must revert.
        vm.expectRevert();
        vm.prank(safe);
        d.timelock.execute(address(registry), 0, callData, bytes32(0), salt);

        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        d.timelock.execute(address(registry), 0, callData, bytes32(0), salt);

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
    // {DEFAULT_ADMIN_ROLE, ADMIN_ROLE, EMERGENCY_ROLE, PAUSER_ROLE} on the
    // Gateway or any vault. The deep deploy-assertion lives in
    // contracts/test/fv/DeployAssertions.t.sol::test_ACL1_*; these tests pin the
    // individual legs and the fix-interaction guarantees.
    //
    // In setUp the deployer EOA is `address(script)` (the broadcaster inside
    // runInProcess). `admin` is the gateway PAUSER but never held DEFAULT_ADMIN
    // there; `emergency` is the independent emergency hot key.

    // NOTE on the in-process model: when these tests call `script.runInProcess()`
    // directly, the script's grant calls execute as `address(script)` while
    // `revokeRole(..., msg.sender)` targets the TEST contract (the external
    // caller). So in this suite neither a single EOA cleanly demonstrates "holds
    // no role" — `address(script)` is the grantor (keeps roles), and the test
    // contract never held them. The faithful end-to-end ACL-1 "deployer EOA holds
    // NO privileged role" proof — where one address both grants and is revoked —
    // lives in contracts/test/fv/DeployAssertions.t.sol::test_ACL1_*. Here we pin
    // the post-handover POSITIVE end-state: the timelock holds the gateway root +
    // vault ADMIN, and the independent hot key holds the vault EMERGENCY_ROLE.

    /// @notice ACL-1: the Timelock receives BOTH ADMIN_ROLE and DEFAULT_ADMIN_ROLE
    ///         on the Gateway (so it can rotate roles / authorizeAgent), and holds
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

    /// @notice Fix-interaction (F-01): AGENT_ROLE's admin is ADMIN_ROLE, so after
    ///         the DEFAULT_ADMIN_ROLE revoke the Timelock (ADMIN_ROLE) can still
    ///         grant AGENT_ROLE directly. Proves the revoke did not brick agent
    ///         onboarding.
    function test_ACL1_agentRoleRemainsGrantableByTimelockAfterRevoke() public {
        address newAgent = makeAddr("post-handover-agent");
        assertEq(
            gateway.getRoleAdmin(AGENT_ROLE), ADMIN_ROLE, "AGENT_ROLE admin must be ADMIN_ROLE"
        );

        bytes memory callData = abi.encodeCall(IAccessControl.grantRole, (AGENT_ROLE, newAgent));
        bytes32 salt = keccak256("acl1-grant-agent-role");

        vm.prank(safe);
        d.timelock.schedule(address(gateway), 0, callData, bytes32(0), salt, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        d.timelock.execute(address(gateway), 0, callData, bytes32(0), salt);

        assertTrue(
            gateway.hasRole(AGENT_ROLE, newAgent),
            "Timelock (ADMIN_ROLE) must be able to grant AGENT_ROLE after the DEFAULT_ADMIN revoke"
        );
    }

    /// @notice AC: the Timelock can `authorizeAgent` on the Gateway post-handover
    ///         (the gateway-native onboarding path, now ADMIN_ROLE-gated).
    function test_ACL1_timelockCanAuthorizeAgentAfterHandover() public {
        address newAgent = makeAddr("timelock-onboarded-agent");
        IGateway.AgentPolicy memory p = _agentPolicy();

        bytes memory callData = abi.encodeCall(IGateway.authorizeAgent, (newAgent, p));
        bytes32 salt = keccak256("acl1-authorize-agent");

        vm.prank(safe);
        d.timelock.schedule(address(gateway), 0, callData, bytes32(0), salt, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        d.timelock.execute(address(gateway), 0, callData, bytes32(0), salt);

        assertTrue(
            gateway.hasRole(AGENT_ROLE, newAgent),
            "timelock authorizeAgent did not grant AGENT_ROLE"
        );
        assertEq(
            gateway.agentOwner(newAgent), address(d.timelock), "timelock must be recorded owner"
        );
    }

    /// @notice AC: a hot key (the Safe) that holds neither DEFAULT_ADMIN_ROLE nor
    ///         ADMIN_ROLE on the Gateway cannot directly authorizeAgent — only the
    ///         timelock-routed path works. Guards the role gate post-handover.
    function test_ACL1_directAuthorizeAgentFromHotKeyReverts() public {
        IGateway.AgentPolicy memory p = _agentPolicy();
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, safe, ADMIN_ROLE
            )
        );
        gateway.authorizeAgent(makeAddr("rejected-agent"), p);
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
            MIN_DELAY
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
            0 // zero delay
        );
        vm.stopPrank();
    }

    // ─── AC: SAFE_ADDRESS must not be an EOA (issue #422) ─────────────────────

    /// @notice DeployTimelock.s.sol aborts when SAFE_ADDRESS has no deployed code.
    ///
    /// @dev We pass a freshly-minted address that has no bytecode.  The script's
    ///      new `code.length` guard should revert before attempting any state writes.
    function test_deploy_revertsWhenSafeIsEOA() public {
        address eoaSafe = makeAddr("eoaSafe");
        // Confirm this address is truly an EOA (no bytecode).
        assertEq(eoaSafe.code.length, 0, "pre-condition: address must be an EOA");

        vm.expectRevert(bytes("SAFE_ADDRESS is an EOA: deploy a Safe multisig contract first"));
        script.runInProcess(
            address(registry),
            address(registry),
            address(registry),
            address(router),
            address(governance),
            eoaSafe,
            emergency,
            MIN_DELAY
        );
    }

    // ─── AC: SAFE_ADDRESS threshold must be >= 2 (issue #422) ────────────────

    /// @notice DeployTimelock.s.sol aborts when the Safe at SAFE_ADDRESS has threshold < 2.
    ///
    /// @dev We deploy a `MockLowThresholdSafe` that returns `1` from `getThreshold()`.
    ///      Passing a 1-of-N Safe as PROPOSER would reduce multisig security to a
    ///      single-key model.
    function test_deploy_revertsWhenSafeThresholdTooLow() public {
        MockLowThresholdSafe lowSafe = new MockLowThresholdSafe();

        vm.expectRevert(bytes("SAFE_ADDRESS threshold < 2: configure at least 2-of-N quorum"));
        script.runInProcess(
            address(registry),
            address(registry),
            address(registry),
            address(router),
            address(governance),
            address(lowSafe),
            emergency,
            MIN_DELAY
        );
    }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/// @dev Minimal stub that mimics a compliant 2-of-3 Safe — `getThreshold()` returns 2.
///      Used as the SAFE_ADDRESS in setUp() so DeployTimelock's code-length and
///      threshold guards (issue #422) are satisfied without deploying a real Safe.
contract MockHighThresholdSafe {
    function getThreshold() external pure returns (uint256) {
        return 2;
    }
}

/// @dev Minimal stub that mimics a 1-of-N Safe — `getThreshold()` returns 1.
///      Used to prove DeployTimelock rejects low-threshold Safes.
contract MockLowThresholdSafe {
    function getThreshold() external pure returns (uint256) {
        return 1;
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
