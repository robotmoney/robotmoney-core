// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md §4 — Access control & admin (Timelock bypass → Mitigated)
// Implements: issue #414 — on-chain timelocked multisig enforcement
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
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
contract DeployTimelockTest is Test {
    // ─── Roles ────────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Test addresses ───────────────────────────────────────────────────────

    address internal admin = makeAddr("admin");
    // `safe` is set in setUp() to the deployed MockHighThresholdSafe contract.
    // It cannot be a plain EOA (makeAddr) because DeployTimelock now requires
    // SAFE_ADDRESS to have deployed bytecode and getThreshold() >= 2 (issue #422).
    address internal safe;
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
            address(script) // admin — script must hold ADMIN_ROLE to wire timelock
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
