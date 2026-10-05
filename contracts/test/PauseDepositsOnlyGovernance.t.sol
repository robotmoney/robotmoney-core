// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §11.1 — users can always withdraw; a pause stops new deposits only
// Canonical: docs/technical/security-model.md §4 — EMERGENCY pauses, ADMIN (timelock) unpauses
// Implements: core 1494 — owner decision 2026-10-05: a vault pause stops new deposits only.
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {SafeFixture} from "./helpers/SafeFixture.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {NoYieldTestAdapter} from "./helpers/NoYieldTestAdapter.sol";
import {ISafe} from "./SafeIntegration.t.sol";
import {BasketVaultHarness, MockPool, MockSwapRouter} from "./BasketVault.t.sol";

/// @title PauseDepositsOnlyGovernanceTest
/// @notice A pause stops new deposits only, on the governance topology we ship. The
///         production `DeployTimelock` handover moves ADMIN_ROLE on rmUSDC and on a basket
///         vault to the timelock and EMERGENCY_ROLE to the emergency key. The emergency key
///         pauses. Holders redeem the correct assets while paused. Only the timelock can
///         unpause, driven by a real 2-of-3 Safe 1.4.1 through `execTransaction` with two
///         owner signatures, at the 172800 s (48 h) production delay. No stub Safe and no
///         pranked Safe: every Safe call carries real owner signatures.
contract PauseDepositsOnlyGovernanceTest is SafeFixture {
    uint256 internal constant ONE_USDC = 1e6;
    /// @dev The Base mainnet floor DeployTimelock enforces (security-model.md §4).
    uint256 internal constant MIN_DELAY = 172_800;

    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    TestERC20 internal usdc;
    TestERC20 internal basketToken;
    MockSwapRouter internal swapRouter;
    RobotMoneyVault internal vault;
    BasketVaultHarness internal basket;
    RobotMoneyGateway internal gateway;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    DeployTimelock.Deployed internal d;
    ISafe internal safe;

    address internal emergency = makeAddr("emergency");
    address internal pauser = makeAddr("pauser");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        usdc = new TestERC20();
        DeployTimelock script = new DeployTimelock();
        address deployer = address(script);
        _installSafeSet();
        safe = ISafe(_newDefaultSafe());

        // rmUSDC with one no-yield adapter, built while the deployer holds every role.
        vault = new RobotMoneyVault(
            usdc,
            type(uint256).max,
            type(uint256).max,
            0,
            makeAddr("feeRecipient"),
            deployer,
            deployer
        );
        NoYieldTestAdapter adapter = new NoYieldTestAdapter(address(usdc), address(vault));
        vm.startPrank(deployer);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAdapter(address(adapter), 10_000);
        vm.stopPrank();

        // A basket vault with one V3 asset priced 1:1 by its pool TWAP.
        basketToken = new TestERC20();
        swapRouter = new MockSwapRouter();
        MockPool pool = new MockPool(address(basketToken), address(usdc), uint160(1 << 96));
        basket = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(swapRouter)), deployer, deployer
        );
        vm.prank(deployer);
        basket.addAsset(address(basketToken), address(pool), 500, address(0), BasketVault.Venue.V3);

        gateway = new RobotMoneyGateway(usdc, vault, deployer, pauser, address(0));
        registry = new VaultRegistry(deployer);
        router = new PortfolioRouter(address(usdc), address(registry), deployer);
        RouterGovernance governance =
            new RouterGovernance(address(router), deployer, 7 days, 1 days, 2);
        vm.prank(deployer);
        router.grantRole(ADMIN_ROLE, address(governance));

        address[] memory vaults = new address[](2);
        vaults[0] = address(vault);
        vaults[1] = address(basket);
        vm.prank(deployer);
        d = script.runInProcessVaults(
            vaults,
            address(gateway),
            address(registry),
            address(router),
            address(governance),
            address(safe),
            emergency,
            MIN_DELAY,
            _fixtureSpec()
        );
    }

    // ─── rmUSDC ───────────────────────────────────────────────────────────────

    /// @notice Pause, redeem and withdraw while paused, then unpause through the Safe.
    function test_rmUSDC_pauseThenRedeem_thenSafeUnpause() public {
        uint256 amount = 1_000 * ONE_USDC;
        uint256 aliceShares = _depositRmUsdc(alice, amount);
        _depositRmUsdc(bob, amount);

        vm.prank(emergency);
        vault.pause();
        assertTrue(vault.paused(), "paused");
        assertFalse(vault.withdrawalsPaused(), "pause never freezes exits");

        // Deposits stop.
        usdc.mint(bob, amount);
        vm.startPrank(bob);
        usdc.approve(address(vault), amount);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, bob, amount, 0)
        );
        vault.deposit(amount, bob);
        vm.stopPrank();

        // Exits stay open and pay the full position.
        assertEq(vault.maxRedeem(alice), aliceShares, "maxRedeem is the full balance");
        vm.prank(alice);
        uint256 out = vault.redeem(aliceShares, alice, alice);
        assertEq(out, amount, "alice redeems her deposit while paused");
        assertEq(usdc.balanceOf(alice), out, "alice holds the USDC");
        uint256 bobMax = vault.maxWithdraw(bob);
        assertEq(bobMax, amount, "maxWithdraw is the full position");
        vm.prank(bob);
        vault.withdraw(bobMax, bob, bob);
        assertEq(vault.balanceOf(bob), 0, "bob withdrew his position while paused");

        // The emergency key cannot unpause.
        vm.prank(emergency);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, emergency, ADMIN_ROLE
            )
        );
        vault.unpause();

        _unpauseThroughSafe(address(vault), abi.encodeCall(RobotMoneyVault.unpause, ()), "rm");

        assertFalse(vault.paused(), "unpaused by the timelock");
        usdc.mint(bob, amount);
        vm.startPrank(bob);
        usdc.approve(address(vault), amount);
        assertGt(vault.deposit(amount, bob), 0, "deposits restored after the Safe unpause");
        vm.stopPrank();
    }

    /// @notice `emergencyWithdraw` halts deposits only; the Safe unpause reopens them.
    function test_rmUSDC_emergencyWithdraw_thenRedeem_thenSafeUnpause() public {
        uint256 amount = 1_000 * ONE_USDC;
        uint256 aliceShares = _depositRmUsdc(alice, amount);

        vm.prank(emergency);
        vault.emergencyWithdraw();
        assertTrue(vault.depositsPaused(), "deposits halted");
        assertEq(vault.maxDeposit(bob), 0, "maxDeposit 0");

        vm.prank(alice);
        assertEq(vault.redeem(aliceShares, alice, alice), amount, "redeem after emergencyWithdraw");

        _unpauseThroughSafe(address(vault), abi.encodeCall(RobotMoneyVault.unpause, ()), "rm-ew");
        assertFalse(vault.depositsPaused(), "deposits reopened by the timelock");
    }

    // ─── Basket vault ─────────────────────────────────────────────────────────

    /// @notice Pause, redeem while paused, then unpause through the Safe.
    function test_basket_pauseThenRedeem_thenSafeUnpause() public {
        uint256 shares = _depositBasket(alice, 1_000 * ONE_USDC);

        vm.prank(emergency);
        basket.pause();
        assertTrue(basket.paused(), "paused");
        assertEq(basket.maxDeposit(bob), 0, "maxDeposit 0 while paused");

        usdc.mint(bob, 100 * ONE_USDC);
        vm.startPrank(bob);
        usdc.approve(address(basket), 100 * ONE_USDC);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626.ERC4626ExceededMaxDeposit.selector, bob, 100 * ONE_USDC, 0
            )
        );
        basket.deposit(100 * ONE_USDC, bob);
        vm.stopPrank();

        // Redeem stays open. The swap pays 995 USDC, above the 1% TWAP floor; no exit fee.
        assertEq(basket.maxRedeem(alice), shares, "maxRedeem is the full balance");
        usdc.mint(address(swapRouter), 995 * ONE_USDC);
        swapRouter.setAmountOut(995 * ONE_USDC);
        vm.prank(alice);
        uint256 out = basket.redeem(shares, alice, alice);
        assertEq(out, 995 * ONE_USDC, "redeem pays the swap proceeds while paused");
        assertEq(usdc.balanceOf(alice), out, "alice holds the USDC");

        vm.prank(emergency);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, emergency, ADMIN_ROLE
            )
        );
        basket.unpause();

        _unpauseThroughSafe(address(basket), abi.encodeCall(BasketVault.unpause, ()), "basket");
        assertFalse(basket.paused(), "unpaused by the timelock");
        assertGt(basket.maxDeposit(bob), 0, "deposits restored after the Safe unpause");
    }

    /// @notice `emergencyUnwind` sets only `depositsPaused`. The Safe unpause must clear it
    ///         instead of reverting `ExpectedPause`.
    function test_basket_emergencyUnwind_thenSafeUnpause_reopensDeposits() public {
        _depositBasket(alice, 1_000 * ONE_USDC);
        usdc.mint(address(swapRouter), 995 * ONE_USDC);
        swapRouter.setAmountOut(995 * ONE_USDC);

        vm.prank(emergency);
        basket.emergencyUnwind();
        assertTrue(basket.depositsPaused(), "deposits halted by the unwind");
        assertFalse(basket.paused(), "the unwind does not set the OZ pause");

        _unpauseThroughSafe(address(basket), abi.encodeCall(BasketVault.unpause, ()), "unwind");
        assertFalse(basket.depositsPaused(), "deposits reopened by the timelock");
        assertGt(basket.maxDeposit(bob), 0, "maxDeposit restored");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _depositRmUsdc(address who, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        shares = vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _depositBasket(address who, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(who, amount);
        basketToken.mint(address(swapRouter), amount);
        swapRouter.setAmountOut(amount);
        vm.startPrank(who);
        usdc.approve(address(basket), amount);
        shares = basket.deposit(amount, who);
        vm.stopPrank();
    }

    /// @dev The real unpause route: the Safe schedules on the timelock, execution before
    ///      the delay fails, and the Safe executes after 172800 s.
    function _unpauseThroughSafe(address target, bytes memory data, string memory tag) internal {
        bytes32 salt = keccak256(bytes(tag));
        TimelockController timelock = d.timelock;
        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.schedule, (target, 0, data, bytes32(0), salt, MIN_DELAY)
            ),
            true
        );
        bytes memory exec =
            abi.encodeCall(TimelockController.execute, (target, 0, data, bytes32(0), salt));
        _safeExec(address(timelock), exec, false);
        vm.warp(block.timestamp + MIN_DELAY);
        _safeExec(address(timelock), exec, true);
    }

    /// @dev `execTransaction` signed by two of the three fixture owners, sorted by address.
    ///      `expectOk == false` asserts the Safe refuses (GS013: the inner call reverted).
    function _safeExec(address to, bytes memory data, bool expectOk) internal {
        bytes32 txHash = safe.getTransactionHash(
            to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), safe.nonce()
        );
        (address a1, uint256 k1) = makeAddrAndKey("safe-owner-1");
        (address a2, uint256 k2) = makeAddrAndKey("safe-owner-2");
        (uint256 lo, uint256 hi) = a1 < a2 ? (k1, k2) : (k2, k1);
        bytes memory sigs = bytes.concat(_sign(lo, txHash), _sign(hi, txHash));
        if (!expectOk) vm.expectRevert(bytes("GS013"));
        safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    function _sign(uint256 pk, bytes32 txHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, txHash);
        return abi.encodePacked(r, s, v);
    }
}
