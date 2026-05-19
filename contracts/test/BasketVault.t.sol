// SPDX-License-Identifier: MIT
// Canonical: docs/security-model.md; docs/technical/security-hardening-seams.md
// Covers: issue #428 — guarded emergency unwind minimums and explicit override events
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

contract MockPool {
    address public immutable token0;
    address public immutable token1;
    uint160 internal immutable sqrtPriceX96;

    constructor(address token0_, address token1_, uint160 sqrtPriceX96_) {
        token0 = token0_;
        token1 = token1_;
        sqrtPriceX96 = sqrtPriceX96_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 0, 0, 0, true);
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
    constructor(IERC20 usdc_, ISwapRouter swapRouter_, address admin_)
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
            admin_
        )
    {}

    function maxAssets() public pure override returns (uint256) {
        return 4;
    }
}

contract BasketVaultTest is Test {
    uint256 internal constant ONE_USDC = 1e6;

    event EmergencyUnwindOverrideUsed(
        address indexed token, uint256 amountIn, uint256 minUsdcOut, address indexed caller
    );

    TestERC20 internal usdc;
    TestERC20 internal basketToken;
    MockSwapRouter internal router;
    MockPool internal pool;
    BasketVaultHarness internal vault;

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new TestERC20();
        basketToken = new TestERC20();
        router = new MockSwapRouter();
        pool = new MockPool(address(basketToken), address(usdc), uint160(1 << 96));
        vault = new BasketVaultHarness(IERC20(address(usdc)), ISwapRouter(address(router)), admin);

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
        vault.setEmergencyUnwindGuard(address(basketToken), minUsdcOut, false);

        vm.expectRevert(
            abi.encodeWithSelector(
                MockSwapRouter.TooLittleReceived.selector, 800 * ONE_USDC, minUsdcOut
            )
        );
        vm.prank(admin);
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
        vault.setEmergencyUnwindGuard(address(basketToken), 900 * ONE_USDC, false);

        vm.prank(admin);
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

        vm.prank(admin);
        vault.setEmergencyUnwindGuard(address(basketToken), 900 * ONE_USDC, true);

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        vm.expectEmit(true, false, false, true, address(vault));
        emit EmergencyUnwindOverrideUsed(address(basketToken), tokenAmount, 900 * ONE_USDC, admin);

        vm.prank(admin);
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

    function test_pauseAndShutdownEmergencyControlsRemainFunctional() public {
        vm.prank(admin);
        vault.pause();
        assertTrue(vault.paused(), "pause remains available");

        vm.prank(admin);
        vault.shutdownVault();
        assertTrue(vault.isShutdown(), "shutdown remains available");
        assertEq(vault.tvlCap(), 0, "shutdown still zeros tvl cap");
    }
}
