// SPDX-License-Identifier: MIT
// Canonical: none — Foundry unit tests for contracts/adapters/MorphoAdapter.sol
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {MorphoAdapter} from "../adapters/MorphoAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Minimal ERC-4626 mock vault that supports both deposit and withdraw.
///      withdraw() sends `assets` USDC directly to `receiver` (normal behaviour).
contract MockMorphoVault is ERC20 {
    IERC20 public immutable asset;

    constructor(address asset_) ERC20("Mock Morpho Vault", "mmUSDC") {
        asset = IERC20(asset_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        asset.transferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
    }

    /// @dev Standard ERC-4626 withdraw: transfer `assets` USDC to `receiver`, burn shares from `owner`.
    ///      Returns the number of shares burned (NOT the USDC amount).
    function withdraw(uint256 assets, address receiver, address owner)
        external
        virtual
        returns (uint256 shares)
    {
        shares = assets; // 1:1 for simplicity
        _burn(owner, shares);
        asset.transfer(receiver, assets);
    }

    function balanceOf(address account) public view override returns (uint256) {
        return super.balanceOf(account);
    }

    function convertToAssets(uint256 shares_) external pure returns (uint256) {
        return shares_;
    }
}

/// @dev Vault that delivers fewer USDC than requested on withdraw (simulates shortfall).
contract ShortfallMorphoVault is MockMorphoVault {
    uint256 public shortfall; // how many fewer USDC to deliver

    constructor(address asset_, uint256 shortfall_) MockMorphoVault(asset_) {
        shortfall = shortfall_;
    }

    function withdraw(uint256 assets, address receiver, address owner)
        external
        override
        returns (uint256 shares)
    {
        // Clamp to a reasonable amount if type(uint256).max to avoid share burn overflow.
        uint256 effectiveAssets = assets == type(uint256).max ? balanceOf(owner) : assets;
        shares = effectiveAssets;
        _burn(owner, shares);
        // Deliver less than requested to simulate shortfall.
        uint256 actual = effectiveAssets > shortfall ? effectiveAssets - shortfall : 0;
        if (actual > 0) {
            asset.transfer(receiver, actual);
        }
    }
}

contract MorphoAdapterTest is Test {
    TestERC20 internal usdc;
    MockMorphoVault internal morphoVault;
    MorphoAdapter internal adapter;

    address internal vault = makeAddr("vault");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ONE_USDC = 1e6;

    function setUp() public {
        usdc = new TestERC20();
        morphoVault = new MockMorphoVault(address(usdc));
        adapter = new MorphoAdapter(address(morphoVault), address(usdc), vault);
    }

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    function test_constructor_wiresImmutables() public view {
        assertEq(address(adapter.MORPHO_VAULT()), address(morphoVault));
        assertEq(address(adapter.USDC()), address(usdc));
        assertEq(adapter.VAULT(), vault);
    }

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(MorphoAdapter.ZeroAddress.selector);
        new MorphoAdapter(address(0), address(usdc), vault);

        vm.expectRevert(MorphoAdapter.ZeroAddress.selector);
        new MorphoAdapter(address(morphoVault), address(0), vault);

        vm.expectRevert(MorphoAdapter.ZeroAddress.selector);
        new MorphoAdapter(address(morphoVault), address(usdc), address(0));
    }

    // -----------------------------------------------------------------------
    // deploy
    // -----------------------------------------------------------------------

    function test_deploy_movesUsdcIntoMorphoVault() public {
        uint256 amount = 100 * ONE_USDC;
        usdc.mint(vault, amount);
        vm.prank(vault);
        usdc.transfer(address(adapter), amount);

        vm.prank(vault);
        adapter.deploy(amount);

        assertEq(morphoVault.balanceOf(address(adapter)), amount);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    function test_deploy_revertsForNonVault() public {
        vm.prank(stranger);
        vm.expectRevert(MorphoAdapter.OnlyVault.selector);
        adapter.deploy(100 * ONE_USDC);
    }

    // -----------------------------------------------------------------------
    // withdraw — happy path
    // -----------------------------------------------------------------------

    function test_withdraw_happyPath_returnsActualAndCreditsVault() public {
        // Set up: deploy then withdraw
        uint256 amount = 50 * ONE_USDC;
        usdc.mint(vault, amount);
        vm.prank(vault);
        usdc.transfer(address(adapter), amount);
        vm.prank(vault);
        adapter.deploy(amount);

        // Record vault USDC balance before withdrawal.
        uint256 vaultBalBefore = usdc.balanceOf(vault);

        vm.prank(vault);
        uint256 returned = adapter.withdraw(amount);

        uint256 vaultBalAfter = usdc.balanceOf(vault);
        assertEq(returned, amount, "should return actual delivered amount");
        assertEq(vaultBalAfter - vaultBalBefore, amount, "vault should receive exact USDC");
    }

    function test_withdraw_revertsForNonVault() public {
        vm.prank(stranger);
        vm.expectRevert(MorphoAdapter.OnlyVault.selector);
        adapter.withdraw(100 * ONE_USDC);
    }

    // -----------------------------------------------------------------------
    // withdraw — shortfall detection
    // -----------------------------------------------------------------------

    function test_withdraw_revertsOnShortfall() public {
        uint256 amount = 100 * ONE_USDC;
        uint256 shortfall = 1; // deliver 1 wei less than requested

        // Deploy with shortfall vault
        ShortfallMorphoVault shortfallVault = new ShortfallMorphoVault(address(usdc), shortfall);
        MorphoAdapter shortfallAdapter =
            new MorphoAdapter(address(shortfallVault), address(usdc), vault);

        // Fund the shortfall vault directly so it can service withdrawals
        usdc.mint(vault, amount);
        vm.prank(vault);
        usdc.transfer(address(shortfallAdapter), amount);

        // Deposit into the shortfall vault (uses normal MockMorphoVault deposit path)
        // Since ShortfallMorphoVault inherits from MockMorphoVault, deposit works normally.
        vm.prank(vault);
        usdc.approve(address(shortfallVault), amount);
        // The adapter calls safeIncreaseAllowance internally, so we need USDC in adapter first
        usdc.mint(address(shortfallAdapter), amount);
        // Manually mint shares to adapter to simulate a pre-existing position
        deal(address(shortfallVault), address(shortfallAdapter), amount);
        // Fund the vault with enough USDC for the partial payout
        usdc.mint(address(shortfallVault), amount - shortfall);

        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(
                MorphoAdapter.WithdrawShortfall.selector, amount, amount - shortfall
            )
        );
        shortfallAdapter.withdraw(amount);
    }

    function test_withdraw_typeMaxDoesNotRevertOnShortfall() public {
        // When amount == type(uint256).max, shortfall check is skipped (mirrors Aave/Compound).
        uint256 shortfall = 1;
        ShortfallMorphoVault shortfallVault = new ShortfallMorphoVault(address(usdc), shortfall);
        MorphoAdapter shortfallAdapter =
            new MorphoAdapter(address(shortfallVault), address(usdc), vault);

        uint256 shares = 50 * ONE_USDC;
        deal(address(shortfallVault), address(shortfallAdapter), shares);
        usdc.mint(address(shortfallVault), shares - shortfall);

        // type(uint256).max withdraw: shortfall guard is skipped; returns actual.
        vm.prank(vault);
        uint256 actual = shortfallAdapter.withdraw(type(uint256).max);
        // actual = shares - shortfall delivered to vault
        assertEq(actual, shares - shortfall);
    }

    // -----------------------------------------------------------------------
    // totalAssets
    // -----------------------------------------------------------------------

    function test_totalAssets_reflectsDeployedShares() public {
        uint256 amount = 75 * ONE_USDC;
        usdc.mint(vault, amount);
        vm.prank(vault);
        usdc.transfer(address(adapter), amount);
        vm.prank(vault);
        adapter.deploy(amount);

        assertEq(adapter.totalAssets(), amount);
    }

    // -----------------------------------------------------------------------
    // rescueTokens
    // -----------------------------------------------------------------------

    function test_rescueTokens_revertsForProtectedUSDC() public {
        vm.prank(vault);
        vm.expectRevert(MorphoAdapter.CannotRescueProtectedToken.selector);
        adapter.rescueTokens(address(usdc), vault);
    }

    function test_rescueTokens_revertsForProtectedMorphoShares() public {
        vm.prank(vault);
        vm.expectRevert(MorphoAdapter.CannotRescueProtectedToken.selector);
        adapter.rescueTokens(address(morphoVault), vault);
    }

    function test_rescueTokens_revertsOnZeroAddress() public {
        TestERC20 other = new TestERC20();
        vm.prank(vault);
        vm.expectRevert(MorphoAdapter.ZeroAddress.selector);
        adapter.rescueTokens(address(other), address(0));
    }

    function test_rescueTokens_transfersUnprotectedToken() public {
        TestERC20 other = new TestERC20();
        usdc.mint(address(adapter), 10 * ONE_USDC); // put something different in
        other.mint(address(adapter), 5 * ONE_USDC);
        address recipient = makeAddr("recipient");

        vm.prank(vault);
        adapter.rescueTokens(address(other), recipient);

        assertEq(other.balanceOf(recipient), 5 * ONE_USDC);
        assertEq(other.balanceOf(address(adapter)), 0);
    }
}
