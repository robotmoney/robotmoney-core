// SPDX-License-Identifier: MIT
// Canonical: docs/technical/governance-decisions.md §3.6 — unit tests for contracts/RouterGovernance.sol
// Implements: issue #1698 (the governed path itself runs through the real Safe and timelock in RouterGovernanceApplyReceipt.t.sol)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {AdminFloorAccessControl} from "../lib/AdminFloorAccessControl.sol";
import {ConsensusRecommendationReceipt} from "../ConsensusRecommendationReceipt.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

// ─── Test fixtures ────────────────────────────────────────────────────────────

/// @notice Minimal ERC-20 USDC mock (6 decimals) for the router.
contract MockUsdc is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Minimal ERC-4626-shaped vault mock.
contract MockGovVault is ERC20 {
    using SafeERC20 for IERC20;

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

    function totalAssets() external view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        return assets;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
    }

    /// @dev IRetirableVault deposit-halt stubs. MockGovVault has no registry
    ///      link, so these are no-ops that satisfy the interface without
    ///      reverting when the registry drives the pause/deposit-halt flag
    ///      (VaultRegistry.setVaultStatus calls retire()/unretire() on the
    ///      vault address when it has code).
    function retire() external {}

    function unretire() external {}
}

// ─── RouterGovernanceTest ─────────────────────────────────────────────────────

/// @notice Unit tests of the weight setter before any handover: constructor checks,
///         role administration, the admin fallbacks and the router's duplicate-vault
///         refusal. The governed path (Safe -> timelock -> applyReceipt) is proved in
///         RouterGovernanceApplyReceipt.t.sol.
contract RouterGovernanceTest is Test {
    MockUsdc internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    ConsensusRecommendationReceipt internal receipts;
    RouterGovernance internal gov;

    address internal govAdmin = makeAddr("govAdmin");
    address internal routerAdmin = makeAddr("routerAdmin");
    address internal registryAdmin = makeAddr("registryAdmin");
    address internal stranger = makeAddr("stranger");

    MockGovVault internal vaultA;
    MockGovVault internal vaultB;

    function setUp() public {
        usdc = new MockUsdc();
        registry = CoreProxies.vaultRegistry(registryAdmin);
        vaultA = new MockGovVault(address(usdc));
        vaultB = new MockGovVault(address(usdc));
        vm.startPrank(registryAdmin);
        registry.registerVault(
            address(vaultA),
            VaultRegistry.VaultMetadata({name: "Vault A", asset: address(usdc), registeredAt: 0})
        );
        registry.registerVault(
            address(vaultB),
            VaultRegistry.VaultMetadata({name: "Vault B", asset: address(usdc), registeredAt: 0})
        );
        registry.setRouterEligible(address(vaultA), true);
        registry.setRouterEligible(address(vaultB), true);
        vm.stopPrank();

        router = CoreProxies.portfolioRouter(address(usdc), address(registry), routerAdmin);
        receipts = CoreProxies.consensusRecommendationReceipt(govAdmin);
        gov = CoreProxies.routerGovernance(address(router), address(receipts), govAdmin);

        vm.startPrank(routerAdmin);
        router.grantRole(router.ADMIN_ROLE(), address(gov));
        router.grantRole(router.WEIGHT_SETTER_ROLE(), address(gov));
        vm.stopPrank();
    }

    function _vector(address a, address b, uint256 bpsA, uint256 bpsB)
        internal
        pure
        returns (address[] memory vaults, uint256[] memory bps)
    {
        vaults = new address[](2);
        vaults[0] = a;
        vaults[1] = b;
        bps = new uint256[](2);
        bps[0] = bpsA;
        bps[1] = bpsB;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        CoreProxies.routerGovernance(address(0), address(receipts), govAdmin);
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        CoreProxies.routerGovernance(address(router), address(0), govAdmin);
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        CoreProxies.routerGovernance(address(router), address(receipts), address(0));
    }

    function test_constructor_storesWiringAndSeedsBothRolesToAdmin() public view {
        assertEq(address(gov.router()), address(router));
        assertEq(address(gov.receipts()), address(receipts));
        assertTrue(gov.hasRole(gov.ADMIN_ROLE(), govAdmin));
        assertTrue(gov.hasRole(gov.WEIGHT_SETTER_ROLE(), govAdmin));
        assertEq(gov.getRoleAdmin(gov.WEIGHT_SETTER_ROLE()), gov.WEIGHT_SETTER_ROLE());
        assertEq(gov.getRoleAdmin(gov.ADMIN_ROLE()), gov.ADMIN_ROLE());
    }

    /// @notice An ADMIN_ROLE holder that is not the weight setter cannot grant itself
    ///         the weight-setter role.
    function test_adminRoleCannotGrantWeightSetter() public {
        address admin2 = makeAddr("admin2");
        vm.startPrank(govAdmin);
        gov.grantRole(gov.ADMIN_ROLE(), admin2);
        vm.stopPrank();
        bytes32 role = gov.WEIGHT_SETTER_ROLE();
        vm.prank(admin2);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", admin2, role
            )
        );
        gov.grantRole(role, admin2);
    }

    function test_applyReceipt_revertsForStranger() public {
        (address[] memory vaults, uint256[] memory bps) =
            _vector(address(vaultA), address(vaultB), 6_000, 4_000);
        bytes32 role = gov.WEIGHT_SETTER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", stranger, role
            )
        );
        gov.applyReceipt(keccak256("r"), keccak256("d"), vaults, bps);
    }

    // ─── Admin fallbacks ──────────────────────────────────────────────────────

    function test_setDefaultWeights_adminOnlyAndForwards() public {
        (address[] memory vaults, uint256[] memory bps) =
            _vector(address(vaultA), address(vaultB), 7_000, 3_000);
        vm.prank(stranger);
        vm.expectRevert();
        gov.setDefaultWeights(vaults, bps);

        vm.prank(govAdmin);
        gov.setDefaultWeights(vaults, bps);
        (address[] memory dv, uint256[] memory db) = router.getDefaultWeights();
        assertEq(dv, vaults);
        assertEq(db, bps);
    }

    function test_setDefaultWeights_rejectsBadSumAndLength() public {
        (address[] memory vaults, uint256[] memory bps) =
            _vector(address(vaultA), address(vaultB), 7_000, 2_000);
        vm.prank(govAdmin);
        vm.expectRevert(PortfolioRouter.InvalidWeightSum.selector);
        gov.setDefaultWeights(vaults, bps);

        address[] memory one = new address[](1);
        one[0] = address(vaultA);
        vm.prank(govAdmin);
        vm.expectRevert(PortfolioRouter.LengthMismatch.selector);
        gov.setDefaultWeights(one, bps);
    }

    /// @notice Issue 1988: RouterGovernance has no function that clears or resets the router's
    ///         applied vector. A `clearVotedWeights()` call reverts for the admin and a stranger,
    ///         and the router keeps routing by the applied vector.
    function test_noClearVotedWeights_theAppliedVectorStays() public {
        (address[] memory dv, uint256[] memory db) =
            _vector(address(vaultA), address(vaultB), 7_000, 3_000);
        vm.prank(govAdmin);
        gov.setDefaultWeights(dv, db);
        (address[] memory vaults, uint256[] memory bps) =
            _vector(address(vaultA), address(vaultB), 2_000, 8_000);
        vm.prank(address(gov));
        router.setWeights(vaults, bps);
        assertTrue(router.votedWeightsActive());

        address[2] memory callers = [govAdmin, stranger];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            (bool ok,) = address(gov).call(abi.encodeWithSignature("clearVotedWeights()"));
            assertFalse(ok, "RouterGovernance has no clearVotedWeights selector");
        }
        assertTrue(router.votedWeightsActive(), "the applied vector stays active");
        (, uint256[] memory eb) = router.getEffectiveWeights();
        assertEq(eb, bps);
    }

    // ─── Duplicate vault on the router setters (HR-L-9) ───────────────────────

    /// @notice The router refuses a vector naming one vault twice on both setters,
    ///         whoever holds the role. The governed-path version is in
    ///         RouterGovernanceApplyReceipt.t.sol.
    function test_router_rejectsDuplicateVaultOnBothSetters() public {
        (address[] memory dup, uint256[] memory bps) =
            _vector(address(vaultA), address(vaultA), 5_000, 5_000);
        bytes memory reason =
            abi.encodeWithSelector(PortfolioRouter.DuplicateVault.selector, address(vaultA));

        vm.prank(address(gov));
        vm.expectRevert(reason);
        router.setWeights(dup, bps);

        vm.prank(routerAdmin);
        vm.expectRevert(reason);
        router.setDefaultWeights(dup, bps);

        vm.prank(govAdmin);
        vm.expectRevert(reason);
        gov.setDefaultWeights(dup, bps);
    }

    // ─── L-10: last-admin floor ────────────────────────────────────────────────

    function test_lastAdminFloor_governance_cannotDropSoleAdmin() public {
        bytes32 adminRole = gov.ADMIN_ROLE();
        assertEq(gov.getRoleMemberCount(adminRole), 1, "expected a single gov admin");

        vm.prank(govAdmin);
        vm.expectRevert(AdminFloorAccessControl.LastAdminFloor.selector);
        gov.renounceRole(adminRole, govAdmin);

        address gov2 = makeAddr("gov2");
        vm.prank(govAdmin);
        gov.grantRole(adminRole, gov2);
        vm.prank(gov2);
        gov.revokeRole(adminRole, govAdmin);
        assertTrue(gov.hasRole(adminRole, gov2), "gov2 retains the role");
    }
}
