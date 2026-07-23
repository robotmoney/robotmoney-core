// SPDX-License-Identifier: MIT
// Canonical: docs/technical/unified-vault-spec.md §4.4/§5.5 (emergency),
//            docs/technical/unified-vault-open-questions-resolution.md
//            (Principle 3: failure response is EMERGENCY-gated + atomic
//             arm+execute + the `revokedIdle` role),
//            docs/adr/ADR-0010-unified-vault-architecture.md.
//
// Behaviour tests for the #1121 EMERGENCY-gated emergency model on the unified
// `contracts/Vault.sol`:
//   * EmergencyArmExecuteTest    — an EMERGENCY_ROLE holder ARMS and EXECUTES an
//     adapter drain+exclusion in a SINGLE transaction with no ADMIN timelock; a
//     non-EMERGENCY caller reverts (the fast-EMERGENCY / timelocked-ADMIN
//     asymmetry, M-S5).
//   * EmergencySkipContinueTest  — draining a SET where one adapter reverts still
//     excludes it and processes the rest (skip-and-continue), and KEEPER_ROLE no
//     longer exists.
//   * EmergencyRevokedIdleTest   — draining an ADP-2 (revoked/ineligible) adapter
//     credits `revokedIdle`, and a subsequent deposit mints against the
//     idle-EXCLUSIVE denominator `taBefore - revokedIdle + 1`; `redeployRevokedIdle`
//     decrements it back down.
//
// These run in the default `forge test` CI job (forge-unit-tests), so the diff is
// executed with a non-zero test count — no external resource, no skip.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {Vault} from "../Vault.sol";
import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Exact `IPositionAdapter`: a 1:1 USDC holder. TEST FIXTURE — unique name
///      (`EmergencyExactAdapter`) to avoid forge-doc re-link collisions with the
///      other suites' `ExactHoldAdapter` / `MockPositionAdapter`.
contract EmergencyExactAdapter is IPositionAdapter {
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

/// @dev Exact `IPositionAdapter` whose `withdraw` ALWAYS reverts (a stuck/frozen
///      venue). `deploy`/`totalAssets` behave normally so it registers eligible
///      and receives routing, but any drain attempt reverts — the skip-and-continue
///      fixture. TEST FIXTURE — unique name.
contract EmergencyRevertingAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;

    address public immutable USDC;
    address public immutable VAULT;
    address internal constant SINK = address(0xdEaD);

    error DrainFrozen();

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

    function withdraw(uint256, uint256) external view onlyVault returns (uint256) {
        revert DrainFrozen();
    }

    function totalAssets() external view returns (uint256) {
        return IERC20(USDC).balanceOf(address(this));
    }

    function isExact() external pure returns (bool) {
        return true;
    }

    function harvestRewards() external {}

    function sweepForeignToken(address token) external {
        IERC20(token).safeTransfer(SINK, IERC20(token).balanceOf(address(this)));
    }
}

/// @dev Shared harness: deploys a `Vault`, funds users, and registers adapters
///      through the full eligibility gate (allowlist + codehash + identity).
abstract contract EmergencyModelBase is Test {
    TestERC20 internal usdc;
    Vault internal vault;

    address internal admin = makeAddr("admin");
    address internal emergency = makeAddr("emergency");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal outsider = makeAddr("outsider");

    uint256 internal constant ONE_USDC = 1_000_000; // 6-decimal
    uint256 internal constant MAX_BPS = 10_000;
    uint256 internal constant MAX_SLIPPAGE_BPS = 200; // 2%
    // Generous finite NAV-growth cap so the #1120 limiter is inert here.
    uint256 internal constant MAX_NAV_GROWTH_RATE_BPS = 1e30;

    function _deployVault() internal {
        usdc = new TestERC20();
        vault = new Vault(
            IERC20(address(usdc)),
            "Robot Money USDC",
            "rmUSDC",
            type(uint256).max, // tvlCap
            type(uint256).max, // perDepositCap
            0, // exitFeeBps — zero to isolate the emergency-accounting invariant
            MAX_SLIPPAGE_BPS,
            MAX_NAV_GROWTH_RATE_BPS,
            feeRecipient,
            admin,
            emergency
        );
    }

    function _registerExact(uint16 capBps) internal returns (EmergencyExactAdapter a) {
        a = new EmergencyExactAdapter(address(usdc), address(vault));
        _register(address(a), capBps, true);
    }

    function _registerReverting(uint16 capBps) internal returns (EmergencyRevertingAdapter a) {
        a = new EmergencyRevertingAdapter(address(usdc), address(vault));
        _register(address(a), capBps, true);
    }

    function _register(address adapter, uint16 capBps, bool isExact) internal {
        vm.startPrank(admin);
        vault.setAdapterAllowed(adapter, true);
        vault.setAdapterCodeHashAllowed(adapter.codehash, true);
        vault.addAdapter(adapter, capBps, isExact);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        vm.warp(block.timestamp + 1 hours);
        usdc.mint(who, assets);
        vm.startPrank(who);
        usdc.approve(address(vault), assets);
        shares = vault.deposit(assets, who);
        vm.stopPrank();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EmergencyArmExecuteTest — atomic arm+execute authority + ADMIN-timelock asymmetry
// ─────────────────────────────────────────────────────────────────────────────

contract EmergencyArmExecuteTest is EmergencyModelBase {
    function setUp() public {
        _deployVault();
    }

    /// @notice AC: an EMERGENCY_ROLE holder ARMS and EXECUTES an adapter
    ///         drain+exclusion in a SINGLE transaction — no two-step, no ADMIN
    ///         timelock wait in between. After the one call the adapter is both
    ///         drained (its USDC recovered to the vault) AND excluded (deactivated,
    ///         out of NAV counting).
    function test_emergencyRole_drainsAndExcludesInOneCall() public {
        EmergencyExactAdapter a = _registerExact(uint16(MAX_BPS));
        _deposit(alice, 1_000 * ONE_USDC);
        assertEq(a.totalAssets(), 1_000 * ONE_USDC, "seeded into adapter");
        assertEq(usdc.balanceOf(address(vault)), 0, "no idle before");

        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;

        // Single EMERGENCY action; no warp / no timelock scheduling precedes it.
        vm.prank(emergency);
        vault.emergencyDrainAndExclude(idx);

        // Executed atomically: drained into idle AND excluded from NAV.
        assertEq(a.totalAssets(), 0, "adapter fully drained in the same call");
        assertEq(usdc.balanceOf(address(vault)), 1_000 * ONE_USDC, "recovered to vault idle");
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "NAV preserved (idle counts)");
        (,, bool active,) = vault.adapters(0);
        assertFalse(active, "adapter excluded (deactivated) atomically");
        assertTrue(vault.depositsPaused(), "emergency action pauses deposits (LIFE-3)");
    }

    /// @notice AC: a non-EMERGENCY caller CANNOT arm+execute — it reverts. Even the
    ///         ADMIN (timelock) key, which does NOT hold EMERGENCY_ROLE, is refused:
    ///         the fast path is EMERGENCY-gated, not ADMIN-gated.
    function test_nonEmergencyCaller_reverts() public {
        _registerExact(uint16(MAX_BPS));
        _deposit(alice, 1_000 * ONE_USDC);

        uint256[] memory idx = new uint256[](1);
        idx[0] = 0;

        vm.prank(outsider);
        vm.expectRevert();
        vault.emergencyDrainAndExclude(idx);

        // ADMIN holds ADMIN_ROLE but not EMERGENCY_ROLE — also refused.
        assertFalse(vault.hasRole(vault.EMERGENCY_ROLE(), admin), "admin lacks EMERGENCY_ROLE");
        vm.prank(admin);
        vm.expectRevert();
        vault.emergencyDrainAndExclude(idx);

        // State untouched by the refused calls.
        (,, bool active,) = vault.adapters(0);
        assertTrue(active, "adapter still active after refused calls");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EmergencySkipContinueTest — one reverting adapter never blocks the rest
// ─────────────────────────────────────────────────────────────────────────────

contract EmergencySkipContinueTest is EmergencyModelBase {
    function setUp() public {
        _deployVault();
    }

    /// @notice AC: draining a SET where one adapter's `withdraw` reverts still
    ///         EXCLUDES that adapter and PROCESSES the rest (skip-and-continue).
    function test_drainSet_skipsRevertingAdapter_processesRest() public {
        EmergencyExactAdapter a = _registerExact(uint16(MAX_BPS));
        EmergencyRevertingAdapter b = _registerReverting(uint16(MAX_BPS));
        EmergencyExactAdapter c = _registerExact(uint16(MAX_BPS));

        // Seed all three (3 active adapters => ~1/3 each of a 3_000 deposit).
        _deposit(alice, 3_000 * ONE_USDC);
        assertGt(a.totalAssets(), 0, "a seeded");
        assertGt(b.totalAssets(), 0, "b (frozen) seeded");
        assertGt(c.totalAssets(), 0, "c seeded");

        uint256 aBal = a.totalAssets();
        uint256 bBal = b.totalAssets();
        uint256 cBal = c.totalAssets();

        uint256[] memory idx = new uint256[](3);
        idx[0] = 0; // a — drains
        idx[1] = 1; // b — withdraw reverts
        idx[2] = 2; // c — drains

        vm.prank(emergency);
        vault.emergencyDrainAndExclude(idx); // must NOT revert overall

        // a and c drained to idle; b's drain reverted but it is STILL excluded.
        assertEq(a.totalAssets(), 0, "a drained despite b failing");
        assertEq(c.totalAssets(), 0, "c drained despite b failing");
        assertEq(b.totalAssets(), bBal, "frozen b keeps its (unrecoverable) assets");
        assertEq(usdc.balanceOf(address(vault)), aBal + cBal, "only recoverable idle returned");

        // ALL THREE excluded (deactivated), including the reverting one.
        (,, bool aActive,) = vault.adapters(0);
        (,, bool bActive,) = vault.adapters(1);
        (,, bool cActive,) = vault.adapters(2);
        assertFalse(aActive, "a excluded");
        assertFalse(bActive, "b excluded even though its drain reverted");
        assertFalse(cActive, "c excluded");
    }

    /// @notice AC: KEEPER_ROLE no longer exists — no address holds it and its
    ///         admin role is unconfigured (DEFAULT_ADMIN_ROLE == 0x00), i.e. the
    ///         role was never wired into the vault. Rebalancing is
    ///         `forceRebalance`-only (§5.6) — no keeper, scheduled, or flow-based
    ///         rebalance exists.
    function test_keeperRole_doesNotExist() public view {
        bytes32 keeper = keccak256("KEEPER_ROLE");
        assertFalse(vault.hasRole(keeper, admin), "admin has no KEEPER_ROLE");
        assertFalse(vault.hasRole(keeper, emergency), "emergency has no KEEPER_ROLE");
        assertFalse(vault.hasRole(keeper, outsider), "no one holds KEEPER_ROLE");
        // Unconfigured role admin is the zero DEFAULT_ADMIN_ROLE — never set up.
        assertEq(vault.getRoleAdmin(keeper), bytes32(0), "KEEPER_ROLE admin unconfigured");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EmergencyRevokedIdleTest — revokedIdle credit + reduced mint denominator
// ─────────────────────────────────────────────────────────────────────────────

contract EmergencyRevokedIdleTest is EmergencyModelBase {
    function setUp() public {
        _deployVault();
    }

    /// @notice AC: draining an ADP-2 (allowlist-revoked, ineligible-but-active)
    ///         adapter credits `revokedIdle` with the recovered USDC, and a
    ///         subsequent deposit mints against the idle-EXCLUSIVE denominator
    ///         `taBefore - revokedIdle + 1` — recovered idle is NOT repriced onto
    ///         the new depositor. `redeployRevokedIdle` then decrements it.
    function test_revoke_creditsRevokedIdle_andReducesMintDenominator() public {
        EmergencyExactAdapter healthy = _registerExact(uint16(MAX_BPS)); // stays counted
        EmergencyExactAdapter bad = _registerExact(uint16(MAX_BPS)); // to be revoked

        // Alice seeds; 2 active adapters => ~1_000 each of a 2_000 deposit.
        _deposit(alice, 2_000 * ONE_USDC);
        assertEq(healthy.totalAssets(), 1_000 * ONE_USDC, "healthy seeded");
        assertEq(bad.totalAssets(), 1_000 * ONE_USDC, "bad seeded");
        assertEq(vault.revokedIdle(), 0, "revokedIdle starts zero");

        // ADP-2 exclusion: revoke the bad adapter's allowlist entry. It stays
        // active but becomes ineligible => no longer counted in NAV.
        vm.prank(admin);
        vault.setAdapterAllowed(address(bad), false);
        assertEq(vault.totalAssets(), 1_000 * ONE_USDC, "bad adapter dropped from NAV once revoked");

        // EMERGENCY drains the revoked adapter: recovered USDC lands in idle and is
        // credited to revokedIdle (it was NOT counted at drain time).
        vm.prank(emergency);
        vault.emergencyWithdrawAdapter(1);
        assertEq(vault.revokedIdle(), 1_000 * ONE_USDC, "recovered idle credited to revokedIdle");
        assertEq(vault.totalAssets(), 2_000 * ONE_USDC, "recovered idle re-enters NAV total");

        // The EMERGENCY drain paused deposits (LIFE-3); ADMIN re-opens them (the
        // trust asymmetry) so a new deposit can be priced against revokedIdle.
        vm.prank(admin);
        vault.unpause();

        // A new deposit mints against `taBefore - revokedIdle + 1`.
        uint256 supplyBefore = vault.totalSupply();
        uint256 taBefore = vault.totalAssets(); // 2_000, includes the recovered idle
        uint256 revoked = vault.revokedIdle(); // 1_000

        uint256 bobDeposit = 500 * ONE_USDC;
        uint256 bobShares = _deposit(bob, bobDeposit);

        // Exact set => realizedDelta == bobDeposit; assert the exact reduced-denom mint.
        uint256 expected = Math.mulDiv(
            bobDeposit, supplyBefore + 1e18, taBefore - revoked + 1, Math.Rounding.Floor
        );
        assertEq(bobShares, expected, "mint uses taBefore - revokedIdle + 1");

        // And it is STRICTLY MORE than the idle-INCLUSIVE denominator would give —
        // recovered idle is excluded, not repriced onto the new depositor.
        uint256 ifNotExcluded =
            Math.mulDiv(bobDeposit, supplyBefore + 1e18, taBefore + 1, Math.Rounding.Floor);
        assertGt(bobShares, ifNotExcluded, "revokedIdle exclusion mints strictly more");
    }

    /// @notice `redeployRevokedIdle` routes recovered idle back into the healthy
    ///         active set and decrements `revokedIdle` by the amount routed.
    function test_redeployRevokedIdle_decrements() public {
        EmergencyExactAdapter healthy = _registerExact(uint16(MAX_BPS));
        EmergencyExactAdapter bad = _registerExact(uint16(MAX_BPS));
        _deposit(alice, 2_000 * ONE_USDC);

        vm.prank(admin);
        vault.setAdapterAllowed(address(bad), false);
        vm.prank(emergency);
        vault.emergencyWithdrawAdapter(1);
        assertEq(vault.revokedIdle(), 1_000 * ONE_USDC, "credited");
        uint256 healthyBefore = healthy.totalAssets();

        // Redeploy half of the recovered idle into the healthy adapter.
        uint256 redeploy = 400 * ONE_USDC;
        vm.prank(admin);
        vault.redeployRevokedIdle(redeploy);

        assertEq(
            vault.revokedIdle(), 1_000 * ONE_USDC - redeploy, "revokedIdle decremented by routed"
        );
        assertEq(
            healthy.totalAssets(),
            healthyBefore + redeploy,
            "recovered idle routed into healthy adapter"
        );

        // Cannot redeploy more than what remains.
        vm.prank(admin);
        vm.expectRevert(Vault.InvalidParam.selector);
        vault.redeployRevokedIdle(1_000 * ONE_USDC);

        // Non-admin cannot redeploy.
        vm.prank(emergency);
        vm.expectRevert();
        vault.redeployRevokedIdle(1);
    }
}
