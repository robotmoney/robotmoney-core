// SPDX-License-Identifier: MIT
// Canonical: none — Foundry unit tests for the ADR-0002 migration interlock
// fix (H-A1, issue #1128): VaultRegistry.migrateEligibility atomically flips a
// vault's router-eligibility AND re-sets PortfolioRouter's default-weight
// vector in one transaction, so the
// `routerEligibleCount == defaultWeights.length` invariant is never observed in
// an inconsistent state.
//
// See docs/technical/unified-vault-open-questions-resolution.md
// "The migration interlock fix (H-A1) — one atomic entry point".
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";

// ─── Test fixtures ────────────────────────────────────────────────────────────

/// @notice Minimal ERC-20 USDC mock (6 decimals).
contract MockUsdc is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @notice Minimal ERC-4626-shaped vault mock exposing `asset()` = USDC, which
///         is all the router needs to accept it into a weight vector.
contract InterlockMockVault is ERC20 {
    IERC20 public immutable assetToken;

    constructor(address asset_) ERC20("Mock Vault Shares", "MVS") {
        assetToken = IERC20(asset_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }
}

// ─── EligibilityWeightsInterlockTest ────────────────────────────────────────────

contract EligibilityWeightsInterlockTest is Test {
    MockUsdc internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;

    address internal registryAdmin = makeAddr("registryAdmin");
    address internal routerAdmin = makeAddr("routerAdmin");
    address internal stranger = makeAddr("stranger");

    // Four vaults form the eligible set with a length-4 default vector; the
    // fifth is the migration target (initially ineligible).
    InterlockMockVault internal vaultA;
    InterlockMockVault internal vaultB;
    InterlockMockVault internal vaultC;
    InterlockMockVault internal vaultD;
    InterlockMockVault internal vaultE;

    function setUp() public {
        usdc = new MockUsdc();
        registry = new VaultRegistry(registryAdmin);
        router = new PortfolioRouter(address(usdc), address(registry), routerAdmin);

        vaultA = new InterlockMockVault(address(usdc));
        vaultB = new InterlockMockVault(address(usdc));
        vaultC = new InterlockMockVault(address(usdc));
        vaultD = new InterlockMockVault(address(usdc));
        vaultE = new InterlockMockVault(address(usdc));

        vm.startPrank(registryAdmin);
        registry.registerVault(address(vaultA), _meta("Vault A"));
        registry.registerVault(address(vaultB), _meta("Vault B"));
        registry.registerVault(address(vaultC), _meta("Vault C"));
        registry.registerVault(address(vaultD), _meta("Vault D"));
        registry.registerVault(address(vaultE), _meta("Vault E"));

        // Four vaults eligible → routerEligibleCount == 4.
        registry.setRouterEligible(address(vaultA), true);
        registry.setRouterEligible(address(vaultB), true);
        registry.setRouterEligible(address(vaultC), true);
        registry.setRouterEligible(address(vaultD), true);
        vm.stopPrank();

        // Router carries a full-length (length-4) default vector.
        vm.prank(routerAdmin);
        router.setDefaultWeights(_fourVaults(), _fourBps());

        // Link the router so the registry's stale-length guard is armed — this
        // is the state that deadlocks every subsequent eligibility flip.
        vm.prank(registryAdmin);
        registry.setRouter(address(router));

        assertEq(registry.routerEligibleCount(), 4, "setup: 4 eligible");
        assertEq(router.defaultWeightsLength(), 4, "setup: length-4 default");
    }

    // ─── The deadlock (reproduction) ────────────────────────────────────────

    /// @notice With 4 eligible vaults and a length-4 default vector, EVERY
    ///         single non-atomic eligibility change reverts
    ///         StaleDefaultWeightsLength — both making a fifth vault eligible
    ///         (count would rise to 5) and revoking one (count would fall to 3).
    ///         Every escape is closed, so migration deadlocks. (H-A1)
    function test_deadlock_everyEligibilityFlipReverts() public {
        vm.startPrank(registryAdmin);

        // Add a fifth eligible vault: newCount 5 != defaultLength 4.
        vm.expectRevert(
            abi.encodeWithSelector(VaultRegistry.StaleDefaultWeightsLength.selector, 5, 4)
        );
        registry.setRouterEligible(address(vaultE), true);

        // Revoke an existing eligible vault: newCount 3 != defaultLength 4.
        vm.expectRevert(
            abi.encodeWithSelector(VaultRegistry.StaleDefaultWeightsLength.selector, 3, 4)
        );
        registry.setRouterEligible(address(vaultA), false);

        vm.stopPrank();

        // The other escape is also closed: you cannot pre-set a length-5 default
        // to unblock the flip, because the router's length check pins the vector
        // to the current (still 4) eligible count.
        vm.prank(routerAdmin);
        vm.expectRevert(PortfolioRouter.LengthMismatch.selector);
        router.setDefaultWeights(_fiveVaults(), _fiveBps());

        // State is unchanged: the deadlock held.
        assertEq(registry.routerEligibleCount(), 4, "count unchanged by deadlock");
        assertEq(router.defaultWeightsLength(), 4, "default unchanged by deadlock");
    }

    // ─── The atomic fix ─────────────────────────────────────────────────────

    /// @notice The atomic entry point flips eligibility AND sets the new
    ///         full-length default vector in one call, without reverting, and
    ///         the count==length invariant holds afterwards.
    function test_migrateEligibility_addsVaultAtomically() public {
        vm.prank(registryAdmin);
        registry.migrateEligibility(address(vaultE), true, _fiveVaults(), _fiveBps());

        assertTrue(registry.isRouterEligible(address(vaultE)), "vaultE now eligible");
        assertEq(registry.routerEligibleCount(), 5, "count moved to 5");
        assertEq(router.defaultWeightsLength(), 5, "default vector moved to length 5");
        // INVARIANT: routerEligibleCount == defaultWeights.length (non-empty).
        assertEq(
            registry.routerEligibleCount(),
            router.defaultWeightsLength(),
            "count == default length invariant"
        );
    }

    /// @notice The same atomic entry point also revokes eligibility while
    ///         shrinking the default vector in one call — the other deadlocked
    ///         direction.
    function test_migrateEligibility_removesVaultAtomically() public {
        // First grow to 5 so removal returns to the length-4 fixture set.
        vm.prank(registryAdmin);
        registry.migrateEligibility(address(vaultE), true, _fiveVaults(), _fiveBps());

        // Now revoke vaultA and shrink the default back to length 4.
        address[] memory vaults = new address[](4);
        vaults[0] = address(vaultB);
        vaults[1] = address(vaultC);
        vaults[2] = address(vaultD);
        vaults[3] = address(vaultE);
        uint256[] memory bps = new uint256[](4);
        bps[0] = 2500;
        bps[1] = 2500;
        bps[2] = 2500;
        bps[3] = 2500;

        vm.prank(registryAdmin);
        registry.migrateEligibility(address(vaultA), false, vaults, bps);

        assertFalse(registry.isRouterEligible(address(vaultA)), "vaultA revoked");
        assertEq(registry.routerEligibleCount(), 4, "count back to 4");
        assertEq(router.defaultWeightsLength(), 4, "default back to length 4");
        assertEq(
            registry.routerEligibleCount(),
            router.defaultWeightsLength(),
            "count == default length invariant"
        );
    }

    // ─── Partial / non-atomic update rejection ──────────────────────────────

    /// @notice A partial update — flipping eligibility while supplying a default
    ///         vector whose length disagrees with the post-flip count — is
    ///         rejected by the router's length check and reverts the WHOLE
    ///         transaction, leaving no stale state behind.
    function test_migrateEligibility_rejectsPartialUpdate() public {
        // Flip vaultE eligible (count would become 5) but pass a length-4 vector.
        vm.prank(registryAdmin);
        vm.expectRevert(PortfolioRouter.LengthMismatch.selector);
        registry.migrateEligibility(address(vaultE), true, _fourVaults(), _fourBps());

        // Atomicity: the eligibility flip was rolled back with the weight write.
        assertFalse(registry.isRouterEligible(address(vaultE)), "flip rolled back");
        assertEq(registry.routerEligibleCount(), 4, "count rolled back");
        assertEq(router.defaultWeightsLength(), 4, "default unchanged");
    }

    /// @notice The router's registry-only weight setter cannot be called by
    ///         anyone but the linked registry — it carries no independent
    ///         authority and reverts OnlyRegistry for every other caller.
    function test_applyMigrationDefaultWeights_onlyRegistry() public {
        vm.prank(stranger);
        vm.expectRevert(PortfolioRouter.OnlyRegistry.selector);
        router.applyMigrationDefaultWeights(_fourVaults(), _fourBps());

        // Even the router's own ADMIN cannot use this path (it is registry-only).
        vm.prank(routerAdmin);
        vm.expectRevert(PortfolioRouter.OnlyRegistry.selector);
        router.applyMigrationDefaultWeights(_fourVaults(), _fourBps());
    }

    /// @notice `migrateEligibility` requires a linked router; with none, it
    ///         reverts RouterNotLinked (use plain setRouterEligible instead).
    function test_migrateEligibility_requiresLinkedRouter() public {
        // Fresh registry with no router linked.
        VaultRegistry solo = new VaultRegistry(registryAdmin);
        vm.startPrank(registryAdmin);
        solo.registerVault(address(vaultA), _meta("Vault A"));
        vm.expectRevert(VaultRegistry.RouterNotLinked.selector);
        solo.migrateEligibility(address(vaultA), true, _fourVaults(), _fourBps());
        vm.stopPrank();
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    function _meta(string memory name) internal view returns (VaultRegistry.VaultMetadata memory) {
        return VaultRegistry.VaultMetadata({name: name, asset: address(usdc), registeredAt: 0});
    }

    function _fourVaults() internal view returns (address[] memory vaults) {
        vaults = new address[](4);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        vaults[2] = address(vaultC);
        vaults[3] = address(vaultD);
    }

    function _fourBps() internal pure returns (uint256[] memory bps) {
        bps = new uint256[](4);
        bps[0] = 2500;
        bps[1] = 2500;
        bps[2] = 2500;
        bps[3] = 2500;
    }

    function _fiveVaults() internal view returns (address[] memory vaults) {
        vaults = new address[](5);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        vaults[2] = address(vaultC);
        vaults[3] = address(vaultD);
        vaults[4] = address(vaultE);
    }

    function _fiveBps() internal pure returns (uint256[] memory bps) {
        bps = new uint256[](5);
        bps[0] = 2000;
        bps[1] = 2000;
        bps[2] = 2000;
        bps[3] = 2000;
        bps[4] = 2000;
    }
}
