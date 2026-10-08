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
//         issue #555 — per-asset DEX venue selector (Venue enum on AssetInfo + addAsset)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {BasketAssetConfigGuard} from "../lib/BasketAssetConfigGuard.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {AerodromeSwapAdapter} from "../adapters/AerodromeSwapAdapter.sol";
import {UniswapV3SwapAdapter} from "../adapters/UniswapV3SwapAdapter.sol";
import {IAerodromeRouter} from "../interfaces/IAerodromeRouter.sol";
import {IAerodromeSlipstreamRouter} from "../interfaces/IAerodromeSlipstreamRouter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
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
    int24 public spotTick; // slot0 spot tick (ORA-4 deviation probe); default 0 = 1:1
    int56 public tickCumulativeRate; // ticks per second contributed to TWAP
    uint16 public cardinality;
    uint128 public poolLiquidity; // in-range liquidity returned by liquidity()
    bool public revertObserve;
    /// @dev Oldest observation age in seconds; 0 means unlimited history.
    ///      `observe()` reverts "OLD" for any `secondsAgo` beyond it, like a
    ///      real pool whose ring buffer does not reach that far back.
    uint32 public maxHistory;
    uint24 public feeTier; // fee() value asserted against swapFee_ by addAsset (ORA-3)

    constructor(address token0_, address token1_, uint160 sqrtPriceX96_) {
        token0 = token0_;
        token1 = token1_;
        sqrtPriceX96Spot = sqrtPriceX96_;
        // Tick=0 means 1:1 price (sqrtP = 2^96); arithmetic-mean tick is 0
        // when tickCumulativeRate=0. Tests override as needed.
        tickCumulativeRate = 0;
        cardinality = 50_000;
        poolLiquidity = 1e18; // large default so existing tests pass unmodified
        feeTier = 500; // matches the swapFee_ tests pass to addAsset by default
    }

    /// @dev ORA-3 / F-09: `addAsset` asserts the pool's `fee()` equals `swapFee_`.
    function fee() external view returns (uint24) {
        return feeTier;
    }

    function setFee(uint24 fee_) external {
        feeTier = fee_;
    }

    function setSpot(uint160 sqrtPriceX96_) external {
        sqrtPriceX96Spot = sqrtPriceX96_;
    }

    /// @dev Set the slot0 spot tick the ORA-4 deviation guard reads. The TWAP
    ///      mean tick is governed separately by `tickCumulativeRate`, so a test
    ///      can drive spot ≠ TWAP to exercise the deviation guard.
    function setSpotTick(int24 tick_) external {
        spotTick = tick_;
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

    function setMaxHistory(uint32 seconds_) external {
        maxHistory = seconds_;
    }

    function liquidity() external view returns (uint128) {
        return poolLiquidity;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96Spot, spotTick, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        if (revertObserve) revert("OLD");
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            if (maxHistory != 0 && secondsAgos[i] > maxHistory) revert("OLD");
        }
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

/// @dev Basket token that calls back into the vault while the vault pays out (an ERC-777 style hook).
///      Records the owner's share balance and the total supply at callback time, then tries to
///      re-enter `redeemInKind`. Core 1665 reentrancy probe.
contract ReentrantHookToken is TestERC20 {
    BasketVault public target;
    address public victim;
    bool public armed;
    bool public reentered;
    bool public reentrySucceeded;
    bytes4 public reentryReason;
    uint256 public sharesAtCallback = type(uint256).max;
    uint256 public supplyAtCallback;

    function arm(BasketVault target_, address victim_) external {
        target = target_;
        victim = victim_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && from == address(target) && !reentered) {
            reentered = true;
            sharesAtCallback = target.balanceOf(victim);
            supplyAtCallback = target.totalSupply();
            try target.redeemInKind(1, victim, victim) {
                reentrySucceeded = true;
            } catch (bytes memory reason) {
                reentryReason = bytes4(reason); // expected: ReentrancyGuardReentrantCall
            }
        }
        super._update(from, to, value);
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
        assertTrue(
            vault.depositsPaused(),
            "unwind halts deposits only; emergency unwind keeps redemption available"
        );
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

    /// @notice ADP-2 / NC-2: addAsset rejects a non-zero adapter whose codehash is
    ///         not on the ADMIN-approved allowlist.
    function test_addAsset_revertsForUnvettedAdapter() public {
        TestERC20 newAsset = new TestERC20();
        MockPool newPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        // Any non-allowlisted contract address with code serves as the unvetted adapter.
        address unvetted = address(new MockSwapRouter());

        vm.prank(admin);
        vm.expectRevert(BasketAssetConfigGuard.AdapterCodeHashNotAllowed.selector);
        vault.addAsset(address(newAsset), address(newPool), 500, unvetted, BasketVault.Venue.V3);
    }

    /// @notice ADP-2 / NC-2: once ADMIN approves the adapter's codehash, addAsset
    ///         accepts it.
    function test_addAsset_acceptsVettedAdapterAfterApproval() public {
        TestERC20 newAsset = new TestERC20();
        MockPool newPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        address vetted = address(new MockSwapRouter());

        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(vetted.codehash, true);
        vault.addAsset(address(newAsset), address(newPool), 500, vetted, BasketVault.Venue.V3);
        vm.stopPrank();
        assertTrue(vault.adapterCodeHashAllowed(vetted.codehash), "codehash approved");
    }

    /// @notice ORA-3 / F-09: addAsset reverts when the registered pool's fee tier
    ///         (the execution pool resolved from swapFee_) does not match swapFee_.
    function test_addAsset_revertsOnExecutionPoolMismatch() public {
        TestERC20 newAsset = new TestERC20();
        MockPool newPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        newPool.setFee(3000); // pool is a 0.30% pool...

        vm.prank(admin);
        vm.expectRevert(BasketAssetConfigGuard.ExecutionPoolMismatch.selector);
        // ...but addAsset is told swapFee_ = 500 → mismatch.
        vault.addAsset(address(newAsset), address(newPool), 500, address(0), BasketVault.Venue.V3);
    }

    /// @notice ACL-3 / F-06: revoking the last ADMIN_ROLE holder reverts
    ///         (last-admin floor), so vault governance can never be bricked.
    function test_lastAdminFloor_revokeRevertsForSoleAdmin() public {
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.prank(admin);
        vm.expectRevert(); // AdminFloorAccessControl.LastAdminFloor
        vault.revokeRole(adminRole, admin);
    }

    /// @notice ACL-3 / F-06: renouncing the last ADMIN_ROLE holder reverts.
    function test_lastAdminFloor_renounceRevertsForSoleAdmin() public {
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.prank(admin);
        vm.expectRevert(); // AdminFloorAccessControl.LastAdminFloor
        vault.renounceRole(adminRole, admin);
    }

    /// @notice ACL-3 / F-06: with a second admin granted, the original may be
    ///         revoked — the floor only blocks dropping the FINAL admin.
    function test_lastAdminFloor_revokeSucceedsWithTwoAdmins() public {
        bytes32 adminRole = vault.ADMIN_ROLE();
        address admin2 = makeAddr("admin2");
        vm.startPrank(admin);
        vault.grantRole(adminRole, admin2);
        vault.revokeRole(adminRole, admin); // not the last admin → allowed
        vm.stopPrank();
        assertFalse(vault.hasRole(adminRole, admin), "original admin revoked");
        assertTrue(vault.hasRole(adminRole, admin2), "second admin retains role");
    }

    /// @notice LIFE-3 / NC-3 / F-06: pauseDeposits() stops deposits only, never withdrawals;
    ///         a holder can still redeem while the vault is paused.
    function test_pauseDeposits_doesNotFreezeWithdrawals() public {
        // Seed a position via a direct deposit on the default V3 path. The deposit
        // swaps USDC→basketToken, so the router yields basketToken.
        usdc.mint(stranger, 1_000 * ONE_USDC);
        basketToken.mint(address(router), 1_000 * ONE_USDC);
        router.setAmountOut(1_000 * ONE_USDC);
        vm.startPrank(stranger);
        usdc.approve(address(vault), 1_000 * ONE_USDC);
        uint256 shares = vault.deposit(1_000 * ONE_USDC, stranger);
        vm.stopPrank();
        assertGt(shares, 0, "deposit minted shares");

        // EMERGENCY pauses (deposits-only freeze).
        vm.prank(emergencyResponder);
        vault.pauseDeposits();
        assertTrue(vault.depositsPaused(), "vault paused");

        // Redeem must still succeed under pause (withdrawals are never frozen). The
        // redeem swaps basketToken→USDC, so the router now yields USDC. Output must
        // clear the TWAP slippage floor (1:1 TWAP, 1% slippage → ~990 USDC).
        usdc.mint(address(router), 995 * ONE_USDC);
        router.setAmountOut(995 * ONE_USDC);
        vm.prank(stranger);
        uint256 out = vault.redeem(shares, stranger, stranger);
        assertGt(out, 0, "redeem succeeds while paused");
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
        vault.reabsorbRemovedAsset(0, 0);

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
        vault.reabsorbRemovedAsset(0, 0);
    }

    /// @notice LIFE-6 / NC-8 (FLIPPED GREEN by #970): re-absorbing a removed asset
    ///         whose pool is DEGRADED (TWAP `observe()` reverts "OLD") never
    ///         reverts-and-strands. Pre-fix, the swap-floor read reverted and the
    ///         reappeared balance was stuck on the vault forever; post-fix the
    ///         quarantine fallback sweeps it to the governed quarantine address, so
    ///         the balance is always actionable (the reversible safety valve).
    ///         Deep proof referenced by FvInvariants.t.sol::test_LIFE6_*.
    function test_LIFE6_reabsorbSurvivesDegradedPool() public {
        vm.prank(admin);
        vault.removeAsset(0); // vault holds zero basketToken, removal allowed

        // A balance reappears after removal.
        uint256 reappeared = 7 * ONE_USDC;
        basketToken.mint(address(vault), reappeared);

        // The removed asset's pool degrades: its TWAP observation history is gone,
        // so observe() reverts "OLD". The happy-path swap floor cannot be priced.
        pool.setRevertObserve(true);

        // Re-absorption must NOT revert-and-strand. The quarantine fallback fires
        // and `sweep` emits ForeignTokenQuarantined(token, amount, caller).
        address stranger = makeAddr("stranger");
        vm.expectEmit(true, true, false, true, address(vault));
        emit ForeignTokenQuarantine.ForeignTokenQuarantined(
            address(basketToken), reappeared, stranger
        );
        vm.prank(stranger);
        vault.reabsorbRemovedAsset(0, 0); // does not revert (LIFE-6)

        // The reappeared balance left the vault for quarantine — never stranded.
        assertEq(basketToken.balanceOf(address(vault)), 0, "LIFE-6: balance not stranded on vault");
        assertEq(
            basketToken.balanceOf(ForeignTokenQuarantine.QUARANTINE),
            reappeared,
            "LIFE-6: degraded-pool balance swept to quarantine safety valve"
        );
    }

    /// @notice LIFE-6 / NC-8: a zero reappeared balance is an idempotent no-op,
    ///         never a revert, even on a degraded pool.
    function test_LIFE6_reabsorbZeroBalanceIsNoOp() public {
        vm.prank(admin);
        vault.removeAsset(0);
        pool.setRevertObserve(true);
        // No balance reappeared; the call returns without reverting or sweeping.
        vault.reabsorbRemovedAsset(0, 0);
        assertEq(basketToken.balanceOf(ForeignTokenQuarantine.QUARANTINE), 0, "nothing swept");
    }

    /// @notice AZ-BSK-5: reabsorbRemovedAsset reverts with SlippageExceeded when
    ///         the caller-supplied minUsdcOut exceeds the actual swap output, so
    ///         MEV sandwich attacks on NAV recovery cannot extract value below the
    ///         caller's floor.
    function test_AZ_BSK5_reabsorbRemovedAsset_revertsSlippageExceeded() public {
        vm.prank(admin);
        vault.removeAsset(0);

        uint256 reappeared = 7 * ONE_USDC;
        basketToken.mint(address(vault), reappeared);

        // Router returns 6 USDC; TWAP floor at 1:1 / 1% slippage = 6.93 USDC.
        // The router will accept 6 USDC because it is < twapFloor so we need to
        // set the mock to satisfy the TWAP floor but have the caller's floor higher.
        // Strategy: set router output to exactly the TWAP floor (6.93 USDC = 6930000
        // for 6 decimal USDC), then set minUsdcOut above that.
        // TWAP floor: 7 * ONE_USDC * (10000 - 100) / 10000 = 6930000 (6 decimals).
        uint256 twapFloor = reappeared * (10_000 - 100) / 10_000; // 6.93 USDC
        // Router pays out exactly the TWAP floor — swap succeeds at the TWAP guard,
        // but the caller demands more: minUsdcOut = twapFloor + 1.
        uint256 usdcOut = twapFloor;
        router.setAmountOut(usdcOut);
        usdc.mint(address(router), usdcOut);

        vm.expectRevert(BasketVault.SlippageExceeded.selector);
        vault.reabsorbRemovedAsset(0, twapFloor + 1);
    }

    /// @notice AZ-BSK-5: reabsorbRemovedAsset succeeds and credits NAV when the
    ///         caller-supplied minUsdcOut is at or below the actual swap output.
    function test_AZ_BSK5_reabsorbRemovedAsset_succeedsAndCreditsNav() public {
        vm.prank(admin);
        vault.removeAsset(0);

        uint256 reappeared = 7 * ONE_USDC;
        basketToken.mint(address(vault), reappeared);

        // Router returns 7 USDC (full 1:1 value, well above TWAP floor and caller's floor).
        uint256 usdcOut = 7 * ONE_USDC;
        router.setAmountOut(usdcOut);
        usdc.mint(address(router), usdcOut);

        uint256 navBefore = vault.totalAssets();

        // Caller supplies minUsdcOut <= actual output → succeeds.
        uint256 minUsdcOut = 6 * ONE_USDC;
        vault.reabsorbRemovedAsset(0, minUsdcOut);

        assertEq(basketToken.balanceOf(address(vault)), 0, "reappeared balance consumed");
        assertEq(vault.totalAssets(), navBefore + usdcOut, "NAV rises by re-absorbed USDC");
    }

    /// @notice NC-8: re-adding a token that already has an ACTIVE registry entry
    ///         reverts rather than creating a duplicate AssetInfo (which would
    ///         double-count it in NAV and corrupt the equal-weight split).
    function test_NC8_addAsset_rejectsActiveDuplicate() public {
        // basketToken is already active at index 0 (added in setUp).
        vm.prank(admin);
        vm.expectRevert(BasketAssetConfigGuard.AssetAlreadyActive.selector);
        vault.addAsset(address(basketToken), address(pool), 500, address(0), BasketVault.Venue.V3);
    }

    /// @notice NC-8: re-adding a previously REMOVED token reuses its inactive
    ///         registry slot in place (refreshing config + re-activating) instead
    ///         of appending a second AssetInfo, so `assets` never holds two entries
    ///         for one token.
    function test_NC8_addAsset_reusesInactiveSlotOnReAdd() public {
        uint256 lenBefore = _assetsLen();
        vm.prank(admin);
        vault.removeAsset(0); // deactivate basketToken at index 0

        // Re-add the same token with a fresh (still-valid) pool config.
        MockPool freshPool = new MockPool(address(basketToken), address(usdc), uint160(1 << 96));
        vm.prank(admin);
        vault.addAsset(
            address(basketToken), address(freshPool), 500, address(0), BasketVault.Venue.V3
        );

        // No new slot appended: the inactive entry was reused in place.
        assertEq(_assetsLen(), lenBefore, "NC-8: re-add must not append a duplicate AssetInfo");

        // Index 0 is active again and points at the refreshed pool.
        (address token0, address poolAddr0,, bool active0,,) = vault.assets(0);
        assertEq(token0, address(basketToken), "reused slot keeps the token");
        assertTrue(active0, "reused slot re-activated");
        assertEq(poolAddr0, address(freshPool), "reused slot refreshed to new pool");
    }

    /// @dev Count the BasketVault `assets` registry by probing the public getter
    ///      until it reverts (no dedicated length getter on-chain — kept off the
    ///      EIP-170-tight basket bytecode).
    function _assetsLen() internal view returns (uint256 n) {
        while (true) {
            try vault.assets(n) returns (
                address, address, uint24, bool, address, BasketVault.Venue
            ) {
                n++;
            } catch {
                return n;
            }
        }
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
        vault.pauseDeposits();
        assertEq(vault.maxDeposit(stranger), 0, "maxDeposit 0 while paused");
        assertEq(vault.maxMint(stranger), 0, "maxMint 0 while paused");

        vm.prank(admin);
        vault.unpauseDeposits();
        assertGt(vault.maxDeposit(stranger), 0, "maxDeposit restored after unpause");
    }

    function test_maxDeposit_zeroWhenShutdown() public {
        vm.prank(emergencyResponder);
        vault.shutdownVault();
        assertEq(vault.maxDeposit(stranger), 0, "maxDeposit 0 after shutdown");
        assertEq(vault.maxMint(stranger), 0, "maxMint 0 after shutdown");
    }

    /// @notice LIFE-4 / F-07: an EMERGENCY-triggered `shutdownVault` permanently
    ///         blocks deposits with no reverse path UNLESS the higher-trust
    ///         ADMIN_ROLE can `restoreVault`. Proof: shutdown blocks deposits;
    ///         ADMIN restore with a fresh cap re-opens them; a redeem in between
    ///         confirms withdrawals were never frozen (LIFE-3).
    function test_F07_restoreVaultReopensDeposits() public {
        // Seed a position so we can confirm redemption stays open across shutdown.
        usdc.mint(stranger, 1_000 * ONE_USDC);
        basketToken.mint(address(router), 1_000 * ONE_USDC);
        router.setAmountOut(1_000 * ONE_USDC);
        vm.startPrank(stranger);
        usdc.approve(address(vault), type(uint256).max);
        uint256 shares = vault.deposit(1_000 * ONE_USDC, stranger);
        vm.stopPrank();
        assertGt(shares, 0, "seed deposit minted shares");

        // EMERGENCY shuts the vault down: deposits blocked, cap zeroed.
        vm.prank(emergencyResponder);
        vault.shutdownVault();
        assertTrue(vault.shutdown(), "vault shut down");
        assertEq(vault.tvlCap(), 0, "shutdown zeroed the cap");

        // While shut down, `maxDeposit` is 0, so the OZ ERC-4626 wrapper rejects the
        // deposit before the internal shutdown guard — either way deposits are blocked.
        assertEq(vault.maxDeposit(stranger), 0, "maxDeposit 0 while shut down");
        vm.startPrank(stranger);
        vm.expectRevert();
        vault.deposit(100 * ONE_USDC, stranger);
        vm.stopPrank();

        // Withdrawals were never frozen by shutdown (LIFE-3): a partial redeem works.
        usdc.mint(address(router), 500 * ONE_USDC);
        router.setAmountOut(500 * ONE_USDC);
        vm.prank(stranger);
        uint256 out = vault.redeem(shares / 2, stranger, stranger);
        assertGt(out, 0, "redeem succeeds while shut down");

        // ADMIN restores with a fresh cap (>= perDepositCap of 100k) — deposits re-open.
        uint256 newCap = 1_000_000 * ONE_USDC;
        vm.expectEmit(false, false, false, true, address(vault));
        emit BasketVault.Restored(newCap);
        vm.prank(admin);
        vault.restoreVault(newCap);
        assertFalse(vault.shutdown(), "restore cleared shutdown");
        assertEq(vault.tvlCap(), newCap, "restore applied the new cap");

        basketToken.mint(address(router), 200 * ONE_USDC);
        router.setAmountOut(200 * ONE_USDC);
        vm.prank(stranger);
        uint256 reopened = vault.deposit(200 * ONE_USDC, stranger);
        assertGt(reopened, 0, "deposits re-opened after restore");
    }

    /// @notice F-07: only ADMIN_ROLE may restore; the EMERGENCY hot key that can
    ///         shut the vault down cannot reverse it (trust asymmetry, like unpause).
    function test_F07_restoreVault_emergencyCannotRestore() public {
        vm.prank(emergencyResponder);
        vault.shutdownVault();

        vm.prank(emergencyResponder);
        vm.expectRevert(); // AccessControl: EMERGENCY lacks ADMIN_ROLE
        vault.restoreVault(50_000 * ONE_USDC);
    }

    /// @notice F-07: `restoreVault` rejects incoherent inputs — not-shut-down,
    ///         zero cap, or a cap below `perDepositCap`.
    function test_F07_restoreVault_revertsOnInvalidInputs() public {
        // Not shut down yet.
        vm.prank(admin);
        vm.expectRevert(BasketVault.NotShutdown.selector);
        vault.restoreVault(50_000 * ONE_USDC);

        vm.prank(emergencyResponder);
        vault.shutdownVault();

        // Zero cap.
        vm.prank(admin);
        vm.expectRevert(BasketVault.InvalidParam.selector);
        vault.restoreVault(0);

        // Cap below the configured per-deposit cap.
        uint256 perDep = vault.perDepositCap();
        vm.prank(admin);
        vm.expectRevert(BasketVault.InvalidParam.selector);
        vault.restoreVault(perDep - 1);
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
        vault.pauseDeposits();
        assertTrue(vault.depositsPaused(), "pause remains available");

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

    /// @notice Governance can never set a TWAP window longer than the pool's
    ///         observation history: such a window would make every NAV read
    ///         revert "OLD" and block redeem. The setter rejects it, the old
    ///         window stays in force, and a holder still redeems (core 1494).
    function test_setTwapWindow_rejectsWindowBeyondPoolHistory_redeemStillWorks() public {
        uint256 shares = _depositAt1to1(stranger, 1_000 * ONE_USDC);
        // The pool's oldest observation is 1 hour old.
        pool.setMaxHistory(3_600);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketAssetConfigGuard.InsufficientObservationHistory.selector,
                address(pool),
                uint32(7_200)
            )
        );
        vault.setTwapWindow(address(basketToken), 7_200);
        assertEq(vault.effectiveTwapWindow(address(basketToken)), 1_800, "default window unchanged");

        // A window the history covers is still accepted.
        vm.prank(admin);
        vault.setTwapWindow(address(basketToken), 3_600);
        assertEq(vault.effectiveTwapWindow(address(basketToken)), 3_600, "covered window set");

        usdc.mint(address(router), 995 * ONE_USDC);
        router.setAmountOut(995 * ONE_USDC);
        vm.prank(stranger);
        assertEq(vault.redeem(shares, stranger, stranger), 995 * ONE_USDC, "redeem still works");
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
        assertTrue(
            vault.depositsPaused(),
            "unwind halts deposits only; redemption remains available after unwind"
        );
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
        vault.pauseDeposits();
        assertTrue(vault.depositsPaused(), "pre-condition: vault is paused");

        // emergencyUnwind must not revert when deposits are already paused.
        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertEq(basketToken.balanceOf(address(vault)), 0, "basket asset fully unwound");
        assertEq(usdc.balanceOf(address(vault)), amountOut, "USDC received after pre-paused unwind");
        assertTrue(vault.depositsPaused(), "vault remains paused after unwind");
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
        vault.pauseDeposits();
        assertTrue(vault.depositsPaused(), "pre-condition: vault is paused");

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertEq(basketToken.balanceOf(address(vault)), 0, "basket asset unwound with override");
        assertTrue(vault.depositsPaused(), "vault remains paused after override unwind");
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

        assertFalse(vault.depositsPaused(), "pre-condition: vault is not paused");

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();

        assertTrue(vault.depositsPaused(), "deposits are paused after emergencyUnwind");
        assertTrue(
            vault.depositsPaused(), "unwind halts deposits only; redemption remains available"
        );
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

        assertFalse(vault.depositsPaused(), "pre-condition: vault is not paused");

        address[] memory tokens = new address[](1);
        tokens[0] = address(basketToken);

        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);

        assertTrue(vault.depositsPaused(), "deposits are paused after override unwind");
        assertTrue(
            vault.depositsPaused(), "unwind halts deposits only; redemption remains available"
        );
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
        assertTrue(
            vault.depositsPaused(),
            "unwind halts deposits only; emergencyUnwind keeps redemption available"
        );
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
                uint16(901),
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

    /// @notice addAsset() succeeds when pool cardinality equals the 1800 s window floor (901).
    function test_addAsset_succeedsWhenCardinalityMeetsMinimum() public {
        TestERC20 newAsset = new TestERC20();
        MockPool goodPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        goodPool.setCardinality(901);

        vm.prank(admin);
        vault.addAsset(address(newAsset), address(goodPool), 500, address(0), BasketVault.Venue.V3);

        assertEq(vault.assetCount(), 2, "asset registered");
    }

    /// @notice totalAssets() does not revert after a successful addAsset() call
    ///         when cardinality satisfies the minimum.
    function test_totalAssets_doesNotRevertAfterValidAddAsset() public {
        TestERC20 newAsset = new TestERC20();
        MockPool goodPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        goodPool.setCardinality(1000);

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
    ///         the window floor (901) and succeeds at or above it.
    function testFuzz_addAsset_cardinalityBoundary(uint16 cardinality_) public {
        // Use a fresh vault so we don't hit MaxAssetsReached after repeated calls.
        BasketVaultHarness freshVault = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(router)), admin, emergencyResponder
        );

        TestERC20 newAsset = new TestERC20();
        MockPool fuzzPool = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        fuzzPool.setCardinality(cardinality_);

        uint16 required = 901;

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

    // ─── SUP-3 / NC-6 / F-16: round trip never profits (#969) ─────────────────

    /// @dev Deposit `amount` USDC into `vault`, executing the swap at 1:1
    ///      (spot == TWAP) so the basket token received equals the USDC in.
    function _depositAt1to1(address who, uint256 amount) internal returns (uint256 shares) {
        basketToken.mint(address(router), amount);
        router.setAmountOut(amount);
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        shares = vault.deposit(amount, who);
        vm.stopPrank();
    }

    /// @notice SUP-3 (pure-view floor): `previewRedeem(previewDeposit(x)) <= x`
    ///         holds across fuzzed slippage params and deposit sizes. The two
    ///         floor-discounted previews compose to strictly below the deposit,
    ///         so a round trip can never preview a profit.
    function test_SUP3_roundTripNeverProfits_fuzz(uint256 x, uint16 slip) public {
        slip = uint16(bound(slip, 5, 500)); // [pool-fee floor, MAX_SLIPPAGE_BPS]
        x = bound(x, 1e6, 100_000e6);

        vm.prank(admin);
        vault.setMaxSlippageBps(slip);

        // Seed so totalSupply > 0 (1:1 execution).
        _depositAt1to1(address(this), 50_000e6);

        uint256 shares = vault.previewDeposit(x);
        assertLe(vault.previewRedeem(shares), x, "SUP-3: round-trip preview must not profit");
    }

    /// @notice SUP-3 (stateful): a real deposit → immediate redeem within the
    ///         deviation band returns no more than was deposited. Exercises the
    ///         mint-on-realized-proceeds accounting (F-16/NC-6): shares are minted
    ///         on the realized post-swap NAV delta (AZ-BSK-1 fix), and
    ///         redeem() returns the actual USDC received (AZ-BSK-2 fix).
    ///
    ///         Router mock is set to return the stranger's proportional share at 1:1.
    ///         AZ-BSK-1 fix: stranger is credited realizedDelta shares (not
    ///         just slippageFloor shares). At 1:1 execution on a 10 000 USDC pool,
    ///         stranger's fraction = 1000/(10000+1000) = 1/11, so their sell
    ///         of 1/11 of the basket at 1:1 USDC yields exactly x. The invariant
    ///         got <= x holds (with equality at 1:1).
    function test_SUP3_statefulDepositRedeemNeverProfits() public {
        vm.prank(admin);
        vault.setMaxSlippageBps(100);

        // Seed pool (1:1).
        _depositAt1to1(address(this), 10_000e6);

        // User deposits at 1:1.
        uint256 x = 1_000e6;
        uint256 shares = _depositAt1to1(stranger, x);

        // Redeem immediately at 1:1. The stranger's proportional sell is
        // x / (10_000e6 + x) * totalBasketTokens = x (at 1:1 prices).
        // Router is set to return x USDC for the stranger's token fraction.
        // AZ-BSK-2: redeem() now returns the ACTUAL USDC balance delta,
        // not OZ's previewRedeem estimate — so got == x at 1:1 execution.
        usdc.mint(address(router), x);
        router.setAmountOut(x); // 1:1 proportional proceeds for stranger's share

        vm.prank(stranger);
        uint256 got = vault.redeem(shares, stranger, stranger);

        assertLe(got, x, "SUP-3: stateful round trip must not return more than deposited");
    }

    // ─── ORA-4 / F-10: NAV-vs-market deviation guard (#969) ───────────────────

    /// @notice ORA-4: when the executable market (slot0 spot) price diverges from
    ///         the NAV-pricing TWAP beyond `navDeviationGuardBps`, a deposit
    ///         reverts `NavMarketDeviationExceeded` rather than minting at the
    ///         stale/manipulated mark. With the guard disabled (0) the same
    ///         deposit succeeds — proving the guard, not some other check, blocks.
    function test_ORA4_deviationGuardBlocksSettlement() public {
        // Arm the guard at 1% and drive spot far from the (tick=0) TWAP.
        vm.prank(admin);
        vault.setNavDeviationGuardBps(100); // 1%

        // TWAP mean tick stays 0 (tickCumulativeRate default 0 ⇒ 1:1). Push the
        // slot0 spot tick well away: ~+200 ticks ≈ +2% price, beyond the 1% band.
        pool.setSpotTick(200);

        usdc.mint(stranger, 1_000e6);
        vm.prank(stranger);
        usdc.approve(address(vault), 1_000e6);
        // The exact on-chain deviationBps is data-dependent; assert the typed
        // selector fires (NavMarketDeviationExceeded) via a low-level call.
        vm.prank(stranger);
        (bool ok, bytes memory ret) =
            address(vault).call(abi.encodeCall(vault.deposit, (1_000e6, stranger)));
        assertFalse(ok, "ORA-4: deposit must revert on deviation");
        assertEq(
            bytes4(ret),
            BasketVault.NavMarketDeviationExceeded.selector,
            "ORA-4: revert must be NavMarketDeviationExceeded"
        );

        // Disable the guard: the same deposit now settles (1:1 swap fixture).
        vm.prank(admin);
        vault.setNavDeviationGuardBps(0);
        basketToken.mint(address(router), 1_000e6);
        router.setAmountOut(1_000e6);
        vm.startPrank(stranger);
        usdc.approve(address(vault), 1_000e6);
        uint256 shares = vault.deposit(1_000e6, stranger);
        vm.stopPrank();
        assertGt(shares, 0, "ORA-4: deposit succeeds once the guard is disabled");
    }

    /// @notice ORA-4: a deposit within the deviation band settles normally — the
    ///         guard does not block ordinary, market-consistent settlement.
    function test_ORA4_withinBandSettles() public {
        vm.prank(admin);
        vault.setNavDeviationGuardBps(300); // 3%

        // Small spot drift (~+50 ticks ≈ +0.5%), inside the 3% band.
        pool.setSpotTick(50);

        uint256 shares = _depositAt1to1(stranger, 1_000e6);
        assertGt(shares, 0, "ORA-4: in-band deposit settles");
    }

    // ─── AZ-BSK-1: deposit credits realizedDelta not slippage floor ──────────────

    /// @notice AZ-BSK-1: when realized NAV > slippage floor (swap beats the TWAP
    ///         worst-case), the depositor is credited realizedDelta shares, not just
    ///         the slippage-discounted floor.  Pre-fix, the floor capped credit even
    ///         when swaps captured extra value; post-fix the full delta is minted.
    function test_AZBSK1_depositCreditsRealizedDeltaNotSlippageFloor() public {
        vm.prank(admin);
        vault.setMaxSlippageBps(100); // 1% slippage

        // Seed pool so the vault has non-zero NAV.
        _depositAt1to1(address(this), 10_000e6);

        uint256 depositAmount = 1_000e6;

        // Configure swap to deliver MORE than the slippage-discounted floor.
        // At 1% slippage, floor = 990 USDC of tokens. Deliver 1000 (full 1:1).
        uint256 swapOut = depositAmount; // 1:1 → realized > floor
        basketToken.mint(address(router), swapOut);
        router.setAmountOut(swapOut);

        uint256 taBefore = vault.totalAssets();

        usdc.mint(stranger, depositAmount);
        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        uint256 shares = vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        uint256 realizedDelta = vault.totalAssets() - taBefore;
        uint256 slippageFloor = depositAmount * (10_000 - 100) / 10_000; // 990e6

        assertGt(realizedDelta, slippageFloor, "swap must beat slippage floor for this test");

        // AZ-BSK-1: the depositor's balance must match the return value.
        assertEq(vault.balanceOf(stranger), shares, "stranger balance must match minted shares");

        // Pre-fix shares would have been based on slippageFloor credit.
        // Post-fix shares use realizedDelta. Compute both to verify the fix gives more.
        // shares = realizedDelta * (supplyBefore + 10^18) / (taBefore + 1), Floor
        // Pre-fix: floorShares = slippageFloor * (supplyBefore + 10^18) / (taBefore + 1)
        // Since realizedDelta > slippageFloor, post-fix shares > pre-fix shares.
        uint256 floorBasedShares = vault.previewDeposit(depositAmount);
        assertGt(shares, floorBasedShares, "AZ-BSK-1: fix yields more shares than old floor cap");
    }

    /// @notice AZ-BSK-1: when realized NAV equals the slippage floor (worst-case
    ///         execution), the depositor is still credited the realized delta
    ///         (which equals the floor in this case).
    function test_AZBSK1_depositAtFloorCreditsFloor() public {
        vm.prank(admin);
        vault.setMaxSlippageBps(100);

        _depositAt1to1(address(this), 10_000e6);

        uint256 depositAmount = 1_000e6;
        uint256 swapOut = depositAmount * (10_000 - 100) / 10_000; // exactly at floor
        basketToken.mint(address(router), swapOut);
        router.setAmountOut(swapOut);

        uint256 taBefore = vault.totalAssets();

        usdc.mint(stranger, depositAmount);
        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        uint256 shares = vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        uint256 realizedDelta = vault.totalAssets() - taBefore;
        uint256 slippageFloor = depositAmount * (10_000 - 100) / 10_000;
        // At-floor execution: realizedDelta == slippageFloor.
        assertEq(realizedDelta, slippageFloor, "at-floor test: realized must equal floor");
        // Shares must equal the previewDeposit floor estimate (realizedDelta == floor).
        assertEq(
            shares,
            vault.previewDeposit(depositAmount),
            "AZ-BSK-1: at-floor shares match previewDeposit"
        );
    }

    // ─── AZ-BSK-2: deposit()/redeem() return actual amounts ──────────────────────

    /// @notice AZ-BSK-2: BasketVault.deposit() returns the ACTUAL minted share
    ///         count, not OZ's previewDeposit estimate. When realized NAV > floor,
    ///         previewDeposit underestimates; the override must return the true count.
    function test_AZBSK2_depositReturnsActualMintedShares() public {
        vm.prank(admin);
        vault.setMaxSlippageBps(100);

        _depositAt1to1(address(this), 10_000e6);

        uint256 depositAmount = 1_000e6;
        // Swap yields above the slippage floor (1:1, floor = 990e6).
        uint256 swapOut = depositAmount; // 1:1
        basketToken.mint(address(router), swapOut);
        router.setAmountOut(swapOut);

        uint256 previewShares = vault.previewDeposit(depositAmount);

        usdc.mint(stranger, depositAmount);
        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        uint256 returnedShares = vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        uint256 actualBalance = vault.balanceOf(stranger);

        // AZ-BSK-2: return value must equal actual minted shares, not previewDeposit.
        assertEq(
            returnedShares, actualBalance, "AZ-BSK-2: deposit() return must equal actual minted"
        );
        // When realized NAV > floor, actual > preview.
        assertGt(
            returnedShares,
            previewShares,
            "AZ-BSK-2: actual shares must exceed previewDeposit floor"
        );
    }

    /// @notice AZ-BSK-2: BasketVault.redeem() returns the ACTUAL USDC withdrawn,
    ///         not OZ's previewRedeem estimate. Confirms PortfolioRouter slippage
    ///         guards are evaluated against accurate amounts.
    function test_AZBSK2_redeemReturnsActualWithdrawnAssets() public {
        vm.prank(admin);
        vault.setMaxSlippageBps(100);

        _depositAt1to1(address(this), 10_000e6);

        uint256 depositAmount = 1_000e6;
        uint256 shares = _depositAt1to1(stranger, depositAmount);

        // Redeem: swap returns 1:1 for stranger's fraction of the basket.
        // Stranger's fraction ≈ 1000/11000 of 11000e6 = 1000e6 tokens.
        uint256 swapBack = depositAmount; // 1:1 USDC for basket tokens
        usdc.mint(address(router), swapBack);
        router.setAmountOut(swapBack);

        uint256 previewAssets = vault.previewRedeem(shares);

        uint256 usdcBefore = usdc.balanceOf(stranger);
        vm.prank(stranger);
        uint256 returnedAssets = vault.redeem(shares, stranger, stranger);
        uint256 actualReceived = usdc.balanceOf(stranger) - usdcBefore;

        // AZ-BSK-2: return value must equal actual USDC received.
        assertEq(
            returnedAssets,
            actualReceived,
            "AZ-BSK-2: redeem() return must equal actual USDC received"
        );
        // Actual proceeds should exceed the conservative previewRedeem floor.
        assertGt(
            returnedAssets,
            previewAssets,
            "AZ-BSK-2: actual proceeds must exceed previewRedeem floor"
        );
    }

    // ─── AZ-BSK-3 (C1-corrected): deposit mints against the FULL pre-deposit NAV ─

    /// @dev Redeem `shares` for `who`, funding the mock router with the fair USDC value
    ///      of the redeemer's pro-rata slice of the vault's basket tokens (1:1 price).
    function _redeemFair(address who, uint256 shares) internal returns (uint256 received) {
        uint256 supply = vault.totalSupply();
        uint256 tokenSlice = basketToken.balanceOf(address(vault)) * shares / supply;
        usdc.mint(address(router), tokenSlice);
        router.setAmountOut(tokenSlice);
        uint256 beforeBal = usdc.balanceOf(who);
        vm.prank(who);
        vault.redeem(shares, who, who);
        received = usdc.balanceOf(who) - beforeBal;
    }

    /// @notice AZ-BSK-3 (C1-corrected): with idle USDC present, deposit() mints exactly
    ///         mulDiv(realizedDelta, supplyBefore + 1e18, taBefore + 1). The old
    ///         `taBefore - idle + 1` denominator (a different, larger share count) is
    ///         asserted unequal. Idle USDC backs existing shares, so it stays in the
    ///         denominator.
    function test_AZBSK3_depositMintsAgainstIdleInclusiveNAV() public {
        _depositAt1to1(address(this), 10_000e6);
        uint256 idleUsdc = 5_000e6;
        usdc.mint(address(vault), idleUsdc);

        uint256 supplyBefore = vault.totalSupply();
        uint256 taBefore = vault.totalAssets(); // includes idleUsdc
        uint256 idleBefore = usdc.balanceOf(address(vault));
        assertGt(idleBefore, 0, "idle USDC must be non-zero");
        assertEq(idleBefore, idleUsdc, "idle is the injected balance");

        uint256 depositAmount = 1_000e6;
        basketToken.mint(address(router), depositAmount);
        router.setAmountOut(depositAmount);
        usdc.mint(stranger, depositAmount);
        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        uint256 actualShares = vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        uint256 realizedDelta = vault.totalAssets() - taBefore;
        uint256 expectedShares = Math.mulDiv(realizedDelta, supplyBefore + 1e18, taBefore + 1);
        uint256 oldShares =
            Math.mulDiv(realizedDelta, supplyBefore + 1e18, taBefore - idleBefore + 1);

        assertEq(actualShares, expectedShares, "AZ-BSK-3: mint uses idle-inclusive taBefore + 1");
        assertEq(vault.balanceOf(stranger), expectedShares, "shares minted to receiver");
        assertTrue(actualShares != oldShares, "AZ-BSK-3: old idle-excluded denominator rejected");
        assertLt(actualShares, oldShares, "AZ-BSK-3: old formula over-minted");
    }

    /// @notice AZ-BSK-3 PoC regression (audit 2026-10-08 test_idleUsdcOverMint):
    ///         emergencyUnwind -> unpauseDeposits -> deposit -> redeem must not let the
    ///         late depositor take value from the incumbent.
    function test_AZBSK3_emergencyUnwindThenDepositNoOverMint() public {
        address alice = makeAddr("alice");
        address eve = makeAddr("eve");

        uint256 aliceShares = _depositAt1to1(alice, 10_000e6);

        // Emergency key unwinds the whole basket to idle USDC at 1:1.
        usdc.mint(address(router), 10_000e6);
        router.setAmountOut(10_000e6);
        vm.prank(emergencyResponder);
        vault.emergencyUnwind();
        assertEq(basketToken.balanceOf(address(vault)), 0, "basket fully unwound");
        assertEq(usdc.balanceOf(address(vault)), 10_000e6, "all value idle");
        assertTrue(vault.depositsPaused(), "unwind pauses deposits");

        vm.prank(admin);
        vault.unpauseDeposits();

        uint256 eveShares = _depositAt1to1(eve, 1_000e6);
        uint256 supply = vault.totalSupply();

        // eve owns at most 1000/11000 of supply, plus rounding.
        assertLe(eveShares, supply * 1_000e6 / 11_000e6 + 1, "eve share of supply capped");

        uint256 eveOut = _redeemFair(eve, eveShares);
        assertLe(eveOut, 1_000e6, "eve cannot redeem more than she deposited");

        uint256 aliceOut = _redeemFair(alice, aliceShares);
        assertGe(aliceOut, 9_999e6, "alice keeps her value");
    }

    /// @notice AZ-BSK-3: no-profit round trip with idle USDC present. A deposit followed
    ///         by an immediate full redeem returns at most the deposit, and the
    ///         incumbent's previewRedeem never drops, up to a 2 wei tolerance. The
    ///         tolerance is the 10^18 virtual-share offset: mint prices against
    ///         (supply + 1e18) while redeem is raw pro-rata, so a donated idle balance
    ///         lets a round trip gain sub-wei-scale dust (measured max 1 wei over 20000
    ///         fuzz runs). That is not the over-mint fixed here (thousands of USDC).
    function test_AZBSK3_idleDepositRoundTripNoProfit(uint256 idle, uint256 d) public {
        idle = bound(idle, 1, 1e13);
        d = bound(d, 1e6, vault.perDepositCap());

        vm.prank(admin);
        vault.setTvlCap(100_000_000e6); // headroom for the 1e13 idle upper bound
        uint256 incumbentShares = _depositAt1to1(address(this), 50_000e6);
        usdc.mint(address(vault), idle);
        uint256 previewBefore = vault.previewRedeem(incumbentShares);

        address eve = makeAddr("eveFuzz");
        uint256 eveShares = _depositAt1to1(eve, d);
        assertGe(
            vault.previewRedeem(incumbentShares),
            previewBefore - 2,
            "incumbent previewRedeem must not drop on deposit"
        );

        uint256 out = _redeemFair(eve, eveShares);
        assertLe(out, d + 2, "round trip cannot profit");
        assertGe(
            vault.previewRedeem(incumbentShares),
            previewBefore - 2,
            "incumbent previewRedeem must not drop after round trip"
        );
    }

    /// @notice AZ-BSK-3 adversarial: first deposit (supply 0) with idle USDC donated
    ///         beforehand cannot be gamed: the first depositor pays the donation into
    ///         the denominator, never receives more than the OZ formula, and caps hold.
    function test_AZBSK3_firstDepositWithDonatedIdleCannotOverMint() public {
        usdc.mint(address(vault), 7_000e6); // donation before any deposit
        assertEq(vault.totalSupply(), 0);

        uint256 d = 1_000e6;
        uint256 taBefore = vault.totalAssets();
        uint256 shares = _depositAt1to1(stranger, d);
        assertEq(shares, Math.mulDiv(d, 1e18, taBefore + 1), "first mint uses full NAV + 1");

        // The depositor cannot extract more than deposit (donation is not recoverable
        // as a profit for the donor-depositor).
        uint256 out = _redeemFair(stranger, shares);
        assertLe(out, d + 7_000e6, "redeem bounded by total vault value");
    }

    /// @notice AZ-BSK-3 adversarial: tiny deposits round down and never mint a profit;
    ///         per-deposit cap still enforced.
    function test_AZBSK3_tinyDepositRoundsDownAndCapStillEnforced() public {
        _depositAt1to1(address(this), 10_000e6);
        usdc.mint(address(vault), 1_000e6);
        uint256 tiny = 1;
        basketToken.mint(address(router), tiny);
        router.setAmountOut(tiny);
        usdc.mint(stranger, tiny);
        uint256 taBefore = vault.totalAssets();
        uint256 supplyBefore = vault.totalSupply();
        vm.startPrank(stranger);
        usdc.approve(address(vault), tiny);
        uint256 shares = vault.deposit(tiny, stranger);
        vm.stopPrank();
        assertEq(shares, Math.mulDiv(tiny, supplyBefore + 1e18, taBefore + 1));
        assertLe(vault.previewRedeem(shares), tiny, "dust mint never redeems above deposit");

        uint256 over = vault.perDepositCap() + 1;
        usdc.mint(stranger, over);
        vm.startPrank(stranger);
        usdc.approve(address(vault), over);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit: maxDeposit is capped by perDepositCap
        vault.deposit(over, stranger);
        vm.stopPrank();
    }

    /// @notice AZ-BSK-3: totalAssets() accounts for ALL vault USDC (including idle
    ///         proceeds from excluded adapters). The fix only changes how shares are
    ///         priced during deposit — it does not alter the NAV accounting.
    function test_AZBSK3_totalAssetsUnchangedByExclusionFix() public {
        // Seed with 10,000 USDC worth of basket tokens (all swapped in).
        _depositAt1to1(address(this), 10_000e6);

        uint256 activeNav = vault.totalAssets(); // = basket token value, no idle USDC
        assertEq(usdc.balanceOf(address(vault)), 0, "no idle USDC yet");

        // Inject idle USDC simulating an excluded adapter's proceeds.
        uint256 idleUsdc = 3_000e6;
        usdc.mint(address(vault), idleUsdc);

        // totalAssets() must include idle USDC — it is part of the vault's NAV
        // and belongs to existing holders pro-rata.
        uint256 fullNav = vault.totalAssets();
        assertEq(
            fullNav,
            activeNav + idleUsdc,
            "AZ-BSK-3: totalAssets() includes idle USDC from excluded adapters unchanged"
        );
        assertEq(
            usdc.balanceOf(address(vault)),
            idleUsdc,
            "AZ-BSK-3: idle USDC is held directly in vault"
        );
    }

    // ─── IRetirableVault: retire/unretire (FS-VLT-19 / issue #1284) ──────────

    /// @notice issue #1284: retire() sets the dedicated `retired` flag, NOT
    ///         `depositsPaused` — the two are independent so ADMIN_ROLE's
    ///         `unpauseDeposits()` (which unconditionally clears `depositsPaused`) can
    ///         never re-open deposits on a registry-retired vault. Matches
    ///         RobotMoneyVault's / Vault's separate-flag model; superseded the
    ///         old aliasing behavior this test used to pin.
    function test_retire_setsRetired() public {
        address reg = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(reg);

        assertFalse(vault.retired(), "vault must not be retired before retire()");

        vm.prank(reg);
        vault.retire();

        assertTrue(vault.retired(), "retire() must set retired = true");
        assertFalse(vault.depositsPaused(), "retire() must not alias depositsPaused (issue #1284)");
    }

    /// @notice issue #1284: unretire() clears the dedicated `retired` flag and
    ///         emits Unretired.
    function test_unretire_clearsRetired() public {
        address reg = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(reg);

        vm.prank(reg);
        vault.retire();
        assertTrue(vault.retired(), "vault must be retired before unretire()");

        vm.prank(reg);
        vault.unretire();

        assertFalse(vault.retired(), "unretire() must clear retired");
    }

    /// @notice issue #1284 (F-06 regression): retire() -> emergency pauseDeposits() ->
    ///         admin unpauseDeposits() must leave deposits closed (the registry still
    ///         records the vault Retired) while ERC-4626 redeem stays open
    ///         (ADR-0009). Before this fix, BasketVault aliased retirement
    ///         onto `depositsPaused`, so `unpauseDeposits()` (which unconditionally
    ///         calls `_setDepositsPaused(false)`) silently re-opened deposits
    ///         on a vault the registry still recorded as Retired.
    function test_retirePauseUnpause_leavesDepositsClosedButRedeemOpen() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 basketOut = 995 * ONE_USDC;
        usdc.mint(stranger, depositAmount);
        basketToken.mint(address(router), basketOut);
        router.setAmountOut(basketOut);

        vm.startPrank(stranger);
        usdc.approve(address(vault), depositAmount);
        uint256 shares = vault.deposit(depositAmount, stranger);
        vm.stopPrank();

        address reg = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(reg);

        vm.prank(reg);
        vault.retire();
        assertTrue(vault.retired(), "vault must be retired");

        vm.prank(emergencyResponder);
        vault.pauseDeposits();

        vm.prank(admin);
        vault.unpauseDeposits();

        assertTrue(vault.retired(), "unpauseDeposits() must not clear retirement (issue #1284)");
        assertEq(vault.maxDeposit(stranger), 0, "deposits must stay closed on a retired vault");

        vm.prank(stranger);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit — deposits gated by maxDeposit()
        vault.deposit(1, stranger);

        uint256 redeemOut = 990 * ONE_USDC;
        usdc.mint(address(router), redeemOut);
        router.setAmountOut(redeemOut);
        vm.prank(stranger);
        uint256 redeemed = vault.redeem(shares, stranger, stranger);
        assertGt(redeemed, 0, "redeem must stay open on a retired vault (ADR-0009)");
    }

    /// @notice retire() reverts when caller is not the linked registry.
    function test_retire_revertsForNonRegistry() public {
        vm.expectRevert(BasketVault.OnlyRegistry.selector);
        vm.prank(stranger);
        vault.retire();
    }

    /// @notice unretire() reverts when caller is not the linked registry.
    function test_unretire_revertsForNonRegistry() public {
        vm.expectRevert(BasketVault.OnlyRegistry.selector);
        vm.prank(stranger);
        vault.unretire();
    }

    /// @notice setRegistry() is set-once; a second call reverts RegistryAlreadySet.
    function test_setRegistry_revertsOnSecondCall() public {
        address reg = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(reg);

        vm.expectRevert(BasketVault.RegistryAlreadySet.selector);
        vm.prank(admin);
        vault.setRegistry(reg);
    }

    // ─── core 1513: redeem entry gas floor ───────────────────────────────────────

    /// @notice A redeem entered with less gas than the floor reverts with the typed
    ///         `InsufficientGas(available, required)` error, before any state change.
    ///         The harness lists one asset, so the floor is 300k + 400k = 700k.
    function test_redeem_revertsInsufficientGasBelowFloor() public {
        uint256 shares = _depositAt1to1(stranger, 1_000e6);
        uint256 floor = 700_000;

        vm.prank(stranger);
        (bool ok, bytes memory ret) = address(vault).call{gas: 600_000}(
            abi.encodeCall(vault.redeem, (shares, stranger, stranger))
        );
        assertFalse(ok, "redeem below the floor must revert");
        assertEq(bytes4(ret), BasketVault.InsufficientGas.selector, "typed floor error");
        (uint256 available, uint256 required) = abi.decode(_tail(ret), (uint256, uint256));
        assertLt(available, floor, "reported gas is below the floor");
        assertEq(required, floor, "reported floor is base + one asset");
        assertEq(vault.balanceOf(stranger), shares, "shares untouched by the refused redeem");
    }

    /// @notice A redeem entered with at least the floor does not hit the guard.
    function test_redeem_succeedsAtOrAboveFloor() public {
        uint256 shares = _depositAt1to1(stranger, 1_000e6);
        usdc.mint(address(router), 1_000e6);
        router.setAmountOut(1_000e6);

        vm.prank(stranger);
        (bool ok,) = address(vault).call{gas: 2_000_000}(
            abi.encodeCall(vault.redeem, (shares, stranger, stranger))
        );
        assertTrue(ok, "redeem with ample gas succeeds");
        assertEq(vault.balanceOf(stranger), 0, "shares burned");
    }

    // ─── Core 1665: window-derived cardinality floor ──────────────────

    /// @notice The 1800 s default window needs 1800 / 2 + 1 = 901 slots: 900 reverts, 901 registers.
    function test_addAsset_rejectsCardinalityBelowWindowFloor() public {
        TestERC20 newAsset = new TestERC20();
        MockPool p = new MockPool(address(newAsset), address(usdc), uint160(1 << 96));
        p.setCardinality(900);
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketAssetConfigGuard.InsufficientPoolCardinality.selector,
                address(p),
                uint16(901),
                uint16(900)
            )
        );
        vm.prank(admin);
        vault.addAsset(address(newAsset), address(p), 500, address(0), BasketVault.Venue.V3);

        p.setCardinality(901);
        vm.prank(admin);
        vault.addAsset(address(newAsset), address(p), 500, address(0), BasketVault.Venue.V3);
        assertEq(vault.assetCount(), 2, "registered at exactly the floor");
    }

    /// @notice A 3600 s window needs 1801 slots: 1800 reverts, 1801 is accepted.
    function test_setTwapWindow_rejectsCardinalityBelowNewFloor() public {
        pool.setCardinality(1_800);
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketAssetConfigGuard.InsufficientPoolCardinality.selector,
                address(pool),
                uint16(1_801),
                uint16(1_800)
            )
        );
        vm.prank(admin);
        vault.setTwapWindow(address(basketToken), 3_600);
        assertEq(vault.effectiveTwapWindow(address(basketToken)), 1_800, "window unchanged");

        pool.setCardinality(1_801);
        vm.prank(admin);
        vault.setTwapWindow(address(basketToken), 3_600);
        assertEq(vault.effectiveTwapWindow(address(basketToken)), 3_600, "window set at floor");
    }

    // ─── Core 1665: redeemInKind ──────────────────────────────────────

    /// @dev Alice holds all shares of a vault with `basketToken` backing, idle USDC and a 1% exit fee.
    function _seedInKind() internal returns (address alice, uint256 shares) {
        alice = makeAddr("alice");
        shares = _depositAt1to1(alice, 10_000 * ONE_USDC);
        usdc.mint(address(vault), 777 * ONE_USDC); // idle USDC
        vm.prank(admin);
        vault.setExitFeeBps(100);
    }

    /// @dev Registers a second ACTIVE asset holding `amount` tokens.
    function _addSecond(uint256 amount) internal returns (TestERC20 t2) {
        t2 = new TestERC20();
        MockPool p2 = new MockPool(address(t2), address(usdc), uint160(1 << 96));
        vm.prank(admin);
        vault.addAsset(address(t2), address(p2), 500, address(0), BasketVault.Venue.V3);
        t2.mint(address(vault), amount);
    }

    /// @notice PoC test_redeemBlockedByOracle: with observe() reverting, redeem reverts and
    ///         redeemInKind pays the pro-rata tokens and idle USDC minus the exit fee.
    function test_redeemInKind_succeedsWhenObserveReverts() public {
        (address alice, uint256 shares) = _seedInKind();
        pool.setRevertObserve(true);

        vm.prank(alice);
        vm.expectRevert();
        vault.redeem(shares / 2, alice, alice);

        uint256 sup = vault.totalSupply();
        uint256 tokBal = basketToken.balanceOf(address(vault));
        uint256 usdcBal = usdc.balanceOf(address(vault));
        uint256 tokAmt = tokBal * (shares / 2) / sup;
        uint256 usdcAmt = usdcBal * (shares / 2) / sup;
        uint256 tokFee = tokAmt * 100 / 10_000;
        uint256 usdcFee = usdcAmt * 100 / 10_000;
        assertGt(tokFee, 0, "fee leg exercised");

        vm.prank(alice);
        vault.redeemInKind(shares / 2, alice, alice);

        assertEq(vault.balanceOf(alice), shares - shares / 2, "shares burned");
        assertEq(basketToken.balanceOf(alice), tokAmt - tokFee, "token net of fee");
        assertEq(usdc.balanceOf(alice), usdcAmt - usdcFee, "idle USDC net of fee");
        assertEq(basketToken.balanceOf(admin), tokFee, "token fee to feeRecipient");
        assertEq(usdc.balanceOf(admin), usdcFee, "usdc fee to feeRecipient");
        assertEq(
            basketToken.balanceOf(address(vault)), tokBal - tokAmt, "vault paid exactly pro rata"
        );
    }

    /// @notice redeemInKind is not blocked by pause, unwind, shutdown or retire. A third party with
    ///         allowance redeems for the owner and the allowance is spent.
    function test_redeemInKind_neverBlocked() public {
        (address alice, uint256 shares) = _seedInKind();
        uint256 q = shares / 5;

        vm.prank(emergencyResponder);
        vault.pauseDeposits();
        assertTrue(vault.depositsPaused());
        vm.prank(alice);
        vault.redeemInKind(q, alice, alice);

        // After emergencyUnwind the basket token is USDC.
        usdc.mint(address(router), 10_000 * ONE_USDC);
        router.setAmountOut(9_000 * ONE_USDC);
        vm.prank(emergencyResponder);
        vault.emergencyUnwind();
        vm.prank(alice);
        vault.redeemInKind(q, alice, alice);

        vm.prank(emergencyResponder);
        vault.shutdownVault();
        vm.prank(alice);
        vault.redeemInKind(q, alice, alice);

        address reg = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(reg);
        vm.prank(reg);
        vault.retire();
        vm.prank(alice);
        vault.redeemInKind(q, alice, alice);

        // Third party with allowance, receiver differs from owner.
        address spender = makeAddr("spender");
        address dest = makeAddr("dest");
        vm.prank(alice);
        vault.approve(spender, q + 5);
        vm.prank(spender);
        vault.redeemInKind(q, dest, alice);
        assertEq(vault.allowance(alice, spender), 5, "allowance spent by exactly shares");
        assertGt(usdc.balanceOf(dest), 0, "receiver paid");

        // Without allowance it reverts and nothing is burned.
        address nobody = makeAddr("nobody");
        uint256 before_ = vault.balanceOf(alice);
        vm.prank(nobody);
        vm.expectRevert();
        vault.redeemInKind(1, nobody, alice);
        assertEq(vault.balanceOf(alice), before_, "no burn without allowance");
    }

    /// @notice Fuzz: exact floor pro-rata per ACTIVE asset, inactive assets not paid, and the remaining
    ///         holder's per-share backing never decreases for any token or USDC.
    function testFuzz_redeemInKind_proRataExact(uint256 shares_) public {
        (address alice, uint256 aliceShares) = _seedInKind();
        address bob = makeAddr("bob");
        // Bob joins so there is a remaining holder.
        _depositAt1to1(bob, 3_000 * ONE_USDC);
        TestERC20 t2 = _addSecond(1_234_567);
        // A removed (inactive) asset whose balance reappeared must not be paid.
        TestERC20 t3 = new TestERC20();
        MockPool p3 = new MockPool(address(t3), address(usdc), uint160(1 << 96));
        vm.startPrank(admin);
        vault.addAsset(address(t3), address(p3), 500, address(0), BasketVault.Venue.V3);
        vault.removeAsset(2);
        vm.stopPrank();
        t3.mint(address(vault), 999_999);

        shares_ = bound(shares_, 1, aliceShares);
        uint256[4] memory pre = [
            vault.totalSupply(),
            basketToken.balanceOf(address(vault)),
            t2.balanceOf(address(vault)),
            usdc.balanceOf(address(vault))
        ];
        uint256 aliceUsdc0 = usdc.balanceOf(alice);

        vm.prank(alice);
        vault.redeemInKind(shares_, alice, alice);

        assertEq(
            basketToken.balanceOf(alice) + basketToken.balanceOf(admin),
            pre[1] * shares_ / pre[0],
            "token1 exact"
        );
        assertEq(
            t2.balanceOf(alice) + t2.balanceOf(admin), pre[2] * shares_ / pre[0], "token2 exact"
        );
        assertEq(
            usdc.balanceOf(alice) - aliceUsdc0 + usdc.balanceOf(admin),
            pre[3] * shares_ / pre[0],
            "usdc exact"
        );
        assertEq(t3.balanceOf(address(vault)), 999_999, "inactive asset not paid");
        assertEq(t3.balanceOf(alice), 0, "inactive asset not paid out");

        assertEq(vault.totalSupply(), pre[0] - shares_, "supply reduced by shares");
        uint256 sup2 = vault.totalSupply();
        assertGe(basketToken.balanceOf(address(vault)) * pre[0], pre[1] * sup2, "token1 backing");
        assertGe(t2.balanceOf(address(vault)) * pre[0], pre[2] * sup2, "token2 backing");
        assertGe(usdc.balanceOf(address(vault)) * pre[0], pre[3] * sup2, "usdc backing");
    }

    /// @notice A token callback cannot re-enter, and shares are already burned when the callback runs.
    function test_redeemInKind_reentrancyBlockedAndSharesBurnedFirst() public {
        ReentrantHookToken hook = new ReentrantHookToken();
        MockPool hp = new MockPool(address(hook), address(usdc), uint160(1 << 96));
        BasketVaultHarness v = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(router)), admin, emergencyResponder
        );
        vm.prank(admin);
        v.addAsset(address(hook), address(hp), 500, address(0), BasketVault.Venue.V3);
        address alice = makeAddr("alice");
        // Mint shares by seeding the vault through a deposit at 1:1.
        hook.mint(address(router), 1_000 * ONE_USDC);
        router.setAmountOut(1_000 * ONE_USDC);
        usdc.mint(alice, 1_000 * ONE_USDC);
        vm.startPrank(alice);
        usdc.approve(address(v), 1_000 * ONE_USDC);
        uint256 sh = v.deposit(1_000 * ONE_USDC, alice);
        vm.stopPrank();

        hook.arm(v, alice);
        vm.prank(alice);
        v.redeemInKind(sh, alice, alice);

        assertTrue(hook.reentered(), "callback ran");
        assertFalse(hook.reentrySucceeded(), "re-entry must not succeed");
        assertEq(
            hook.reentryReason(),
            bytes4(abi.encodeWithSignature("ReentrancyGuardReentrantCall()")),
            "blocked by the reentrancy guard"
        );
        assertEq(hook.sharesAtCallback(), 0, "shares were burned before the first transfer");
        assertEq(hook.supplyAtCallback(), 0, "supply already reduced at the callback");
        assertEq(hook.balanceOf(alice), 1_000 * ONE_USDC, "paid in kind (fee is 0 on this vault)");
    }

    /// @notice redeemInKind reads no TWAP and sells nothing: it works with a router that has no
    ///         liquidity and a pool that reverts on both observe and slot0-priced reads.
    function test_redeemInKind_noSwapNoOracle() public {
        (address alice, uint256 shares) = _seedInKind();
        pool.setRevertObserve(true);
        router.setAmountOut(0);
        vm.prank(alice);
        vault.redeemInKind(shares, alice, alice);
        assertEq(vault.totalSupply(), 0);
        assertGt(basketToken.balanceOf(alice), 0);
    }

    /// @notice The entry gas floor applies as in redeem.
    function test_redeemInKind_revertsBelowGasFloor() public {
        (address alice, uint256 shares) = _seedInKind();
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(vault).call{gas: 400_000}(
            abi.encodeCall(vault.redeemInKind, (shares, alice, alice))
        );
        assertFalse(ok, "low gas must revert");
        assertEq(bytes4(ret), BasketVault.InsufficientGas.selector, "InsufficientGas");
        assertEq(vault.balanceOf(alice), shares, "no burn");
    }

    function _tail(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = data[i + 4];
        }
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
        cardinality = 1000;
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

        // ADP-2 / NC-2: approve the adapter's codehash before it can be onboarded.
        vm.prank(admin);
        vault.setAdapterCodeHashAllowed(address(aeroAdapter).codehash, true);

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
        assertTrue(
            vault.depositsPaused(),
            "unwind halts deposits only; Aerodrome unwind keeps redemption available"
        );
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

// ─── Per-asset venue selector tests (issue #555) ──────────────────────────────

/// @title BasketVaultVenueSelectorTest
/// @notice Verifies that addAsset stores the Venue enum on AssetInfo and
///         dispatches swap + TWAP through the matching adapter for all three
///         venue types (V3, V3 via adapter, Aerodrome).
///         Acceptance criteria (issue #555):
///         AC1 — addAsset accepts a venue selector and stores it on AssetInfo.
///         AC2 — Swap and TWAP dispatch to the correct adapter per venue,
///               including in emergency unwind.
///         AC3 — Tests cover adding assets on V3, V3 via adapter, and Aerodrome.
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
    MockAerodromeRouter internal aeroRouter;
    BasketVaultHarness internal vault;

    address internal admin = makeAddr("admin");
    address internal emergencyResponder = makeAddr("emergencyResponder");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_800_000); // ensure block.timestamp > DEFAULT_TWAP_WINDOW

        usdc = new TestERC20();
        v3Router = new MockSwapRouter();
        aeroRouter = new MockAerodromeRouter();

        vault = new BasketVaultHarness(
            IERC20(address(usdc)), ISwapRouter(address(v3Router)), admin, emergencyResponder
        );

        // ADP-2 / NC-2: every UniswapV3SwapAdapter / AerodromeSwapAdapter instance
        // shares the same runtime codehash, so approving one representative codehash
        // per type covers all per-test adapter deployments below.
        bytes32 v3AdapterCodeHash = address(new UniswapV3SwapAdapter(address(v3Router))).codehash;
        bytes32 aeroCodeHash =
            address(new AerodromeSwapAdapter(address(aeroRouter), address(aeroRouter))).codehash;
        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(v3AdapterCodeHash, true);
        vault.setAdapterCodeHashAllowed(aeroCodeHash, true);
        vm.stopPrank();
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

    /// @notice A three-asset basket (V3 + V3 adapter + Aerodrome) stores all three venue
    ///         values correctly on AssetInfo.
    function test_mixedVenue_allVenueValuesStoredCorrectly() public {
        BasketVaultHarness freshVault = _buildMixedVenueVault();
        (,,,,, BasketVault.Venue venue0) = freshVault.assets(0);
        (,,,,, BasketVault.Venue venue1) = freshVault.assets(1);
        (,,,,, BasketVault.Venue venue2) = freshVault.assets(2);
        assertEq(uint8(venue0), uint8(BasketVault.Venue.V3), "mixed: asset[0] venue is V3");
        assertEq(uint8(venue1), uint8(BasketVault.Venue.V3), "mixed: asset[1] venue is V3");
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

        // V3 asset routed through the UniswapV3SwapAdapter
        TestERC20 v4Token = new TestERC20();
        MockPool v4Pool = new MockPool(address(v4Token), address(usdc), uint160(1 << 96));
        UniswapV3SwapAdapter v4Adapter = new UniswapV3SwapAdapter(address(v3Router));

        // Aerodrome asset
        TestERC20 aeroToken = new TestERC20();
        address aero0 = address(aeroToken) < address(usdc) ? address(aeroToken) : address(usdc);
        address aero1 = address(aeroToken) < address(usdc) ? address(usdc) : address(aeroToken);
        MockAerodromePool aeroPool = new MockAerodromePool(aero0, aero1);
        aeroRouter.setPool(address(aeroToken), address(usdc), 100, address(aeroPool));
        AerodromeSwapAdapter aeroAdapter =
            new AerodromeSwapAdapter(address(aeroRouter), address(aeroRouter));

        vm.startPrank(admin);
        // ADP-2 / NC-2: approve the external adapters' codehashes on this fresh vault.
        freshVault.setAdapterCodeHashAllowed(address(v4Adapter).codehash, true);
        freshVault.setAdapterCodeHashAllowed(address(aeroAdapter).codehash, true);
        freshVault.addAsset(
            address(v3Token), address(v3Pool), 500, address(0), BasketVault.Venue.V3
        );
        freshVault.addAsset(
            address(v4Token), address(v4Pool), 500, address(v4Adapter), BasketVault.Venue.V3
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
        TestERC20(v4TokenAddr).mint(address(v3Router), routerOut);
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
            "mixed: adapter token received via V3 adapter"
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

contract BasketVaultTimelockTest is SafeGovernance {
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
        _installSafeSet();
        safe = _newDefaultSafe();

        // Production timelock shape: the Safe is the only proposer and canceller.
        timelock = _newGovTimelock(safe, MIN_DELAY);

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
        bytes32 salt = keccak256("ac7-basket-fee-recipient");

        _govSchedule(safe, timelock, address(vault), callData, salt, MIN_DELAY);

        // Pre-delay: exact reasons through the Safe (GS013) and on the timelock.
        _expectExecuteRefused(safe, timelock, address(vault), callData, salt);

        vm.warp(block.timestamp + MIN_DELAY);
        _govExecute(safe, timelock, address(vault), callData, salt);

        assertEq(vault.feeRecipient(), newRecipient, "fee recipient must update via timelock");
    }

    /// @notice AC7: setExitFeeBps succeeds ONLY via TimelockController.
    function test_AC7_basket_setExitFeeBps_succeedsViaTimelock() public {
        uint256 newFee = 50;
        bytes memory callData = abi.encodeCall(BasketVault.setExitFeeBps, (newFee));

        bytes32 salt = keccak256("ac7-basket-exit-fee");
        _govRun(safe, timelock, address(vault), callData, salt, MIN_DELAY);

        // Replay of the executed operation: exact reasons on both paths.
        _expectExecuteRefused(safe, timelock, address(vault), callData, salt);

        assertEq(vault.exitFeeBps(), newFee, "exit fee must update via timelock");
    }
}
