// SPDX-License-Identifier: MIT
// Canonical: none — Foundry unit tests for contracts/PortfolioRouter.sol
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";

// ─── Test fixtures ────────────────────────────────────────────────────────────

/// @notice Minimal ERC-20 USDC mock (6 decimals).
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice ERC-4626-shaped vault mock for router tests. 1:1 deposit, previewDeposit returns
///         1:1 unless `_failOnDeposit` is set.
contract MockRouterVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;
    bool public failOnDeposit;

    event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);

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
        return assets; // 1:1
    }

    function setFailOnDeposit(bool fail) external {
        failOnDeposit = fail;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(!failOnDeposit, "MockRouterVault: deposit reverted");
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }
}

// ─── PortfolioRouterTest ──────────────────────────────────────────────────────

contract PortfolioRouterTest is Test {
    MockUSDC internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;

    address internal admin = makeAddr("admin");
    address internal depositor = makeAddr("depositor");
    address internal stranger = makeAddr("stranger");

    MockRouterVault internal vaultA;
    MockRouterVault internal vaultB;
    MockRouterVault internal vaultC;

    VaultRegistry.VaultMetadata internal metaA;
    VaultRegistry.VaultMetadata internal metaB;
    VaultRegistry.VaultMetadata internal metaC;

    uint256 constant ONE_USDC = 1e6;

    function setUp() public {
        usdc = new MockUSDC();
        registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);

        vaultA = new MockRouterVault(address(usdc));
        vaultB = new MockRouterVault(address(usdc));
        vaultC = new MockRouterVault(address(usdc));

        metaA =
            VaultRegistry.VaultMetadata({name: "Vault A", asset: address(usdc), registeredAt: 0});
        metaB =
            VaultRegistry.VaultMetadata({name: "Vault B", asset: address(usdc), registeredAt: 0});
        metaC =
            VaultRegistry.VaultMetadata({name: "Vault C", asset: address(usdc), registeredAt: 0});

        // Register vaultA and vaultB by default.
        vm.startPrank(admin);
        registry.registerVault(address(vaultA), metaA);
        registry.registerVault(address(vaultB), metaB);
        vm.stopPrank();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _setEqualWeights() internal {
        address[] memory vaults = new address[](2);
        uint256[] memory bps = new uint256[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps[0] = 5000;
        bps[1] = 5000;
        vm.prank(admin);
        router.setWeights(vaults, bps);
    }

    function _fundAndApprove(address user, uint256 amount) internal {
        usdc.mint(user, amount);
        vm.prank(user);
        usdc.approve(address(router), amount);
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_revertsOnZeroUsdc() public {
        vm.expectRevert(PortfolioRouter.ZeroAddress.selector);
        new PortfolioRouter(address(0), address(registry), admin);
    }

    function test_constructor_revertsOnZeroRegistry() public {
        vm.expectRevert(PortfolioRouter.ZeroAddress.selector);
        new PortfolioRouter(address(usdc), address(0), admin);
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(PortfolioRouter.ZeroAddress.selector);
        new PortfolioRouter(address(usdc), address(registry), address(0));
    }

    function test_constructor_grantsAdminRole() public view {
        assertTrue(router.hasRole(router.ADMIN_ROLE(), admin));
    }

    // ─── setWeights ──────────────────────────────────────────────────────────

    function test_setWeights_revertsIfSumNot10000() public {
        address[] memory vaults = new address[](2);
        uint256[] memory bps = new uint256[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps[0] = 4000;
        bps[1] = 5000; // sum = 9000, not 10000
        vm.prank(admin);
        vm.expectRevert(PortfolioRouter.InvalidWeightSum.selector);
        router.setWeights(vaults, bps);
    }

    function test_setWeights_revertsIfVaultNotRegistered() public {
        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = makeAddr("unregisteredVault");
        bps[0] = 10_000;
        vm.prank(admin);
        vm.expectRevert(VaultRegistry.NotRegistered.selector);
        router.setWeights(vaults, bps);
    }

    function test_setWeights_revertsIfLengthMismatch() public {
        address[] memory vaults = new address[](2);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps[0] = 10_000;
        vm.prank(admin);
        vm.expectRevert(PortfolioRouter.LengthMismatch.selector);
        router.setWeights(vaults, bps);
    }

    function test_setWeights_revertsForUnauthorized() public {
        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = address(vaultA);
        bps[0] = 10_000;
        bytes32 role = router.ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role
            )
        );
        vm.prank(stranger);
        router.setWeights(vaults, bps);
    }

    function test_setWeights_happyPath_emitsEvent() public {
        address[] memory vaults = new address[](2);
        uint256[] memory bps = new uint256[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps[0] = 6000;
        bps[1] = 4000;

        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit PortfolioRouter.WeightsSet(vaults, bps);
        router.setWeights(vaults, bps);

        (address[] memory retVaults, uint256[] memory retBps) = router.getWeights();
        assertEq(retVaults.length, 2);
        assertEq(retVaults[0], address(vaultA));
        assertEq(retVaults[1], address(vaultB));
        assertEq(retBps[0], 6000);
        assertEq(retBps[1], 4000);
    }

    // ─── deposit: happy path ─────────────────────────────────────────────────

    function test_deposit_splitsUSDCProportionally() public {
        _setEqualWeights();

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        // Each leg gets 500 USDC (50/50).
        assertEq(shares.length, 2);
        assertEq(shares[0], 500 * ONE_USDC);
        assertEq(shares[1], 500 * ONE_USDC);

        // Shares minted to depositor directly.
        assertEq(vaultA.balanceOf(depositor), 500 * ONE_USDC);
        assertEq(vaultB.balanceOf(depositor), 500 * ONE_USDC);

        // Router holds no residual USDC.
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_deposit_emitsRouterDepositPerLeg() public {
        _setEqualWeights();

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        vm.expectEmit(true, true, false, true);
        emit PortfolioRouter.RouterDeposit(
            depositor, address(vaultA), 500 * ONE_USDC, 500 * ONE_USDC, 5000
        );
        vm.expectEmit(true, true, false, true);
        emit PortfolioRouter.RouterDeposit(
            depositor, address(vaultB), 500 * ONE_USDC, 500 * ONE_USDC, 5000
        );
        router.deposit(amount, new uint256[](0));
    }

    function test_deposit_asymmetricWeights() public {
        address[] memory vaults = new address[](2);
        uint256[] memory bps = new uint256[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps[0] = 7000; // 70%
        bps[1] = 3000; // 30%
        vm.prank(admin);
        router.setWeights(vaults, bps);

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        assertEq(shares[0], 700 * ONE_USDC);
        assertEq(shares[1], 300 * ONE_USDC);
    }

    // ─── deposit: all-or-revert ───────────────────────────────────────────────

    function test_deposit_revertsIfAnyLegReverts() public {
        _setEqualWeights();
        vaultB.setFailOnDeposit(true);

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        vm.expectRevert("MockRouterVault: deposit reverted");
        router.deposit(amount, new uint256[](0));
    }

    // ─── deposit: cap enforcement ─────────────────────────────────────────────

    function test_deposit_revertsIfRouterCapExceeded() public {
        _setEqualWeights();

        vm.prank(admin);
        router.setRouterCap(500 * ONE_USDC); // cap at 500 USDC

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.RouterCapExceeded.selector);
        router.deposit(amount, new uint256[](0));
    }

    function test_deposit_revertsIfVaultCapExceeded() public {
        _setEqualWeights();

        vm.prank(admin);
        router.setVaultCap(address(vaultA), 100 * ONE_USDC); // per-vault cap at 100

        uint256 amount = 1000 * ONE_USDC; // each leg = 500, exceeds cap
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.VaultCapExceeded.selector);
        router.deposit(amount, new uint256[](0));
    }

    function test_deposit_succeedsWhenBelowAllCaps() public {
        _setEqualWeights();

        vm.prank(admin);
        router.setRouterCap(2000 * ONE_USDC);
        vm.prank(admin);
        router.setVaultCap(address(vaultA), 600 * ONE_USDC);
        vm.prank(admin);
        router.setVaultCap(address(vaultB), 600 * ONE_USDC);

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        assertEq(shares[0], 500 * ONE_USDC);
        assertEq(shares[1], 500 * ONE_USDC);
    }

    // ─── deposit: minSharesPerLeg slippage ───────────────────────────────────

    function test_deposit_revertsIfSlippageExceeded() public {
        _setEqualWeights();

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        // Set minimum shares higher than 1:1 mock will provide.
        uint256[] memory minShares = new uint256[](2);
        minShares[0] = 600 * ONE_USDC; // expects 600, gets 500
        minShares[1] = 400 * ONE_USDC;

        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.SlippageExceeded.selector);
        router.deposit(amount, minShares);
    }

    function test_deposit_revertsIfMinSharesLengthMismatch() public {
        _setEqualWeights();

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        uint256[] memory minShares = new uint256[](1); // wrong length
        minShares[0] = 500 * ONE_USDC;

        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.MinSharesLengthMismatch.selector);
        router.deposit(amount, minShares);
    }

    // ─── deposit: no weights set ──────────────────────────────────────────────

    function test_deposit_revertsIfNoWeightsSet() public {
        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.NoWeightsSet.selector);
        router.deposit(amount, new uint256[](0));
    }

    // ─── previewDeposit ───────────────────────────────────────────────────────

    function test_previewDeposit_returnsCorrectLegAmounts() public {
        _setEqualWeights();

        uint256 amount = 1000 * ONE_USDC;
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);

        assertEq(legs.length, 2);
        assertEq(legs[0].vault, address(vaultA));
        assertEq(legs[0].legAmount, 500 * ONE_USDC);
        assertEq(legs[0].estShares, 500 * ONE_USDC);
        assertFalse(legs[0].unavailable);

        assertEq(legs[1].vault, address(vaultB));
        assertEq(legs[1].legAmount, 500 * ONE_USDC);
        assertEq(legs[1].estShares, 500 * ONE_USDC);
        assertFalse(legs[1].unavailable);
    }

    function test_previewDeposit_marksUnavailableForPausedVault() public {
        _setEqualWeights();

        // Pause vaultA.
        vm.prank(admin);
        registry.setVaultStatus(address(vaultA), VaultRegistry.VaultStatus.Paused);

        uint256 amount = 1000 * ONE_USDC;
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);

        assertEq(legs.length, 2);
        assertTrue(legs[0].unavailable);
        assertEq(legs[0].estShares, 0);
        assertFalse(legs[1].unavailable);
    }

    function test_previewDeposit_marksUnavailableForRetiredVault() public {
        _setEqualWeights();

        // Retire vaultB.
        vm.prank(admin);
        registry.setVaultStatus(address(vaultB), VaultRegistry.VaultStatus.Retired);

        uint256 amount = 1000 * ONE_USDC;
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);

        assertEq(legs.length, 2);
        assertFalse(legs[0].unavailable);
        assertTrue(legs[1].unavailable);
        assertEq(legs[1].estShares, 0);
    }

    function test_previewDeposit_doesNotRevertForUnavailableVault() public {
        _setEqualWeights();

        // Pause both vaults.
        vm.startPrank(admin);
        registry.setVaultStatus(address(vaultA), VaultRegistry.VaultStatus.Paused);
        registry.setVaultStatus(address(vaultB), VaultRegistry.VaultStatus.Paused);
        vm.stopPrank();

        // Should not revert.
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(1000 * ONE_USDC);
        assertTrue(legs[0].unavailable);
        assertTrue(legs[1].unavailable);
    }

    // ─── Caps: admin surface ─────────────────────────────────────────────────

    function test_setRouterCap_emitsEvent() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit PortfolioRouter.RouterCapSet(0, 1000 * ONE_USDC);
        router.setRouterCap(1000 * ONE_USDC);
        assertEq(router.routerCap(), 1000 * ONE_USDC);
    }

    function test_setVaultCap_emitsEvent() public {
        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit PortfolioRouter.VaultCapSet(address(vaultA), 0, 500 * ONE_USDC);
        router.setVaultCap(address(vaultA), 500 * ONE_USDC);
        assertEq(router.vaultCap(address(vaultA)), 500 * ONE_USDC);
    }

    function test_setRouterCap_revertsForUnauthorized() public {
        bytes32 role = router.ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role
            )
        );
        vm.prank(stranger);
        router.setRouterCap(1000);
    }

    function test_setVaultCap_revertsOnZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(PortfolioRouter.ZeroAddress.selector);
        router.setVaultCap(address(0), 1000);
    }

    // ─── deposit: registry status enforcement ────────────────────────────────

    /// @notice Deposit reverts when a vault in the weight list is Paused in the
    ///         registry, even if the vault contract itself would still accept
    ///         deposits.
    function test_deposit_revertsIfRegistryVaultIsPaused() public {
        _setEqualWeights();

        // Pause vaultA in the registry; the vault contract still accepts deposits.
        vm.prank(admin);
        registry.setVaultStatus(address(vaultA), VaultRegistry.VaultStatus.Paused);

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.VaultNotActive.selector,
                address(vaultA),
                VaultRegistry.VaultStatus.Paused
            )
        );
        router.deposit(amount, new uint256[](0));
    }

    /// @notice Deposit reverts when a vault in the weight list is Retired in the
    ///         registry, even if the vault contract itself would still accept
    ///         deposits.
    function test_deposit_revertsIfRegistryVaultIsRetired() public {
        _setEqualWeights();

        // Retire vaultB in the registry; the vault contract still accepts deposits.
        vm.prank(admin);
        registry.setVaultStatus(address(vaultB), VaultRegistry.VaultStatus.Retired);

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.VaultNotActive.selector,
                address(vaultB),
                VaultRegistry.VaultStatus.Retired
            )
        );
        router.deposit(amount, new uint256[](0));
    }

    // ─── Fuzz: weight sum must equal 10000 ───────────────────────────────────

    /// @notice Any single-vault weight that is not 10000 must revert.
    function testFuzz_setWeights_singleVaultInvalidSum(uint256 bps) public {
        bps = bound(bps, 1, 9999);

        address[] memory vaults = new address[](1);
        uint256[] memory bpsArr = new uint256[](1);
        vaults[0] = address(vaultA);
        bpsArr[0] = bps;

        vm.prank(admin);
        vm.expectRevert(PortfolioRouter.InvalidWeightSum.selector);
        router.setWeights(vaults, bpsArr);
    }

    /// @notice A two-vault deposit always splits proportionally (capped to avoid overflow).
    function testFuzz_deposit_proportionalSplit(uint256 amount, uint256 bpsA) public {
        bpsA = bound(bpsA, 1, 9999);
        uint256 bpsB = 10_000 - bpsA;
        amount = bound(amount, 10_000, 1_000_000 * ONE_USDC); // 0.01 USDC to 1M USDC

        address[] memory vaults = new address[](2);
        uint256[] memory bps = new uint256[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps[0] = bpsA;
        bps[1] = bpsB;
        vm.prank(admin);
        router.setWeights(vaults, bps);

        _fundAndApprove(depositor, amount);
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        // Each share should match the proportional split.
        assertEq(shares[0], (amount * bpsA) / 10_000);
        assertEq(shares[1], (amount * bpsB) / 10_000);
    }
}
