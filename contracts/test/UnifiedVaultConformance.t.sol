// SPDX-License-Identifier: MIT
// Canonical: docs/technical/unified-vault-spec.md §5 (Unified `Vault`),
//            docs/adr/ADR-0010-unified-vault-architecture.md,
//            docs/technical/unified-vault-open-questions-resolution.md.
//
// ERC-4626 CONFORMANCE / PARITY PER COMPOSITION (issue #1127, M-A2/M-A3).
//
// ERC-4626 conformance MUST be re-verified per composition because the unified
// `Vault` runs in two pinned accounting modes selected by `allExact()`, and the
// two modes expose DIFFERENT `withdraw`/`redeem`/`preview*`/`max*` semantics and
// a DIFFERENT exit-fee base that integrators branch on (spec §5.1/§5.3, review
// L-E6). A single conformance pass over one mode would leave the other mode's
// surface unverified. This file pins BOTH compositions in one contract family
// matched by `--match-contract UnifiedVaultConformanceTest`:
//
//   * UnifiedVaultConformanceTestExact      — the LENDING-ONLY EXACT composition
//     (`allExact() == true`): every active adapter is a 1:1 redemption claim.
//     `withdraw()`/`previewWithdraw()` are LIVE, `maxWithdraw`/`maxRedeem` are
//     non-zero, and the exit fee is charged on the GROSS redeemed value.
//   * UnifiedVaultConformanceTestRedeemOnly — the BASKET REDEEM-ONLY composition
//     (`allExact() == false`): at least one active adapter is slippage-priced.
//     `withdraw()`/`previewWithdraw()` revert `RedeemOnly`, `maxWithdraw`/
//     `maxRedeem` are `0`, `redeem()` stays live, and the exit fee is charged on
//     the REALIZED proceeds.
//
// These run in the default `forge test` CI job (suite-01-02-forge-tests.yml),
// so the diff is executed with a non-zero test count — no external resource,
// no skip, no fork. The pinned-fork parity leg lives in VaultForkRegressions.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Vault} from "../Vault.sol";
import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Exact `IPositionAdapter` conformance fixture: a 1:1 USDC holder.
///      `deploy` marks at par, `withdraw` clamps at balance and delivers 1:1,
///      `totalAssets` is the held USDC, `isExact() == true`. Uniquely named to
///      avoid forge-doc re-link collisions with the sibling test fixtures.
contract ConformanceExactAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;

    address public immutable USDC;
    address public immutable VAULT;
    address internal constant SINK = address(0xdEaD);

    error TokenProtected();

    constructor(address usdc_, address vault_) {
        USDC = usdc_;
        VAULT = vault_;
    }

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    function deploy(uint256 usdcIn, uint256 minValueOut)
        external
        onlyVault
        returns (uint256 valueAdded)
    {
        valueAdded = usdcIn;
        if (valueAdded < minValueOut) revert SlippageExceeded();
    }

    function withdraw(uint256 usdcWanted, uint256 minUsdcOut)
        external
        onlyVault
        returns (uint256 usdcOut)
    {
        uint256 bal = IERC20(USDC).balanceOf(address(this));
        usdcOut = usdcWanted > bal ? bal : usdcWanted;
        if (usdcOut < minUsdcOut) revert SlippageExceeded();
        IERC20(USDC).safeTransfer(VAULT, usdcOut);
    }

    function totalAssets() external view returns (uint256) {
        return IERC20(USDC).balanceOf(address(this));
    }

    function isExact() external pure returns (bool) {
        return true;
    }

    function harvestRewards() external {}

    function sweepForeignToken(address token) external {
        if (token == USDC) revert TokenProtected();
        IERC20(token).safeTransfer(SINK, IERC20(token).balanceOf(address(this)));
    }
}

/// @dev Inexact (basket) `IPositionAdapter` conformance fixture: a slippage-
///      priced position. It custodies USDC as its mark, but a `withdraw`
///      realizes only `wanted × (1 − haircutBps)` — the haircut burned to a sink
///      so the mark drops by the full consumed amount. `deploy` marks at par,
///      `isExact() == false`, never reverts on under-delivery above the floor.
contract ConformanceInexactAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;

    address public immutable USDC;
    address public immutable VAULT;
    uint256 public immutable haircutBps;
    address internal constant SINK = address(0xdEaD);
    uint16 internal constant BPS = 10_000;

    error TokenProtected();

    constructor(address usdc_, address vault_, uint256 haircutBps_) {
        USDC = usdc_;
        VAULT = vault_;
        haircutBps = haircutBps_;
    }

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    function deploy(uint256 usdcIn, uint256 minValueOut)
        external
        onlyVault
        returns (uint256 valueAdded)
    {
        valueAdded = usdcIn; // marked at par on entry
        if (valueAdded < minValueOut) revert SlippageExceeded();
    }

    function withdraw(uint256 usdcWanted, uint256 minUsdcOut)
        external
        onlyVault
        returns (uint256 usdcOut)
    {
        uint256 bal = IERC20(USDC).balanceOf(address(this));
        uint256 consumed = usdcWanted > bal ? bal : usdcWanted;
        usdcOut = consumed - (consumed * haircutBps) / BPS;
        if (usdcOut < minUsdcOut) revert SlippageExceeded();
        IERC20(USDC).safeTransfer(VAULT, usdcOut);
        uint256 lost = consumed - usdcOut;
        if (lost > 0) IERC20(USDC).safeTransfer(SINK, lost);
    }

    function totalAssets() external view returns (uint256) {
        return IERC20(USDC).balanceOf(address(this));
    }

    function isExact() external pure returns (bool) {
        return false;
    }

    function harvestRewards() external {}

    function sweepForeignToken(address token) external {
        if (token == USDC) revert TokenProtected();
        IERC20(token).safeTransfer(SINK, IERC20(token).balanceOf(address(this)));
    }
}

/// @dev Shared conformance harness: deploys a `Vault`, funds users, and
///      registers adapters through the full eligibility gate.
abstract contract UnifiedVaultConformanceBase is Test {
    TestERC20 internal usdc;
    Vault internal vault;

    address internal admin = makeAddr("admin");
    address internal emergency = makeAddr("emergency");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant ONE_USDC = 1_000_000; // 6-decimal
    uint256 internal constant MAX_BPS = 10_000;
    uint256 internal constant MAX_SLIPPAGE_BPS = 200; // 2%
    // Huge finite NAV-growth cap so the #1120 limiter is inert for these
    // accounting-focused conformance tests (it has its own suite). Combined with
    // a time warp before every deposit so the elapsed-scaled budget is non-zero.
    uint256 internal constant MAX_NAV_GROWTH_RATE_BPS = 1e30;

    function _deployVault(uint256 exitFeeBps) internal {
        usdc = new TestERC20();
        vault = new Vault(
            IERC20(address(usdc)),
            "Robot Money USDC",
            "rmUSDC",
            type(uint256).max, // tvlCap
            type(uint256).max, // perDepositCap
            exitFeeBps,
            MAX_SLIPPAGE_BPS,
            MAX_NAV_GROWTH_RATE_BPS,
            feeRecipient,
            admin,
            emergency
        );
    }

    function _register(address adapter, uint16 capBps, bool isExact) internal {
        vm.startPrank(admin);
        vault.setAdapterAllowed(adapter, true);
        vault.setAdapterCodeHashAllowed(adapter.codehash, true);
        vault.addAdapter(adapter, capBps, isExact);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        // Warp so the #1120 NAV-growth budget is non-zero across back-to-back
        // deposits (see MAX_NAV_GROWTH_RATE_BPS), keeping the limiter inert.
        vm.warp(block.timestamp + 1 hours);
        usdc.mint(who, assets);
        vm.startPrank(who);
        usdc.approve(address(vault), assets);
        shares = vault.deposit(assets, who);
        vm.stopPrank();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// UnifiedVaultConformanceTestExact — LENDING-ONLY EXACT composition
//   `allExact() == true`: live withdraw, non-zero max*, fee-on-GROSS.
// ─────────────────────────────────────────────────────────────────────────────

contract UnifiedVaultConformanceTestExact is UnifiedVaultConformanceBase {
    ConformanceExactAdapter internal adapter;

    function setUp() public {
        _deployVault(0); // default zero-fee vault; fee cases re-deploy locally
        adapter = new ConformanceExactAdapter(address(usdc), address(vault));
        _register(address(adapter), uint16(MAX_BPS), true);
    }

    // ── Composition selector ─────────────────────────────────────────────────

    function test_composition_isExactMode() public {
        assertTrue(vault.allExact(), "lending-only set => allExact() true");
    }

    // ── ERC-4626 preview↔action parity (zero fee) ────────────────────────────

    /// @notice `previewDeposit` equals the shares `deposit` actually mints, and
    ///         both equal OZ's floor conversion (exact composition, spec §5.2).
    function test_previewDeposit_parity() public {
        uint256 assets = 750 * ONE_USDC;
        uint256 predicted = vault.previewDeposit(assets);
        assertEq(predicted, vault.convertToShares(assets), "previewDeposit == OZ floor convert");
        uint256 minted = _deposit(alice, assets);
        assertEq(minted, predicted, "deposit() mints exactly previewDeposit shares");
    }

    /// @notice `previewWithdraw` is LIVE in exact mode and equals the shares
    ///         `withdraw` burns; the receiver gets exactly the requested net.
    function test_previewWithdraw_isLive_andParity() public {
        _deposit(alice, 1_000 * ONE_USDC);

        uint256 net = 300 * ONE_USDC;
        uint256 predictedShares = vault.previewWithdraw(net); // does NOT revert
        assertGt(predictedShares, 0, "previewWithdraw live in exact mode");

        uint256 sharesBefore = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 burned = vault.withdraw(net, alice, alice);
        assertEq(burned, predictedShares, "withdraw burns previewWithdraw shares");
        assertEq(sharesBefore - vault.balanceOf(alice), burned, "share delta == burned");
        assertEq(usdc.balanceOf(alice), net, "receiver funded exact net");
    }

    /// @notice `previewRedeem` equals the assets `redeem` returns; with zero fee
    ///         it equals the gross conversion (exact composition).
    function test_previewRedeem_parity_zeroFee() public {
        uint256 shares = _deposit(alice, 1_000 * ONE_USDC);
        uint256 predicted = vault.previewRedeem(shares);
        assertEq(predicted, vault.convertToAssets(shares), "zero-fee previewRedeem == gross");
        vm.prank(alice);
        uint256 got = vault.redeem(shares, alice, alice);
        assertEq(got, predicted, "redeem returns previewRedeem assets");
        assertEq(usdc.balanceOf(alice), got, "receiver funded");
    }

    // ── max* views (live, non-zero) ──────────────────────────────────────────

    function test_maxViews_liveAndNonZero() public {
        _deposit(alice, 1_000 * ONE_USDC);
        assertGt(vault.maxWithdraw(alice), 0, "maxWithdraw > 0 in exact mode");
        assertEq(vault.maxRedeem(alice), vault.balanceOf(alice), "maxRedeem == share balance");
    }

    /// @notice E-1 (classic ERC-4626 fee edge): `withdraw(maxWithdraw(owner))`
    ///         must never revert, even under a non-zero exit fee.
    function test_maxWithdraw_roundTripNeverReverts_withFee() public {
        _deployVault(100); // 1% exit fee
        ConformanceExactAdapter a = new ConformanceExactAdapter(address(usdc), address(vault));
        _register(address(a), uint16(MAX_BPS), true);
        _deposit(alice, 1_000 * ONE_USDC);

        uint256 maxW = vault.maxWithdraw(alice);
        assertGt(maxW, 0, "maxWithdraw > 0");
        vm.prank(alice);
        uint256 burned = vault.withdraw(maxW, alice, alice); // must not revert
        assertGt(burned, 0, "withdraw at maxWithdraw succeeds");
        assertEq(usdc.balanceOf(alice), maxW, "received exactly maxWithdraw");
    }

    // ── Fee base: EXACT mode charges the exit fee on the GROSS redeemed value ──

    function test_feeBase_isGross_onWithdraw() public {
        _deployVault(100); // 1% exit fee
        ConformanceExactAdapter a = new ConformanceExactAdapter(address(usdc), address(vault));
        _register(address(a), uint16(MAX_BPS), true);
        _deposit(alice, 1_000 * ONE_USDC);

        uint256 net = 200 * ONE_USDC;
        uint256 shares = vault.previewWithdraw(net);
        uint256 grossAssets = vault.previewMint(shares); // gross implied by the burned shares
        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        vm.prank(alice);
        vault.withdraw(net, alice, alice);

        uint256 feePaid = usdc.balanceOf(feeRecipient) - feeBefore;
        // Fee is charged on the GROSS value (not the net delivered).
        assertApproxEqAbs(feePaid, Math.mulDiv(grossAssets, 100, MAX_BPS), 2, "fee-on-gross base");
        assertEq(usdc.balanceOf(alice), net, "receiver still gets exact net");
    }

    /// @notice `previewRedeem` in exact mode is gross-minus-fee (fee-on-gross).
    function test_feeBase_previewRedeem_isGrossMinusFee() public {
        _deployVault(100); // 1% exit fee
        ConformanceExactAdapter a = new ConformanceExactAdapter(address(usdc), address(vault));
        _register(address(a), uint16(MAX_BPS), true);
        uint256 shares = _deposit(alice, 1_000 * ONE_USDC);

        uint256 gross = vault.convertToAssets(shares);
        uint256 expected = gross - Math.mulDiv(gross, 100, MAX_BPS);
        assertEq(vault.previewRedeem(shares), expected, "previewRedeem == gross*(1-fee)");
    }

    // ── Round-trip: no profit; zero-fee round-trip is loss-free ──────────────

    /// @notice SUP-3: an immediate deposit→redeem round trip cannot profit; with
    ///         zero fee on an exact set it returns exactly the principal.
    function testFuzz_depositRedeemRoundTrip_noProfit(uint256 assets) public {
        assets = bound(assets, ONE_USDC, 1_000_000 * ONE_USDC);
        uint256 shares = _deposit(alice, assets);
        vm.prank(alice);
        uint256 got = vault.redeem(shares, alice, alice);
        assertLe(got, assets, "round trip never profits (SUP-3)");
        assertEq(got, assets, "zero-fee exact round trip is loss-free");
    }

    /// @notice convert* rounding direction: shares→assets→shares never inflates.
    function testFuzz_convertRoundTrip_flooredNoInflation(uint256 assets) public {
        assets = bound(assets, ONE_USDC, 1_000_000 * ONE_USDC);
        _deposit(alice, assets);
        uint256 s = vault.convertToShares(assets);
        assertLe(vault.convertToAssets(s), assets, "assets->shares->assets never inflates");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// UnifiedVaultConformanceTestRedeemOnly — BASKET REDEEM-ONLY composition
//   `allExact() == false`: withdraw reverts RedeemOnly, max*==0, fee-on-REALIZED.
// ─────────────────────────────────────────────────────────────────────────────

contract UnifiedVaultConformanceTestRedeemOnly is UnifiedVaultConformanceBase {
    uint256 internal constant EXIT_FEE_BPS = 50; // 0.5%
    uint256 internal constant HAIRCUT_BPS = 100; // 1% realized slippage (< maxSlippage)

    ConformanceInexactAdapter internal adapter;

    function setUp() public {
        _deployVault(EXIT_FEE_BPS);
        adapter = new ConformanceInexactAdapter(address(usdc), address(vault), HAIRCUT_BPS);
        _register(address(adapter), uint16(MAX_BPS), false);
    }

    // ── Composition selector ─────────────────────────────────────────────────

    function test_composition_isRedeemOnlyMode() public {
        assertFalse(vault.allExact(), "basket set => allExact() false");
    }

    // ── withdraw / previewWithdraw are RedeemOnly ────────────────────────────

    function test_previewWithdraw_revertsRedeemOnly() public {
        _deposit(alice, 1_000 * ONE_USDC);
        vm.expectRevert(Vault.RedeemOnly.selector);
        vault.previewWithdraw(1 * ONE_USDC);
    }

    function test_withdraw_revertsRedeemOnly() public {
        _deposit(alice, 1_000 * ONE_USDC);
        vm.prank(alice);
        vm.expectRevert(Vault.RedeemOnly.selector);
        vault.withdraw(1 * ONE_USDC, alice, alice);
    }

    /// @notice E-4: `withdraw(maxWithdraw(owner)) == withdraw(0)` is a safe no-op
    ///         (never `RedeemOnly`), because `maxWithdraw` is 0 in this mode.
    function test_withdrawZero_isNoOp() public {
        _deposit(alice, 1_000 * ONE_USDC);
        vm.prank(alice);
        uint256 out = vault.withdraw(vault.maxWithdraw(alice), alice, alice);
        assertEq(out, 0, "withdraw(0) is a no-op");
    }

    // ── max* views are 0 ─────────────────────────────────────────────────────

    function test_maxViews_areZero() public {
        _deposit(alice, 1_000 * ONE_USDC);
        assertEq(vault.maxWithdraw(alice), 0, "maxWithdraw == 0 (redeem-only)");
        assertEq(vault.maxRedeem(alice), 0, "maxRedeem == 0 (spec 5.1)");
    }

    // ── redeem stays live; fee base is the REALIZED proceeds ─────────────────

    function test_redeem_isLive_feeOnRealized() public {
        uint256 shares = _deposit(alice, 1_000 * ONE_USDC);
        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        // maxRedeem()==0 but redeem() stays live (caps on the true share balance).
        vm.prank(alice);
        uint256 net = vault.redeem(shares, alice, alice);

        // The adapter realized deposited×(1-haircut); fee is on that REALIZED base.
        uint256 realized = Math.mulDiv(1_000 * ONE_USDC, MAX_BPS - HAIRCUT_BPS, MAX_BPS);
        uint256 expectedFee = Math.mulDiv(realized, EXIT_FEE_BPS, MAX_BPS);
        uint256 expectedNet = realized - expectedFee;

        assertApproxEqAbs(net, expectedNet, 2, "net = realized - fee-on-realized");
        assertEq(usdc.balanceOf(alice), net, "receiver funded with realized net");
        uint256 feePaid = usdc.balanceOf(feeRecipient) - feeBefore;
        assertApproxEqAbs(feePaid, expectedFee, 2, "fee charged on REALIZED, not gross NAV");
        assertLt(net, 1_000 * ONE_USDC, "inexact redeem realizes below par (slippage)");
    }

    // ── preview* semantics (the floored basket branch) ───────────────────────

    /// @notice `previewRedeem` is the ADR-0007 NAV-haircut floor
    ///         `gross × (1 − maxSlippageBps) × (1 − exitFeeBps)`.
    function test_previewRedeem_navHaircutFloor() public {
        uint256 shares = _deposit(alice, 1_000 * ONE_USDC);
        uint256 gross = vault.convertToAssets(shares);
        uint256 afterSlippage = Math.mulDiv(gross, MAX_BPS - MAX_SLIPPAGE_BPS, MAX_BPS);
        uint256 expected = afterSlippage - Math.mulDiv(afterSlippage, EXIT_FEE_BPS, MAX_BPS);
        assertEq(vault.previewRedeem(shares), expected, "previewRedeem == NAV-haircut floor");
    }

    /// @notice `previewDeposit` is the slippage-discounted floor (< OZ par).
    function test_previewDeposit_slippageFloor() public {
        _deposit(alice, 1_000 * ONE_USDC);
        uint256 assets = 100 * ONE_USDC;
        uint256 effective = Math.mulDiv(assets, MAX_BPS - MAX_SLIPPAGE_BPS, MAX_BPS);
        assertEq(
            vault.previewDeposit(assets),
            vault.convertToShares(effective),
            "previewDeposit == convertToShares(assets*(1-slip))"
        );
        assertLt(
            vault.previewDeposit(assets), vault.convertToShares(assets), "below OZ par conversion"
        );
    }

    /// @notice `previewMint` ceil-grosses-up the slippage haircut so `mint`
    ///         cannot undercharge relative to `deposit` (H-1).
    function test_previewMint_ceilGrossUp() public {
        _deposit(alice, 1_000 * ONE_USDC);
        uint256 pd = vault.previewDeposit(100 * ONE_USDC);
        uint256 pm = vault.previewMint(pd);
        assertGe(pm, 100 * ONE_USDC - 1, "previewMint grosses up the slippage haircut");
    }

    // ── Fuzz: redeem always realizes below par and never profits ─────────────

    function testFuzz_redeem_realizesBelowPar_noProfit(uint256 assets) public {
        assets = bound(assets, ONE_USDC, 1_000_000 * ONE_USDC);
        uint256 shares = _deposit(alice, assets);
        vm.prank(alice);
        uint256 net = vault.redeem(shares, alice, alice);
        assertLe(net, assets, "redeem never profits");
        assertLt(net, assets, "inexact redeem always realizes below par");
    }
}
