// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md; docs/technical/security-hardening-seams.md
// Covers: issue #428 — guarded emergency unwind minimums and explicit override events
//         issue #446 — upper-loss cap (slippage bound) on emergencyUnwindWithOverride
//         issue #451 — Uniswap V3 TWAP oracle hardening (NAV, deposit/withdraw
//                      minimums, ADMIN_ROLE-gated per-asset window)
//         issue #493 — emergencyUnwind reverts when vault is already paused
//         issue #494 — addAsset must verify Uniswap V3 pool observation cardinality
//         issue #501 — replace safeIncreaseAllowance with forceApprove/clear pattern
//         issue #506 — separate admin_ and emergencyResponder_ addresses in constructor
//         issue #508 — emergencyUnwind uses live TWAP floor instead of stale minUsdcOut
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

    function setCardinality(uint16 cardinality_) external {
        cardinality = cardinality_;
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

        // TWAP floor (tick=0, 1:1 price, 1% slippage): 1000 * 9900 / 10000 = 990 USDC.
        // effectiveFloor = max(TWAP=990, configured=900) = 990. Router output 800 < 990.
        uint256 twapFloor = tokenAmount * (10_000 - 100) / 10_000; // 990 USDC
        vm.expectRevert(
            abi.encodeWithSelector(
                MockSwapRouter.TooLittleReceived.selector, 800 * ONE_USDC, twapFloor
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
        // TWAP floor = 1000 * 9900 / 10000 = 990 USDC. Use 995 to satisfy both floors.
        uint256 amountOut = 995 * ONE_USDC;
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
        // TWAP floor (tick=0, 1:1, 1% slippage) = 990 USDC, which exceeds configFloor=0 (maxLossBps=10000).
        // effectiveFloor = max(990, 0) = 990. Use amountOut ≥ 990 to satisfy the TWAP floor.
        uint256 amountOut = 995 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), amountOut);
        router.setAmountOut(amountOut);

        // maxLossBps = MAX_BPS reproduces the legacy zero configured-floor override semantics;
        // the live TWAP floor still applies as the active guard.
        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), 900 * ONE_USDC, true, 10_000);

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        uint256 twapFloor = tokenAmount * (10_000 - 100) / 10_000; // 990 USDC
        vm.expectEmit(true, false, false, true, address(vault));
        emit EmergencyUnwindOverrideUsed(
            address(basketToken), tokenAmount, 900 * ONE_USDC, twapFloor, emergencyResponder
        );

        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertEq(
            usdc.balanceOf(address(vault)), amountOut, "override accepts output above TWAP floor"
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
        // maxLossBps = 1000 (10%) -> configFloor = 900 * 0.9 = 810 USDC.
        uint256 maxLossBps = 1_000;
        // TWAP floor (tick=0, 1:1, 1% slippage) = 990 USDC > configFloor 810.
        // effectiveFloor = max(990, 810) = 990.
        uint256 twapFloor = tokenAmount * (10_000 - 100) / 10_000; // 990 USDC
        // Router only returns 800 USDC — below both the TWAP floor and configured cap.
        uint256 routerOut = 800 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), minUsdcOut, true, maxLossBps);

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        // The router enforces effectiveFloor (TWAP-derived, higher than configFloor) and reverts.
        vm.expectRevert(
            abi.encodeWithSelector(MockSwapRouter.TooLittleReceived.selector, routerOut, twapFloor)
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
        // issue #446: when realized output meets both the configured cap and the TWAP floor,
        // override path still works and emits EmergencyUnwindOverrideUsed for off-chain visibility.
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 minUsdcOut = 900 * ONE_USDC;
        uint256 maxLossBps = 1_000; // 10% cap -> configFloor = 810 USDC
        // TWAP floor (tick=0, 1:1, 1% slippage) = 990 USDC > configFloor 810.
        // effectiveFloor = max(990, 810) = 990.
        uint256 twapFloor = tokenAmount * (10_000 - 100) / 10_000; // 990 USDC
        uint256 routerOut = 995 * ONE_USDC; // above both floors
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), minUsdcOut, true, maxLossBps);

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        vm.expectEmit(true, false, false, true, address(vault));
        emit EmergencyUnwindOverrideUsed(
            address(basketToken), tokenAmount, minUsdcOut, twapFloor, emergencyResponder
        );

        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertEq(
            usdc.balanceOf(address(vault)),
            routerOut,
            "override succeeds when realized output meets both TWAP and configured floors"
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
        // The emergency-unwind floor is now computed on-chain from the live TWAP, so slot0
        // manipulation cannot lower it. This test verifies that even with a hostile slot0,
        // the TWAP-derived floor (tick=0, 1:1 price, 1% slippage → 990 USDC for 1000 tokens)
        // still rejects a router output of 100 USDC.
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 twapDerivedMin = 950 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), 100 * ONE_USDC); // router can only return 100 (manipulated)
        router.setAmountOut(100 * ONE_USDC);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), twapDerivedMin, false, 0);

        // Distort slot0 to an absurd value — the vault must use the TWAP (tick=0 = 1:1)
        // and NOT slot0. effectiveFloor = max(TWAP=990, configured=950) = 990.
        pool.setSpot(uint160(1)); // hostile slot0 — must NOT lower the floor
        uint256 liveTwapFloor = tokenAmount * (10_000 - 100) / 10_000; // 990 USDC
        vm.expectRevert(
            abi.encodeWithSelector(
                MockSwapRouter.TooLittleReceived.selector, 100 * ONE_USDC, liveTwapFloor
            )
        );
        vm.prank(emergencyResponder);
        vault.emergencyUnwind();
    }

    // ─── Live TWAP floor in emergencyUnwind (issue #508) ─────────────

    /// @notice When minUsdcOut is stale (far below TWAP), emergencyUnwind uses the
    ///         live TWAP-derived floor and rejects a swap that only satisfies the
    ///         stale configured floor.
    function test_emergencyUnwind_staleFloor_usesTwapFloor() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        // Stale configured minimum — far below current fair value (tick=0 → 1:1 price).
        uint256 staleMin = 500 * ONE_USDC;
        // TWAP floor (1:1 TWAP, 1% maxSlippageBps): 1000 * 9900 / 10000 = 990 USDC.
        uint256 twapFloor = tokenAmount * (10_000 - 100) / 10_000; // 990 USDC

        // Router can only return 800 USDC — satisfies stale floor (500) but NOT the TWAP floor (990).
        uint256 routerOut = 800 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), staleMin, false, 0);

        // The live TWAP floor (990) wins over the stale configured floor (500).
        // effectiveFloor = max(990, 500) = 990. Router output 800 < 990 → revert.
        vm.expectRevert(
            abi.encodeWithSelector(MockSwapRouter.TooLittleReceived.selector, routerOut, twapFloor)
        );
        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(
            basketToken.balanceOf(address(vault)), tokenAmount, "stale floor cannot be exploited"
        );
        assertEq(usdc.balanceOf(address(vault)), 0, "no USDC extracted via stale floor");
    }

    /// @notice When minUsdcOut is above the TWAP-derived floor, the configured floor wins
    ///         (max semantics). Attempting a swap at the TWAP-only level must revert.
    function test_emergencyUnwind_configuredFloorAboveTwap_configuredFloorWins() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        // TWAP floor (1:1 TWAP, 1% slippage) = 990 USDC.
        // Configured min is set higher than the TWAP floor.
        uint256 highMin = 995 * ONE_USDC;

        // Router output satisfies TWAP floor (990) but NOT the configured floor (995).
        uint256 routerOut = 993 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), highMin, false, 0);

        // effectiveFloor = max(TWAP=990, configured=995) = 995. Router output 993 < 995 → revert.
        vm.expectRevert(
            abi.encodeWithSelector(MockSwapRouter.TooLittleReceived.selector, routerOut, highMin)
        );
        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(
            basketToken.balanceOf(address(vault)), tokenAmount, "configured floor rejects swap"
        );
    }

    /// @notice When a swap satisfies both the TWAP floor and the configured floor, the
    ///         emergency unwind completes successfully.
    function test_emergencyUnwind_bothFloorsSatisfied_succeeds() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        // TWAP floor = 990 USDC. Configured min also below 990. Router out = 995 satisfies both.
        uint256 configuredMin = 900 * ONE_USDC;
        uint256 routerOut = 995 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), configuredMin, false, 0);

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(basketToken.balanceOf(address(vault)), 0, "all tokens swapped");
        assertEq(usdc.balanceOf(address(vault)), routerOut, "USDC received");
        assertTrue(vault.paused(), "vault paused after unwind");
    }

    /// @notice emergencyUnwindWithOverride also applies the TWAP floor as a secondary
    ///         check alongside the configured appliedFloor. A swap below the TWAP floor
    ///         is rejected even when maxLossBps is generous.
    function test_emergencyUnwindWithOverride_twapFloorAppliedAsSecondaryCheck() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        // Configured guard: minUsdcOut=900, maxLossBps=5000 (50%) → configFloor=450 USDC.
        uint256 minUsdcOut = 900 * ONE_USDC;
        uint256 maxLossBps = 5_000;
        // TWAP floor (1:1 TWAP, 1% slippage) = 990 USDC > configFloor 450.
        // effectiveFloor = max(990, 450) = 990.
        uint256 twapFloor = tokenAmount * (10_000 - 100) / 10_000; // 990 USDC

        // Router output satisfies configFloor (450) but NOT the TWAP floor (990).
        uint256 routerOut = 600 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), minUsdcOut, true, maxLossBps);

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        // TWAP floor wins: effectiveFloor=990. Router output 600 < 990 → revert.
        vm.expectRevert(
            abi.encodeWithSelector(MockSwapRouter.TooLittleReceived.selector, routerOut, twapFloor)
        );
        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertEq(
            basketToken.balanceOf(address(vault)), tokenAmount, "TWAP floor blocks sandwich exploit"
        );
        assertEq(usdc.balanceOf(address(vault)), 0, "no USDC drained below TWAP floor");
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

    // ─── Pre-paused emergency unwind (issue #493) ─────────────────────

    /// @notice emergencyUnwind succeeds when vault is already paused.
    function test_emergencyUnwind_succeedsWhenAlreadyPaused() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        // TWAP floor (tick=0, 1:1, 1% slippage) = 990 USDC. Use 995 to satisfy both floors.
        uint256 amountOut = 995 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), amountOut);
        router.setAmountOut(amountOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), 900 * ONE_USDC, false, 0);

        // Pre-pause first — the common incident sequence.
        vm.prank(emergencyResponder);
        vault.pause();
        assertTrue(vault.paused(), "pre-condition: vault is paused");

        // emergencyUnwind must not revert with EnforcedPause.
        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(basketToken.balanceOf(address(vault)), 0, "basket asset fully unwound");
        assertEq(usdc.balanceOf(address(vault)), amountOut, "USDC received after pre-paused unwind");
        assertTrue(vault.paused(), "vault remains paused after unwind");
    }

    /// @notice emergencyUnwindWithOverride succeeds when vault is already paused.
    function test_emergencyUnwindWithOverride_succeedsWhenAlreadyPaused() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        // TWAP floor (tick=0, 1:1, 1% slippage) = 990 USDC. Use 995 to satisfy.
        uint256 amountOut = 995 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), amountOut);
        router.setAmountOut(amountOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), 800 * ONE_USDC, true, 500);

        // Pre-pause first.
        vm.prank(emergencyResponder);
        vault.pause();
        assertTrue(vault.paused(), "pre-condition: vault is paused");

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertEq(basketToken.balanceOf(address(vault)), 0, "basket asset unwound with override");
        assertTrue(vault.paused(), "vault remains paused after override unwind");
    }

    /// @notice emergencyUnwind on unpaused vault still pauses the vault.
    function test_emergencyUnwind_pausesVaultWhenNotAlreadyPaused() public {
        uint256 tokenAmount = 500 * ONE_USDC;
        // TWAP floor (tick=0, 1:1, 1% slippage) = 500 * 9900 / 10000 = 495 USDC. Use 497 to satisfy.
        uint256 amountOut = 497 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), amountOut);
        router.setAmountOut(amountOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), 400 * ONE_USDC, false, 0);

        assertFalse(vault.paused(), "pre-condition: vault is not paused");

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertTrue(vault.paused(), "vault is paused after emergencyUnwind");
        assertEq(basketToken.balanceOf(address(vault)), 0, "assets unwound");
    }

    /// @notice emergencyUnwindWithOverride on unpaused vault still pauses the vault.
    function test_emergencyUnwindWithOverride_pausesVaultWhenNotAlreadyPaused() public {
        uint256 tokenAmount = 500 * ONE_USDC;
        // TWAP floor (tick=0, 1:1, 1% slippage) = 500 * 9900 / 10000 = 495 USDC. Use 497 to satisfy.
        uint256 amountOut = 497 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), amountOut);
        router.setAmountOut(amountOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), 400 * ONE_USDC, true, 500);

        assertFalse(vault.paused(), "pre-condition: vault is not paused");

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertTrue(vault.paused(), "vault is paused after emergencyUnwindWithOverride");
        assertEq(basketToken.balanceOf(address(vault)), 0, "assets unwound with override");
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

    // ─── Pool cardinality check on addAsset (issue #494) ──────────────

    /// @notice addAsset() reverts with InsufficientPoolCardinality when the
    ///         pool's observationCardinality is 1 (Uniswap deployment default).
    function test_addAsset_revertsWhenPoolCardinalityIsOne() public {
        TestERC20 newAsset = new TestERC20();
        MockPool lowCardPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        lowCardPool.setCardinality(1);

        vm.expectRevert(
            abi.encodeWithSelector(
                BasketVault.InsufficientPoolCardinality.selector,
                address(lowCardPool),
                vault.MIN_POOL_CARDINALITY(),
                uint16(1)
            )
        );
        vm.prank(admin);
        vault.addAsset(address(newAsset), address(lowCardPool), 500);
    }

    /// @notice addAsset() succeeds when pool cardinality equals MIN_POOL_CARDINALITY (2).
    function test_addAsset_succeedsWhenCardinalityMeetsMinimum() public {
        TestERC20 newAsset = new TestERC20();
        MockPool goodPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        goodPool.setCardinality(vault.MIN_POOL_CARDINALITY());

        vm.prank(admin);
        vault.addAsset(address(newAsset), address(goodPool), 500);

        assertEq(vault.assetCount(), 2, "asset registered");
    }

    /// @notice totalAssets() does not revert after a successful addAsset() call
    ///         when cardinality satisfies the minimum.
    function test_totalAssets_doesNotRevertAfterValidAddAsset() public {
        TestERC20 newAsset = new TestERC20();
        MockPool goodPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        goodPool.setCardinality(100);

        vm.prank(admin);
        vault.addAsset(address(newAsset), address(goodPool), 500);

        // totalAssets() must not revert after valid addAsset().
        uint256 nav = vault.totalAssets();
        assertGe(nav, 0, "totalAssets returned without revert");
    }

    /// @notice Fuzz: addAsset() reverts exactly when pool cardinality is below
    ///         MIN_POOL_CARDINALITY and succeeds at or above it.
    function testFuzz_addAsset_cardinalityBoundary(uint16 cardinality_) public {
        // Use a fresh vault so we don't hit MaxAssetsReached after repeated calls.
        BasketVaultHarness freshVault = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(router)), admin, emergencyResponder
        );

        TestERC20 newAsset = new TestERC20();
        MockPool fuzzPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        fuzzPool.setCardinality(cardinality_);

        uint16 required = freshVault.MIN_POOL_CARDINALITY();

        if (cardinality_ < required) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    BasketVault.InsufficientPoolCardinality.selector,
                    address(fuzzPool),
                    required,
                    cardinality_
                )
            );
            vm.prank(admin);
            freshVault.addAsset(address(newAsset), address(fuzzPool), 500);
        } else {
            vm.prank(admin);
            freshVault.addAsset(address(newAsset), address(fuzzPool), 500);
            assertEq(freshVault.assetCount(), 1, "asset registered when cardinality sufficient");
        }
    }

    // ─── forceApprove/clear pattern (issue #501) ────────────────────────

    /// @notice After _routeDeposit, residual USDC allowance on the router is zero.
    function test_routeDeposit_zeroResidualAllowanceAfterSwap() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        // tick=0 → 1:1 price; slippage = 100 bps → minOut = 990 USDC.
        // Router must return at least 990 tokens to satisfy the floor.
        uint256 routerOut = 995 * ONE_USDC;

        usdc.mint(address(stranger), depositAmount);
        basketToken.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        assertEq(
            usdc.allowance(address(vault), address(router)),
            0,
            "_routeDeposit: no residual USDC allowance on router"
        );
    }

    /// @notice After _sellProportional (withdrawal), residual token allowance on the router is zero.
    function test_sellProportional_zeroResidualAllowanceAfterSwap() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        // tick=0 → 1:1 price; slippage = 100 bps → minOut = 990 USDC for deposit.
        uint256 tokensFromDeposit = 995 * ONE_USDC;

        // Seed router with basket tokens for the deposit swap.
        usdc.mint(address(stranger), depositAmount);
        basketToken.mint(address(router), tokensFromDeposit);
        router.setAmountOut(tokensFromDeposit);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        // Withdrawal path: basket tokens → USDC.
        // vault holds tokensFromDeposit basket tokens; slippage = 100 bps → minUsdcOut = 99% of TWAP value.
        uint256 withdrawUsdc = 990 * ONE_USDC;
        usdc.mint(address(router), withdrawUsdc);
        router.setAmountOut(withdrawUsdc);

        uint256 shares = vault.balanceOf(stranger);
        vm.prank(stranger);
        vault.redeem(shares, stranger, stranger);

        assertEq(
            basketToken.allowance(address(vault), address(router)),
            0,
            "_sellProportional: no residual basket-token allowance on router"
        );
    }

    /// @notice After emergencyUnwindAsset, residual token allowance on the router is zero.
    function test_emergencyUnwindAsset_zeroResidualAllowanceAfterSwap() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        // TWAP floor (tick=0, 1:1, 1% slippage) = 990 USDC. Use 995 to satisfy.
        uint256 amountOut = 995 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), amountOut);
        router.setAmountOut(amountOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), 900 * ONE_USDC, false, 0);

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(
            basketToken.allowance(address(vault), address(router)),
            0,
            "_emergencyUnwindAsset: no residual basket-token allowance on router"
        );
    }

    /// @notice After emergencyUnwindAssetWithCap, residual token allowance on the router is zero.
    function test_emergencyUnwindAssetWithCap_zeroResidualAllowanceAfterSwap() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 minUsdcOut = 900 * ONE_USDC;
        uint256 maxLossBps = 1_000; // 10% cap -> configFloor = 810 USDC
        // TWAP floor (tick=0, 1:1, 1% slippage) = 990 USDC > configFloor 810.
        // effectiveFloor = max(990, 810) = 990. Use 995 to satisfy.
        uint256 routerOut = 995 * ONE_USDC;

        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), minUsdcOut, true, maxLossBps);

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertEq(
            basketToken.allowance(address(vault), address(router)),
            0,
            "_emergencyUnwindAssetWithCap: no residual basket-token allowance on router"
        );
    }

    /// @notice Deposit + withdrawal round-trip preserves correct token balances and zero allowances.
    function test_depositWithdrawRoundTrip_correctBalancesAndZeroAllowances() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        // tick=0 → 1:1 price; slippage = 100 bps → minOut ≥ 990. Use 995 to satisfy.
        uint256 tokensFromDeposit = 995 * ONE_USDC; // USDC -> basket token
        uint256 usdcFromWithdraw = 990 * ONE_USDC; // basket token -> USDC (satisfies 99% of TWAP)

        usdc.mint(address(stranger), depositAmount);
        basketToken.mint(address(router), tokensFromDeposit);
        router.setAmountOut(tokensFromDeposit);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        // Vault holds basket tokens; allowance on router must be zero.
        assertEq(
            basketToken.balanceOf(address(vault)),
            tokensFromDeposit,
            "vault holds basket tokens after deposit"
        );
        assertEq(
            usdc.allowance(address(vault), address(router)),
            0,
            "no residual USDC allowance after deposit"
        );

        // Withdrawal swap: basket tokens -> USDC.
        usdc.mint(address(router), usdcFromWithdraw);
        router.setAmountOut(usdcFromWithdraw);

        uint256 shares = vault.balanceOf(stranger);
        vm.prank(stranger);
        vault.redeem(shares, stranger, stranger);

        assertEq(
            basketToken.balanceOf(address(vault)), 0, "vault holds no basket tokens after redeem"
        );
        assertEq(
            basketToken.allowance(address(vault), address(router)),
            0,
            "no residual basket-token allowance after redeem"
        );
        assertGt(usdc.balanceOf(stranger), 0, "stranger received USDC from redeem");
    }
}

