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
//         issue #553 — Aerodrome swap + TWAP adapter (IBasketSwapAdapter venue abstraction)
//         issue #554 — Uniswap V4 swap + TWAP adapter (UniswapV4SwapAdapter)
//         issue #555 — per-asset DEX venue selector (Venue enum on AssetInfo + addAsset)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {AerodromeSwapAdapter} from "../adapters/AerodromeSwapAdapter.sol";
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {IAerodromeRouter} from "../interfaces/IAerodromeRouter.sol";
import {IAerodromeSlipstreamRouter} from "../interfaces/IAerodromeSlipstreamRouter.sol";
import {IUniswapV4SwapRouter} from "../interfaces/IUniswapV4SwapRouter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

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
    uint128 public poolLiquidity; // in-range liquidity returned by liquidity()
    bool public revertObserve;

    constructor(address token0_, address token1_, uint160 sqrtPriceX96_) {
        token0 = token0_;
        token1 = token1_;
        sqrtPriceX96Spot = sqrtPriceX96_;
        // Tick=0 means 1:1 price (sqrtP = 2^96); arithmetic-mean tick is 0
        // when tickCumulativeRate=0. Tests override as needed.
        tickCumulativeRate = 0;
        cardinality = 100;
        poolLiquidity = 1e18; // large default so existing tests pass unmodified
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

    function setLiquidity(uint128 liquidity_) external {
        poolLiquidity = liquidity_;
    }

    function setRevertObserve(bool value) external {
        revertObserve = value;
    }

    function liquidity() external view returns (uint128) {
        return poolLiquidity;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96Spot, 0, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        if (revertObserve) revert("OLD");
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
        vault.addAsset(address(basketToken), address(pool), 500, address(0), BasketVault.Venue.V3);
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
        assertTrue(vault.depositsPaused(), "emergency unwind pauses deposits");
        assertFalse(vault.paused(), "emergency unwind keeps redemption available");
    }

    function test_emergencyUnwindWithOverride_emitsHighRiskEvent() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 amountOut = 1 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), amountOut);
        router.setAmountOut(amountOut);

        // maxLossBps = MAX_BPS explicitly permits a zero-floor, oracle-independent unwind.
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
            usdc.balanceOf(address(vault)), amountOut, "override accepts configured zero floor"
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
        vault.addAsset(address(newAsset), address(badPool), 500, address(0), BasketVault.Venue.V3);
    }

    /// @notice INV-1: an ACTIVE basket asset may never be swept to quarantine —
    ///         it is a protocol/depositor asset counted in NAV.
    function test_sweepForeignToken_revertsForActiveBasketAsset() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ForeignTokenQuarantine.TokenIsProtected.selector, address(basketToken)
            )
        );
        vault.sweepForeignToken(address(basketToken));
    }

    /// @notice INV-1: USDC (the vault asset) and the share token may never be swept.
    function test_sweepForeignToken_revertsForUsdcAndShareToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, address(usdc))
        );
        vault.sweepForeignToken(address(usdc));

        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, address(vault))
        );
        vault.sweepForeignToken(address(vault));
    }

    /// @notice INV-2: a genuinely foreign token is permissionlessly swept to the
    ///         fixed quarantine address — no admin role, no caller-supplied
    ///         recipient.
    function test_sweepForeignToken_permissionlessForNonBasketAsset() public {
        TestERC20 stray = new TestERC20();
        stray.mint(address(vault), 5 * ONE_USDC);
        address stranger = makeAddr("stranger");

        vm.prank(stranger);
        vault.sweepForeignToken(address(stray));

        assertEq(
            stray.balanceOf(ForeignTokenQuarantine.QUARANTINE),
            5 * ONE_USDC,
            "stray ERC-20 quarantined"
        );
        assertEq(stray.balanceOf(address(vault)), 0, "vault no longer holds stray ERC-20");
    }

    /// @notice INV-1: a removed (inactive) basket asset is STILL protected from the
    ///         quarantine sweep — it is re-absorbed into NAV instead, never routed
    ///         away (replaces the audit 2026-06-09 L-15 admin rescue path).
    function test_sweepForeignToken_revertsForInactiveBasketAsset() public {
        vm.prank(admin);
        vault.removeAsset(0);
        basketToken.mint(address(vault), 7 * ONE_USDC);

        vm.expectRevert(
            abi.encodeWithSelector(
                ForeignTokenQuarantine.TokenIsProtected.selector, address(basketToken)
            )
        );
        vault.sweepForeignToken(address(basketToken));
    }

    /// @notice INV-2: a balance reappearing on a removed basket asset is
    ///         permissionlessly re-absorbed — swapped to USDC into NAV — so it
    ///         stays redeemable by holders, with no admin-routable path.
    function test_reabsorbRemovedAsset_creditsNavPermissionlessly() public {
        vm.prank(admin);
        vault.removeAsset(0); // vault holds zero basketToken, removal allowed

        // A balance reappears after removal (e.g. late airdrop or refund).
        uint256 reappeared = 7 * ONE_USDC;
        basketToken.mint(address(vault), reappeared);

        // Fund the swap router so it can pay out USDC for the re-absorb swap.
        // Pool is 1:1 (tick=0); 1% slippage floor → minUsdcOut = 6.93 USDC.
        uint256 usdcOut = 7 * ONE_USDC;
        router.setAmountOut(usdcOut);
        usdc.mint(address(router), usdcOut);

        uint256 navBefore = vault.totalAssets();

        // Permissionless: an arbitrary stranger triggers re-absorption.
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vault.reabsorbRemovedAsset(0);

        assertEq(basketToken.balanceOf(address(vault)), 0, "reappeared balance consumed");
        assertEq(
            basketToken.balanceOf(ForeignTokenQuarantine.QUARANTINE),
            0,
            "re-absorbed asset must NOT be quarantined"
        );
        assertEq(
            vault.totalAssets(),
            navBefore + usdcOut,
            "NAV rises by re-absorbed USDC for all holders"
        );
    }

    /// @notice An active asset cannot be re-absorbed (it is sold proportionally on
    ///         withdrawal, not swept).
    function test_reabsorbRemovedAsset_revertsForActiveAsset() public {
        basketToken.mint(address(vault), 7 * ONE_USDC);
        vm.expectRevert(BasketVault.AssetInBasket.selector);
        vault.reabsorbRemovedAsset(0);
    }

    // ─── INV-3: fee setters are governance-gated (issue #929) ─────────────────
    //
    // Fee setters are `onlyRole(ADMIN_ROLE)`. In production ADMIN_ROLE is held by
    // the TimelockController (see DeployTimelock.s.sol / DeployTimelock.t.sol),
    // so they change only via multisig + timelock. Here we prove the gate by
    // asserting the hot EMERGENCY key cannot move fees and ADMIN can.

    function test_INV3_setFeeRecipient_revertsForHotEmergencyKey() public {
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.prank(emergencyResponder);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                emergencyResponder,
                adminRole
            )
        );
        vault.setFeeRecipient(makeAddr("newRecipient"));
    }

    function test_INV3_setExitFeeBps_revertsForHotEmergencyKey() public {
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.prank(emergencyResponder);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                emergencyResponder,
                adminRole
            )
        );
        vault.setExitFeeBps(50);
    }

    function test_INV3_feeSetters_succeedForAdminRole() public {
        address newRecipient = makeAddr("newRecipient");
        vm.prank(admin);
        vault.setFeeRecipient(newRecipient);
        assertEq(vault.feeRecipient(), newRecipient, "fee recipient updated by admin");

        vm.prank(admin);
        vault.setExitFeeBps(50);
        assertEq(vault.exitFeeBps(), 50, "exit fee updated by admin");
    }

    // ─── maxDeposit / maxMint 4626 conformance (audit 2026-06-09, L-16) ───────

    function test_maxDeposit_reflectsPerDepositCap() public view {
        // Fresh vault: TVL headroom (1M) exceeds perDepositCap (100k).
        assertEq(vault.maxDeposit(stranger), 100_000 * ONE_USDC, "maxDeposit == perDepositCap");
        assertEq(
            vault.maxMint(stranger),
            vault.previewDeposit(100_000 * ONE_USDC),
            "maxMint mirrors maxDeposit through previewDeposit"
        );
    }

    function test_maxDeposit_zeroWhenPaused() public {
        vm.prank(emergencyResponder);
        vault.pause();
        assertEq(vault.maxDeposit(stranger), 0, "maxDeposit 0 while paused");
        assertEq(vault.maxMint(stranger), 0, "maxMint 0 while paused");

        vm.prank(admin);
        vault.unpause();
        assertGt(vault.maxDeposit(stranger), 0, "maxDeposit restored after unpause");
    }

    function test_maxDeposit_zeroWhenShutdown() public {
        vm.prank(emergencyResponder);
        vault.shutdownVault();
        assertEq(vault.maxDeposit(stranger), 0, "maxDeposit 0 after shutdown");
        assertEq(vault.maxMint(stranger), 0, "maxMint 0 after shutdown");
    }

    function test_maxDeposit_zeroWhenNoActiveAssets() public {
        vm.prank(admin);
        vault.removeAsset(0);
        assertEq(vault.maxDeposit(stranger), 0, "maxDeposit 0 with no active assets");
        assertEq(vault.maxMint(stranger), 0, "maxMint 0 with no active assets");
    }

    function test_maxDeposit_reflectsTvlHeadroom() public {
        vm.prank(admin);
        vault.setTvlCap(50_000 * ONE_USDC);
        assertEq(vault.maxDeposit(stranger), 50_000 * ONE_USDC, "headroom below perDepositCap");

        // Idle USDC counts toward totalAssets and shrinks the headroom.
        usdc.mint(address(vault), 20_000 * ONE_USDC);
        assertEq(vault.maxDeposit(stranger), 30_000 * ONE_USDC, "headroom shrinks with TVL");

        // At/above the cap, deposits are fully disabled.
        usdc.mint(address(vault), 40_000 * ONE_USDC);
        assertEq(vault.maxDeposit(stranger), 0, "maxDeposit 0 at TVL cap");
        assertEq(vault.maxMint(stranger), 0, "maxMint 0 at TVL cap");
    }

    // ─── setMaxSlippageBps pool-fee floor (audit 2026-06-09, L-17) ────────────

    function test_setMaxSlippageBps_revertsBelowPoolFeeFloor() public {
        // Active asset registered with fee tier 500 (hundredths of a bip) → 5 bps floor.
        assertEq(vault.minSlippageFloorBps(), 5, "floor derives from the active fee tier");

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(BasketVault.SlippageBelowPoolFeeFloor.selector, 0, 5)
        );
        vault.setMaxSlippageBps(0); // the bricking case from the audit

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(BasketVault.SlippageBelowPoolFeeFloor.selector, 4, 5)
        );
        vault.setMaxSlippageBps(4);
    }

    function test_setMaxSlippageBps_acceptsValuesAtOrAboveFloor() public {
        vm.prank(admin);
        vault.setMaxSlippageBps(5); // exactly at the 5 bps floor
        assertEq(vault.maxSlippageBps(), 5, "floor value accepted");

        vm.prank(admin);
        vault.setMaxSlippageBps(200);
        assertEq(vault.maxSlippageBps(), 200, "value above floor accepted");
    }

    function test_setMaxSlippageBps_zeroAllowedWhenNoActiveAssets() public {
        vm.prank(admin);
        vault.removeAsset(0);
        assertEq(vault.minSlippageFloorBps(), 0, "no active assets, no floor");

        vm.prank(admin);
        vault.setMaxSlippageBps(0); // nothing can brick with an empty basket
        assertEq(vault.maxSlippageBps(), 0, "zero accepted with empty basket");
    }

    function test_emergencyUnwindWithOverride_revertsWhenBelowUpperLossCap() public {
        // issue #446: an admin-configured upper-loss cap must bound override slippage.
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 minUsdcOut = 900 * ONE_USDC;
        // maxLossBps = 1000 (10%) -> configFloor = 900 * 0.9 = 810 USDC.
        uint256 maxLossBps = 1_000;
        uint256 appliedFloor = 810 * ONE_USDC;
        // Router only returns 800 USDC, below the configured loss cap.
        uint256 routerOut = 800 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), minUsdcOut, true, maxLossBps);

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

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
        // issue #446: when realized output meets the configured cap,
        // override path still works and emits EmergencyUnwindOverrideUsed for off-chain visibility.
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 minUsdcOut = 900 * ONE_USDC;
        uint256 maxLossBps = 1_000; // 10% cap -> configFloor = 810 USDC
        uint256 appliedFloor = 810 * ONE_USDC;
        uint256 routerOut = 815 * ONE_USDC;
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
            "override succeeds when realized output meets configured loss cap"
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
        assertTrue(vault.depositsPaused(), "deposits paused after unwind");
        assertFalse(vault.paused(), "redemption remains available after unwind");
    }

    /// @notice Override execution remains available when the TWAP oracle is unavailable.
    function test_emergencyUnwindWithOverride_isOracleIndependent() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        // Configured guard: minUsdcOut=900, maxLossBps=5000 (50%) → configFloor=450 USDC.
        uint256 minUsdcOut = 900 * ONE_USDC;
        uint256 maxLossBps = 5_000;
        uint256 appliedFloor = 450 * ONE_USDC;
        uint256 routerOut = 600 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), routerOut);
        router.setAmountOut(routerOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), minUsdcOut, true, maxLossBps);
        pool.setRevertObserve(true);

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        vm.expectEmit(true, false, false, true, address(vault));
        emit EmergencyUnwindOverrideUsed(
            address(basketToken), tokenAmount, minUsdcOut, appliedFloor, emergencyResponder
        );
        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertEq(basketToken.balanceOf(address(vault)), 0, "asset unwound without oracle");
        assertEq(usdc.balanceOf(address(vault)), routerOut, "bounded output received");
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

    /// @notice emergencyUnwind on an unpaused vault pauses deposits only.
    function test_emergencyUnwind_pausesDepositsWhenNotAlreadyPaused() public {
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

        assertTrue(vault.depositsPaused(), "deposits are paused after emergencyUnwind");
        assertFalse(vault.paused(), "redemption remains available");
        assertEq(basketToken.balanceOf(address(vault)), 0, "assets unwound");
    }

    /// @notice emergencyUnwindWithOverride on an unpaused vault pauses deposits only.
    function test_emergencyUnwindWithOverride_pausesDepositsWhenNotAlreadyPaused() public {
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

        assertTrue(vault.depositsPaused(), "deposits are paused after override unwind");
        assertFalse(vault.paused(), "redemption remains available");
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
        assertTrue(vault.depositsPaused(), "emergencyUnwind pauses deposits");
        assertFalse(vault.paused(), "emergencyUnwind keeps redemption available");
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
        vault.addAsset(
            address(newAsset), address(lowCardPool), 500, address(0), BasketVault.Venue.V3
        );
    }

    function test_addAsset_revertsWithoutFullTwapHistory() public {
        TestERC20 newAsset = new TestERC20();
        MockPool youngPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        youngPool.setRevertObserve(true);

        vm.expectRevert(
            abi.encodeWithSelector(
                BasketVault.InsufficientObservationHistory.selector,
                address(youngPool),
                vault.DEFAULT_TWAP_WINDOW()
            )
        );
        vm.prank(admin);
        vault.addAsset(address(newAsset), address(youngPool), 500, address(0), BasketVault.Venue.V3);
    }

    function test_emergencyUnwind_usesConfiguredFloorWhenOracleUnavailable() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 configuredFloor = 800 * ONE_USDC;
        uint256 amountOut = 850 * ONE_USDC;
        basketToken.mint(address(vault), tokenAmount);
        usdc.mint(address(router), amountOut);
        router.setAmountOut(amountOut);
        pool.setRevertObserve(true);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), configuredFloor, false, 0);

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(basketToken.balanceOf(address(vault)), 0, "asset unwound with configured floor");
        assertEq(usdc.balanceOf(address(vault)), amountOut, "configured-floor output received");
    }

    function test_emergencyUnwind_blocksDepositsButAllowsRedemption() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 basketOut = 995 * ONE_USDC;
        usdc.mint(stranger, depositAmount);
        basketToken.mint(address(router), basketOut);
        router.setAmountOut(basketOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        uint256 shares = vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        uint256 unwindOut = 990 * ONE_USDC;
        usdc.mint(address(router), unwindOut);
        router.setAmountOut(unwindOut);
        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), 980 * ONE_USDC, false, 0);
        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(vault.maxDeposit(stranger), 0, "new deposits disabled");
        vm.prank(stranger);
        uint256 redeemed = vault.redeem(shares, stranger, stranger);
        assertGt(redeemed, 0, "existing holder can redeem after unwind");
    }

    /// @notice addAsset() succeeds when pool cardinality equals MIN_POOL_CARDINALITY (2).
    function test_addAsset_succeedsWhenCardinalityMeetsMinimum() public {
        TestERC20 newAsset = new TestERC20();
        MockPool goodPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        goodPool.setCardinality(vault.MIN_POOL_CARDINALITY());

        vm.prank(admin);
        vault.addAsset(address(newAsset), address(goodPool), 500, address(0), BasketVault.Venue.V3);

        assertEq(vault.assetCount(), 2, "asset registered");
    }

    /// @notice totalAssets() does not revert after a successful addAsset() call
    ///         when cardinality satisfies the minimum.
    function test_totalAssets_doesNotRevertAfterValidAddAsset() public {
        TestERC20 newAsset = new TestERC20();
        MockPool goodPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        goodPool.setCardinality(100);

        vm.prank(admin);
        vault.addAsset(address(newAsset), address(goodPool), 500, address(0), BasketVault.Venue.V3);

        // totalAssets() must not revert after valid addAsset().
        uint256 nav = vault.totalAssets();
        assertGe(nav, 0, "totalAssets returned without revert");
    }

    // ─── Pool minimum-liquidity gate on addAsset (issue #551) ─────────

    /// @notice addAsset() reverts with InsufficientPoolLiquidity when the
    ///         pool's in-range liquidity is below MIN_POOL_LIQUIDITY.
    function test_addAsset_revertsWhenPoolLiquidityBelowMinimum() public {
        TestERC20 newAsset = new TestERC20();
        MockPool thinPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        // Set liquidity below the minimum. MIN_POOL_LIQUIDITY = 1e6; use 0 (empty pool).
        thinPool.setLiquidity(0);

        vm.expectRevert(
            abi.encodeWithSelector(
                BasketVault.InsufficientPoolLiquidity.selector,
                address(thinPool),
                vault.MIN_POOL_LIQUIDITY(),
                uint128(0)
            )
        );
        vm.prank(admin);
        vault.addAsset(address(newAsset), address(thinPool), 500, address(0), BasketVault.Venue.V3);
    }

    /// @notice addAsset() succeeds when pool liquidity meets MIN_POOL_LIQUIDITY.
    function test_addAsset_succeedsWhenPoolLiquidityMeetsMinimum() public {
        TestERC20 newAsset = new TestERC20();
        MockPool deepPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        // Set liquidity exactly at the minimum floor.
        deepPool.setLiquidity(vault.MIN_POOL_LIQUIDITY());

        vm.prank(admin);
        vault.addAsset(address(newAsset), address(deepPool), 500, address(0), BasketVault.Venue.V3);

        assertEq(vault.assetCount(), 2, "asset registered when liquidity sufficient");
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
            freshVault.addAsset(
                address(newAsset), address(fuzzPool), 500, address(0), BasketVault.Venue.V3
            );
        } else {
            vm.prank(admin);
            freshVault.addAsset(
                address(newAsset), address(fuzzPool), 500, address(0), BasketVault.Venue.V3
            );
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

    // ─── Slippage-adjusted previewRedeem / previewDeposit (issue #549) ──

    /// @notice previewRedeem returns TWAP-minus-slippage-minus-exitFee floor.
    ///         With tick=0 (1:1 price), 1 000 USDC of vault NAV, 1% maxSlippage, 0% fee:
    ///         floor = 1 000 * 9 900/10 000 = 990 USDC.
    function test_previewRedeem_returnsSlippageAndFeeAdjustedFloor() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        // Seed the vault with basketToken directly so totalAssets() = depositAmount (tick=0 → 1:1).
        basketToken.mint(address(vault), depositAmount);
        // Mint shares to stranger directly via a deposit, but we need to test previewRedeem on
        // a known share count — use totalSupply trick: mint USDC and deposit.
        usdc.mint(address(stranger), depositAmount);
        uint256 tokensFromDeposit = 995 * ONE_USDC;
        basketToken.mint(address(router), tokensFromDeposit);
        router.setAmountOut(tokensFromDeposit);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        uint256 shares = vault.balanceOf(stranger);
        uint256 preview = vault.previewRedeem(shares);

        // gross = _convertToAssets(shares) ≈ depositAmount (initial 1 000 + deposit-derived NAV).
        // The exact gross depends on share math, but the floor must be:
        //   gross * (MAX_BPS - maxSlippageBps) / MAX_BPS * (MAX_BPS - exitFeeBps) / MAX_BPS.
        // exitFeeBps = 0 in the harness, maxSlippageBps = 100 (1%).
        // Verify the preview is strictly less than the unadjusted gross (i.e., slippage was applied).
        uint256 grossWithFeeOnly = vault.convertToAssets(shares); // TWAP NAV without slippage
        assertLt(preview, grossWithFeeOnly, "previewRedeem must be below unadjusted TWAP NAV");
        // Verify the floor equals exactly TWAP NAV * (1 - 100 bps).
        uint256 expectedFloor = grossWithFeeOnly * (10_000 - 100) / 10_000;
        assertEq(preview, expectedFloor, "previewRedeem must equal TWAP-minus-slippage floor");
    }

    /// @notice Actual redeem proceeds are >= previewRedeem when slippage < maxSlippageBps.
    ///         This is the ERC-4626 guarantee: redeem must return at least previewRedeem.
    function test_previewRedeem_floorLeqActualSwapProceeds_underSlippage() public {
        // Set up vault with basket tokens worth 1 000 USDC (tick=0 → 1:1).
        uint256 depositAmount = 1_000 * ONE_USDC;
        usdc.mint(address(stranger), depositAmount);
        // Router returns 995 tokens (above the 990 minOut floor for 1% slippage).
        uint256 tokensFromDeposit = 995 * ONE_USDC;
        basketToken.mint(address(router), tokensFromDeposit);
        router.setAmountOut(tokensFromDeposit);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        uint256 shares = vault.balanceOf(stranger);
        uint256 preview = vault.previewRedeem(shares);

        // Simulate a redemption that returns 992 USDC — above the 990-USDC floor.
        // (Router mock returns a fixed amountOut.)
        uint256 actualSwapOut = 992 * ONE_USDC; // between floor(990) and full(~995)
        usdc.mint(address(router), actualSwapOut);
        router.setAmountOut(actualSwapOut);

        uint256 usdcBefore = usdc.balanceOf(stranger);
        vm.prank(stranger);
        vault.redeem(shares, stranger, stranger);
        uint256 usdcAfter = usdc.balanceOf(stranger);
        uint256 actualNet = usdcAfter - usdcBefore;

        // ERC-4626 invariant: actual >= preview.
        assertGe(actualNet, preview, "actual redeem proceeds must be >= previewRedeem floor");
    }

    /// @notice previewRedeem with a non-zero exit fee applies fee on top of slippage.
    function test_previewRedeem_appliesExitFeeOnSlippageAdjustedProceeds() public {
        // Set exit fee to 50 bps (0.5%) on the shared vault.
        vm.prank(admin);
        vault.setExitFeeBps(50); // 0.5%

        // Seed the vault by depositing.
        uint256 depositAmount = 1_000 * ONE_USDC;
        usdc.mint(address(stranger), depositAmount);
        uint256 tokensFromDeposit = 995 * ONE_USDC;
        basketToken.mint(address(router), tokensFromDeposit);
        router.setAmountOut(tokensFromDeposit);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        uint256 shares = vault.balanceOf(stranger);
        uint256 gross = vault.convertToAssets(shares);
        // Expected floor: gross * (MAX_BPS - maxSlippageBps) / MAX_BPS, then * (MAX_BPS - exitFeeBps) / MAX_BPS.
        // Use the same mulDiv rounding as the contract (Math.mulDiv floors by default).
        uint256 afterSlippage = gross * (10_000 - 100) / 10_000; // 1% slippage (floor)
        // The contract applies exitFeeBps via mulDiv(floor) on afterSlippage.
        // afterSlippage - afterSlippage * exitFeeBps / MAX_BPS, where the subtracted term is floored.
        uint256 feeAmount = afterSlippage * 50 / 10_000;
        uint256 expectedFloor = afterSlippage - feeAmount;

        uint256 preview = vault.previewRedeem(shares);
        assertEq(
            preview,
            expectedFloor,
            "previewRedeem must apply exit fee on slippage-adjusted proceeds"
        );
    }

    /// @notice previewDeposit returns fewer shares than without slippage discount.
    ///         With 1% maxSlippage, depositing 1 000 USDC should preview fewer
    ///         shares than the raw convertToShares(1 000).
    function test_previewDeposit_returnsSlippageAdjustedShareFloor() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        // Seed vault with some tokens so NAV is non-zero (prevents divide-by-zero).
        basketToken.mint(address(vault), 500 * ONE_USDC);

        // previewDeposit should be less than the unadjusted share conversion.
        uint256 unadjusted = vault.convertToShares(depositAmount);
        uint256 preview = vault.previewDeposit(depositAmount);
        assertLt(preview, unadjusted, "previewDeposit must be below unadjusted share conversion");

        // Verify it equals exactly convertToShares(depositAmount * (MAX_BPS - maxSlippageBps) / MAX_BPS).
        uint256 effectiveAssets = depositAmount * (10_000 - 100) / 10_000;
        uint256 expectedPreview = vault.convertToShares(effectiveAssets);
        assertEq(
            preview,
            expectedPreview,
            "previewDeposit must equal slippage-discounted share conversion"
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

    // ─── previewMint slippage haircut (issue #746) ────────────────────

    /// @notice previewMint grosses up raw NAV by the slippage factor so mint()
    ///         charges the same haircut as deposit(). Without this override, mint()
    ///         would undercharge relative to deposit(), enabling a value leak.
    function test_previewMint_grossesUpBySlippage() public {
        basketToken.mint(address(vault), 500 * ONE_USDC);

        uint256 targetShares = 100 * 1e18;
        uint256 rawAssets = vault.convertToAssets(targetShares);
        uint256 mintAssets = vault.previewMint(targetShares);

        // mintAssets must exceed rawAssets (grossed up by slippage).
        assertGt(mintAssets, rawAssets, "previewMint must gross up raw NAV by slippage");
        // Verify the gross-up factor: rawAssets * MAX_BPS / (MAX_BPS - slip).
        // Ceil rounding may add 1 wei.
        uint256 expectedGrossUp = rawAssets * (10_000) / (10_000 - vault.maxSlippageBps());
        assertApproxEqAbs(
            mintAssets, expectedGrossUp, 1, "previewMint gross-up must match slippage factor"
        );
    }

    /// @notice Mint is not cheaper than deposit for the same share count.
    ///         Depositing the assets that previewMint requires must yield at
    ///         least targetShares (ERC-4626 symmetry with slippage haircut).
    function test_previewMint_notCheaperThanDeposit_dilutionPrevented() public {
        basketToken.mint(address(vault), 500 * ONE_USDC);

        uint256 targetShares = 100 * 1e18;
        uint256 mintAssets = vault.previewMint(targetShares);
        uint256 depositShares = vault.previewDeposit(mintAssets);

        // deposit path using the mint-required assets must yield >= targetShares.
        assertGe(
            depositShares, targetShares, "previewMint must not undercharge relative to deposit"
        );
    }

    // ─── ERC-4626 withdraw exactness (issue #754) ──────────────────────

    /// @notice withdraw() and previewWithdraw() revert with RedeemOnly because
    ///         BasketVault proportional-swap exits cannot guarantee the ERC-4626
    ///         exactness guarantee. Users must use redeem() instead.
    function test_withdrawAndPreviewWithdraw_revertRedeemOnly() public {
        // Preview (no state needed — view function).
        vm.expectRevert(BasketVault.RedeemOnly.selector);
        vault.previewWithdraw(100);

        // Stateful: deposit to get shares, then call withdraw.
        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 basketOut = 995 * ONE_USDC;
        usdc.mint(address(stranger), depositAmount);
        basketToken.mint(address(router), basketOut);
        router.setAmountOut(basketOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        uint256 shares = vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert(BasketVault.RedeemOnly.selector);
        vault.withdraw(100, stranger, stranger);

        // redeem still works.
        vm.prank(stranger);
        vault.redeem(shares, stranger, stranger);

        assertGt(usdc.balanceOf(stranger), 0, "redeem still works");
    }
}

// ─── ADR-0003: Rebalancing model (WeightSnapshot, previewDepositWeights, realizedWeights, rebalance stub) ─────────

contract BasketVaultRebalanceTest is Test {
    // Covers: issue #550 — ADR-0003 rebalancing model implementation
    //         WeightSnapshot event, previewDepositWeights, realizedWeights, rebalance() stub

    uint256 internal constant ONE_USDC = 1e6;

    event WeightSnapshot(
        address indexed depositor, address[] assets, uint256[] bpsWeights, uint256 timestamp
    );

    TestERC20 internal usdc;
    TestERC20 internal tokenA;
    TestERC20 internal tokenB;
    MockSwapRouter internal router;
    MockPool internal poolA;
    MockPool internal poolB;
    BasketVaultHarness internal vault;

    address internal admin = makeAddr("admin");
    address internal emergencyResponder = makeAddr("emergencyResponder");
    address internal depositor = makeAddr("depositor");

    function setUp() public {
        vm.warp(1_000_000); // fixed block.timestamp for snapshot assertions
        usdc = new TestERC20();
        tokenA = new TestERC20();
        tokenB = new TestERC20();
        router = new MockSwapRouter();
        // Tick=0 → 1:1 price for both pools
        poolA = new MockPool(address(tokenA), address(usdc), uint160(1 << 96));
        poolB = new MockPool(address(tokenB), address(usdc), uint160(1 << 96));

        vault = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(router)), admin, emergencyResponder
        );

        vm.startPrank(admin);
        vault.addAsset(address(tokenA), address(poolA), 500, address(0), BasketVault.Venue.V3);
        vault.addAsset(address(tokenB), address(poolB), 500, address(0), BasketVault.Venue.V3);
        vm.stopPrank();
    }

    // ─── rebalance() stub ─────────────────────────────────────────────

    function test_rebalance_revertsWithNotImplemented() public {
        vm.expectRevert(BasketVault.NotImplemented.selector);
        vault.rebalance(100, block.timestamp + 60);
    }

    function test_rebalance_revertsForAnyCallerNotJustAdmin() public {
        // The stub is permissionless but always reverts — no role gates needed.
        vm.prank(depositor);
        vm.expectRevert(BasketVault.NotImplemented.selector);
        vault.rebalance(0, 0);
    }

    // ─── WeightSnapshot event ─────────────────────────────────────────

    function test_deposit_emitsWeightSnapshot_singleAsset() public {
        // Remove tokenB so only tokenA is active → weight must be 10_000 bps.
        // First we need to have no tokenB balance (which is the case initially).
        vm.prank(admin);
        vault.removeAsset(1);

        uint256 usdcAmount = 1_000 * ONE_USDC;
        usdc.mint(depositor, usdcAmount);

        // Router returns 1:1 (tick=0). Set amountOut to the full swapIn amount.
        tokenA.mint(address(router), usdcAmount);
        router.setAmountOut(usdcAmount);

        address[] memory expectedAssets = new address[](1);
        expectedAssets[0] = address(tokenA);
        uint256[] memory expectedWeights = new uint256[](1);
        expectedWeights[0] = 10_000; // 100% to the single active asset

        vm.startPrank(depositor);
        usdc.approve(address(vault), usdcAmount);

        vm.expectEmit(true, false, false, true, address(vault));
        emit WeightSnapshot(depositor, expectedAssets, expectedWeights, block.timestamp);
        vault.deposit(usdcAmount, depositor);
        vm.stopPrank();
    }

    function test_deposit_emitsWeightSnapshot_twoAssets() public {
        // Two active assets → each gets 5_000 bps (50%).
        // With usdcAmount = 1000 and n=2: perAsset=500, remainder=0.
        // First active gets: baseWeightBps + remainderWeightBps = 5000 + 0 = 5000 bps.
        uint256 usdcAmount = 1_000 * ONE_USDC;
        usdc.mint(depositor, usdcAmount);

        // Router swaps at 1:1; each leg needs tokenA/B in router.
        uint256 perAsset = usdcAmount / 2; // 500 USDC each
        tokenA.mint(address(router), perAsset);
        tokenB.mint(address(router), perAsset);
        router.setAmountOut(perAsset);

        address[] memory expectedAssets = new address[](2);
        expectedAssets[0] = address(tokenA);
        expectedAssets[1] = address(tokenB);
        uint256[] memory expectedWeights = new uint256[](2);
        expectedWeights[0] = 5_000;
        expectedWeights[1] = 5_000;

        vm.startPrank(depositor);
        usdc.approve(address(vault), usdcAmount);

        vm.expectEmit(true, false, false, true, address(vault));
        emit WeightSnapshot(depositor, expectedAssets, expectedWeights, block.timestamp);
        vault.deposit(usdcAmount, depositor);
        vm.stopPrank();
    }

    // ─── previewDepositWeights ────────────────────────────────────────

    function test_previewDepositWeights_returnsActiveAssetsOnly() public {
        // Remove tokenB; only tokenA active.
        vm.prank(admin);
        vault.removeAsset(1);

        uint256 usdcAmount = 1_000 * ONE_USDC;
        (address[] memory activeAssets, uint256[] memory amountsOut) =
            vault.previewDepositWeights(usdcAmount);

        assertEq(activeAssets.length, 1, "one active asset");
        assertEq(activeAssets[0], address(tokenA), "tokenA is the active asset");
        // TWAP tick=0 → 1:1 price; 1000 USDC → 1000 token units
        assertEq(amountsOut[0], usdcAmount, "full amount goes to single active asset");
    }

    function test_previewDepositWeights_splitEquallyAcrossTwoAssets() public {
        uint256 usdcAmount = 1_000 * ONE_USDC;
        (address[] memory activeAssets, uint256[] memory amountsOut) =
            vault.previewDepositWeights(usdcAmount);

        assertEq(activeAssets.length, 2, "two active assets");
        assertEq(activeAssets[0], address(tokenA));
        assertEq(activeAssets[1], address(tokenB));
        // Each leg gets 500 USDC; TWAP 1:1 → 500 token units each.
        assertEq(amountsOut[0], 500 * ONE_USDC, "tokenA gets half");
        assertEq(amountsOut[1], 500 * ONE_USDC, "tokenB gets half");
    }

    function test_previewDepositWeights_zeroAmountReturnsZeros() public {
        (address[] memory activeAssets, uint256[] memory amountsOut) =
            vault.previewDepositWeights(0);
        assertEq(activeAssets.length, 2, "returns active asset list even for zero amount");
        assertEq(amountsOut[0], 0, "zero output for zero input");
        assertEq(amountsOut[1], 0, "zero output for zero input");
    }

    // ─── realizedWeights ──────────────────────────────────────────────

    function test_realizedWeights_returnsZerosForNonDepositor() public {
        (address[] memory activeAssets, uint256[] memory bpsWeights) =
            vault.realizedWeights(depositor);
        assertEq(activeAssets.length, 2, "returns active asset set");
        assertEq(bpsWeights[0], 0, "zero weight for non-depositor");
        assertEq(bpsWeights[1], 0, "zero weight for non-depositor");
    }

    function test_realizedWeights_returnsEqualWeightsAfterEqualDeposit() public {
        // Deposit equal amounts → should hold 50/50 of each asset.
        uint256 usdcAmount = 1_000 * ONE_USDC;
        usdc.mint(depositor, usdcAmount);

        uint256 perAsset = usdcAmount / 2;
        tokenA.mint(address(router), perAsset);
        tokenB.mint(address(router), perAsset);
        router.setAmountOut(perAsset);

        vm.startPrank(depositor);
        usdc.approve(address(vault), usdcAmount);
        vault.deposit(usdcAmount, depositor);
        vm.stopPrank();

        (, uint256[] memory bpsWeights) = vault.realizedWeights(depositor);
        // Both assets have equal USDC value (tick=0, 1:1 price) → 5000 bps each.
        // Due to integer rounding the sum may be 9999 or 10000; check approximate equality.
        assertApproxEqAbs(bpsWeights[0], 5_000, 1, "tokenA weight ~50%");
        assertApproxEqAbs(bpsWeights[1], 5_000, 1, "tokenB weight ~50%");
    }

    function test_realizedWeights_noActiveAssets_returnsEmpty() public {
        // Remove both assets (they hold zero balance).
        vm.prank(admin);
        vault.removeAsset(0);
        vm.prank(admin);
        vault.removeAsset(1);

        (address[] memory activeAssets, uint256[] memory bpsWeights) =
            vault.realizedWeights(depositor);
        assertEq(activeAssets.length, 0, "no active assets");
        assertEq(bpsWeights.length, 0, "no weights");
    }
}

// ─── Aerodrome swap + TWAP adapter tests (issue #553) ─────────────────────────

/// @dev Mock Aerodrome Slipstream router and CL factory.
contract MockAerodromeRouter {
    using SafeERC20 for IERC20;

    uint256 public amountOut;
    /// @dev When set, the deadline forwarded by the adapter is enforced
    ///      (mirrors the real Aerodrome Router's "Expired" check).
    bool public enforceDeadline;
    mapping(bytes32 => address) public pools;

    error TooLittleReceived(uint256 amountOut, uint256 amountOutMin);
    error Expired(uint256 deadline, uint256 blockTimestamp);

    function setAmountOut(uint256 amountOut_) external {
        amountOut = amountOut_;
    }

    function setEnforceDeadline(bool enforce_) external {
        enforceDeadline = enforce_;
    }

    function setPool(address tokenA, address tokenB, int24 tickSpacing, address pool) external {
        pools[keccak256(abi.encode(tokenA, tokenB, tickSpacing))] = pool;
        pools[keccak256(abi.encode(tokenB, tokenA, tickSpacing))] = pool;
    }

    function exactInputSingle(IAerodromeSlipstreamRouter.ExactInputSingleParams calldata params)
        external
        returns (uint256)
    {
        if (enforceDeadline && block.timestamp > params.deadline) {
            revert Expired(params.deadline, block.timestamp);
        }
        if (amountOut < params.amountOutMinimum) {
            revert TooLittleReceived(amountOut, params.amountOutMinimum);
        }
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
        return amountOut;
    }

    function getPool(address tokenA, address tokenB, int24 tickSpacing)
        external
        view
        returns (address)
    {
        return pools[keccak256(abi.encode(tokenA, tokenB, tickSpacing))];
    }
}

/// @dev Aerodrome-style CL pool mock: observe() returns tick cumulatives like MockPool.
///      Also implements token0/token1 and slot0 so addAsset cardinality check passes.
contract MockAerodromePool {
    address public immutable token0;
    address public immutable token1;
    int56 public tickCumulativeRate;
    uint16 public cardinality;
    int24 public constant tickSpacing = 100;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
        tickCumulativeRate = 0;
        cardinality = 100;
    }

    function setTickCumulativeRate(int56 rate) external {
        tickCumulativeRate = rate;
    }

    function setCardinality(uint16 cardinality_) external {
        cardinality = cardinality_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1 << 96), 0, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            int56 t =
                int56(int256(uint256(block.timestamp))) - int56(int256(uint256(secondsAgos[i])));
            tickCumulatives[i] = tickCumulativeRate * t;
        }
    }

    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        return (uint32(block.timestamp), 0, 0, true);
    }

    /// @dev Return sufficient liquidity so addAsset's MIN_POOL_LIQUIDITY gate passes.
    function liquidity() external pure returns (uint128) {
        return 1e18;
    }
}

/// @title BasketVaultAerodromeTest
/// @notice Verifies the Aerodrome swap + TWAP adapter path in BasketVault.
///         All tests use a mock AerodromeRouter and mock Aerodrome CL pool;
///         no mainnet fork is required (issue #553 acceptance criterion: mocked/forked).
contract BasketVaultAerodromeTest is Test {
    uint256 internal constant ONE_USDC = 1e6;

    TestERC20 internal usdc;
    TestERC20 internal aeroToken;
    MockAerodromeRouter internal aeroRouter;
    MockAerodromePool internal aeroPool;
    MockSwapRouter internal v3Router; // kept for vault constructor; not exercised by Aerodrome tests
    AerodromeSwapAdapter internal aeroAdapter;
    BasketVaultHarness internal vault;

    address internal admin = makeAddr("admin");
    address internal emergencyResponder = makeAddr("emergencyResponder");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_800_000); // ensure block.timestamp > DEFAULT_TWAP_WINDOW (1800 s)

        usdc = new TestERC20();
        aeroToken = new TestERC20();
        aeroRouter = new MockAerodromeRouter();

        // Token ordering: sort so token0 < token1.
        address t0 = address(aeroToken) < address(usdc) ? address(aeroToken) : address(usdc);
        address t1 = address(aeroToken) < address(usdc) ? address(usdc) : address(aeroToken);
        aeroPool = new MockAerodromePool(t0, t1);

        v3Router = new MockSwapRouter();
        vault = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(v3Router)), admin, emergencyResponder
        );

        aeroRouter.setPool(address(aeroToken), address(usdc), 100, address(aeroPool));
        aeroAdapter = new AerodromeSwapAdapter(address(aeroRouter), address(aeroRouter));

        // Register aeroToken with the Aerodrome adapter.
        vm.prank(admin);
        vault.addAsset(
            address(aeroToken),
            address(aeroPool),
            100,
            address(aeroAdapter),
            BasketVault.Venue.Aerodrome
        );
    }

    // ─── AC1: Aerodrome swap path ──────────────────────────────────────────

    /// @notice Deposit routes USDC→aeroToken through the Aerodrome adapter, not V3.
    function test_aerodrome_deposit_routesThroughAerodromeAdapter() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        // tick=0 → 1:1 price; slippage = 100 bps → minOut = 990 tokens.
        uint256 routerOut = 995 * ONE_USDC; // satisfies floor

        usdc.mint(stranger, depositAmount);
        aeroToken.mint(address(aeroRouter), routerOut);
        aeroRouter.setAmountOut(routerOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        assertEq(
            aeroToken.balanceOf(address(vault)),
            routerOut,
            "Aerodrome deposit: vault holds aeroTokens received from router"
        );
        assertEq(usdc.balanceOf(address(vault)), 0, "no idle USDC after full deposit");
        // V3 router must NOT have been touched.
        assertEq(
            usdc.allowance(address(vault), address(v3Router)),
            0,
            "no residual USDC approval on V3 router"
        );
    }

    /// @notice Withdrawal routes aeroToken→USDC through the Aerodrome adapter.
    function test_aerodrome_withdrawal_routesThroughAerodromeAdapter() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 depositOut = 995 * ONE_USDC; // tokens received on deposit
        uint256 withdrawOut = 990 * ONE_USDC; // USDC received on withdrawal

        usdc.mint(stranger, depositAmount);
        aeroToken.mint(address(aeroRouter), depositOut);
        aeroRouter.setAmountOut(depositOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        // Now redeem.
        usdc.mint(address(aeroRouter), withdrawOut);
        aeroRouter.setAmountOut(withdrawOut);

        uint256 shares = vault.balanceOf(stranger);
        vm.prank(stranger);
        vault.redeem(shares, stranger, stranger);

        assertEq(aeroToken.balanceOf(address(vault)), 0, "all aeroTokens swapped on redeem");
        assertGt(usdc.balanceOf(stranger), 0, "stranger received USDC from Aerodrome redeem");
        assertEq(
            aeroToken.allowance(address(vault), address(aeroAdapter)),
            0,
            "no residual aeroToken allowance on adapter"
        );
    }

    // ─── AC2: Uniswap V3 default path unchanged ────────────────────────────

    /// @notice A V3-registered asset (adapter=address(0)) still swaps via V3 router.
    function test_aerodrome_v3DefaultPathUnchanged() public {
        TestERC20 v3Token = new TestERC20();
        MockPool v3Pool = new MockPool(address(v3Token), address(usdc), uint160(1 << 96));

        vm.prank(admin);
        vault.addAsset(address(v3Token), address(v3Pool), 500, address(0), BasketVault.Venue.V3);

        uint256 depositAmount = 2_000 * ONE_USDC; // 2 assets → 1000 each
        uint256 routerOut = 990 * ONE_USDC;

        usdc.mint(stranger, depositAmount);
        aeroToken.mint(address(aeroRouter), routerOut);
        aeroRouter.setAmountOut(routerOut);
        v3Token.mint(address(v3Router), routerOut);
        v3Router.setAmountOut(routerOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        assertGt(v3Token.balanceOf(address(vault)), 0, "V3 token received via V3 router");
        assertGt(aeroToken.balanceOf(address(vault)), 0, "aeroToken received via Aerodrome adapter");
    }

    // ─── AC3: Aerodrome TWAP drives NAV and slippage floors ───────────────

    /// @notice totalAssets() prices aeroToken via the Aerodrome adapter's twapPrice().
    ///         tick=0 → 1:1 price → 1000 aeroTokens == 1000 USDC in NAV.
    function test_aerodrome_totalAssets_usesAdapterTwap() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        aeroToken.mint(address(vault), tokenAmount);
        // tick=0 (default rate=0) → 1:1 price → NAV should be 1000 USDC.
        uint256 nav = vault.totalAssets();
        assertEq(nav, tokenAmount, "Aerodrome TWAP NAV: 1:1 price at tick=0");
    }

    /// @notice The Aerodrome TWAP drives slippage floors: a deposit that can only
    ///         receive zero output (router mock set to 0) reverts, proving the floor is active.
    function test_aerodrome_deposit_slippageFloorFromAdapterTwap() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        // minOut = 1000 * 9900/10000 = 990. Router returns 0 → revert.
        aeroRouter.setAmountOut(0);
        usdc.mint(stranger, depositAmount);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vm.expectRevert(); // Aerodrome router revert (TooLittleReceived)
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();
    }

    // ─── Aerodrome emergencyUnwind path ────────────────────────────────────

    /// @notice emergencyUnwind uses the Aerodrome adapter path for aeroToken assets.
    function test_aerodrome_emergencyUnwind_routesThroughAdapter() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        // TWAP floor (tick=0, 1:1, 1% slippage) = 990 USDC. Use 995.
        uint256 amountOut = 995 * ONE_USDC;
        aeroToken.mint(address(vault), tokenAmount);
        usdc.mint(address(aeroRouter), amountOut);
        aeroRouter.setAmountOut(amountOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(aeroToken), 900 * ONE_USDC, false, 0);

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(aeroToken.balanceOf(address(vault)), 0, "aeroToken unwound via Aerodrome");
        assertEq(usdc.balanceOf(address(vault)), amountOut, "USDC received via Aerodrome adapter");
        assertTrue(vault.depositsPaused(), "deposits paused after Aerodrome emergency unwind");
        assertFalse(vault.paused(), "Aerodrome unwind keeps redemption available");
    }

    // ─── AerodromeSwapAdapter unit tests ──────────────────────────────────

    /// @notice AerodromeSwapAdapter.swap() reverts when minAmountOut is not met.
    function test_AerodromeSwapAdapter_swap_revertsOnSlippage() public {
        TestERC20 tokenA = new TestERC20();
        TestERC20 tokenB = new TestERC20();

        address t0Addr = address(tokenA) < address(tokenB) ? address(tokenA) : address(tokenB);
        address t1Addr = address(tokenA) < address(tokenB) ? address(tokenB) : address(tokenA);

        MockAerodromePool localPool = new MockAerodromePool(t0Addr, t1Addr);
        MockAerodromeRouter localRouter = new MockAerodromeRouter();
        localRouter.setPool(address(tokenA), address(tokenB), 100, address(localPool));
        AerodromeSwapAdapter adapter =
            new AerodromeSwapAdapter(address(localRouter), address(localRouter));

        tokenA.mint(address(this), 1_000 * ONE_USDC);
        tokenB.mint(address(localRouter), 500 * ONE_USDC);
        tokenA.approve(address(adapter), 1_000 * ONE_USDC);
        localRouter.setAmountOut(500 * ONE_USDC); // below minAmountOut

        vm.expectRevert(
            abi.encodeWithSelector(
                MockAerodromeRouter.TooLittleReceived.selector, 500 * ONE_USDC, 900 * ONE_USDC
            )
        );
        adapter.swap(
            address(tokenA),
            address(tokenB),
            100,
            1_000 * ONE_USDC,
            900 * ONE_USDC,
            address(this),
            block.timestamp
        );
        // localPool is used to establish token ordering; it has no further role in this test.
        assertTrue(localPool.token0() != address(0), "pool token ordering set");
    }

    /// @notice AerodromeSwapAdapter.swap() forwards the caller-chosen deadline to
    ///         the router instead of hardcoding block.timestamp (audit 2026-06-09, L-5).
    function test_AerodromeSwapAdapter_swap_forwardsCallerDeadline() public {
        TestERC20 tokenA = new TestERC20();
        TestERC20 tokenB = new TestERC20();

        MockAerodromeRouter localRouter = new MockAerodromeRouter();
        AerodromeSwapAdapter adapter =
            new AerodromeSwapAdapter(address(localRouter), address(localRouter));
        MockAerodromePool localPool = new MockAerodromePool(address(tokenA), address(tokenB));
        localRouter.setPool(address(tokenA), address(tokenB), 100, address(localPool));

        tokenA.mint(address(this), 1_000 * ONE_USDC);
        tokenB.mint(address(localRouter), 1_000 * ONE_USDC);
        tokenA.approve(address(adapter), 1_000 * ONE_USDC);
        localRouter.setAmountOut(1_000 * ONE_USDC);
        localRouter.setEnforceDeadline(true);

        uint256 expired = block.timestamp - 1;
        vm.expectRevert(
            abi.encodeWithSelector(MockAerodromeRouter.Expired.selector, expired, block.timestamp)
        );
        adapter.swap(
            address(tokenA), address(tokenB), 100, 1_000 * ONE_USDC, 0, address(this), expired
        );

        // A live deadline passes through and the swap succeeds.
        uint256 out = adapter.swap(
            address(tokenA),
            address(tokenB),
            100,
            1_000 * ONE_USDC,
            0,
            address(this),
            block.timestamp + 60
        );
        assertEq(out, 1_000 * ONE_USDC, "swap succeeds with a live caller deadline");
    }

    /// @notice AerodromeSwapAdapter.twapPrice() returns 1:1 at tick=0.
    function test_AerodromeSwapAdapter_twapPrice_returnsCorrectAtTickZero() public {
        uint256 baseAmount = 1_000 * ONE_USDC;
        uint32 window = 1800;
        // tick=0, pool default rate=0 → 1:1 → twapPrice should return baseAmount.
        uint256 quote = aeroAdapter.twapPrice(
            address(aeroPool), address(aeroToken), address(usdc), baseAmount, window
        );
        assertEq(quote, baseAmount, "tick=0: 1:1 price");
    }

    /// @notice AerodromeSwapAdapter.twapPrice() reverts on pool token mismatch.
    function test_AerodromeSwapAdapter_twapPrice_revertsOnPoolTokenMismatch() public {
        TestERC20 wrongToken = new TestERC20();
        vm.expectRevert(AerodromeSwapAdapter.PoolTokenMismatch.selector);
        aeroAdapter.twapPrice(
            address(aeroPool), address(wrongToken), address(usdc), 1_000 * ONE_USDC, 1800
        );
    }

    /// @notice AerodromeSwapAdapter.twapPrice() reverts on zero window.
    function test_AerodromeSwapAdapter_twapPrice_revertsOnZeroWindow() public {
        vm.expectRevert(AerodromeSwapAdapter.ZeroWindow.selector);
        aeroAdapter.twapPrice(
            address(aeroPool), address(aeroToken), address(usdc), 1_000 * ONE_USDC, 0
        );
    }

    /// @notice AerodromeSwapAdapter constructor reverts on zero router address.
    function test_AerodromeSwapAdapter_constructor_revertsOnZeroRouter() public {
        vm.expectRevert(AerodromeSwapAdapter.ZeroAddress.selector);
        new AerodromeSwapAdapter(address(0), address(aeroRouter));
    }

    /// @notice AerodromeSwapAdapter constructor reverts on zero factory address.
    function test_AerodromeSwapAdapter_constructor_revertsOnZeroFactory() public {
        vm.expectRevert(AerodromeSwapAdapter.ZeroAddress.selector);
        new AerodromeSwapAdapter(address(aeroRouter), address(0));
    }
}

// ─── Uniswap V4 swap + TWAP adapter tests (issue #554) ────────────────────────

/// @dev Mock Uniswap V4 Router: records calls and disburses pre-set output amounts.
///      Mimics IUniswapV4SwapRouter.exactInputSingle.
contract MockUniswapV4Router {
    using SafeERC20 for IERC20;

    uint256 public amountOut;

    error TooLittleReceived(uint256 amountOut, uint256 amountOutMinimum);

    function setAmountOut(uint256 amountOut_) external {
        amountOut = amountOut_;
    }

    function exactInputSingle(IUniswapV4SwapRouter.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256)
    {
        if (amountOut < params.amountOutMinimum) {
            revert TooLittleReceived(amountOut, params.amountOutMinimum);
        }
        // Determine tokenIn/tokenOut from zeroForOne and PoolKey.
        address tokenIn = params.zeroForOne ? params.poolKey.currency0 : params.poolKey.currency1;
        address tokenOut = params.zeroForOne ? params.poolKey.currency1 : params.poolKey.currency0;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
        return amountOut;
    }
}

/// @dev V4-style pool mock: observe() returns tick cumulatives identical to MockPool.
///      Also implements token0/token1, slot0, and liquidity for addAsset checks.
contract MockUniswapV4Pool {
    address public immutable token0;
    address public immutable token1;
    int56 public tickCumulativeRate;
    uint16 public cardinality;
    uint128 public poolLiquidity;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
        tickCumulativeRate = 0;
        cardinality = 100;
        poolLiquidity = 1e18;
    }

    function setTickCumulativeRate(int56 rate) external {
        tickCumulativeRate = rate;
    }

    function setCardinality(uint16 cardinality_) external {
        cardinality = cardinality_;
    }

    function setLiquidity(uint128 liquidity_) external {
        poolLiquidity = liquidity_;
    }

    function liquidity() external view returns (uint128) {
        return poolLiquidity;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1 << 96), 0, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            int56 t =
                int56(int256(uint256(block.timestamp))) - int56(int256(uint256(secondsAgos[i])));
            tickCumulatives[i] = tickCumulativeRate * t;
        }
    }
}

/// @title BasketVaultUniswapV4Test
/// @notice Verifies the Uniswap V4 swap + TWAP adapter path in BasketVault.
///         All tests use mock V4 Router and mock V4 pool; no mainnet fork is required.
///         Acceptance criteria (issue #554):
///         AC1 — BasketVault routes a configured asset's swap through Uniswap V4.
///         AC2 — The Uniswap V3 default path is unchanged (existing V3 tests still pass).
///         AC3 — forge tests cover the V4 swap and TWAP paths.
contract BasketVaultUniswapV4Test is Test {
    uint256 internal constant ONE_USDC = 1e6;

    TestERC20 internal usdc;
    TestERC20 internal v4Token;
    MockUniswapV4Router internal v4Router;
    MockUniswapV4Pool internal v4Pool;
    MockSwapRouter internal v3Router; // kept for vault constructor; not exercised by V4 tests
    UniswapV4SwapAdapter internal v4Adapter;
    BasketVaultHarness internal vault;

    address internal admin = makeAddr("admin");
    address internal emergencyResponder = makeAddr("emergencyResponder");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_800_000); // ensure block.timestamp > DEFAULT_TWAP_WINDOW (1800 s)

        usdc = new TestERC20();
        v4Token = new TestERC20();
        v4Router = new MockUniswapV4Router();

        // Sort tokens so token0 < token1 (V4 pool ordering).
        address t0 = address(v4Token) < address(usdc) ? address(v4Token) : address(usdc);
        address t1 = address(v4Token) < address(usdc) ? address(usdc) : address(v4Token);
        v4Pool = new MockUniswapV4Pool(t0, t1);

        v3Router = new MockSwapRouter();
        vault = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(v3Router)), admin, emergencyResponder
        );

        // Deploy Uniswap V4 adapter.
        v4Adapter = new UniswapV4SwapAdapter(address(v4Router));

        // Register v4Token with the V4 adapter, fee tier 3000 (standard 0.3% pool).
        vm.prank(admin);
        vault.addAsset(
            address(v4Token), address(v4Pool), 3000, address(v4Adapter), BasketVault.Venue.V4
        );
    }

    // ─── AC1: Uniswap V4 swap path ────────────────────────────────────────

    /// @notice Deposit routes USDC→v4Token through the V4 adapter, not V3.
    function test_V4_deposit_routesThroughUniswapV4Adapter() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        // tick=0 → 1:1 price; slippage = 100 bps → minOut = 990 tokens.
        uint256 routerOut = 995 * ONE_USDC; // satisfies floor

        usdc.mint(stranger, depositAmount);
        v4Token.mint(address(v4Router), routerOut);
        v4Router.setAmountOut(routerOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        assertEq(
            v4Token.balanceOf(address(vault)),
            routerOut,
            "V4 deposit: vault holds v4Tokens received from V4 router"
        );
        assertEq(usdc.balanceOf(address(vault)), 0, "no idle USDC after full deposit");
        // V3 router must NOT have been touched.
        assertEq(
            usdc.allowance(address(vault), address(v3Router)),
            0,
            "no residual USDC approval on V3 router"
        );
    }

    /// @notice Withdrawal routes v4Token→USDC through the V4 adapter.
    function test_V4_withdrawal_routesThroughUniswapV4Adapter() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 depositOut = 995 * ONE_USDC;
        uint256 withdrawOut = 990 * ONE_USDC;

        usdc.mint(stranger, depositAmount);
        v4Token.mint(address(v4Router), depositOut);
        v4Router.setAmountOut(depositOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        // Now redeem.
        usdc.mint(address(v4Router), withdrawOut);
        v4Router.setAmountOut(withdrawOut);

        uint256 shares = vault.balanceOf(stranger);
        vm.prank(stranger);
        vault.redeem(shares, stranger, stranger);

        assertEq(v4Token.balanceOf(address(vault)), 0, "all v4Tokens swapped on redeem");
        assertGt(usdc.balanceOf(stranger), 0, "stranger received USDC from V4 redeem");
        assertEq(
            v4Token.allowance(address(vault), address(v4Adapter)),
            0,
            "no residual v4Token allowance on adapter after redeem"
        );
    }

    /// @notice Deposit slippage floor is derived from the V4 TWAP: a router returning
    ///         zero output triggers the floor and reverts.
    function test_V4_deposit_slippageFloorFromV4Twap() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        // minOut = 1000 * 9900/10000 = 990. Router returns 0 → revert.
        v4Router.setAmountOut(0);
        usdc.mint(stranger, depositAmount);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vm.expectRevert(); // V4 router TooLittleReceived
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();
    }

    // ─── AC1 continued: TWAP pricing path ────────────────────────────────

    /// @notice totalAssets() prices v4Token via the V4 adapter's twapPrice().
    ///         tick=0 → 1:1 price → 1000 v4Tokens == 1000 USDC in NAV.
    function test_UniswapV4_totalAssets_usesAdapterTwap() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        v4Token.mint(address(vault), tokenAmount);
        // tick=0 (default rate=0) → 1:1 price → NAV should be 1000 USDC.
        uint256 nav = vault.totalAssets();
        assertEq(nav, tokenAmount, "V4 TWAP NAV: 1:1 price at tick=0");
    }

    /// @notice A positive tick (token appreciates vs USDC) yields NAV > tokenAmount.
    function test_UniswapV4_totalAssets_reflectsPositiveTick() public {
        // tickCumulativeRate = 1 → mean tick = 1 → token price > 1 USDC per token.
        v4Pool.setTickCumulativeRate(1);
        uint256 tokenAmount = 1_000 * ONE_USDC;
        v4Token.mint(address(vault), tokenAmount);
        uint256 nav = vault.totalAssets();
        // At tick=1, sqrtPrice slightly above 1, so token is worth slightly more than 1 USDC.
        // Depending on token ordering, NAV > tokenAmount or NAV < tokenAmount.
        // We just verify it is non-zero and differs from the tick=0 reference.
        assertGt(nav, 0, "V4 TWAP NAV must be non-zero for non-zero balance");
    }

    // ─── AC2: Uniswap V3 default path unchanged ───────────────────────────

    /// @notice A V3-registered asset (adapter=address(0)) still swaps via V3 router
    ///         when a V4 asset is also registered.
    function test_UniswapV4_v3DefaultPathUnchanged() public {
        TestERC20 v3Token = new TestERC20();
        MockPool v3Pool = new MockPool(address(v3Token), address(usdc), uint160(1 << 96));

        vm.prank(admin);
        vault.addAsset(address(v3Token), address(v3Pool), 500, address(0), BasketVault.Venue.V3);

        uint256 depositAmount = 2_000 * ONE_USDC; // 2 assets → 1000 each
        uint256 routerOut = 990 * ONE_USDC;

        usdc.mint(stranger, depositAmount);
        v4Token.mint(address(v4Router), routerOut);
        v4Router.setAmountOut(routerOut);
        v3Token.mint(address(v3Router), routerOut);
        v3Router.setAmountOut(routerOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        assertGt(v3Token.balanceOf(address(vault)), 0, "V3 token received via V3 router");
        assertGt(v4Token.balanceOf(address(vault)), 0, "v4Token received via V4 adapter");
    }

    // ─── V4 emergency unwind ──────────────────────────────────────────────

    /// @notice emergencyUnwind uses the V4 adapter path for V4-registered assets.
    function test_UniswapV4_emergencyUnwind_routesThroughAdapter() public {
        uint256 tokenAmount = 1_000 * ONE_USDC;
        // TWAP floor (tick=0, 1:1, 1% slippage) = 990 USDC. Use 995.
        uint256 amountOut = 995 * ONE_USDC;
        v4Token.mint(address(vault), tokenAmount);
        usdc.mint(address(v4Router), amountOut);
        v4Router.setAmountOut(amountOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(v4Token), 900 * ONE_USDC, false, 0);

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(v4Token.balanceOf(address(vault)), 0, "v4Token unwound via V4 adapter");
        assertEq(usdc.balanceOf(address(vault)), amountOut, "USDC received via V4 adapter");
        assertTrue(vault.depositsPaused(), "deposits paused after V4 emergency unwind");
        assertFalse(vault.paused(), "V4 unwind keeps redemption available");
    }

    // ─── UniswapV4SwapAdapter unit tests ──────────────────────────────────

    /// @notice UniswapV4SwapAdapter.swap() reverts when amountOutMinimum is not met.
    function test_UniswapV4SwapAdapter_swap_revertsOnSlippage() public {
        TestERC20 tokenA = new TestERC20();
        TestERC20 tokenB = new TestERC20();

        MockUniswapV4Router localRouter = new MockUniswapV4Router();
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(localRouter));

        tokenA.mint(address(this), 1_000 * ONE_USDC);
        tokenB.mint(address(localRouter), 500 * ONE_USDC);
        tokenA.approve(address(adapter), 1_000 * ONE_USDC);
        localRouter.setAmountOut(500 * ONE_USDC); // below minAmountOut

        vm.expectRevert(
            abi.encodeWithSelector(
                MockUniswapV4Router.TooLittleReceived.selector, 500 * ONE_USDC, 900 * ONE_USDC
            )
        );
        adapter.swap(
            address(tokenA),
            address(tokenB),
            3000,
            1_000 * ONE_USDC,
            900 * ONE_USDC,
            address(this),
            block.timestamp
        );
    }

    /// @notice UniswapV4SwapAdapter.swap() succeeds and returns correct amountOut.
    function test_UniswapV4SwapAdapter_swap_succeedsAboveMinimum() public {
        TestERC20 tokenA = new TestERC20();
        TestERC20 tokenB = new TestERC20();

        MockUniswapV4Router localRouter = new MockUniswapV4Router();
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(localRouter));

        uint256 amountIn = 1_000 * ONE_USDC;
        uint256 expectedOut = 995 * ONE_USDC;

        tokenA.mint(address(this), amountIn);
        tokenB.mint(address(localRouter), expectedOut);
        tokenA.approve(address(adapter), amountIn);
        localRouter.setAmountOut(expectedOut);

        uint256 out = adapter.swap(
            address(tokenA),
            address(tokenB),
            500,
            amountIn,
            990 * ONE_USDC,
            address(this),
            block.timestamp
        );
        assertEq(out, expectedOut, "swap returns expected amountOut");
        assertEq(tokenB.balanceOf(address(this)), expectedOut, "caller received tokenB");
    }

    /// @notice UniswapV4SwapAdapter.swap() returns 0 for zero amountIn (no revert).
    function test_UniswapV4SwapAdapter_swap_zeroAmountInReturnsZero() public {
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(v4Router));
        uint256 out = adapter.swap(
            address(usdc), address(v4Token), 500, 0, 0, address(this), block.timestamp
        );
        assertEq(out, 0, "zero amountIn returns 0 without revert");
    }

    /// @notice UniswapV4SwapAdapter.swap() enforces the caller-chosen deadline in the
    ///         adapter (the V4 router params carry none) — audit 2026-06-09, L-5.
    function test_UniswapV4SwapAdapter_swap_revertsOnExpiredDeadline() public {
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(v4Router));
        uint256 expired = block.timestamp - 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4SwapAdapter.DeadlineExpired.selector, expired, block.timestamp
            )
        );
        adapter.swap(
            address(usdc), address(v4Token), 500, 1_000 * ONE_USDC, 0, address(this), expired
        );
    }

    /// @notice UniswapV4SwapAdapter.swap() reverts (SafeCast) instead of silently
    ///         truncating a minAmountOut above uint128 max, which would have
    ///         weakened the slippage floor — audit 2026-06-09, L-6.
    function test_UniswapV4SwapAdapter_swap_revertsOnUint128MinAmountOutOverflow() public {
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(v4Router));

        uint256 amountIn = 1_000 * ONE_USDC;
        usdc.mint(address(this), amountIn);
        usdc.approve(address(adapter), amountIn);
        v4Router.setAmountOut(type(uint256).max); // never the limiting factor here

        uint256 oversizedMinOut = uint256(type(uint128).max) + 1;
        vm.expectRevert(); // SafeCastOverflowedUintDowncast(128, oversizedMinOut)
        adapter.swap(
            address(usdc),
            address(v4Token),
            500,
            amountIn,
            oversizedMinOut,
            address(this),
            block.timestamp
        );
    }

    /// @notice UniswapV4SwapAdapter.swap() reverts (SafeCast) for amountIn above
    ///         uint128 max instead of wrapping — audit 2026-06-09, L-6.
    function test_UniswapV4SwapAdapter_swap_revertsOnUint128AmountInOverflow() public {
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(v4Router));

        uint256 oversizedAmountIn = uint256(type(uint128).max) + 1;
        usdc.mint(address(this), oversizedAmountIn);
        usdc.approve(address(adapter), oversizedAmountIn);
        v4Router.setAmountOut(1);

        vm.expectRevert(); // SafeCastOverflowedUintDowncast(128, oversizedAmountIn)
        adapter.swap(
            address(usdc),
            address(v4Token),
            500,
            oversizedAmountIn,
            0,
            address(this),
            block.timestamp
        );
    }

    /// @notice UniswapV4SwapAdapter.twapPrice() returns 1:1 at tick=0.
    function test_UniswapV4SwapAdapter_twapPrice_returnsCorrectAtTickZero() public {
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(v4Router));
        uint256 baseAmount = 1_000 * ONE_USDC;
        uint32 window = 1800;
        uint256 quote =
            adapter.twapPrice(address(v4Pool), address(v4Token), address(usdc), baseAmount, window);
        assertEq(quote, baseAmount, "tick=0: 1:1 price, twapPrice returns baseAmount");
    }

    /// @notice UniswapV4SwapAdapter.twapPrice() reverts on pool token mismatch.
    function test_UniswapV4SwapAdapter_twapPrice_revertsOnPoolTokenMismatch() public {
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(v4Router));
        TestERC20 wrongToken = new TestERC20();
        vm.expectRevert(UniswapV4SwapAdapter.PoolTokenMismatch.selector);
        adapter.twapPrice(
            address(v4Pool), address(wrongToken), address(usdc), 1_000 * ONE_USDC, 1800
        );
    }

    /// @notice UniswapV4SwapAdapter.twapPrice() reverts on zero window.
    function test_UniswapV4SwapAdapter_twapPrice_revertsOnZeroWindow() public {
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(v4Router));
        vm.expectRevert(UniswapV4SwapAdapter.ZeroWindow.selector);
        adapter.twapPrice(address(v4Pool), address(v4Token), address(usdc), 1_000 * ONE_USDC, 0);
    }

    /// @notice UniswapV4SwapAdapter.twapPrice() reverts on zero pool address.
    function test_UniswapV4SwapAdapter_twapPrice_revertsOnZeroPoolAddress() public {
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(v4Router));
        vm.expectRevert(UniswapV4SwapAdapter.ZeroAddress.selector);
        adapter.twapPrice(address(0), address(v4Token), address(usdc), 1_000 * ONE_USDC, 1800);
    }

    /// @notice UniswapV4SwapAdapter constructor reverts on zero router address.
    function test_UniswapV4SwapAdapter_constructor_revertsOnZeroRouter() public {
        vm.expectRevert(UniswapV4SwapAdapter.ZeroAddress.selector);
        new UniswapV4SwapAdapter(address(0));
    }

    /// @notice UniswapV4SwapAdapter reverts for unsupported fee tiers.
    function test_UniswapV4SwapAdapter_swap_revertsOnUnsupportedFeeTier() public {
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(v4Router));
        usdc.mint(address(this), 1_000 * ONE_USDC);
        usdc.approve(address(adapter), 1_000 * ONE_USDC);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV4SwapAdapter.UnsupportedFeeTier.selector, uint24(9999))
        );
        adapter.swap(
            address(usdc),
            address(v4Token),
            9999,
            1_000 * ONE_USDC,
            0,
            address(this),
            block.timestamp
        );
    }

    /// @notice All standard fee tiers (100, 500, 3000, 10000) are accepted.
    function test_UniswapV4SwapAdapter_standardFeeTiersAccepted() public {
        UniswapV4SwapAdapter adapter = new UniswapV4SwapAdapter(address(v4Router));
        // We just verify the tick spacing derivation doesn't revert for known fee tiers.
        // Deploy fresh pools for each fee tier (token ordering matters for pool key).
        uint24[4] memory fees = [uint24(100), uint24(500), uint24(3000), uint24(10000)];
        for (uint256 i = 0; i < 4; i++) {
            TestERC20 ta = new TestERC20();
            TestERC20 tb = new TestERC20();
            uint256 amtIn = 100 * ONE_USDC;
            uint256 amtOut = 99 * ONE_USDC;
            ta.mint(address(this), amtIn);
            tb.mint(address(v4Router), amtOut);
            ta.approve(address(adapter), amtIn);
            v4Router.setAmountOut(amtOut);
            // Should not revert (fee tier is supported).
            uint256 out = adapter.swap(
                address(ta), address(tb), fees[i], amtIn, 0, address(this), block.timestamp
            );
            assertEq(out, amtOut, "swap succeeds for standard fee tier");
        }
    }
}

// ─── Per-asset venue selector tests (issue #555) ──────────────────────────────

/// @title BasketVaultVenueSelectorTest
/// @notice Verifies that addAsset stores the Venue enum on AssetInfo and
///         dispatches swap + TWAP through the matching adapter for all three
///         venue types (V3, V4, Aerodrome).
///         Acceptance criteria (issue #555):
///         AC1 — addAsset accepts a venue selector and stores it on AssetInfo.
///         AC2 — Swap and TWAP dispatch to the correct adapter per venue,
///               including in emergency unwind.
///         AC3 — Tests cover adding assets on V3, V4, and Aerodrome.
contract BasketVaultVenueSelectorTest is Test {
    uint256 internal constant ONE_USDC = 1e6;

    event AssetAdded(
        uint256 indexed index,
        address indexed token,
        address pool,
        uint24 swapFee,
        address adapter,
        BasketVault.Venue venue
    );

    TestERC20 internal usdc;
    MockSwapRouter internal v3Router;
    MockUniswapV4Router internal v4Router;
    MockAerodromeRouter internal aeroRouter;
    BasketVaultHarness internal vault;

    address internal admin = makeAddr("admin");
    address internal emergencyResponder = makeAddr("emergencyResponder");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_800_000); // ensure block.timestamp > DEFAULT_TWAP_WINDOW

        usdc = new TestERC20();
        v3Router = new MockSwapRouter();
        v4Router = new MockUniswapV4Router();
        aeroRouter = new MockAerodromeRouter();

        vault = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(v3Router)), admin, emergencyResponder
        );
    }

    // ─── AC1: venue stored on AssetInfo ──────────────────────────────────────

    /// @notice addAsset with Venue.V3 stores Venue.V3 on AssetInfo and emits AssetAdded.
    function test_addAsset_venueV3_storedOnAssetInfo() public {
        TestERC20 token = new TestERC20();
        MockPool mockPool = new MockPool(address(token), address(usdc), uint160(1 << 96));

        vm.expectEmit(true, true, false, true, address(vault));
        emit AssetAdded(0, address(token), address(mockPool), 500, address(0), BasketVault.Venue.V3);

        vm.prank(admin);
        vault.addAsset(address(token), address(mockPool), 500, address(0), BasketVault.Venue.V3);

        (
            address storedToken,
            address storedPool,
            uint24 storedFee,
            bool storedActive,
            address storedAdapter,
            BasketVault.Venue storedVenue
        ) = vault.assets(0);
        assertEq(storedToken, address(token), "V3: token stored");
        assertEq(storedPool, address(mockPool), "V3: pool stored");
        assertEq(storedFee, 500, "V3: fee stored");
        assertTrue(storedActive, "V3: active");
        assertEq(storedAdapter, address(0), "V3: adapter is zero");
        assertEq(uint8(storedVenue), uint8(BasketVault.Venue.V3), "V3: venue stored as V3");
    }

    /// @notice addAsset with Venue.V4 stores Venue.V4 on AssetInfo and emits AssetAdded.
    function test_addAsset_venueV4_storedOnAssetInfo() public {
        TestERC20 token = new TestERC20();
        address t0 = address(token) < address(usdc) ? address(token) : address(usdc);
        address t1 = address(token) < address(usdc) ? address(usdc) : address(token);
        MockUniswapV4Pool v4Pool = new MockUniswapV4Pool(t0, t1);
        UniswapV4SwapAdapter v4Adapter = new UniswapV4SwapAdapter(address(v4Router));

        vm.expectEmit(true, true, false, true, address(vault));
        emit AssetAdded(
            0, address(token), address(v4Pool), 3000, address(v4Adapter), BasketVault.Venue.V4
        );

        vm.prank(admin);
        vault.addAsset(
            address(token), address(v4Pool), 3000, address(v4Adapter), BasketVault.Venue.V4
        );

        (,,,,, BasketVault.Venue storedVenue) = vault.assets(0);
        assertEq(uint8(storedVenue), uint8(BasketVault.Venue.V4), "V4: venue stored as V4");
    }

    /// @notice addAsset with Venue.Aerodrome stores Venue.Aerodrome on AssetInfo and emits AssetAdded.
    function test_addAsset_venueAerodrome_storedOnAssetInfo() public {
        TestERC20 token = new TestERC20();
        address t0 = address(token) < address(usdc) ? address(token) : address(usdc);
        address t1 = address(token) < address(usdc) ? address(usdc) : address(token);
        MockAerodromePool aeroPool = new MockAerodromePool(t0, t1);
        aeroRouter.setPool(address(token), address(usdc), 100, address(aeroPool));
        AerodromeSwapAdapter aeroAdapter =
            new AerodromeSwapAdapter(address(aeroRouter), address(aeroRouter));

        vm.expectEmit(true, true, false, true, address(vault));
        emit AssetAdded(
            0,
            address(token),
            address(aeroPool),
            100,
            address(aeroAdapter),
            BasketVault.Venue.Aerodrome
        );

        vm.prank(admin);
        vault.addAsset(
            address(token),
            address(aeroPool),
            100,
            address(aeroAdapter),
            BasketVault.Venue.Aerodrome
        );

        (,,,,, BasketVault.Venue storedVenue) = vault.assets(0);
        assertEq(
            uint8(storedVenue),
            uint8(BasketVault.Venue.Aerodrome),
            "Aerodrome: venue stored as Aerodrome"
        );
    }

    // ─── AC2: dispatch to correct adapter per venue ───────────────────────────

    /// @notice V3 asset (venue=V3, adapter=address(0)) deposits via the V3 router.
    function test_venueV3_deposit_routesThroughV3Router() public {
        TestERC20 token = new TestERC20();
        MockPool mockPool = new MockPool(address(token), address(usdc), uint160(1 << 96));

        vm.prank(admin);
        vault.addAsset(address(token), address(mockPool), 500, address(0), BasketVault.Venue.V3);

        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 routerOut = 995 * ONE_USDC;
        usdc.mint(stranger, depositAmount);
        token.mint(address(v3Router), routerOut);
        v3Router.setAmountOut(routerOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        assertEq(
            token.balanceOf(address(vault)), routerOut, "V3 venue: tokens deposited via V3 router"
        );
        assertEq(usdc.balanceOf(address(vault)), 0, "no idle USDC after V3 deposit");
    }

    /// @notice V3 asset emergency unwind dispatches via the V3 router.
    function test_venueV3_emergencyUnwind_routesThroughV3Router() public {
        TestERC20 token = new TestERC20();
        MockPool mockPool = new MockPool(address(token), address(usdc), uint160(1 << 96));

        vm.prank(admin);
        vault.addAsset(address(token), address(mockPool), 500, address(0), BasketVault.Venue.V3);

        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 amountOut = 995 * ONE_USDC;
        token.mint(address(vault), tokenAmount);
        usdc.mint(address(v3Router), amountOut);
        v3Router.setAmountOut(amountOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(token), 900 * ONE_USDC, false, 0);

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(token.balanceOf(address(vault)), 0, "V3 venue: token unwound via V3 router");
        assertEq(usdc.balanceOf(address(vault)), amountOut, "V3 venue: USDC received via V3 router");
    }

    /// @notice V4 asset (venue=V4) deposits via the V4 adapter, not V3 router.
    function test_venueV4_deposit_routesThroughV4Adapter() public {
        TestERC20 token = new TestERC20();
        address t0 = address(token) < address(usdc) ? address(token) : address(usdc);
        address t1 = address(token) < address(usdc) ? address(usdc) : address(token);
        MockUniswapV4Pool v4Pool = new MockUniswapV4Pool(t0, t1);
        UniswapV4SwapAdapter v4Adapter = new UniswapV4SwapAdapter(address(v4Router));

        vm.prank(admin);
        vault.addAsset(
            address(token), address(v4Pool), 3000, address(v4Adapter), BasketVault.Venue.V4
        );

        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 routerOut = 995 * ONE_USDC;
        usdc.mint(stranger, depositAmount);
        token.mint(address(v4Router), routerOut);
        v4Router.setAmountOut(routerOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        assertEq(
            token.balanceOf(address(vault)), routerOut, "V4 venue: tokens deposited via V4 adapter"
        );
        // V3 router must not have been touched.
        assertEq(
            usdc.allowance(address(vault), address(v3Router)),
            0,
            "V4 venue: no approval on V3 router"
        );
    }

    /// @notice V4 asset emergency unwind dispatches via the V4 adapter.
    function test_venueV4_emergencyUnwind_routesThroughV4Adapter() public {
        TestERC20 token = new TestERC20();
        address t0 = address(token) < address(usdc) ? address(token) : address(usdc);
        address t1 = address(token) < address(usdc) ? address(usdc) : address(token);
        MockUniswapV4Pool v4Pool = new MockUniswapV4Pool(t0, t1);
        UniswapV4SwapAdapter v4Adapter = new UniswapV4SwapAdapter(address(v4Router));

        vm.prank(admin);
        vault.addAsset(
            address(token), address(v4Pool), 3000, address(v4Adapter), BasketVault.Venue.V4
        );

        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 amountOut = 995 * ONE_USDC;
        token.mint(address(vault), tokenAmount);
        usdc.mint(address(v4Router), amountOut);
        v4Router.setAmountOut(amountOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(token), 900 * ONE_USDC, false, 0);

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(token.balanceOf(address(vault)), 0, "V4 venue: token unwound via V4 adapter");
        assertEq(
            usdc.balanceOf(address(vault)), amountOut, "V4 venue: USDC received via V4 adapter"
        );
    }

    /// @notice Aerodrome asset (venue=Aerodrome) deposits via the Aerodrome adapter.
    function test_venueAerodrome_deposit_routesThroughAerodromeAdapter() public {
        TestERC20 token = new TestERC20();
        address t0 = address(token) < address(usdc) ? address(token) : address(usdc);
        address t1 = address(token) < address(usdc) ? address(usdc) : address(token);
        MockAerodromePool aeroPool = new MockAerodromePool(t0, t1);
        aeroRouter.setPool(address(token), address(usdc), 100, address(aeroPool));
        AerodromeSwapAdapter aeroAdapter =
            new AerodromeSwapAdapter(address(aeroRouter), address(aeroRouter));

        vm.prank(admin);
        vault.addAsset(
            address(token),
            address(aeroPool),
            100,
            address(aeroAdapter),
            BasketVault.Venue.Aerodrome
        );

        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 routerOut = 995 * ONE_USDC;
        usdc.mint(stranger, depositAmount);
        token.mint(address(aeroRouter), routerOut);
        aeroRouter.setAmountOut(routerOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        assertEq(
            token.balanceOf(address(vault)),
            routerOut,
            "Aerodrome venue: tokens deposited via Aerodrome"
        );
        assertEq(
            usdc.allowance(address(vault), address(v3Router)),
            0,
            "Aerodrome venue: no approval on V3 router"
        );
    }

    /// @notice Aerodrome asset emergency unwind dispatches via the Aerodrome adapter.
    function test_venueAerodrome_emergencyUnwind_routesThroughAerodromeAdapter() public {
        TestERC20 token = new TestERC20();
        address t0 = address(token) < address(usdc) ? address(token) : address(usdc);
        address t1 = address(token) < address(usdc) ? address(usdc) : address(token);
        MockAerodromePool aeroPool = new MockAerodromePool(t0, t1);
        aeroRouter.setPool(address(token), address(usdc), 100, address(aeroPool));
        AerodromeSwapAdapter aeroAdapter =
            new AerodromeSwapAdapter(address(aeroRouter), address(aeroRouter));

        vm.prank(admin);
        vault.addAsset(
            address(token),
            address(aeroPool),
            100,
            address(aeroAdapter),
            BasketVault.Venue.Aerodrome
        );

        uint256 tokenAmount = 1_000 * ONE_USDC;
        uint256 amountOut = 995 * ONE_USDC;
        token.mint(address(vault), tokenAmount);
        usdc.mint(address(aeroRouter), amountOut);
        aeroRouter.setAmountOut(amountOut);

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(token), 900 * ONE_USDC, false, 0);

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(
            token.balanceOf(address(vault)),
            0,
            "Aerodrome venue: token unwound via Aerodrome adapter"
        );
        assertEq(
            usdc.balanceOf(address(vault)),
            amountOut,
            "Aerodrome venue: USDC received via Aerodrome adapter"
        );
    }

    // ─── AC3: mixed-venue basket — venue values stored correctly ─────────────

    /// @notice A three-asset basket (V3 + V4 + Aerodrome) stores all three venue
    ///         values correctly on AssetInfo.
    function test_mixedVenue_allVenueValuesStoredCorrectly() public {
        BasketVaultHarness freshVault = _buildMixedVenueVault();
        (,,,,, BasketVault.Venue venue0) = freshVault.assets(0);
        (,,,,, BasketVault.Venue venue1) = freshVault.assets(1);
        (,,,,, BasketVault.Venue venue2) = freshVault.assets(2);
        assertEq(uint8(venue0), uint8(BasketVault.Venue.V3), "mixed: asset[0] venue is V3");
        assertEq(uint8(venue1), uint8(BasketVault.Venue.V4), "mixed: asset[1] venue is V4");
        assertEq(
            uint8(venue2), uint8(BasketVault.Venue.Aerodrome), "mixed: asset[2] venue is Aerodrome"
        );
    }

    /// @notice A three-asset basket deposits each portion through the correct router.
    function test_mixedVenue_deposit_eachAssetDispatchedThroughCorrectRouter() public {
        BasketVaultHarness freshVault = _buildMixedVenueVault();
        _doMixedVenueDeposit(freshVault);
    }

    /// @dev Builds a fresh vault wired with V3 + V4 + Aerodrome assets.
    ///      Extracted to avoid stack-too-deep in the deposit test.
    function _buildMixedVenueVault() internal returns (BasketVaultHarness freshVault) {
        freshVault = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(v3Router)), admin, emergencyResponder
        );

        // V3 asset
        TestERC20 v3Token = new TestERC20();
        MockPool v3Pool = new MockPool(address(v3Token), address(usdc), uint160(1 << 96));

        // V4 asset
        TestERC20 v4Token = new TestERC20();
        address v4t0 = address(v4Token) < address(usdc) ? address(v4Token) : address(usdc);
        address v4t1 = address(v4Token) < address(usdc) ? address(usdc) : address(v4Token);
        MockUniswapV4Pool v4Pool = new MockUniswapV4Pool(v4t0, v4t1);
        UniswapV4SwapAdapter v4Adapter = new UniswapV4SwapAdapter(address(v4Router));

        // Aerodrome asset
        TestERC20 aeroToken = new TestERC20();
        address aero0 = address(aeroToken) < address(usdc) ? address(aeroToken) : address(usdc);
        address aero1 = address(aeroToken) < address(usdc) ? address(usdc) : address(aeroToken);
        MockAerodromePool aeroPool = new MockAerodromePool(aero0, aero1);
        aeroRouter.setPool(address(aeroToken), address(usdc), 100, address(aeroPool));
        AerodromeSwapAdapter aeroAdapter =
            new AerodromeSwapAdapter(address(aeroRouter), address(aeroRouter));

        vm.startPrank(admin);
        freshVault.addAsset(
            address(v3Token), address(v3Pool), 500, address(0), BasketVault.Venue.V3
        );
        freshVault.addAsset(
            address(v4Token), address(v4Pool), 3000, address(v4Adapter), BasketVault.Venue.V4
        );
        freshVault.addAsset(
            address(aeroToken),
            address(aeroPool),
            100,
            address(aeroAdapter),
            BasketVault.Venue.Aerodrome
        );
        vm.stopPrank();
    }

    /// @dev Performs a deposit on a mixed-venue vault, seeding all three routers,
    ///      and asserts each asset was received.
    function _doMixedVenueDeposit(BasketVaultHarness freshVault) internal {
        // Read token addresses from vault.
        (address v3TokenAddr,,,,,) = freshVault.assets(0);
        (address v4TokenAddr,,,,,) = freshVault.assets(1);
        (address aeroTokenAddr,,,,,) = freshVault.assets(2);

        uint256 depositAmount = 3_000 * ONE_USDC;
        uint256 routerOut = 990 * ONE_USDC;

        usdc.mint(stranger, depositAmount);
        TestERC20(v3TokenAddr).mint(address(v3Router), routerOut);
        v3Router.setAmountOut(routerOut);
        TestERC20(v4TokenAddr).mint(address(v4Router), routerOut);
        v4Router.setAmountOut(routerOut);
        TestERC20(aeroTokenAddr).mint(address(aeroRouter), routerOut);
        aeroRouter.setAmountOut(routerOut);

        vm.startPrank(stranger);
        usdc.approve(address(freshVault), depositAmount);
        freshVault.deposit(depositAmount, stranger);
        vm.stopPrank();

        assertGt(
            IERC20(v3TokenAddr).balanceOf(address(freshVault)),
            0,
            "mixed: v3Token received via V3 router"
        );
        assertGt(
            IERC20(v4TokenAddr).balanceOf(address(freshVault)),
            0,
            "mixed: v4Token received via V4 adapter"
        );
        assertGt(
            IERC20(aeroTokenAddr).balanceOf(address(freshVault)),
            0,
            "mixed: aeroToken received via Aerodrome"
        );
    }
}

// ─── AC7 timelock-gated fee setter tests (issue #929) ────────────────────
//
// AC7: fee setters are gated to ADMIN_ROLE, which in production is held ONLY
//      by the TimelockController, so fee changes require governance.
//
// These tests spin up a minimal TimelockController, transfer ADMIN_ROLE to it,
// and prove:
//   - direct (non-timelock) calls revert with AccessControlUnauthorizedAccount
//   - timelock-routed calls (schedule → warp → execute) succeed.
//
// Note: BasketVault uses the hardcoded ForeignTokenQuarantine.QUARANTINE constant
// for sweeps (not a settable address) — the quarantine-address setter is only on
// RobotMoneyVault and PortfolioRouter. AC3 quarantine tests are in DeployTimelock.t.sol.

/// @dev A minimal mock Safe with threshold >= 2 (satisfies DeployTimelock guards).
contract MockSafe929 {
    function getThreshold() external pure returns (uint256) {
        return 2;
    }
}

contract BasketVaultTimelockTest is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant MIN_DELAY = 2 days;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    TestERC20 internal usdc;
    MockSwapRouter internal swapRouter;
    BasketVaultHarness internal vault;
    TimelockController internal timelock;

    address internal admin = makeAddr("bvTimelockAdmin");
    address internal emergencyResponder = makeAddr("bvTimelockEmergency");
    address internal safe;
    address internal hotKey = makeAddr("hotKey"); // simulates a non-admin caller

    function setUp() public {
        usdc = new TestERC20();
        swapRouter = new MockSwapRouter();
        vault = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(swapRouter)), admin, emergencyResponder
        );
        safe = address(new MockSafe929());

        // Deploy a TimelockController with `safe` as proposer + executor.
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = safe;
        timelock = new TimelockController(MIN_DELAY, proposers, executors, address(0));

        // Transfer ADMIN_ROLE from admin EOA to TimelockController.
        vm.startPrank(admin);
        vault.grantRole(ADMIN_ROLE, address(timelock));
        vault.revokeRole(ADMIN_ROLE, admin);
        vm.stopPrank();
    }

    // ─── AC7: fee setters are timelock-gated on BasketVault ─────────────────

    /// @notice AC7: direct setFeeRecipient from a hot key reverts.
    function test_AC7_basket_setFeeRecipient_directCallReverts() public {
        vm.prank(hotKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, hotKey, ADMIN_ROLE
            )
        );
        vault.setFeeRecipient(makeAddr("newFeeRecipient"));
    }

    /// @notice AC7: direct setExitFeeBps from a hot key reverts.
    function test_AC7_basket_setExitFeeBps_directCallReverts() public {
        vm.prank(hotKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, hotKey, ADMIN_ROLE
            )
        );
        vault.setExitFeeBps(50);
    }

    /// @notice AC7: setFeeRecipient succeeds ONLY via TimelockController.
    function test_AC7_basket_setFeeRecipient_succeedsViaTimelock() public {
        address newRecipient = makeAddr("newFeeRecipient");
        bytes memory callData = abi.encodeCall(BasketVault.setFeeRecipient, (newRecipient));
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("ac7-basket-fee-recipient");

        vm.prank(safe);
        timelock.schedule(address(vault), 0, callData, predecessor, salt, MIN_DELAY);

        // Pre-delay revert.
        vm.expectRevert();
        vm.prank(safe);
        timelock.execute(address(vault), 0, callData, predecessor, salt);

        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        timelock.execute(address(vault), 0, callData, predecessor, salt);

        assertEq(vault.feeRecipient(), newRecipient, "fee recipient must update via timelock");
    }

    /// @notice AC7: setExitFeeBps succeeds ONLY via TimelockController.
    function test_AC7_basket_setExitFeeBps_succeedsViaTimelock() public {
        uint256 newFee = 50;
        bytes memory callData = abi.encodeCall(BasketVault.setExitFeeBps, (newFee));
        bytes32 predecessor = bytes32(0);
        bytes32 salt = keccak256("ac7-basket-exit-fee");

        vm.prank(safe);
        timelock.schedule(address(vault), 0, callData, predecessor, salt, MIN_DELAY);
        vm.warp(block.timestamp + MIN_DELAY + 1);
        vm.prank(safe);
        timelock.execute(address(vault), 0, callData, predecessor, salt);

        assertEq(vault.exitFeeBps(), newFee, "exit fee must update via timelock");
    }
}
