// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0002-router-default-weights-on-chain.md
// Implements: issue #1746 — PortfolioRouter must skip zero-amount legs
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {MockUSDC} from "./PortfolioRouter.t.sol";

/// @notice 1:1 vault that REVERTS on `deposit(0)` (like rmAGENT: a zero swap) and
///         counts every `deposit` call, so a test can prove a leg was never called.
contract StrictZeroRevertVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;
    uint256 public depositCalls;

    constructor(address asset_) ERC20("Strict Vault", "SV") {
        assetToken = IERC20(asset_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        require(assets != 0, "StrictZeroRevertVault: preview(0)");
        return assets;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        depositCalls++;
        require(assets != 0, "StrictZeroRevertVault: deposit(0)");
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
    }

    function retire() external {}

    function unretire() external {}
}

/// @notice Issue 1746: an Active, router-eligible leg whose computed amount is 0
///         (a 0-bps weight, or a weight that rounds to 0) is never called.
contract PortfolioRouterZeroLegTest is Test {
    MockUSDC internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;

    address internal admin = makeAddr("admin");
    address internal depositor = makeAddr("depositor");

    StrictZeroRevertVault[4] internal v; // usdc, proto, agent, rwa

    event RouterDeposit(
        address indexed depositor,
        address indexed vault,
        uint256 amount,
        uint256 shares,
        uint256 weightBps
    );

    function setUp() public {
        usdc = new MockUSDC();
        registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);
        for (uint256 i = 0; i < 4; i++) {
            v[i] = new StrictZeroRevertVault(address(usdc));
            vm.startPrank(admin);
            registry.registerVault(
                address(v[i]),
                VaultRegistry.VaultMetadata({name: "V", asset: address(usdc), registeredAt: 0})
            );
            registry.setRouterEligible(address(v[i]), true);
            vm.stopPrank();
        }
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

    function _fund(uint256 amount) internal {
        usdc.mint(depositor, amount);
        vm.prank(depositor);
        usdc.approve(address(router), amount);
    }

    function _deposit(uint256 amount) internal returns (uint256[] memory shares) {
        _fund(amount);
        vm.prank(depositor);
        shares = router.deposit(amount, new uint256[](0));
    }

    // ─── The launch vector: 9500 / 500 / 0 / 0 over four eligible vaults ─────

    function test_launchVector_zeroBpsEligibleLegsAreNeverCalled() public {
        _setWeights(9500, 500, 0, 0);
        uint256 amount = 10 * 1e6;

        // Zero-amount legs: no approval, no vault call.
        vm.expectCall(
            address(v[2]), abi.encodeWithSelector(StrictZeroRevertVault.deposit.selector), 0
        );
        vm.expectCall(
            address(v[3]), abi.encodeWithSelector(StrictZeroRevertVault.deposit.selector), 0
        );

        uint256[] memory shares = _deposit(amount);

        assertEq(shares[0], 9_500_000);
        assertEq(shares[1], 500_000);
        assertEq(shares[2], 0);
        assertEq(shares[3], 0);
        assertEq(v[2].depositCalls(), 0, "agent leg never called");
        assertEq(v[3].depositCalls(), 0, "rwa leg never called");
        assertEq(v[0].balanceOf(depositor), 9_500_000);
        assertEq(v[1].balanceOf(depositor), 500_000);
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing");
        assertEq(usdc.allowance(address(router), address(v[2])), 0, "no approval to skipped leg");
        assertEq(usdc.allowance(address(router), address(v[3])), 0, "no approval to skipped leg");
    }

    function test_launchVector_noEventForSkippedLeg() public {
        _setWeights(9500, 500, 0, 0);
        _fund(10 * 1e6);
        vm.recordLogs();
        vm.prank(depositor);
        router.deposit(10 * 1e6, new uint256[](0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 routerEvents;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == RouterDeposit.selector) {
                routerEvents++;
                assertTrue(
                    address(uint160(uint256(logs[i].topics[2]))) != address(v[2])
                        && address(uint160(uint256(logs[i].topics[2]))) != address(v[3]),
                    "no event for a skipped leg"
                );
            }
        }
        assertEq(routerEvents, 2);
        // And the two events carry the funded legs' exact data.
        (uint256 amt0, uint256 sh0, uint256 w0) = (0, 0, 0);
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(router) && logs[i].topics[0] == RouterDeposit.selector
                    && address(uint160(uint256(logs[i].topics[2]))) == address(v[0])
            ) {
                (amt0, sh0, w0) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
        assertEq(amt0, 9_500_000);
        assertEq(sh0, 9_500_000);
        assertEq(w0, 9500);
    }

    function test_previewDeposit_matchesActual_andKeepsZeroLegAvailable() public {
        _setWeights(9500, 500, 0, 0);
        uint256 amount = 10 * 1e6;
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertEq(legs[2].legAmount, 0);
        assertEq(legs[3].legAmount, 0);
        assertFalse(legs[2].unavailable, "0-bps leg is available, just unfunded");
        assertEq(legs[2].estShares, 0);
        assertEq(legs[3].estShares, 0);

        uint256[] memory shares = _deposit(amount);
        for (uint256 i = 0; i < 4; i++) {
            assertEq(shares[i], legs[i].estShares, "preview == actual shares");
            assertEq(v[i].balanceOf(depositor), legs[i].legAmount, "preview == actual amount");
        }
    }

    // ─── Rounding dust ───────────────────────────────────────────────────────

    /// Dust goes to the last leg that carries weight, never to a 0-bps leg that
    /// sits after it in the vector.
    function test_dust_landsOnLastNonZeroBpsLeg_notTrailingZeroLeg() public {
        _setWeights(3333, 3333, 3334, 0);
        uint256[] memory shares = _deposit(7);
        // 7*3333/10000 = 2 ; 7*3334/10000 = 2 ; allocated 6, dust 1 -> leg 2 (last nonzero).
        assertEq(shares[0], 2);
        assertEq(shares[1], 2);
        assertEq(shares[2], 3);
        assertEq(shares[3], 0);
        assertEq(v[3].depositCalls(), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_tinyDeposits_1_2_3_baseUnits() public {
        _setWeights(9500, 500, 0, 0);
        // 1: 9500*1/10000 = 0, 500*1/10000 = 0 -> dust 1 to leg 1 (last nonzero).
        uint256[] memory s1 = _deposit(1);
        assertEq(s1[0] + s1[1] + s1[2] + s1[3], 1);
        assertEq(s1[1], 1, "dust lands on the last non-zero-bps leg");
        assertEq(s1[0], 0, "a nonzero weight that rounds to 0 is skipped");
        assertEq(v[0].depositCalls(), 0, "rounded-to-zero leg is not called");
        // 2 and 3.
        uint256[] memory s2 = _deposit(2);
        assertEq(s2[0] + s2[1] + s2[2] + s2[3], 2);
        uint256[] memory s3 = _deposit(3);
        assertEq(s3[0] + s3[1] + s3[2] + s3[3], 3);
        assertEq(s3[2] + s3[3], 0);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_roundedToZeroLeg_previewEqualsActual() public {
        _setWeights(9500, 500, 0, 0);
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(1);
        assertEq(legs[0].legAmount, 0);
        assertEq(legs[1].legAmount, 1);
        uint256[] memory shares = _deposit(1);
        assertEq(shares[0], legs[0].estShares);
        assertEq(shares[1], legs[1].estShares);
    }

    function test_largeDeposit_sumsExactly() public {
        _setWeights(9500, 500, 0, 0);
        uint256 amount = 123_456_789_012_345; // 123M USDC + change
        uint256[] memory shares = _deposit(amount);
        assertEq(shares[0] + shares[1] + shares[2] + shares[3], amount);
        assertEq(shares[0], (amount * 9500) / 10_000);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    // ─── All legs zero ───────────────────────────────────────────────────────

    function test_zeroAmountDeposit_revertsNoFundedLeg() public {
        _setWeights(9500, 500, 0, 0);
        _fund(1);
        vm.prank(depositor);
        vm.expectRevert(PortfolioRouter.NoFundedLeg.selector);
        router.deposit(0, new uint256[](0));
    }

    // ─── Unchanged behaviour: non-zero legs, paused skip, min shares ─────────

    function test_pausedLegStillRenormalises_zeroLegStillSkipped() public {
        _setWeights(9500, 500, 0, 0);
        vm.prank(admin);
        registry.setVaultStatus(address(v[1]), VaultRegistry.VaultStatus.DepositsPaused);
        uint256[] memory shares = _deposit(1000);
        assertEq(shares[0], 1000);
        assertEq(v[1].depositCalls(), 0);
        assertEq(v[2].depositCalls(), 0);
    }

    function test_onlyZeroBpsLegsAvailable_reverts() public {
        _setWeights(9500, 500, 0, 0);
        vm.startPrank(admin);
        registry.setVaultStatus(address(v[0]), VaultRegistry.VaultStatus.DepositsPaused);
        registry.setVaultStatus(address(v[1]), VaultRegistry.VaultStatus.DepositsPaused);
        vm.stopPrank();
        _fund(1000);
        vm.prank(depositor);
        // Only 0-bps legs remain depositable: every computed amount is 0, so the
        // deposit reverts with a named error (and calls no vault).
        vm.expectRevert(PortfolioRouter.NoFundedLeg.selector);
        router.deposit(1000, new uint256[](0));
    }

    function test_minSharesOnSkippedLeg_isNotEnforced() public {
        _setWeights(9500, 500, 0, 0);
        _fund(1000);
        uint256[] memory mins = new uint256[](4);
        mins[0] = 950;
        mins[1] = 50;
        mins[2] = 1; // skipped leg: same as an unavailable leg, no floor applies
        vm.prank(depositor);
        uint256[] memory shares = router.deposit(1000, mins);
        assertEq(shares[0], 950);
        assertEq(shares[1], 50);
    }

    // ─── Fuzz: sum invariant, skipped legs get no calls, preview == actual ───

    function testFuzz_zeroLegs_sumInvariantAndNoCalls(
        uint96 amountSeed,
        uint16 w0,
        uint16 w1,
        uint16 w2
    ) public {
        uint256 amount = bound(uint256(amountSeed), 1, 1e15);
        // Build a vector summing to 10000, with zeros reachable.
        uint256 a = bound(uint256(w0), 0, 10_000);
        uint256 b = bound(uint256(w1), 0, 10_000 - a);
        uint256 c = bound(uint256(w2), 0, 10_000 - a - b);
        uint256 d = 10_000 - a - b - c;
        _setWeights(a, b, c, d);

        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        uint256 previewSum;
        for (uint256 i = 0; i < 4; i++) {
            previewSum += legs[i].legAmount;
            if (legs[i].weightBps == 0) assertEq(legs[i].legAmount, 0, "0-bps leg gets 0");
        }
        assertEq(previewSum, amount, "sum(leg amounts) == amount");

        uint256[] memory shares = _deposit(amount);
        uint256 sharesSum;
        for (uint256 i = 0; i < 4; i++) {
            sharesSum += shares[i];
            assertEq(shares[i], legs[i].estShares, "preview == actual");
            assertEq(v[i].balanceOf(depositor), legs[i].legAmount);
            if (legs[i].legAmount == 0) assertEq(v[i].depositCalls(), 0, "skipped leg not called");
            else assertEq(v[i].depositCalls(), 1);
        }
        assertEq(sharesSum, amount, "no funds lost");
        assertEq(usdc.balanceOf(address(router)), 0, "no funds stranded");
    }
}
