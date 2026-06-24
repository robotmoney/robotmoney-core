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
import {AdminFloorAccessControl} from "../lib/AdminFloorAccessControl.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";

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

    /// @dev IRetirableVault deposit-halt stubs. MockRouterVault has no registry
    ///      link, so these are no-ops that satisfy the interface without reverting.
    function retire() external {}

    function unretire() external {}

    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets)
    {
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        assets = shares;
        assetToken.safeTransfer(receiver, assets);
    }
}

/// @notice A misbehaving vault that only accepts half of the legAmount,
///         leaving the other half stranded in the router. Used to exercise
///         the UsdcCustodyInvariantViolated post-loop check.
contract PartialAcceptVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;

    event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);

    constructor(address asset_) ERC20("Partial Vault Shares", "PVS") {
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
        return assets / 2;
    }

    /// @dev Accepts only half of `assets`, leaving the remainder in the router.
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        uint256 accepted = assets / 2;
        assetToken.safeTransferFrom(msg.sender, address(this), accepted);
        shares = accepted;
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, accepted, shares);
    }
}

/// @notice USDC mock that supports Circle-style address blacklisting.
///         Any transferFrom whose `from` address is blacklisted reverts,
///         simulating FS-RTR-1 (USDC blacklist hit inside _executeLeg).
contract BlacklistableUSDC is ERC20 {
    mapping(address => bool) public isBlacklisted;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function blacklist(address account) external {
        isBlacklisted[account] = true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        require(!isBlacklisted[from], "USDC: account is blacklisted");
        return super.transferFrom(from, to, amount);
    }
}

/// @notice ERC-4626-shaped vault that uses a BlacklistableUSDC instance.
///         Identical to MockRouterVault but typed to BlacklistableUSDC so the
///         blacklist test can pass the address check in setWeights / _requireRouterEligible.
contract BlacklistableVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;

    event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);

    constructor(address asset_) ERC20("Blacklistable Vault Shares", "BVS") {
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
        // Issue #475: production-readiness is registry state. Mark the
        // shared fixtures router-eligible so the existing tests keep
        // exercising the production weighting flow. vaultC is intentionally
        // left ineligible until a test registers it; tests that bring it
        // into the weight vector flip the flag locally.
        registry.setRouterEligible(address(vaultA), true);
        registry.setRouterEligible(address(vaultB), true);
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

    /// @notice FS-RTR-1: when a vault's deposit() reverts (e.g. USDC blacklist
    ///         or fee-on-transfer), the router surfaces a named
    ///         UsdcLegTransferFailed error that identifies the vault, rather
    ///         than the opaque raw revert string from the vault.
    function test_deposit_revertsIfAnyLegReverts() public {
        _setEqualWeights();
        vaultB.setFailOnDeposit(true);

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.UsdcLegTransferFailed.selector, address(vaultB))
        );
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

    /// @notice Skip-and-renormalise (RTR-5 / F-13): a vault Paused in the registry
    ///         after weighting is skipped, NOT reverted; the deposit routes the
    ///         full amount to the surviving Active leg. Preview reports the Paused
    ///         leg unavailable, and execute deposits exactly the available legs —
    ///         a single Paused vault never bricks the whole router deposit (NC-4).
    function test_deposit_skipsRegistryPausedVault() public {
        _setEqualWeights();

        // Pause vaultA in the registry; the vault contract still accepts deposits.
        vm.prank(admin);
        registry.setVaultStatus(address(vaultA), VaultRegistry.VaultStatus.Paused);

        uint256 amount = 1000 * ONE_USDC;

        // Preview must agree with execute on availability.
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertTrue(legs[0].unavailable, "paused leg must preview unavailable");
        assertFalse(legs[1].unavailable, "active leg must preview available");
        assertEq(legs[0].legAmount, 0, "skipped leg gets no amount");
        assertEq(legs[1].legAmount, amount, "active leg absorbs renormalised amount");

        _fundAndApprove(depositor, amount);
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        assertEq(shares[0], 0, "skipped paused leg mints nothing");
        assertEq(shares[1], amount, "surviving leg receives full renormalised amount");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no dust");
    }

    /// @notice Skip-and-renormalise (RTR-5 / F-13): a vault Retired in the
    ///         registry after weighting is skipped, NOT reverted; the deposit
    ///         routes the full amount to the surviving Active leg, matching preview.
    function test_deposit_skipsRegistryRetiredVault() public {
        _setEqualWeights();

        // Retire vaultB in the registry; the vault contract still accepts deposits.
        vm.prank(admin);
        registry.setVaultStatus(address(vaultB), VaultRegistry.VaultStatus.Retired);

        uint256 amount = 1000 * ONE_USDC;

        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertFalse(legs[0].unavailable, "active leg must preview available");
        assertTrue(legs[1].unavailable, "retired leg must preview unavailable");
        assertEq(legs[0].legAmount, amount, "active leg absorbs renormalised amount");
        assertEq(legs[1].legAmount, 0, "skipped leg gets no amount");

        _fundAndApprove(depositor, amount);
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        assertEq(shares[0], amount, "surviving leg receives full renormalised amount");
        assertEq(shares[1], 0, "skipped retired leg mints nothing");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no dust");
    }

    /// @notice When EVERY weighted vault is non-Active the basket is consistently
    ///         unavailable: preview reports all legs unavailable and the deposit
    ///         reverts (NoWeightsSet) rather than stranding the caller's USDC.
    ///         Preview and execute never disagree (RTR-5).
    function test_deposit_revertsWhenAllLegsUnavailable() public {
        _setEqualWeights();

        vm.startPrank(admin);
        registry.setVaultStatus(address(vaultA), VaultRegistry.VaultStatus.Paused);
        registry.setVaultStatus(address(vaultB), VaultRegistry.VaultStatus.Retired);
        vm.stopPrank();

        uint256 amount = 1000 * ONE_USDC;
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertTrue(legs[0].unavailable && legs[1].unavailable, "all legs unavailable in preview");

        _fundAndApprove(depositor, amount);
        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.NoWeightsSet.selector);
        router.deposit(amount, new uint256[](0));
    }

    // ─── Router-eligibility: asset compatibility ─────────────────────────────

    /// @notice Registered vault whose ERC-4626 `asset()` is not router USDC
    ///         cannot be added to the weight vector.
    function test_setWeights_revertsIfVaultAssetMismatch() public {
        // A mock "vault" denominated in a non-USDC asset is registered.
        MockUSDC otherAsset = new MockUSDC();
        MockRouterVault badVault = new MockRouterVault(address(otherAsset));
        VaultRegistry.VaultMetadata memory badMeta = VaultRegistry.VaultMetadata({
            name: "Bad Vault", asset: address(otherAsset), registeredAt: 0
        });
        vm.prank(admin);
        registry.registerVault(address(badVault), badMeta);

        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = address(badVault);
        bps[0] = 10_000;

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.VaultAssetMismatch.selector, address(badVault), address(otherAsset)
            )
        );
        router.setWeights(vaults, bps);
    }

    /// @notice A registered EOA-style "vault" (no code, asset() reverts) cannot
    ///         be added to the weight vector. This protects against an
    ///         attacker registering an arbitrary address with crafted metadata
    ///         and being able to weight it.
    function test_setWeights_revertsIfVaultAssetUnreadable() public {
        address fakeVault = makeAddr("fakeVault");
        VaultRegistry.VaultMetadata memory fakeMeta = VaultRegistry.VaultMetadata({
            name: "Fake Vault", asset: address(usdc), registeredAt: 0
        });
        vm.prank(admin);
        registry.registerVault(fakeVault, fakeMeta);

        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = fakeVault;
        bps[0] = 10_000;

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.VaultAssetUnreadable.selector, fakeVault)
        );
        router.setWeights(vaults, bps);
    }

    /// @notice A malicious ERC-4626-shaped vault whose underlying asset is not
    ///         router USDC cannot receive USDC via PortfolioRouter.deposit even
    ///         if it were somehow present in the weight vector. The
    ///         setWeights guard normally blocks this; this test installs the
    ///         bad vault via direct storage manipulation (foundry `store`) on
    ///         a fresh router so we can prove the deposit-time check rejects
    ///         it as defence in depth.
    function test_deposit_skipsRuntimeAssetMismatchVault() public {
        // Construct an eligible-at-config-time vault, then swap it for an
        // ineligible one between setWeights and deposit by replacing its
        // bytecode. We use `vm.etch` to overwrite the eligible vault's code
        // with a vault that returns a different asset(). Skip-and-renormalise
        // (RTR-5) means the now-ineligible leg is skipped — it never receives
        // USDC — and the surviving eligible leg absorbs the amount.
        _setEqualWeights();

        // Build a non-USDC-backed vault and copy its bytecode over vaultA.
        MockUSDC otherAsset = new MockUSDC();
        MockRouterVault attackerVault = new MockRouterVault(address(otherAsset));
        vm.etch(address(vaultA), address(attackerVault).code);
        // The asset slot on MockRouterVault is the first storage slot
        // (immutable in source — but bytecode hard-codes it). Since
        // `assetToken` is immutable, the swapped code now returns the
        // attacker's asset address through asset(). Verify:
        assertEq(MockRouterVault(address(vaultA)).asset(), address(otherAsset));

        uint256 amount = 1000 * ONE_USDC;

        // Preview agrees: vaultA now ineligible (asset mismatch) ⇒ unavailable.
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertTrue(legs[0].unavailable, "asset-mismatch leg must preview unavailable");
        assertFalse(legs[1].unavailable, "eligible leg must preview available");

        _fundAndApprove(depositor, amount);
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        assertEq(shares[0], 0, "ineligible (asset-mismatch) leg receives nothing");
        assertEq(shares[1], amount, "eligible leg absorbs full renormalised amount");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no dust");
    }

    /// @notice `depositFor` also skip-and-renormalises a leg that becomes
    ///         router-ineligible (asset mismatch) at runtime (RTR-5).
    function test_depositFor_skipsRuntimeAssetMismatchVault() public {
        _setEqualWeights();

        MockUSDC otherAsset = new MockUSDC();
        MockRouterVault attackerVault = new MockRouterVault(address(otherAsset));
        vm.etch(address(vaultB), address(attackerVault).code);

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        uint256[] memory shares = router.depositFor(depositor, amount, new uint256[](0));

        assertEq(shares[0], amount, "eligible leg absorbs full renormalised amount");
        assertEq(shares[1], 0, "ineligible (asset-mismatch) leg receives nothing");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no dust");
    }

    /// @notice Eligible vaults retain their normal deposit behaviour — the
    ///         eligibility guard does not affect the happy path.
    function test_deposit_eligibleVaults_succeed() public {
        _setEqualWeights();

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        assertEq(shares[0], 500 * ONE_USDC);
        assertEq(shares[1], 500 * ONE_USDC);
    }

    // ─── Router-eligibility: read surface ────────────────────────────────────

    /// @notice `isRouterEligible` returns true for a USDC-backed ERC-4626 vault.
    function test_isRouterEligible_trueForUSDCVault() public view {
        assertTrue(router.isRouterEligible(address(vaultA)));
        assertTrue(router.isRouterEligible(address(vaultB)));
    }

    /// @notice `isRouterEligible` returns false for a non-USDC-backed vault.
    function test_isRouterEligible_falseForNonUSDCVault() public {
        MockUSDC otherAsset = new MockUSDC();
        MockRouterVault badVault = new MockRouterVault(address(otherAsset));
        assertFalse(router.isRouterEligible(address(badVault)));
    }

    /// @notice `isRouterEligible` returns false for an EOA (no asset() view).
    function test_isRouterEligible_falseForEOA() public {
        assertFalse(router.isRouterEligible(makeAddr("eoa")));
    }

    /// @notice `isRouterEligible` returns false for address(0).
    function test_isRouterEligible_falseForZeroAddress() public view {
        assertFalse(router.isRouterEligible(address(0)));
    }

    /// @notice Router eligibility is distinct from registry status — a vault
    ///         that is Paused in the registry is still router-eligible from
    ///         an asset-compatibility standpoint. Clients must read both
    ///         signals to compose accurate UI state.
    function test_isRouterEligible_independentOfRegistryStatus() public {
        // Pause vaultA in the registry. Router eligibility should not change.
        vm.prank(admin);
        registry.setVaultStatus(address(vaultA), VaultRegistry.VaultStatus.Paused);
        assertTrue(router.isRouterEligible(address(vaultA)));

        // Retire as well.
        vm.prank(admin);
        registry.setVaultStatus(address(vaultA), VaultRegistry.VaultStatus.Retired);
        assertTrue(router.isRouterEligible(address(vaultA)));
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
    ///         The first leg receives the floored BPS allocation; the final leg receives
    ///         the floored allocation plus any rounding remainder so the router holds zero.
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

        uint256 expectedA = (amount * bpsA) / 10_000;
        // The final leg absorbs the rounding remainder so that total == amount.
        uint256 expectedB = amount - expectedA;

        assertEq(shares[0], expectedA);
        assertEq(shares[1], expectedB);
        // Conservation invariant: no dust left in router.
        assertEq(usdc.balanceOf(address(router)), 0, "router holds dust");
    }

    // ─── BPS rounding / dust invariant ───────────────────────────────────────

    /// @notice Deposit with an amount not divisible by leg count leaves zero
    ///         USDC in the router (remainder is assigned to the final leg).
    function test_deposit_noRouterDustOnUnevenSplit() public {
        // Weights [3334, 3333, 3333] — three vaults, intentionally uneven.
        vm.startPrank(admin);
        registry.registerVault(address(vaultC), metaC);
        registry.setRouterEligible(address(vaultC), true);
        address[] memory vaults = new address[](3);
        uint256[] memory bps = new uint256[](3);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        vaults[2] = address(vaultC);
        bps[0] = 3334;
        bps[1] = 3333;
        bps[2] = 3333;
        router.setWeights(vaults, bps);
        vm.stopPrank();

        // 100 USDC: floored amounts are [33, 33, 33] = 99, remainder = 1
        uint256 amount = 100 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        // Router must hold zero USDC after the deposit.
        assertEq(usdc.balanceOf(address(router)), 0, "router holds dust");

        // All deposited USDC must reach the vaults.
        uint256 totalShares = shares[0] + shares[1] + shares[2];
        assertEq(totalShares, amount, "shares do not sum to deposited amount");
    }

    /// @notice Fuzz: arbitrary deposit amounts and two-leg weights — router
    ///         balance is always zero after a successful deposit.
    function testFuzz_deposit_routerBalanceAlwaysZero(uint256 amount, uint256 bpsA) public {
        bpsA = bound(bpsA, 1, 9999);
        uint256 bpsB = 10_000 - bpsA;
        amount = bound(amount, 1, 1_000_000 * ONE_USDC);

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

        // Pass-through invariant: router holds zero USDC.
        assertEq(usdc.balanceOf(address(router)), 0, "router holds dust");

        // Conservation: sum of shares equals total deposited amount.
        assertEq(shares[0] + shares[1], amount, "shares do not sum to deposited amount");
    }

    // ─── Router-eligibility gate (issue #475) ────────────────────────────────
    //
    // Production-readiness for Portfolio Router weighting is registry state:
    // `VaultRegistry.isRouterEligible(vault)` is the single signal an operator
    // sets. `PortfolioRouter` refuses to weight or deposit into a vault whose
    // registry eligibility flag is false. The same contracts ship into every
    // environment; only the registry flag's value differs. See
    // `docs/development/single-production-codebase.md` and the removal of
    // the historical `isPrototype()` / `prototypeOverride` /
    // `nonPrototypeAttested` machinery in issue #475.

    /// @notice Helper: register a vault in the registry without marking it
    ///         router-eligible. Used to exercise the eligibility gate from
    ///         the un-opted-in default state.
    function _registerIneligible(address vault) internal {
        VaultRegistry.VaultMetadata memory meta =
            VaultRegistry.VaultMetadata({name: "Pending", asset: address(usdc), registeredAt: 0});
        vm.prank(admin);
        registry.registerVault(vault, meta);
    }

    /// @notice AC#4 (test-plan: fail-closed): a registered vault that has NOT
    ///         been marked router-eligible in the registry is rejected by
    ///         setWeights with `VaultNotRouterEligible`. The default
    ///         eligibility value is false for every registration, so a fresh
    ///         deployment is gated by construction.
    function test_setWeights_revertsIfVaultNotRouterEligible() public {
        // Fresh vault — USDC-backed but never marked eligible.
        MockRouterVault pending = new MockRouterVault(address(usdc));
        _registerIneligible(address(pending));

        // Sanity: registry flag defaults to false.
        assertFalse(registry.isRouterEligible(address(pending)));

        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = address(pending);
        bps[0] = 10_000;

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.VaultNotRouterEligible.selector, address(pending)
            )
        );
        router.setWeights(vaults, bps);
    }

    /// @notice AC#3 (test-plan: configuration-only success): a vault becomes
    ///         router-eligible via a single registry call — no subclass, no
    ///         code override — and a USDC deposit through PortfolioRouter
    ///         succeeds end-to-end. This is the production weighting flow
    ///         that test, demo, and mainnet all share.
    function test_setWeights_succeedsAfterRegistryOptIn() public {
        MockRouterVault pending = new MockRouterVault(address(usdc));
        _registerIneligible(address(pending));

        // Flip the single registry-backed eligibility flag.
        vm.prank(admin);
        registry.setRouterEligible(address(pending), true);

        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = address(pending);
        bps[0] = 10_000;
        vm.prank(admin);
        router.setWeights(vaults, bps);

        (address[] memory storedVaults,) = router.getWeights();
        assertEq(storedVaults.length, 1);
        assertEq(storedVaults[0], address(pending));

        // Deposit through the production router flow succeeds.
        uint256 amount = 100 * ONE_USDC;
        _fundAndApprove(depositor, amount);
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        assertEq(shares.length, 1);
        assertEq(shares[0], amount, "1:1 mock vault must mint amount shares");
        assertEq(pending.balanceOf(depositor), amount, "shares minted to depositor");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds dust");
    }

    /// @notice Skip-and-renormalise (RTR-5 / F-13): revoking the registry
    ///         eligibility flag after a vault has been weighted makes that leg
    ///         unavailable — it is skipped (matching preview), and the surviving
    ///         eligible leg absorbs the renormalised amount. The ineligible vault
    ///         never receives USDC.
    function test_deposit_skipsRegistryEligibilityRevokedVault() public {
        // vaultA is marked eligible in setUp; weight it then revoke.
        _setEqualWeights();

        vm.prank(admin);
        registry.setRouterEligible(address(vaultA), false);

        uint256 amount = 100 * ONE_USDC;

        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertTrue(legs[0].unavailable, "ineligible leg must preview unavailable");
        assertFalse(legs[1].unavailable, "eligible leg must preview available");

        _fundAndApprove(depositor, amount);
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        assertEq(shares[0], 0, "ineligible leg receives nothing");
        assertEq(shares[1], amount, "eligible leg absorbs full renormalised amount");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no dust");
    }

    /// @notice `VaultRegistry.setRouterEligible` is admin-gated.
    function test_setRouterEligible_revertsForUnauthorized() public {
        MockRouterVault v = new MockRouterVault(address(usdc));
        _registerIneligible(address(v));
        bytes32 adminRole = registry.ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole
            )
        );
        registry.setRouterEligible(address(v), true);
    }

    /// @notice `VaultRegistry.setRouterEligible` rejects unregistered vaults
    ///         — the flag cannot be set on an address that was never
    ///         registered.
    function test_setRouterEligible_revertsIfNotRegistered() public {
        address unknown = makeAddr("unknownVault");
        vm.prank(admin);
        vm.expectRevert(VaultRegistry.NotRegistered.selector);
        registry.setRouterEligible(unknown, true);
    }

    /// @notice `VaultRegistry.setRouterEligible` emits the audit event with
    ///         old/new values so a registry indexer can track every flip.
    function test_setRouterEligible_emitsEvent() public {
        MockRouterVault v = new MockRouterVault(address(usdc));
        _registerIneligible(address(v));

        vm.expectEmit(true, false, false, true, address(registry));
        emit VaultRegistry.RouterEligibilityChanged(address(v), false, true);
        vm.prank(admin);
        registry.setRouterEligible(address(v), true);

        // Toggling back also emits with the correct previous value.
        vm.expectEmit(true, false, false, true, address(registry));
        emit VaultRegistry.RouterEligibilityChanged(address(v), true, false);
        vm.prank(admin);
        registry.setRouterEligible(address(v), false);
    }

    /// @notice `PortfolioRouter.isRouterEligible` mirrors the gate enforced
    ///         at setWeights / deposit time: false for a registered but
    ///         un-opted-in vault, true once the registry flag is flipped.
    function test_isRouterEligible_followsRegistryFlag() public {
        MockRouterVault v = new MockRouterVault(address(usdc));
        _registerIneligible(address(v));
        assertFalse(router.isRouterEligible(address(v)), "default false");

        vm.prank(admin);
        registry.setRouterEligible(address(v), true);
        assertTrue(router.isRouterEligible(address(v)), "true after opt-in");

        vm.prank(admin);
        registry.setRouterEligible(address(v), false);
        assertFalse(router.isRouterEligible(address(v)), "false after revoke");
    }

    // ─── Zero-USDC custody invariant (issue #502) ─────────────────────────────
    //
    // After _executeLegs completes, usdc.balanceOf(address(router)) must be
    // zero. If any vault accepts less than its allocated legAmount the whole
    // deposit reverts with UsdcCustodyInvariantViolated so no USDC is left
    // stranded. The router never holds USDC across transactions, and the old
    // arbitrary-recipient `rescueUsdc` path is DELETED (INV-1): no admin/role
    // function may route USDC to a caller-supplied recipient. The only asset
    // movement left is the permissionless foreign-token quarantine sweep, which
    // refuses USDC.

    /// @dev Deploy and register a PartialAcceptVault, marking it router-eligible.
    function _deployPartialVault() internal returns (PartialAcceptVault pv) {
        pv = new PartialAcceptVault(address(usdc));
        VaultRegistry.VaultMetadata memory meta = VaultRegistry.VaultMetadata({
            name: "Partial Vault", asset: address(usdc), registeredAt: 0
        });
        vm.startPrank(admin);
        registry.registerVault(address(pv), meta);
        registry.setRouterEligible(address(pv), true);
        vm.stopPrank();
    }

    /// @notice AC#1: deposit through a mock vault that accepts only half legAmount
    ///         causes the full deposit to revert with UsdcCustodyInvariantViolated.
    function test_deposit_revertsWithInvariantViolation_whenVaultAcceptsPartial() public {
        PartialAcceptVault pv = _deployPartialVault();

        // Single-vault weight vector so all USDC flows to the partial-accept vault.
        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = address(pv);
        bps[0] = 10_000;
        vm.prank(admin);
        router.setWeights(vaults, bps);

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.UsdcCustodyInvariantViolated.selector);
        router.deposit(amount, new uint256[](0));
    }

    /// @notice AC#4: normal deposit through well-behaved vaults leaves zero USDC
    ///         in the router — confirming the invariant is satisfied on the
    ///         happy path without triggering UsdcCustodyInvariantViolated.
    function test_deposit_happyPath_leavesZeroUsdcInRouter() public {
        _setEqualWeights();

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        router.deposit(amount, new uint256[](0));

        assertEq(usdc.balanceOf(address(router)), 0, "router must hold zero USDC after deposit");
    }

    // ─── FS-RTR-1: named blacklist error ─────────────────────────────────────

    /// @notice FS-RTR-1 / AC#2: when the router's USDC contract reverts on
    ///         transferFrom because the router address is blacklisted, the
    ///         router re-raises UsdcLegTransferFailed (not the opaque
    ///         UsdcCustodyInvariantViolated) so callers can identify the cause.
    ///
    ///         Setup: deploy a BlacklistableUSDC + BlacklistableVault, wire a
    ///         fresh router, blacklist the router address, then attempt a
    ///         deposit through that vault.
    function test_deposit_revertsWithNamedError_whenUsdcBlacklist() public {
        // Deploy fresh USDC + vault + router for this scenario.
        BlacklistableUSDC bUsdc = new BlacklistableUSDC();
        VaultRegistry bRegistry = new VaultRegistry(admin);
        PortfolioRouter bRouter = new PortfolioRouter(address(bUsdc), address(bRegistry), admin);

        BlacklistableVault bVault = new BlacklistableVault(address(bUsdc));
        VaultRegistry.VaultMetadata memory bMeta = VaultRegistry.VaultMetadata({
            name: "Blacklistable Vault", asset: address(bUsdc), registeredAt: 0
        });

        vm.startPrank(admin);
        bRegistry.registerVault(address(bVault), bMeta);
        bRegistry.setRouterEligible(address(bVault), true);
        address[] memory bVaults = new address[](1);
        uint256[] memory bBps = new uint256[](1);
        bVaults[0] = address(bVault);
        bBps[0] = 10_000;
        bRouter.setWeights(bVaults, bBps);
        vm.stopPrank();

        // Blacklist the router so that vault.deposit's safeTransferFrom reverts.
        bUsdc.blacklist(address(bRouter));

        uint256 amount = 100 * ONE_USDC;
        bUsdc.mint(depositor, amount);
        vm.prank(depositor);
        bUsdc.approve(address(bRouter), amount);

        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.UsdcLegTransferFailed.selector, address(bVault))
        );
        bRouter.deposit(amount, new uint256[](0));
    }

    // ─── AZ-RTR-2: donation DoS fix ──────────────────────────────────────────

    /// @notice AZ-RTR-2 / AC#3: a small USDC donation to the router before a
    ///         deposit must not cause the deposit to revert. The post-deposit
    ///         invariant uses a balance delta (snapshot before pulling the
    ///         caller's funds) so the pre-existing donated USDC is excluded.
    function test_deposit_succeedsWithDonatedUsdcInRouter() public {
        _setEqualWeights();

        // Donate 1 USDC to the router before any deposit.
        usdc.mint(address(router), 1 * ONE_USDC);
        assertEq(usdc.balanceOf(address(router)), 1 * ONE_USDC, "donation present");

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        // Deposit must succeed: the delta is zero even though the absolute
        // post-deposit balance is 1 USDC (the donated amount).
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        // All shares minted (1:1 mock vault).
        assertEq(shares[0], 500 * ONE_USDC, "vaultA shares");
        assertEq(shares[1], 500 * ONE_USDC, "vaultB shares");

        // Donated USDC is still on the router — the invariant did not consume it.
        assertEq(
            usdc.balanceOf(address(router)), 1 * ONE_USDC, "donated USDC remains after deposit"
        );
    }

    /// @notice INV-1: USDC (a protocol asset) can never be swept out of the router.
    ///         The deleted `rescueUsdc` is replaced by a sweep that refuses USDC,
    ///         so there is no admin/role path that routes USDC to any recipient.
    function test_sweepForeignToken_revertsForUsdc() public {
        usdc.mint(address(router), 500 * ONE_USDC);
        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, address(usdc))
        );
        router.sweepForeignToken(address(usdc));
        assertEq(usdc.balanceOf(address(router)), 500 * ONE_USDC, "USDC must stay put");
    }

    /// @notice INV-2: a foreign (non-USDC) token that lands on the router is
    ///         permissionlessly swept to the fixed quarantine address — any
    ///         caller, never a caller-supplied recipient.
    function test_sweepForeignToken_permissionlessToQuarantine() public {
        MockUSDC stray = new MockUSDC();
        stray.mint(address(router), 250 * ONE_USDC);

        vm.prank(stranger);
        router.sweepForeignToken(address(stray));

        assertEq(stray.balanceOf(address(router)), 0, "router must be empty after sweep");
        assertEq(
            stray.balanceOf(ForeignTokenQuarantine.QUARANTINE),
            250 * ONE_USDC,
            "stray token quarantined"
        );
    }

    /// @notice The sweep is a harmless no-op when there is nothing to move.
    function test_sweepForeignToken_zeroBalanceIsNoop() public {
        MockUSDC stray = new MockUSDC();
        router.sweepForeignToken(address(stray));
        assertEq(stray.balanceOf(ForeignTokenQuarantine.QUARANTINE), 0);
    }

    // ─── RWA/Thematic placeholder coexistence (issue #479) ────────────────────

    /// @dev Register a fourth vault matching the demo's RWA/Thematic
    ///      placeholder shape: present in the registry but non-Active
    ///      (Paused) and never marked router-eligible. Returns the vault.
    function _registerRwaPlaceholder() internal returns (MockRouterVault rwa) {
        rwa = new MockRouterVault(address(usdc));
        VaultRegistry.VaultMetadata memory meta = VaultRegistry.VaultMetadata({
            name: "Robot Money RWA / Thematic", asset: address(usdc), registeredAt: 0
        });
        vm.startPrank(admin);
        registry.registerVault(address(rwa), meta);
        // Non-Active status; isRouterEligible stays false (the registry
        // default). This mirrors DeployDemoExtraVaults' RWA placeholder.
        registry.setVaultStatus(address(rwa), VaultRegistry.VaultStatus.Paused);
        vm.stopPrank();
    }

    /// @notice AC (issue #479): with the RWA/Thematic placeholder present in
    ///         the registry as a non-Active, non-router-eligible entry,
    ///         `previewDeposit` returns only the weighted (Active, eligible)
    ///         legs and does not surface or revert on the RWA leg.
    function test_previewDeposit_skipsRwaPlaceholder() public {
        _setEqualWeights();
        MockRouterVault rwa = _registerRwaPlaceholder();

        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(1000 * ONE_USDC);

        // Only the two weighted vaults appear; the RWA placeholder is not in
        // the weight vector so it never enters the preview.
        assertEq(legs.length, 2, "RWA placeholder must not appear in preview legs");
        for (uint256 i = 0; i < legs.length; i++) {
            assertTrue(legs[i].vault != address(rwa), "RWA vault must not be a preview leg");
        }
    }

    /// @notice AC (issue #479): `deposit` succeeds and splits across the
    ///         Active weighted vaults while the non-Active RWA placeholder
    ///         sits inertly in the registry — no revert, no flow to RWA.
    function test_deposit_succeedsWithRwaPlaceholderPresent() public {
        _setEqualWeights();
        MockRouterVault rwa = _registerRwaPlaceholder();

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);

        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        assertEq(shares.length, 2, "deposit splits across the two weighted vaults");
        assertEq(vaultA.balanceOf(depositor), 500 * ONE_USDC);
        assertEq(vaultB.balanceOf(depositor), 500 * ONE_USDC);
        // The RWA placeholder received nothing and the router holds no dust.
        assertEq(rwa.balanceOf(depositor), 0, "no shares minted in the RWA placeholder");
        assertEq(usdc.balanceOf(address(rwa)), 0, "no USDC routed to the RWA placeholder");
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    /// @notice AC (issue #479): the RWA placeholder reports the expected
    ///         non-Active status and stays router-ineligible — the two
    ///         signals the dapp and Router read to keep it out of flow.
    function test_rwaPlaceholder_isNonActiveAndIneligible() public {
        MockRouterVault rwa = _registerRwaPlaceholder();
        (, VaultRegistry.VaultStatus status) = registry.getVault(address(rwa));
        assertTrue(status != VaultRegistry.VaultStatus.Active, "RWA must be non-Active");
        assertFalse(registry.isRouterEligible(address(rwa)), "RWA must be router-ineligible");
        assertFalse(router.isRouterEligible(address(rwa)), "router view agrees: ineligible");
    }

    // ─── defaultWeights fallback — ADR-0002 ────────────────────────────────────

    /// @dev Set a default 60/40 vector over the two eligible vaults.
    function _setDefaultWeights() internal {
        address[] memory vaults = new address[](2);
        uint256[] memory bps = new uint256[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps[0] = 6_000;
        bps[1] = 4_000;
        vm.prank(admin);
        router.setDefaultWeights(vaults, bps);
    }

    /// @notice setDefaultWeights rejects a length that does not match the
    ///         registry's router-eligible vault count.
    function test_setDefaultWeights_revertsIfLengthMismatch() public {
        address[] memory vaults = new address[](1);
        uint256[] memory bps = new uint256[](1);
        vaults[0] = address(vaultA);
        bps[0] = 10_000;
        vm.prank(admin);
        vm.expectRevert(PortfolioRouter.LengthMismatch.selector);
        router.setDefaultWeights(vaults, bps);
    }

    // ─── redeemFor: authorization guards (issue #751) ──────────────────────────

    /// @notice An unauthorized caller cannot redeemFor — the confused-deputy
    ///         guard reverts with UnauthorizedRedeemer before any vault call.
    function test_redeemFor_unauthorizedCaller_reverts() public {
        _setEqualWeights();

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        // Fund vaults so they can pay out on redeem.
        usdc.mint(address(vaultA), 1000 * ONE_USDC);
        usdc.mint(address(vaultB), 1000 * ONE_USDC);

        // Approve the router on vault share tokens.
        vm.prank(depositor);
        vaultA.approve(address(router), shares[0]);
        vm.prank(depositor);
        vaultB.approve(address(router), shares[1]);

        uint256[] memory sharesToRedeem = new uint256[](2);
        sharesToRedeem[0] = shares[0];
        sharesToRedeem[1] = shares[1];

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.UnauthorizedRedeemer.selector, depositor, stranger
            )
        );
        router.redeemFor(
            depositor,
            stranger,
            _redeemVaults(),
            sharesToRedeem,
            new uint256[](2),
            type(uint256).max
        );
    }

    /// @notice shareHolder can call redeemFor on their own shares.
    function test_redeemFor_shareHolderCanRedeem() public {
        _setEqualWeights();

        uint256 amount = 1000 * ONE_USDC;
        _fundAndApprove(depositor, amount);
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        // Fund vaults so they can pay out on redeem.
        usdc.mint(address(vaultA), 1000 * ONE_USDC);
        usdc.mint(address(vaultB), 1000 * ONE_USDC);

        // Approve the router on vault share tokens.
        vm.prank(depositor);
        vaultA.approve(address(router), shares[0]);
        vm.prank(depositor);
        vaultB.approve(address(router), shares[1]);

        uint256[] memory sharesToRedeem = new uint256[](2);
        sharesToRedeem[0] = shares[0];
        sharesToRedeem[1] = shares[1];

        vm.prank(depositor);
        uint256[] memory assetsOut = router.redeemFor(
            depositor,
            depositor,
            _redeemVaults(),
            sharesToRedeem,
            new uint256[](2),
            type(uint256).max
        );

        assertEq(assetsOut[0], shares[0]);
        assertEq(assetsOut[1], shares[1]);
        assertEq(vaultA.balanceOf(depositor), 0);
        assertEq(vaultB.balanceOf(depositor), 0);
        assertEq(usdc.balanceOf(depositor), amount);
    }

    // ─── L-8: redeemFor per-leg slippage floor + deadline ──────────────────────

    /// @dev Deposit `amount`, fund both vaults to cover redemption, approve the
    ///      router on both share tokens, and return the per-leg share array.
    function _depositAndApproveForRedeem(uint256 amount)
        internal
        returns (uint256[] memory sharesToRedeem)
    {
        _setEqualWeights();
        _fundAndApprove(depositor, amount);
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(amount, new uint256[](0));

        usdc.mint(address(vaultA), amount);
        usdc.mint(address(vaultB), amount);

        vm.prank(depositor);
        vaultA.approve(address(router), shares[0]);
        vm.prank(depositor);
        vaultB.approve(address(router), shares[1]);

        sharesToRedeem = new uint256[](2);
        sharesToRedeem[0] = shares[0];
        sharesToRedeem[1] = shares[1];
    }

    /// @dev The explicit redeem vault set [vaultA, vaultB], parallel to the
    ///      equal-weight deposit legs. `redeemFor` now drives legs from this
    ///      caller-supplied array, not the live weight vector (issue #967).
    function _redeemVaults() internal view returns (address[] memory vaults) {
        vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
    }

    /// @notice redeemFor reverts SlippageExceeded when realized per-leg proceeds
    ///         fall below the caller-supplied minAssetsPerLeg floor.
    function test_redeemFor_revertsWhenBelowMinAssetsFloor() public {
        uint256 amount = 1000 * ONE_USDC;
        uint256[] memory sharesToRedeem = _depositAndApproveForRedeem(amount);

        // MockRouterVault redeems 1:1, so each leg yields sharesToRedeem[i].
        // Set the second leg's floor one wei above its proceeds → revert.
        uint256[] memory minAssets = new uint256[](2);
        minAssets[0] = 0;
        minAssets[1] = sharesToRedeem[1] + 1;

        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.SlippageExceeded.selector);
        router.redeemFor(
            depositor, depositor, _redeemVaults(), sharesToRedeem, minAssets, type(uint256).max
        );
    }

    /// @notice redeemFor reverts DeadlineExpired when block.timestamp exceeds the
    ///         supplied deadline, and the floor/deadline both pass at-or-above the
    ///         floor before the deadline (happy path settles).
    function test_redeemFor_revertsWhenDeadlineExpired_succeedsBeforeDeadline() public {
        uint256 amount = 1000 * ONE_USDC;
        uint256[] memory sharesToRedeem = _depositAndApproveForRedeem(amount);

        // Move time forward so a past deadline is unambiguously expired.
        vm.warp(1_000_000);
        uint256[] memory minAssets = new uint256[](2); // zero floors

        // Expired deadline → revert before any redemption.
        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.DeadlineExpired.selector);
        router.redeemFor(
            depositor, depositor, _redeemVaults(), sharesToRedeem, minAssets, block.timestamp - 1
        );

        // At-or-above floor, before deadline → succeeds.
        // Floor exactly equals 1:1 proceeds; deadline is in the future.
        minAssets[0] = sharesToRedeem[0];
        minAssets[1] = sharesToRedeem[1];
        vm.prank(depositor);
        uint256[] memory assetsOut = router.redeemFor(
            depositor, depositor, _redeemVaults(), sharesToRedeem, minAssets, block.timestamp + 60
        );
        assertEq(assetsOut[0], sharesToRedeem[0], "leg 0 proceeds at floor");
        assertEq(assetsOut[1], sharesToRedeem[1], "leg 1 proceeds at floor");
        assertEq(usdc.balanceOf(depositor), amount, "depositor received full USDC");
    }

    /// @notice redeemFor reverts RedeemVaultsLengthMismatch when the floor array
    ///         length does not match the explicit `vaults[]` leg count.
    function test_redeemFor_revertsOnMinAssetsLengthMismatch() public {
        uint256 amount = 1000 * ONE_USDC;
        uint256[] memory sharesToRedeem = _depositAndApproveForRedeem(amount);

        uint256[] memory badLenFloor = new uint256[](1); // should be length 2

        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.RedeemVaultsLengthMismatch.selector);
        router.redeemFor(
            depositor, depositor, _redeemVaults(), sharesToRedeem, badLenFloor, type(uint256).max
        );
    }

    // ─── #967: explicit vaults[] exit semantics (F-02, F-03, NC-5) ─────────────

    /// @notice redeemFor drives legs from the explicit `vaults[]` argument, not
    ///         the live weight vector (F-03). After a full reweight onto vaultC,
    ///         the holder still exits vaultA/vaultB by naming them.
    function test_redeemFor_drivesLegsFromExplicitVaults_notWeightVector() public {
        uint256 amount = 1000 * ONE_USDC;
        uint256[] memory sharesToRedeem = _depositAndApproveForRedeem(amount);

        // Register + make vaultC eligible, then reweight the router 100% onto it
        // - a vault the holder never held.
        vm.startPrank(admin);
        registry.registerVault(address(vaultC), metaC);
        registry.setRouterEligible(address(vaultC), true);
        vm.stopPrank();
        address[] memory cw = new address[](1);
        uint256[] memory cbps = new uint256[](1);
        cw[0] = address(vaultC);
        cbps[0] = 10_000;
        vm.prank(admin);
        router.setWeights(cw, cbps);

        vm.prank(depositor);
        uint256[] memory assetsOut = router.redeemFor(
            depositor,
            depositor,
            _redeemVaults(),
            sharesToRedeem,
            new uint256[](2),
            type(uint256).max
        );
        assertEq(assetsOut[0], sharesToRedeem[0], "vaultA leg redeemed by name");
        assertEq(assetsOut[1], sharesToRedeem[1], "vaultB leg redeemed by name");
        assertEq(vaultA.balanceOf(depositor), 0, "vaultA emptied");
        assertEq(vaultB.balanceOf(depositor), 0, "vaultB emptied");
    }

    /// @notice redeemFor permits redeeming from a Retired vault (F-02): Retired
    ///         is withdraw-only, so the exit path must still succeed.
    function test_redeemFor_redeemsFromRetiredVault() public {
        uint256 amount = 1000 * ONE_USDC;
        uint256[] memory sharesToRedeem = _depositAndApproveForRedeem(amount);

        // Retire vaultA in the registry.
        vm.prank(admin);
        registry.setVaultStatus(address(vaultA), VaultRegistry.VaultStatus.Retired);

        vm.prank(depositor);
        uint256[] memory assetsOut = router.redeemFor(
            depositor,
            depositor,
            _redeemVaults(),
            sharesToRedeem,
            new uint256[](2),
            type(uint256).max
        );
        assertEq(assetsOut[0], sharesToRedeem[0], "Retired vaultA still redeemable");
        assertEq(assetsOut[1], sharesToRedeem[1], "Active vaultB redeemable");
    }

    /// @notice redeemFor reverts VaultPausedForRedeem when a named leg is Paused
    ///         (F-02): only Paused blocks the exit path.
    function test_redeemFor_revertsWhenLegPaused() public {
        uint256 amount = 1000 * ONE_USDC;
        uint256[] memory sharesToRedeem = _depositAndApproveForRedeem(amount);

        vm.prank(admin);
        registry.setVaultStatus(address(vaultA), VaultRegistry.VaultStatus.Paused);

        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.VaultPausedForRedeem.selector, address(vaultA))
        );
        router.redeemFor(
            depositor,
            depositor,
            _redeemVaults(),
            sharesToRedeem,
            new uint256[](2),
            type(uint256).max
        );
    }

    /// @notice redeemFor reverts RedeemVaultNotRegistered when a named vault is
    ///         not registered in the VaultRegistry.
    function test_redeemFor_revertsOnUnregisteredVault() public {
        uint256 amount = 1000 * ONE_USDC;
        uint256[] memory sharesToRedeem = _depositAndApproveForRedeem(amount);

        address bogus = makeAddr("unregisteredVault");
        address[] memory vaults = new address[](2);
        vaults[0] = bogus;
        vaults[1] = address(vaultB);

        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.RedeemVaultNotRegistered.selector, bogus)
        );
        router.redeemFor(
            depositor, depositor, vaults, sharesToRedeem, new uint256[](2), type(uint256).max
        );
    }

    /// @notice redeemFor reverts RedeemVaultsLengthMismatch when the shares array
    ///         length does not match the explicit `vaults[]`.
    function test_redeemFor_revertsOnSharesLengthMismatch() public {
        uint256 amount = 1000 * ONE_USDC;
        _depositAndApproveForRedeem(amount);

        uint256[] memory badShares = new uint256[](1); // should be length 2
        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.RedeemVaultsLengthMismatch.selector);
        router.redeemFor(
            depositor, depositor, _redeemVaults(), badShares, new uint256[](2), type(uint256).max
        );
    }

    // ─── L-10: last-admin floor ────────────────────────────────────────────────

    /// @notice The sole ADMIN_ROLE holder cannot renounceRole itself to an admin
    ///         count of zero (LastAdminFloor), and cannot revokeRole itself
    ///         either; after first granting a second admin, the old admin can be
    ///         dropped (floor only blocks the LAST admin).
    function test_lastAdminFloor_router_cannotDropSoleAdmin() public {
        bytes32 adminRole = router.ADMIN_ROLE();
        assertEq(router.getRoleMemberCount(adminRole), 1, "expected a single admin");

        // renounce by the sole admin → reverts.
        vm.prank(admin);
        vm.expectRevert(AdminFloorAccessControl.LastAdminFloor.selector);
        router.renounceRole(adminRole, admin);

        // revoke the sole admin (admin is also the role-admin) → reverts.
        vm.prank(admin);
        vm.expectRevert(AdminFloorAccessControl.LastAdminFloor.selector);
        router.revokeRole(adminRole, admin);

        // Grant a second admin, then the original can be removed.
        address admin2 = makeAddr("admin2");
        vm.prank(admin);
        router.grantRole(adminRole, admin2);
        vm.prank(admin2);
        router.revokeRole(adminRole, admin);
        assertEq(router.getRoleMemberCount(adminRole), 1, "second admin remains");
        assertTrue(router.hasRole(adminRole, admin2), "admin2 retains the role");
    }

    /// @notice With no proposal ever passed (voted vector inactive), the router
    ///         previews and routes by the default weight vector. ADR-0002.
    function test_previewDeposit_uses_defaultWeights_when_no_proposal() public {
        _setDefaultWeights();
        assertFalse(router.votedWeightsActive(), "voted vector must be inactive");

        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(1_000e6);
        assertEq(legs.length, 2);
        assertEq(legs[0].vault, address(vaultA));
        assertEq(legs[0].weightBps, 6_000);
        assertEq(legs[0].legAmount, 600e6);
        assertEq(legs[1].weightBps, 4_000);
        assertEq(legs[1].legAmount, 400e6);

        // Effective weights echo the default vector.
        (address[] memory eV, uint256[] memory eB) = router.getEffectiveWeights();
        assertEq(eV.length, 2);
        assertEq(eB[0], 6_000);
        assertEq(eB[1], 4_000);

        // A real deposit splits by the default vector too.
        _fundAndApprove(depositor, 1_000e6);
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(1_000e6, new uint256[](0));
        assertEq(shares[0], 600e6);
        assertEq(shares[1], 400e6);
    }

    /// @notice After the voted vector is cleared (simulating a fall-back to
    ///         default after the most recent proposal failed quorum), the
    ///         router previews by the default vector again. ADR-0002.
    function test_previewDeposit_uses_defaultWeights_after_failed_quorum() public {
        _setDefaultWeights();

        // A prior proposal had passed and set a 50/50 voted vector...
        _setEqualWeights();
        assertTrue(router.votedWeightsActive());

        // ...then governance reverts to default after a failed-quorum window.
        vm.prank(admin);
        router.clearVotedWeights();
        assertFalse(router.votedWeightsActive());

        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(1_000e6);
        assertEq(legs[0].weightBps, 6_000);
        assertEq(legs[1].weightBps, 4_000);
    }

    /// @notice A passed vote overrides the default; defaultWeights storage is
    ///         unchanged; clearing the voted vector reverts to default. ADR-0002.
    function test_voted_weights_override_defaults_then_revert_to_defaults() public {
        _setDefaultWeights();

        // Vote passes -> voted 50/50 overrides the default.
        _setEqualWeights();
        assertTrue(router.votedWeightsActive());
        (, uint256[] memory effBps) = router.getEffectiveWeights();
        assertEq(effBps[0], 5_000);
        assertEq(effBps[1], 5_000);

        // defaultWeights storage is untouched by the vote.
        (, uint256[] memory defBps) = router.getDefaultWeights();
        assertEq(defBps[0], 6_000);
        assertEq(defBps[1], 4_000);

        // Revert to default.
        vm.prank(admin);
        router.clearVotedWeights();
        (, uint256[] memory backBps) = router.getEffectiveWeights();
        assertEq(backBps[0], 6_000);
        assertEq(backBps[1], 4_000);
    }
}
