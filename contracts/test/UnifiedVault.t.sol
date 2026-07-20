// SPDX-License-Identifier: MIT
// Canonical: docs/technical/unified-vault-spec.md §5 (Unified `Vault`),
//            docs/adr/ADR-0010-unified-vault-architecture.md.
//
// Behaviour tests for the unified `contracts/Vault.sol` (issue #1119):
//   * UnifiedVaultDepositTest        — realized-delta mint, idle-INCLUSIVE
//     denominator (`taBefore - revokedIdle + 1`), the SUP-3 / C1 no-round-trip-
//     profit invariant, and the first-deposit-into-cap-full underflow guard.
//   * UnifiedVaultRedemptionModeTest — both `allExact()` branches: EXACT-mode
//     `withdraw()` via `_pullProportional` (fee-on-gross) and INEXACT-mode
//     `RedeemOnly` withdraw / `maxWithdraw()==0` / no-revert sell `redeem()`
//     (fee-on-realized), plus all four previews.
//
// These run in the default `forge test` CI job (suite-01-02-forge-tests.yml),
// so the diff is executed with a non-zero test count — no external resource,
// no skip.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Vault} from "../Vault.sol";
import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Exact `IPositionAdapter`: a 1:1 USDC holder. `deploy` marks at par,
///      `withdraw` clamps at balance and delivers 1:1, `totalAssets` is the held
///      USDC. `isExact() == true`. TEST FIXTURE — unique name to avoid forge-doc
///      re-link collisions with `MockPositionAdapter`.
contract ExactHoldAdapter is IPositionAdapter {
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

/// @dev Inexact `IPositionAdapter`: a slippage-priced position. It custodies USDC
///      as its mark (`totalAssets` = held USDC), but a `withdraw` realizes only
///      `wanted x (1 - haircutBps)` — the haircut is burned to a sink so the mark
///      drops by the full consumed amount. `deploy` marks at par. `isExact() ==
///      false`. Never reverts on under-delivery above the floor. TEST FIXTURE.
contract InexactSellAdapter is IPositionAdapter {
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
        // No-revert design: only a floor breach reverts, never a shortfall vs wanted.
        if (usdcOut < minUsdcOut) revert SlippageExceeded();
        IERC20(USDC).safeTransfer(VAULT, usdcOut);
        uint256 lost = consumed - usdcOut;
        if (lost > 0) IERC20(USDC).safeTransfer(SINK, lost); // mark drops by `consumed`
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

/// @dev Shared harness: deploys a `Vault`, funds users, and registers adapters
///      through the full eligibility gate (allowlist + codehash + identity).
abstract contract UnifiedVaultBase is Test {
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
    // Generous finite NAV-growth cap so the #1120 limiter is effectively inert for
    // these accounting-focused tests (the limiter has its own suite,
    // NavGrowthLimiterTest). Finite so `rate * elapsed / period` never overflows.
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
            MAX_NAV_GROWTH_RATE_BPS, // effectively inert for accounting tests
            feeRecipient,
            admin,
            emergency
        );
    }

    function _registerExact(uint16 capBps) internal returns (ExactHoldAdapter a) {
        a = new ExactHoldAdapter(address(usdc), address(vault));
        _register(address(a), capBps, true);
    }

    function _registerInexact(uint16 capBps, uint256 haircutBps)
        internal
        returns (InexactSellAdapter a)
    {
        a = new InexactSellAdapter(address(usdc), address(vault), haircutBps);
        _register(address(a), capBps, false);
    }

    function _register(address adapter, uint16 capBps, bool isExact) internal {
        vm.startPrank(admin);
        vault.setAdapterAllowed(adapter, true);
        vault.setAdapterCodeHashAllowed(adapter.codehash, true);
        vault.addAdapter(adapter, capBps, isExact);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        // Advance time so the #1120 NAV-growth budget (which scales with elapsed
        // time and is zero over zero elapsed) is non-zero across back-to-back
        // deposits; combined with the huge `MAX_NAV_GROWTH_RATE_BPS` this keeps the
        // limiter inert for these accounting tests without special-casing it.
        vm.warp(block.timestamp + 1 hours);
        usdc.mint(who, assets);
        vm.startPrank(who);
        usdc.approve(address(vault), assets);
        shares = vault.deposit(assets, who);
        vm.stopPrank();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// UnifiedVaultDepositTest — realized-delta mint + idle-inclusive denominator
// ─────────────────────────────────────────────────────────────────────────────

contract UnifiedVaultDepositTest is UnifiedVaultBase {
    function setUp() public {
        _deployVault(0); // zero exit fee to isolate the accounting invariant
    }

    /// @notice AC: first deposit into a (nearly) cap-full adapter set with
    ///         `taBefore == 0` and `revokedIdle == 0` does NOT underflow the
    ///         `taBefore - revokedIdle + 1` denominator — it mints against the
    ///         realized delta (idle-and-continue), never reverts (A-H2).
    function test_firstDepositIntoCapFull_noUnderflow() public {
        // A tiny-cap adapter: most of a first deposit stays idle in the vault.
        _registerExact(1); // capBps = 1 (0.01%)

        uint256 deposit = 1_000 * ONE_USDC;
        uint256 shares = _deposit(alice, deposit);

        // No revert; the idle-and-continue path preserves realized delta == deposit.
        assertGt(shares, 0, "first deposit must mint");
        assertEq(vault.totalAssets(), deposit, "NAV counts routed + idle USDC");
        // Almost everything stayed idle (cap 0.01% of NAV).
        assertGe(usdc.balanceOf(address(vault)), deposit - deposit / 10_000 - 1, "idle held");
    }

    /// @notice AC (SUP-3 / C1): with pre-existing idle USDC backing existing
    ///         shares, the mint uses the idle-INCLUSIVE denominator `taBefore + 1`
    ///         (NOT the buggy `taBefore - idle + 1`), so a deposit+redeem round
    ///         trip cannot profit and existing holders are not diluted.
    function test_idleInclusiveDenominator_noRoundTripProfit() public {
        ExactHoldAdapter a = _registerExact(uint16(MAX_BPS)); // full cap

        // Alice seeds the vault; her deposit routes fully into the adapter.
        uint256 aliceDeposit = 1_000 * ONE_USDC;
        _deposit(alice, aliceDeposit);
        assertEq(a.totalAssets(), aliceDeposit, "alice routed to adapter");
        assertEq(usdc.balanceOf(address(vault)), 0, "no idle from alice");

        // A third party donates idle USDC directly to the vault — this idle now
        // backs the EXISTING shares (the exact C1 precondition: I0 > 0).
        uint256 idle0 = 1_000 * ONE_USDC;
        usdc.mint(address(vault), idle0);
        assertEq(vault.totalAssets(), aliceDeposit + idle0, "NAV includes donated idle");

        // Snapshot the denominator inputs BEFORE Bob deposits.
        uint256 supplyBefore = vault.totalSupply();
        uint256 taBefore = vault.totalAssets(); // includes idle0
        uint256 idleBefore = usdc.balanceOf(address(vault));
        assertEq(idleBefore, idle0, "idle snapshot");

        // Bob deposits and we capture the ACTUAL minted shares (AZ-BSK-2 return).
        uint256 bobDeposit = 1_000 * ONE_USDC;
        uint256 bobShares = _deposit(bob, bobDeposit);

        // The idle-INCLUSIVE (correct) mint and the idle-EXCLUSIVE (buggy) mint.
        uint256 inclusive =
            Math.mulDiv(bobDeposit, supplyBefore + 1e18, taBefore + 1, Math.Rounding.Floor);
        uint256 buggy = Math.mulDiv(
            bobDeposit, supplyBefore + 1e18, taBefore - idleBefore + 1, Math.Rounding.Floor
        );

        assertEq(bobShares, inclusive, "mint must use idle-inclusive denominator");
        assertLt(bobShares, buggy, "idle must NOT be subtracted (C1 over-mint closed)");

        // Round-trip: Bob redeems everything immediately. With zero fee and an
        // exact set, he must not walk away with more than he deposited.
        vm.prank(bob);
        uint256 got = vault.redeem(bobShares, bob, bob);
        assertLe(got, bobDeposit, "no round-trip profit (SUP-3)");

        // Existing holder Alice is not diluted: her redeemable value is still
        // >= her original principal (she also earns a pro-rata slice of idle0).
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 aliceValue = vault.previewRedeem(aliceShares);
        assertGe(aliceValue, aliceDeposit, "existing holder not diluted");
    }

    /// @notice The deposit() override returns the ACTUAL minted shares (AZ-BSK-2),
    ///         which for an exact set equals OZ's `convertToShares` of the deposit.
    function test_depositReturnsActualMintedShares() public {
        _registerExact(uint16(MAX_BPS));
        uint256 deposit = 500 * ONE_USDC;
        uint256 predicted = vault.previewDeposit(deposit);
        uint256 shares = _deposit(alice, deposit);
        assertEq(shares, predicted, "exact-set deposit == previewDeposit");
        assertEq(vault.balanceOf(alice), shares, "shares credited");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// UnifiedVaultRedemptionModeTest — allExact()-gated dual redemption modes
// ─────────────────────────────────────────────────────────────────────────────

contract UnifiedVaultRedemptionModeTest is UnifiedVaultBase {
    uint256 internal constant EXIT_FEE_BPS = 50; // 0.5%
    uint256 internal constant HAIRCUT_BPS = 100; // 1% realized slippage (< maxSlippage)

    function setUp() public {
        _deployVault(EXIT_FEE_BPS);
    }

    // ── EXACT mode (allExact() == true) ──────────────────────────────────────

    function test_exactMode_allExactTrue() public {
        _registerExact(uint16(MAX_BPS));
        assertTrue(vault.allExact(), "single exact adapter => allExact");
    }

    function test_exactMode_withdrawViaPullProportional_feeOnGross() public {
        _registerExact(uint16(MAX_BPS));
        _deposit(alice, 1_000 * ONE_USDC);

        // previewWithdraw is live in exact mode.
        uint256 netWanted = 100 * ONE_USDC;
        uint256 shares = vault.previewWithdraw(netWanted);
        assertGt(shares, 0, "previewWithdraw live in exact mode");
        assertGt(vault.maxWithdraw(alice), 0, "maxWithdraw > 0 in exact mode");

        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        vm.prank(alice);
        vault.withdraw(netWanted, alice, alice);

        // Fee-on-GROSS: fee = grossAssets x exitFeeBps / MAX_BPS, receiver gets net.
        uint256 grossAssets = vault.previewMint(shares); // gross implied by burned shares (ceil)
        // The receiver got exactly the requested net.
        assertEq(usdc.balanceOf(alice), netWanted, "receiver gets exact net");
        uint256 feePaid = usdc.balanceOf(feeRecipient) - feeBefore;
        // fee ≈ net x fee/(MAX-fee); assert it equals grossAssets*fee/MAX within rounding.
        assertApproxEqAbs(
            feePaid, Math.mulDiv(grossAssets, EXIT_FEE_BPS, MAX_BPS), 2, "fee-on-gross base"
        );
        assertGt(feePaid, 0, "exit fee charged");
    }

    function test_exactMode_redeemReturnsRealizedNet() public {
        _registerExact(uint16(MAX_BPS));
        uint256 shares = _deposit(alice, 1_000 * ONE_USDC);

        uint256 expectedNet = vault.previewRedeem(shares);
        vm.prank(alice);
        uint256 got = vault.redeem(shares, alice, alice);
        assertEq(got, expectedNet, "redeem returns realized net (exact)");
        assertEq(usdc.balanceOf(alice), expectedNet, "receiver funded");
    }

    // ── INEXACT mode (allExact() == false) ───────────────────────────────────

    function test_inexactMode_allExactFalse() public {
        _registerExact(uint16(MAX_BPS / 2));
        _registerInexact(uint16(MAX_BPS / 2), HAIRCUT_BPS);
        assertFalse(vault.allExact(), "one inexact adapter => !allExact");
    }

    function test_inexactMode_withdrawAndPreviewWithdrawRevertRedeemOnly() public {
        _registerInexact(uint16(MAX_BPS), HAIRCUT_BPS);
        _deposit(alice, 1_000 * ONE_USDC);

        vm.expectRevert(Vault.RedeemOnly.selector);
        vault.previewWithdraw(1 * ONE_USDC);

        vm.prank(alice);
        vm.expectRevert(Vault.RedeemOnly.selector);
        vault.withdraw(1 * ONE_USDC, alice, alice);
    }

    function test_inexactMode_maxWithdrawIsZero_andMaxRedeemIsZero() public {
        _registerInexact(uint16(MAX_BPS), HAIRCUT_BPS);
        _deposit(alice, 1_000 * ONE_USDC);

        assertEq(vault.maxWithdraw(alice), 0, "maxWithdraw == 0 when inexact");
        assertEq(vault.maxRedeem(alice), 0, "maxRedeem == 0 when inexact (spec 5.1)");

        // E-4: withdraw(maxWithdraw(owner)) == withdraw(0) is a safe no-op.
        vm.prank(alice);
        uint256 out = vault.withdraw(vault.maxWithdraw(alice), alice, alice);
        assertEq(out, 0, "withdraw(0) is a no-op, never reverts");
    }

    function test_inexactMode_redeemReturnsRealizedProceeds_feeOnRealized() public {
        _registerInexact(uint16(MAX_BPS), HAIRCUT_BPS);
        uint256 shares = _deposit(alice, 1_000 * ONE_USDC);
        assertFalse(vault.allExact(), "inexact set");

        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        // Redeem stays LIVE in inexact mode despite maxRedeem()==0.
        vm.prank(alice);
        uint256 net = vault.redeem(shares, alice, alice);

        // The adapter realized `deposited x (1 - haircut)`; fee is charged on that
        // REALIZED base, not on the gross NAV.
        uint256 realized = Math.mulDiv(1_000 * ONE_USDC, MAX_BPS - HAIRCUT_BPS, MAX_BPS);
        uint256 expectedFee = Math.mulDiv(realized, EXIT_FEE_BPS, MAX_BPS);
        uint256 expectedNet = realized - expectedFee;

        assertApproxEqAbs(net, expectedNet, 2, "net = realized - fee-on-realized");
        assertEq(usdc.balanceOf(alice), net, "receiver funded with realized net");
        uint256 feePaid = usdc.balanceOf(feeRecipient) - feeBefore;
        assertApproxEqAbs(feePaid, expectedFee, 2, "fee-on-realized base");
        // The realized proceeds are strictly below the gross NAV (slippage bit).
        assertLt(net, 1_000 * ONE_USDC, "inexact redeem realizes below par");
    }

    /// @notice All four previews behave per composition in INEXACT mode.
    function test_inexactMode_allFourPreviews() public {
        _registerInexact(uint16(MAX_BPS), HAIRCUT_BPS);
        uint256 shares = _deposit(alice, 1_000 * ONE_USDC);

        // previewDeposit — slippage-discounted floor (< OZ par conversion).
        uint256 pd = vault.previewDeposit(100 * ONE_USDC);
        assertGt(pd, 0, "previewDeposit floor > 0");

        // previewMint — ceil gross-up so mint cannot undercharge vs deposit (H-1).
        uint256 pm = vault.previewMint(pd);
        assertGe(pm, 100 * ONE_USDC - 1, "previewMint grosses up the slippage haircut");

        // previewRedeem — NAV-haircut floor grossx(1-slip)x(1-fee).
        uint256 pr = vault.previewRedeem(shares);
        uint256 gross = vault.convertToAssets(shares);
        uint256 floorExpected = Math.mulDiv(gross, MAX_BPS - MAX_SLIPPAGE_BPS, MAX_BPS);
        floorExpected -= Math.mulDiv(floorExpected, EXIT_FEE_BPS, MAX_BPS);
        assertEq(pr, floorExpected, "previewRedeem = NAV-haircut floor");

        // previewWithdraw — reverts RedeemOnly.
        vm.expectRevert(Vault.RedeemOnly.selector);
        vault.previewWithdraw(1 * ONE_USDC);
    }
}
