// SPDX-License-Identifier: MIT
// Canonical: none — Foundry tests for contracts/VaultRegistry.sol
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {VaultRegistry} from "../VaultRegistry.sol";

/// @notice Minimal stand-in for `PortfolioRouter` exposing only the
///         `defaultWeightsLength()` view the registry's stale-length guard
///         reads. Lets the registry test exercise the guard without pulling in
///         the full router. ADR-0002.
contract MockDefaultWeightsRouter {
    uint256 public defaultWeightsLength;

    function setDefaultWeightsLength(uint256 n) external {
        defaultWeightsLength = n;
    }
}

contract VaultRegistryTest is Test {
    VaultRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    // Stable fake vault addresses for tests that don't need real contracts.
    address internal vault1 = makeAddr("vault1");
    address internal vault2 = makeAddr("vault2");
    address internal vault3 = makeAddr("vault3");

    // Reusable metadata fixtures.
    VaultRegistry.VaultMetadata internal meta1 = VaultRegistry.VaultMetadata({
        name: "Robot Money USDC",
        asset: makeAddr("usdc"),
        registeredAt: 0 // populated by contract, ignored in fixture
    });

    VaultRegistry.VaultMetadata internal meta2 = VaultRegistry.VaultMetadata({
        name: "Robot Money ETH", asset: makeAddr("weth"), registeredAt: 0
    });

    // ─── setUp ────────────────────────────────────────────────────────────────

    function setUp() public {
        registry = new VaultRegistry(admin);
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(VaultRegistry.ZeroAddress.selector);
        new VaultRegistry(address(0));
    }

    function test_constructor_grantsAdminRole() public view {
        assertTrue(registry.hasRole(registry.ADMIN_ROLE(), admin));
    }

    function test_constructor_vaultCountIsZero() public view {
        assertEq(registry.vaultCount(), 0);
    }

    // ─── registerVault: happy path ───────────────────────────────────────────

    function test_registerVault_succeeds() public {
        vm.prank(admin);
        registry.registerVault(vault1, meta1);

        assertEq(registry.vaultCount(), 1);
    }

    function test_registerVault_emitsVaultRegistered() public {
        vm.prank(admin);
        vm.expectEmit(true, true, false, true);
        emit VaultRegistry.VaultRegistered(vault1, meta1.name, meta1.asset);
        registry.registerVault(vault1, meta1);
    }

    function test_registerVault_setsActiveStatus() public {
        vm.prank(admin);
        registry.registerVault(vault1, meta1);

        (, VaultRegistry.VaultStatus status) = registry.getVault(vault1);
        assertEq(uint256(status), uint256(VaultRegistry.VaultStatus.Active));
    }

    function test_registerVault_storesMetadata() public {
        vm.warp(1_000_000);
        vm.prank(admin);
        registry.registerVault(vault1, meta1);

        (VaultRegistry.VaultMetadata memory stored,) = registry.getVault(vault1);
        assertEq(stored.name, meta1.name);
        assertEq(stored.asset, meta1.asset);
        assertEq(stored.registeredAt, 1_000_000);
    }

    function test_registerVault_multipleVaults_registrationOrder() public {
        vm.startPrank(admin);
        registry.registerVault(vault1, meta1);
        registry.registerVault(vault2, meta2);
        vm.stopPrank();

        address[] memory vaults = registry.listVaults();
        assertEq(vaults.length, 2);
        assertEq(vaults[0], vault1);
        assertEq(vaults[1], vault2);
    }

    // ─── registerVault: revert cases ─────────────────────────────────────────

    function test_registerVault_revertsOnZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(VaultRegistry.ZeroAddress.selector);
        registry.registerVault(address(0), meta1);
    }

    function test_registerVault_revertsOnDuplicate() public {
        vm.prank(admin);
        registry.registerVault(vault1, meta1);

        vm.prank(admin);
        vm.expectRevert(VaultRegistry.AlreadyRegistered.selector);
        registry.registerVault(vault1, meta1);
    }

    function test_registerVault_revertsForUnauthorizedCaller() public {
        bytes32 role = registry.ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role
            )
        );
        vm.prank(stranger);
        registry.registerVault(vault1, meta1);
    }

    // ─── setVaultStatus: happy path ──────────────────────────────────────────

    function test_setVaultStatus_toPaused() public {
        vm.startPrank(admin);
        registry.registerVault(vault1, meta1);
        registry.setVaultStatus(vault1, VaultRegistry.VaultStatus.Paused);
        vm.stopPrank();

        (, VaultRegistry.VaultStatus status) = registry.getVault(vault1);
        assertEq(uint256(status), uint256(VaultRegistry.VaultStatus.Paused));
    }

    function test_setVaultStatus_toRetired() public {
        vm.startPrank(admin);
        registry.registerVault(vault1, meta1);
        registry.setVaultStatus(vault1, VaultRegistry.VaultStatus.Retired);
        vm.stopPrank();

        (, VaultRegistry.VaultStatus status) = registry.getVault(vault1);
        assertEq(uint256(status), uint256(VaultRegistry.VaultStatus.Retired));
    }

    function test_setVaultStatus_activeAfterPaused() public {
        vm.startPrank(admin);
        registry.registerVault(vault1, meta1);
        registry.setVaultStatus(vault1, VaultRegistry.VaultStatus.Paused);
        registry.setVaultStatus(vault1, VaultRegistry.VaultStatus.Active);
        vm.stopPrank();

        (, VaultRegistry.VaultStatus status) = registry.getVault(vault1);
        assertEq(uint256(status), uint256(VaultRegistry.VaultStatus.Active));
    }

    function test_setVaultStatus_emitsVaultStatusChanged() public {
        vm.prank(admin);
        registry.registerVault(vault1, meta1);

        vm.warp(2_000_000);
        vm.prank(admin);
        vm.expectEmit(true, true, false, true);
        emit VaultRegistry.VaultStatusChanged(vault1, VaultRegistry.VaultStatus.Paused, 2_000_000);
        registry.setVaultStatus(vault1, VaultRegistry.VaultStatus.Paused);
    }

    // ─── setVaultStatus: revert cases ────────────────────────────────────────

    function test_setVaultStatus_revertsForNotRegistered() public {
        vm.prank(admin);
        vm.expectRevert(VaultRegistry.NotRegistered.selector);
        registry.setVaultStatus(vault1, VaultRegistry.VaultStatus.Paused);
    }

    function test_setVaultStatus_revertsForUnauthorizedCaller() public {
        vm.prank(admin);
        registry.registerVault(vault1, meta1);

        bytes32 role = registry.ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role
            )
        );
        vm.prank(stranger);
        registry.setVaultStatus(vault1, VaultRegistry.VaultStatus.Paused);
    }

    // ─── getVault ────────────────────────────────────────────────────────────

    function test_getVault_revertsForNotRegistered() public {
        vm.expectRevert(VaultRegistry.NotRegistered.selector);
        registry.getVault(vault1);
    }

    // ─── listVaults / vaultCount ─────────────────────────────────────────────

    function test_listVaults_emptyInitially() public view {
        address[] memory vaults = registry.listVaults();
        assertEq(vaults.length, 0);
    }

    function test_listVaults_lengthMatchesVaultCount_after_multiple() public {
        vm.startPrank(admin);
        registry.registerVault(vault1, meta1);
        registry.registerVault(vault2, meta2);
        registry.registerVault(vault3, meta1);
        vm.stopPrank();

        address[] memory vaults = registry.listVaults();
        assertEq(vaults.length, registry.vaultCount());
        assertEq(vaults.length, 3);
    }

    // ─── Fuzz: listVaults().length always equals vaultCount() ────────────────

    /// @notice Registers `n` distinct vaults and asserts `listVaults().length == vaultCount()`.
    function testFuzz_listVaultsLength_equalsVaultCount(uint8 n) public {
        // Cap at 30 to keep the test fast; correctness holds for any finite n.
        uint256 count = bound(n, 0, 30);

        for (uint256 i = 0; i < count; i++) {
            // Derive a deterministic non-zero address for each iteration.
            address v = address(uint160(uint256(keccak256(abi.encodePacked("v", i)))));
            vm.prank(admin);
            registry.registerVault(v, meta1);
        }

        assertEq(registry.listVaults().length, registry.vaultCount());
    }

    // ─── routerEligibleCount + stale-defaultWeights guard — ADR-0002 ───────────

    /// @notice setRouterEligible maintains `routerEligibleCount` as the number
    ///         of vaults currently flagged eligible.
    function test_setRouterEligible_tracksCount() public {
        vm.startPrank(admin);
        registry.registerVault(vault1, meta1);
        registry.registerVault(vault2, meta2);
        assertEq(registry.routerEligibleCount(), 0);

        registry.setRouterEligible(vault1, true);
        assertEq(registry.routerEligibleCount(), 1);
        registry.setRouterEligible(vault2, true);
        assertEq(registry.routerEligibleCount(), 2);

        // No-op (already true) leaves the count unchanged.
        registry.setRouterEligible(vault2, true);
        assertEq(registry.routerEligibleCount(), 2);

        registry.setRouterEligible(vault1, false);
        assertEq(registry.routerEligibleCount(), 1);
        vm.stopPrank();
    }

    /// @notice With a linked router carrying a non-empty default weight vector,
    ///         a setRouterEligible change that would leave that vector with a
    ///         stale length reverts. An empty default vector is exempt, and a
    ///         re-set default that matches the new count is accepted.
    function test_setRouterEligible_blocks_stale_defaultWeights_length() public {
        MockDefaultWeightsRouter mockRouter = new MockDefaultWeightsRouter();

        vm.startPrank(admin);
        registry.registerVault(vault1, meta1);
        registry.registerVault(vault2, meta2);
        registry.registerVault(vault3, meta1);

        // Two vaults eligible, default vector spans both (length 2).
        registry.setRouterEligible(vault1, true);
        registry.setRouterEligible(vault2, true);
        registry.setRouter(address(mockRouter));
        mockRouter.setDefaultWeightsLength(2);

        // Adding a third eligible vault would make the default vector stale
        // (length 2 != new count 3) -> revert.
        vm.expectRevert(
            abi.encodeWithSelector(VaultRegistry.StaleDefaultWeightsLength.selector, 3, 2)
        );
        registry.setRouterEligible(vault3, true);

        // Removing an eligible vault is likewise blocked (length 2 != count 1).
        vm.expectRevert(
            abi.encodeWithSelector(VaultRegistry.StaleDefaultWeightsLength.selector, 1, 2)
        );
        registry.setRouterEligible(vault1, false);

        // Re-setting the default vector to span the new set first unblocks the
        // change (atomic from the operator's perspective: re-set then flip).
        mockRouter.setDefaultWeightsLength(3);
        registry.setRouterEligible(vault3, true);
        assertEq(registry.routerEligibleCount(), 3);

        // An empty default vector (length 0) is always consistent.
        mockRouter.setDefaultWeightsLength(0);
        registry.setRouterEligible(vault3, false);
        assertEq(registry.routerEligibleCount(), 2);
        vm.stopPrank();
    }

    /// @notice setRouter is gated by ADMIN_ROLE and emits RouterSet.
    function test_setRouter_adminOnlyAndEmits() public {
        MockDefaultWeightsRouter mockRouter = new MockDefaultWeightsRouter();

        vm.prank(stranger);
        vm.expectRevert();
        registry.setRouter(address(mockRouter));

        vm.expectEmit(true, true, false, false);
        emit VaultRegistry.RouterSet(address(0), address(mockRouter));
        vm.prank(admin);
        registry.setRouter(address(mockRouter));
        assertEq(address(registry.router()), address(mockRouter));
    }
}
