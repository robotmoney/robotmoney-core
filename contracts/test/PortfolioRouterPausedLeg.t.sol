// SPDX-License-Identifier: MIT
// Canonical: issue 1705 S2 and Q3 (c): the router's behaviour for a vault-paused leg, pinned for the
//            mainnet test. Update this test when the owner's answer to Q3 (a) lands before the final deployment.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {TestUSDC, MockAdapter} from "./RobotMoneyVault.t.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

/// @notice The router's availability check reads the REGISTRY status and eligibility only. A vault
///         whose own `depositsPaused()` reads true is still Active and eligible, so:
///         - at 0 bps its leg gets amount 0 and is skipped (issue 1746): the router deposit succeeds;
///         - above 0 bps the router calls the vault, which reverts `DepositsArePaused`; the router
///           wraps it as `UsdcLegTransferFailed(vault)` and the whole router deposit reverts (fails
///           closed, no funds move, no USDC stays in the router).
///         Direct deposits into the open vaults and every redeem, the paused vault's included, are
///         unaffected. The four legs are real RobotMoneyVault instances, each with one mock adapter.
contract PortfolioRouterPausedLegTest is Test {
    uint256 internal constant ONE_USDC = 1e6;

    TestUSDC internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RobotMoneyVault[4] internal v; // the launch order: rmUSDC, rmPROTO, rmAGENT, rmRWA

    address internal admin = makeAddr("admin");
    address internal depositor = makeAddr("depositor");

    function setUp() public {
        usdc = new TestUSDC();
        registry = CoreProxies.vaultRegistry(admin);
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), admin);
        for (uint256 i = 0; i < 4; i++) {
            v[i] = CoreProxies.robotMoneyVault(
                IERC20(address(usdc)),
                1_000_000 * ONE_USDC,
                100_000 * ONE_USDC,
                0,
                makeAddr("fees"),
                admin,
                admin
            );
            MockAdapter adapter = new MockAdapter(address(usdc), address(v[i]));
            vm.startPrank(admin);
            v[i].setAdapterAllowed(address(adapter), true);
            v[i].setAdapterCodeHashAllowed(address(adapter).codehash, true);
            v[i].addAdapter(address(adapter), 10_000);
            registry.registerVault(
                address(v[i]),
                VaultRegistry.VaultMetadata({name: "V", asset: address(usdc), registeredAt: 0})
            );
            registry.setRouterEligible(address(v[i]), true);
            vm.stopPrank();
        }
        _setWeights(9500, 500, 0, 0); // the 8453 launch vector
        usdc.mint(depositor, 1_000_000 * ONE_USDC);
        vm.prank(depositor);
        usdc.approve(address(router), type(uint256).max);
    }

    function _setWeights(uint256 a, uint256 b, uint256 c, uint256 d) internal {
        address[] memory vaults = new address[](4);
        uint256[] memory bps = new uint256[](4);
        uint256[4] memory w = [a, b, c, d];
        for (uint256 i = 0; i < 4; i++) {
            vaults[i] = address(v[i]);
            bps[i] = w[i];
        }
        vm.prank(admin);
        router.setWeights(vaults, bps);
    }

    function _pause(uint256 i) internal {
        vm.prank(admin);
        v[i].pauseDeposits();
        assertTrue(v[i].depositsPaused());
        (, VaultRegistry.VaultStatus status) = registry.getVault(address(v[i]));
        assertEq(uint8(status), uint8(VaultRegistry.VaultStatus.Active), "registry still Active");
        assertTrue(registry.isRouterEligible(address(v[i])), "still router-eligible");
    }

    function test_pausedLegAtZeroBps_isSkipped_routerDepositSucceeds() public {
        _pause(2); // rmAGENT at 0 bps
        _pause(3); // rmRWA at 0 bps
        vm.expectCall(address(v[2]), abi.encodeWithSelector(v[2].deposit.selector), 0);
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(10_000 * ONE_USDC, new uint256[](0));
        assertGt(shares[0], 0);
        assertGt(shares[1], 0);
        assertEq(shares[2], 0);
        assertEq(shares[3], 0);
        assertEq(v[0].totalAssets(), 9_500 * ONE_USDC);
        assertEq(v[1].totalAssets(), 500 * ONE_USDC);
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing");
    }

    function test_pausedLegAboveZeroBps_revertsTheWholeRouterDeposit() public {
        _pause(1); // rmPROTO at 500 bps
        // previewDeposit does not see the vault pause: the leg reads available
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(10_000 * ONE_USDC);
        assertFalse(legs[1].unavailable, "a vault-paused leg is not marked unavailable");
        assertEq(legs[1].legAmount, 500 * ONE_USDC);

        uint256 before = usdc.balanceOf(depositor);
        // the vault reverts DepositsArePaused inside the leg; the router wraps it as UsdcLegTransferFailed(vault)
        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.UsdcLegTransferFailed.selector, address(v[1]))
        );
        router.deposit(10_000 * ONE_USDC, new uint256[](0));
        assertEq(usdc.balanceOf(depositor), before, "fails closed: no USDC moved");
        assertEq(v[0].totalAssets(), 0, "the open leg got nothing either");
    }

    function test_pausedLegAboveZeroBps_revertsForTheBaseLegToo() public {
        _pause(0); // rmUSDC at 9500 bps
        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.UsdcLegTransferFailed.selector, address(v[0]))
        );
        router.deposit(10_000 * ONE_USDC, new uint256[](0));
    }

    function test_directDepositsAndEveryRedeemAreUnaffected() public {
        vm.prank(depositor);
        router.deposit(10_000 * ONE_USDC, new uint256[](0));
        _pause(1);
        // a direct deposit into an open vault works
        usdc.mint(address(this), 100 * ONE_USDC);
        usdc.approve(address(v[0]), 100 * ONE_USDC);
        assertGt(v[0].deposit(100 * ONE_USDC, address(this)), 0);
        // the paused vault's holder redeems in full
        uint256 s = v[1].balanceOf(depositor);
        uint256 before = usdc.balanceOf(depositor);
        vm.prank(depositor);
        v[1].redeem(s, depositor, depositor);
        assertEq(usdc.balanceOf(depositor) - before, 500 * ONE_USDC, "redeem pays while paused");
    }
}
