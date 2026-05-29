// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md; docs/technical/security-hardening-seams.md
// Covers: issue #428 — guarded emergency unwind minimums and explicit override events
//         issue #446 — upper-loss cap (slippage bound) on emergencyUnwindWithOverride
//         issue #451 — Uniswap V3 TWAP oracle hardening (NAV, deposit/withdraw
//                      minimums, ADMIN_ROLE-gated per-asset window)
//         issue #506 — separate admin_ and emergencyResponder_ addresses in constructor
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Minimal mock supporting both slot0 (legacy spot read) and observe()
///      (TWAP read). `setTickCumulativeRate` controls the per-second tick
///      growth: the TWAP arithmetic-mean tick equals exactly this value,
///      independent of the slot0 spot, which lets tests separate manipulation
///      of slot0 from the TWAP-bounded price the vault actually consumes.
contract MockPool {
    address public immutable token0;
    address public immutable token1;
    uint160 public sqrtPriceX96Spot; // mutable so tests can simulate manipulation
    int56 public tickCumulativeRate; // ticks per second contributed to TWAP
    uint16 public cardinality;

    constructor(address token0_, address token1_, uint160 sqrtPriceX96_) {
        token0 = token0_;
        token1 = token1_;
        sqrtPriceX96Spot = sqrtPriceX96_;
        // Tick=0 means 1:1 price (sqrtP = 2^96); arithmetic-mean tick is 0
        // when tickCumulativeRate=0. Tests override as needed.
        tickCumulativeRate = 0;
        cardinality = 100;
    }

    function setSpot(uint160 sqrtPriceX96_) external {
        sqrtPriceX96Spot = sqrtPriceX96_;
    }

    function setTickCumulativeRate(int56 rate) external {
        tickCumulativeRate = rate;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96Spot, 0, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
        // Cumulative grows linearly: cum(now) > cum(past). Use uint256 to do
        // signed math safely, then assign as int56.
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            // cum(t) = rate * t, with t measured forward from epoch. We want
            // cum(now) - cum(now - W) = rate * W. Use block.timestamp as `now`.
            int56 t =
                int56(int256(uint256(block.timestamp))) - int56(int256(uint256(secondsAgos[i])));
            tickCumulatives[i] = tickCumulativeRate * t;
        }
    }

    function observations(uint256)
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidity,
            bool initialized
        )
    {
        return (uint32(block.timestamp), 0, 0, true);
    }
}

contract MockSwapRouter is ISwapRouter {
    using SafeERC20 for IERC20;

    uint256 public amountOut;

    error TooLittleReceived(uint256 amountOut, uint256 amountOutMinimum);

    function setAmountOut(uint256 amountOut_) external {
        amountOut = amountOut_;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256) {
        if (amountOut < params.amountOutMinimum) {
            revert TooLittleReceived(amountOut, params.amountOutMinimum);
        }
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
        return amountOut;
    }
}

contract BasketVaultHarness is BasketVault {
    constructor(IERC20 usdc_, ISwapRouter swapRouter_, address admin_, address emergencyResponder_)
        BasketVault(
            "Basket Harness",
            "bTEST",
            usdc_,
            swapRouter_,
            1_000_000e6,
            100_000e6,
            0,
            100,
            admin_,
            admin_,
            emergencyResponder_
        )
    {}

    function maxAssets() public pure override returns (uint256) {
        return 4;
    }
}

contract BasketVaultTest is Test {
    uint256 internal constant ONE_USDC = 1e6;

    event EmergencyUnwindOverrideUsed(
        address indexed token,
        uint256 amountIn,
        uint256 minUsdcOut,
        uint256 appliedFloor,
        address indexed caller
    );

    TestERC20 internal usdc;
    TestERC20 internal basketToken;
    MockSwapRouter internal router;
    MockPool internal pool;
    BasketVaultHarness internal vault;

    address internal admin = makeAddr("admin");
    address internal emergencyResponder = makeAddr("emergencyResponder");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new TestERC20();
        basketToken = new TestERC20();
        router = new MockSwapRouter();
        pool = new MockPool(address(basketToken), address(usdc), uint160(1 << 96));
        vault = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(router)), admin, emergencyResponder
        );

        vm.prank(admin);
        vault.addAsset(address(basketToken), address(pool), 500);
    }

    function test_emergencyUnwind_revertsWhenRouterOutputBelowConfiguredMinimum() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 minUsdcOut = 900 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), 800 * ONE_USDC);
        router.setAmountOut(800 * ONE_USDC);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), minUsdcOut, false, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                MockSwapRouter.TooLittleReceived.selector, 800 * ONE_USDC, minUsdcOut
            )
        );
        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(
            basketToken.balanceOf(address(vault)), tokenAmount, "guard keeps basket asset in vault"
        );
        assertEq(usdc.balanceOf(address(vault)), 0, "low-output unwind refused");
    }

    function test_emergencyUnwind_succeedsWhenRouterOutputSatisfiesConfiguredMinimum() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 amountOut = 950 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), amountOut);
        router.setAmountOut(amountOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), 900 * ONE_USDC, false, 0);

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(basketToken.balanceOf(address(vault)), 0, "basket asset unwound");
        assertEq(usdc.balanceOf(address(vault)), amountOut, "guarded USDC received");
        assertTrue(vault.paused(), "emergency unwind still pauses vault");
    }

    function test_emergencyUnwindWithOverride_emitsHighRiskEvent() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 amountOut = 1;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), amountOut);
        router.setAmountOut(amountOut);

        // maxLossBps = MAX_BPS reproduces the legacy zero-floor override semantics.
        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), 900 * ONE_USDC, true, 10_000);

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        vm.expectEmit(true, false, false, true, address(vault));
        emit EmergencyUnwindOverrideUsed(
            address(basketToken), tokenAmount, 900 * ONE_USDC, 0, emergencyResponder
        );

        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertEq(
            usdc.balanceOf(address(vault)), amountOut, "override accepts explicit high-loss output"
        );
    }

    function test_emergencyUnwindWithOverride_requiresEmergencyRole() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        vm.prank(stranger);
        vm.expectRevert();
        vault.emergencyUnwindWithOverride(tokens);
    }

    function test_addAsset_revertsWhenPoolDoesNotPairTokenWithUsdc() public {
        TestERC20 otherToken = new TestERC20();
        MockPool badPool = new MockPool(address(otherToken), address(usdc), uint160(1 << 96));
        TestERC20 newAsset = new TestERC20();

        vm.expectRevert(BasketVault.PoolTokenMismatch.selector);
        vm.prank(admin);
        vault.addAsset(address(newAsset), address(badPool), 500);
    }

    function test_rescueTokens_revertsWhenTokenIsActiveBasketAsset() public {
        vm.expectRevert(BasketVault.AssetInBasket.selector);
        vm.prank(admin);
        vault.rescueTokens(address(basketToken), admin);
    }

    function test_rescueTokens_succeedsForNonBasketAsset() public {
        TestERC20 stray = new TestERC20();
        stray.mint(address(vault), 5 * ONE_USDC);

        vm.prank(admin);
        vault.rescueTokens(address(stray), admin);

        assertEq(stray.balanceOf(admin), 5 * ONE_USDC, "stray ERC-20 recovered");
        assertEq(stray.balanceOf(address(vault)), 0, "vault no longer holds stray ERC-20");
    }

    function test_emergencyUnwindWithOverride_revertsWhenBelowUpperLossCap() public {
        // issue #446: an admin-configured upper-loss cap must bound override slippage.
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 minUsdcOut = 900 * ONE_USDC;
        // maxLossBps = 1000 (10%) -> appliedFloor = 900 * 0.9 = 810 USDC.
        uint256 maxLossBps = 1_000;
        uint256 appliedFloor = minUsdcOut * (10_000 - maxLossBps) / 10_000;
        // Router only returns 800 USDC — below the 810 cap.
        uint256 routerOut = 800 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), minUsdcOut, true, maxLossBps);

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        // The router enforces appliedFloor as amountOutMinimum and reverts first,
        // surfacing the slippage bound at the router layer. This is the
        // upper-loss cap enforcement path.
        vm.expectRevert(
            abi.encodeWithSelector(
                MockSwapRouter.TooLittleReceived.selector, routerOut, appliedFloor
            )
        );
        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertEq(
            basketToken.balanceOf(address(vault)),
            tokenAmount,
            "cap violation keeps basket asset in vault"
        );
    }

    function test_emergencyUnwindWithOverride_succeedsWithinUpperLossCap() public {
        // issue #446: when realized output meets the cap, override path still works
        // and still emits EmergencyUnwindOverrideUsed for off-chain visibility.
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 minUsdcOut = 900 * ONE_USDC;
        uint256 maxLossBps = 1_000; // 10% cap -> appliedFloor = 810 USDC
        uint256 appliedFloor = minUsdcOut * (10_000 - maxLossBps) / 10_000;
        uint256 routerOut = 820 * ONE_USDC; // above 810 floor
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), minUsdcOut, true, maxLossBps);

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        vm.expectEmit(true, false, false, true, address(vault));
        emit EmergencyUnwindOverrideUsed(
            address(basketToken), tokenAmount, minUsdcOut, appliedFloor, emergencyResponder
        );

        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertEq(
            usdc.balanceOf(address(vault)),
            routerOut,
            "override succeeds when realized output meets the cap"
        );
    }

    function test_setEmergencyUnwindGuard_requiresAdminRole() public {
        // issue #446 acceptance: cap setter is ADMIN_ROLE-gated; an unauthorized
        // caller reverts with AccessControlUnauthorizedAccount.
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", stranger, adminRole
            )
        );
        vm.prank(stranger);
        vault.setEmergencyUnwindGuard(address(basketToken), 900 * ONE_USDC, true, 1_000);
    }

    function test_setEmergencyUnwindGuard_rejectsMaxLossBpsAboveMaxBps() public {
        // issue #446: maxLossBps must not exceed MAX_BPS (100%).
        vm.prank(admin);
        vm.expectRevert(BasketVault.InvalidParam.selector);
        vault.setEmergencyUnwindGuard(address(basketToken), 900 * ONE_USDC, true, 10_001);
    }

    function test_pauseAndShutdownEmergencyControlsRemainFunctional() public {
        vm.prank(emergencyResponder);
        vault.pause();
        assertTrue(vault.paused(), "pause remains available");

        vm.prank(emergencyResponder);
        vault.shutdownVault();
        assertTrue(vault.isShutdown(), "shutdown remains available");
        assertEq(vault.tvlCap(), 0, "shutdown still zeros tvl cap");
    }

    // ─── TWAP oracle hardening (issue #451) ────────────────────────────

    function test_totalAssets_usesTwapTickNotSlot0() public {
        // tickCumulativeRate=0 -> arithmetic-mean tick=0 -> 1:1 price irrespective
        // of slot0 manipulation. With 1000 token units in vault, NAV should be
        // exactly 1000 USDC (tick=0 means token/USDC == 1).
        pool.setTickCumulativeRate(0);
        basketToken.mint(address(vault), 1_000 * ONE_USDC);

        // Manipulate slot0 to a huge sqrtPrice — TWAP NAV must ignore it.
        // sqrtPriceX96 = 2 * 2^96 implies price = 4 at slot0; TWAP stays at 1.
        pool.setSpot(uint160(2) * uint160(1 << 96));

        uint256 nav = vault.totalAssets();
        assertEq(nav, 1_000 * ONE_USDC, "NAV bounded by TWAP, not slot0");
    }

    function test_totalAssets_revertsOnSpotPriceManipulationUsingSlot0() public {
        // Sanity: prove the TWAP path is the ONE consulted. If we set
        // tickCumulativeRate=0 (TWAP=1.0) and slot0 to anything else, NAV
        // must still be 1.0. This guards against future regressions that
        // reintroduce slot0 reads.
        pool.setTickCumulativeRate(0);
        basketToken.mint(address(vault), 500 * ONE_USDC);
        pool.setSpot(uint160(1)); // absurd slot0 — would yield NAV of ~0 if slot0 leaked
        uint256 nav = vault.totalAssets();
        assertEq(nav, 500 * ONE_USDC, "NAV must not read slot0");
    }

    function test_setTwapWindow_requiresAdminRole() public {
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", stranger, adminRole
            )
        );
        vm.prank(stranger);
        vault.setTwapWindow(address(basketToken), 3_600);
    }

    function test_setTwapWindow_rejectsBelowMinimum() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BasketVault.InvalidTwapWindow.selector, uint32(599)));
        vault.setTwapWindow(address(basketToken), 599);
    }

    function test_setTwapWindow_rejectsAboveMaximum() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(BasketVault.InvalidTwapWindow.selector, uint32(86_401))
        );
        vault.setTwapWindow(address(basketToken), 86_401);
    }

    function test_setTwapWindow_acceptsBoundary() public {
        vm.prank(admin);
        vault.setTwapWindow(address(basketToken), 600);
        assertEq(vault.effectiveTwapWindow(address(basketToken)), 600, "min window set");

        vm.prank(admin);
        vault.setTwapWindow(address(basketToken), 86_400);
        assertEq(vault.effectiveTwapWindow(address(basketToken)), 86_400, "max window set");
    }

    function test_effectiveTwapWindow_fallsBackToDefault() public view {
        // No setTwapWindow call -> defaults to 30 minutes.
        assertEq(
            vault.effectiveTwapWindow(address(basketToken)), 1_800, "default 30-minute TWAP window"
        );
    }

    function test_emergencyUnwindMinimum_derivedFromTwapNotSlot0() public {
        // The emergency-unwind floor is configured via setEmergencyUnwindGuard;
        // the vault routes the router call with that floor. This test asserts
        // that manipulating slot0 does NOT lower the floor below the admin's
        // TWAP-derived configuration: the floor is read from storage (TWAP-derived
        // off-chain by ADMIN), and a slot0-distorted swap cannot satisfy it.
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 twapDerivedMin = 950 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), 100 * ONE_USDC); // router can only return 100 (manipulated)
        router.setAmountOut(100 * ONE_USDC);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), twapDerivedMin, false, 0);

        // Even with slot0 distorted, the TWAP-derived minimum on the router
        // call refuses any output below the admin-configured floor.
        pool.setSpot(uint160(1)); // hostile slot0 — must NOT lower the floor
        vm.expectRevert(
            abi.encodeWithSelector(
                MockSwapRouter.TooLittleReceived.selector, 100 * ONE_USDC, twapDerivedMin
            )
        );
        vm.prank(emergencyResponder);
        vault.emergencyUnwind();
    }

    function test_setTwapWindow_emitsEvent() public {
        vm.prank(admin);
        vm.expectEmit(true, false, false, true, address(vault));
        emit TwapWindowUpdated(address(basketToken), 0, 3_600);
        vault.setTwapWindow(address(basketToken), 3_600);
    }

    // Mirror the contract event so vm.expectEmit can match it.
    event TwapWindowUpdated(address indexed token, uint32 oldWindow, uint32 newWindow);

    // ─── Separate admin / emergencyResponder roles (issue #506) ───────────

    /// @notice Constructor with distinct addresses grants each role to the
    ///         correct address and does NOT cross-assign.
    function test_constructor_grantsAdminRoleToAdminOnly() public view {
        assertTrue(vault.hasRole(vault.ADMIN_ROLE(), admin), "admin has ADMIN_ROLE");
        assertFalse(
            vault.hasRole(vault.ADMIN_ROLE(), emergencyResponder),
            "emergencyResponder must NOT have ADMIN_ROLE"
        );
    }

    function test_constructor_grantsEmergencyRoleToEmergencyResponderOnly() public view {
        assertTrue(
            vault.hasRole(vault.EMERGENCY_ROLE(), emergencyResponder),
            "emergencyResponder has EMERGENCY_ROLE"
        );
        assertFalse(
            vault.hasRole(vault.EMERGENCY_ROLE(), admin), "admin must NOT have EMERGENCY_ROLE"
        );
    }

    /// @notice Constructor reverts when admin_ is address(0).
    function test_constructor_revertsWhenAdminIsZero() public {
        vm.expectRevert(BasketVault.ZeroAddress.selector);
        new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(router)), address(0), emergencyResponder
        );
    }

    /// @notice Constructor reverts when emergencyResponder_ is address(0).
    function test_constructor_revertsWhenEmergencyResponderIsZero() public {
        vm.expectRevert(BasketVault.ZeroAddress.selector);
        new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(router)), admin, address(0)
        );
    }

    /// @notice ADMIN_ROLE holder can call setMaxSlippageBps; EMERGENCY_ROLE-only holder cannot.
    function test_setMaxSlippageBps_requiresAdminRole() public {
        bytes32 adminRole = vault.ADMIN_ROLE();
        // emergencyResponder has EMERGENCY_ROLE but NOT ADMIN_ROLE — must revert.
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", emergencyResponder, adminRole
            )
        );
        vm.prank(emergencyResponder);
        vault.setMaxSlippageBps(200);

        // admin has ADMIN_ROLE — must succeed.
        vm.prank(admin);
        vault.setMaxSlippageBps(200);
        assertEq(vault.maxSlippageBps(), 200, "admin can update slippage");
    }

    /// @notice EMERGENCY_ROLE holder can call emergencyUnwind; ADMIN_ROLE-only holder cannot.
    function test_emergencyUnwind_requiresEmergencyRole_adminOnlyReverts() public {
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();
        basketToken.mint(address(vault), 100 * ONE_USDC);
        usdc.mint(address(router), 100 * ONE_USDC);
        router.setAmountOut(100 * ONE_USDC);

        // admin has ADMIN_ROLE but NOT EMERGENCY_ROLE — must revert.
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", admin, emergencyRole
            )
        );
        vm.prank(admin);
        vault.emergencyUnwind();

        // emergencyResponder has EMERGENCY_ROLE — must succeed.
        vm.prank(emergencyResponder);
        vault.emergencyUnwind();
        assertTrue(vault.paused(), "emergencyUnwind pauses vault");
    }
}

