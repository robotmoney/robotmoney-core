// SPDX-License-Identifier: MIT
// Canonical: docs/technical/unified-vault-spec.md §5.1 (vault-attested `isExact`,
//            `allExact()`, exact→inexact composition-transition timelock + event),
//            docs/technical/unified-vault-open-questions-resolution.md (C2, D2),
//            docs/adr/ADR-0010-unified-vault-architecture.md.
//
// Behaviour tests for the unified `contracts/Vault.sol` exactness surface (#1123):
//   * IsExactAttestationTest             — `isExact` is vault-attested at
//     `addAdapter` alongside the codehash pinning, and the vault NEVER reads the
//     adapter's self-reported `isExact()` for share-value-critical branch
//     selection (a self-reporting adapter cannot move the vault's mode, C2).
//   * ExactnessTransitionTimelockTest    — the true→false composition-class flip
//     (first inexact adapter on an operating all-exact vault) is armed + delayed,
//     reverts before the delay, emits `ExactnessTransition` once it elapses,
//     flips `allExact()`, leaves a same-class add unaffected, and is surfaced
//     through the registry-visible `VaultRegistry.isVaultAllExact` flag.
//
// These run in the default `forge test` CI job (suite-01-02-forge-tests.yml), so
// the diff is executed with a non-zero test count — no external resource, no skip.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Vault} from "../Vault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev A 1:1 USDC holder whose SELF-REPORTED `isExact()` is set at construction
///      and can DISAGREE with the vault's attestation. Behaves like a par-value
///      exact adapter (deploy marks at par, withdraw delivers 1:1) regardless of
///      what its `isExact()` view claims — so a test can prove the vault selects
///      its mode from the vault-attested `AdapterInfo.isExact`, never from this
///      self-report (C2). TEST FIXTURE — unique name to avoid forge-doc collisions.
contract SelfReportLiarAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;

    address public immutable USDC;
    address public immutable VAULT;
    bool internal immutable _selfReport;
    address internal constant SINK = address(0xdEaD);

    error TokenProtected();

    constructor(address usdc_, address vault_, bool selfReport_) {
        USDC = usdc_;
        VAULT = vault_;
        _selfReport = selfReport_;
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

    /// @dev The DELIBERATELY-DISAGREEING self-report the vault must ignore (C2).
    function isExact() external view returns (bool) {
        return _selfReport;
    }

    function harvestRewards() external {}

    function sweepForeignToken(address token) external {
        if (token == USDC) revert TokenProtected();
        IERC20(token).safeTransfer(SINK, IERC20(token).balanceOf(address(this)));
    }
}

/// @dev Shared harness: deploys a `Vault`, funds users, registers adapters
///      through the full eligibility gate (allowlist + codehash + identity).
abstract contract ExactnessBase is Test {
    TestERC20 internal usdc;
    Vault internal vault;

    address internal admin = makeAddr("admin");
    address internal emergency = makeAddr("emergency");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");

    uint256 internal constant ONE_USDC = 1_000_000; // 6-decimal
    uint256 internal constant MAX_BPS = 10_000;
    uint256 internal constant MAX_SLIPPAGE_BPS = 200; // 2%
    // Generous finite NAV-growth cap so the #1120 limiter is inert here.
    uint256 internal constant MAX_NAV_GROWTH_RATE_BPS = 1e30;

    function setUp() public virtual {
        usdc = new TestERC20();
        vault = new Vault(
            usdc,
            "Robot Money USDC",
            "rmUSDC",
            type(uint256).max, // tvlCap
            type(uint256).max, // perDepositCap
            0, // exitFeeBps — isolate exactness behaviour
            MAX_SLIPPAGE_BPS,
            MAX_NAV_GROWTH_RATE_BPS,
            feeRecipient,
            admin,
            emergency
        );
    }

    /// @dev Register `adapter` through the full eligibility gate at `capBps` with
    ///      the vault-attested `attestedExact`. Does NOT auto-arm — callers that
    ///      need the exactness-transition guard drive it explicitly.
    function _register(address adapter, uint16 capBps, bool attestedExact) internal {
        vm.startPrank(admin);
        vault.setAdapterAllowed(adapter, true);
        vault.setAdapterCodeHashAllowed(adapter.codehash, true);
        vault.addAdapter(adapter, capBps, attestedExact);
        vm.stopPrank();
    }

    /// @dev Allowlist + codehash-pin `adapter` without adding it, so a subsequent
    ///      `addAdapter` reaches the exactness-transition guard (not the
    ///      eligibility gate).
    function _allow(address adapter) internal {
        vm.startPrank(admin);
        vault.setAdapterAllowed(adapter, true);
        vault.setAdapterCodeHashAllowed(adapter.codehash, true);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        vm.warp(block.timestamp + 1 hours); // keep the #1120 budget non-zero
        usdc.mint(who, assets);
        vm.startPrank(who);
        usdc.approve(address(vault), assets);
        shares = vault.deposit(assets, who);
        vm.stopPrank();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// IsExactAttestationTest — vault-attested classification (C2)
// ─────────────────────────────────────────────────────────────────────────────
contract IsExactAttestationTest is ExactnessBase {
    /// @notice `isExact` is written at `addAdapter` in the same act that pins the
    ///         codehash + allowlist entry, and is what `getAdapterInfo` returns.
    function test_isExactAttestedAtAddAdapter_alongsideCodehashPinning() public {
        SelfReportLiarAdapter a = new SelfReportLiarAdapter(address(usdc), address(vault), true);
        _register(address(a), uint16(MAX_BPS), true);

        // The codehash was pinned by the SAME governance act (allowlist entry).
        assertTrue(vault.adapterCodeHashAllowed(address(a).codehash), "codehash pinned");
        assertTrue(vault.adapterAllowed(address(a)), "instance allowlisted");

        (,,, bool storedIsExact,,) = vault.getAdapterInfo(0);
        assertTrue(storedIsExact, "isExact stored on AdapterInfo at addAdapter");
    }

    /// @notice A liar adapter whose self-report is FALSE but attested TRUE keeps
    ///         the vault in EXACT mode: `allExact()` stays true and `withdraw()`
    ///         works at deposit/withdraw time — proving the vault never reads
    ///         `adapter.isExact()` (which is false) for the mode branch (C2).
    function test_attestedExact_overridesAdapterSelfReportFalse() public {
        SelfReportLiarAdapter a = new SelfReportLiarAdapter(address(usdc), address(vault), false);
        assertFalse(a.isExact(), "adapter self-reports INEXACT");

        _register(address(a), uint16(MAX_BPS), true); // vault attests EXACT

        assertTrue(vault.allExact(), "allExact follows attestation (true), not self-report");

        // Deposit then exact withdraw() must succeed — the branch is chosen from
        // the attested value, never re-read from the adapter's false self-report.
        _deposit(alice, 1_000 * ONE_USDC);
        uint256 want = 100 * ONE_USDC;
        assertGt(vault.maxWithdraw(alice), 0, "maxWithdraw positive in attested-exact mode");
        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(want, alice, alice); // no RedeemOnly revert => exact branch taken
        assertEq(
            usdc.balanceOf(alice) - balBefore,
            want,
            "exact withdraw delivered 1:1 despite adapter self-reporting inexact"
        );
    }

    /// @notice A liar adapter whose self-report is TRUE but attested FALSE puts
    ///         the vault in INEXACT mode: `allExact()` is false, `previewWithdraw`
    ///         reverts `RedeemOnly` and `maxWithdraw` is 0 — proving the vault
    ///         never reads `adapter.isExact()` (which is true) for the branch.
    function test_attestedInexact_overridesAdapterSelfReportTrue() public {
        SelfReportLiarAdapter a = new SelfReportLiarAdapter(address(usdc), address(vault), true);
        assertTrue(a.isExact(), "adapter self-reports EXACT");

        _register(address(a), uint16(MAX_BPS), false); // vault attests INEXACT

        assertFalse(vault.allExact(), "allExact follows attestation (false), not self-report");

        _deposit(alice, 1_000 * ONE_USDC);
        assertEq(vault.maxWithdraw(alice), 0, "maxWithdraw == 0 in attested-inexact mode");

        vm.expectRevert(Vault.RedeemOnly.selector);
        vault.previewWithdraw(1 * ONE_USDC);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ExactnessTransitionTimelockTest — armed + delayed true→false flip (C2)
// ─────────────────────────────────────────────────────────────────────────────
contract ExactnessTransitionTimelockTest is ExactnessBase {
    VaultRegistry internal registry;

    event ExactnessTransition(bool wasAllExact, bool nowAllExact, address indexed adapter);

    function setUp() public override {
        super.setUp();
        registry = new VaultRegistry(admin);
        vm.prank(admin);
        registry.registerVault(
            address(vault),
            VaultRegistry.VaultMetadata({name: "rmUSDC", asset: address(usdc), registeredAt: 0})
        );
    }

    function _newInexact() internal returns (SelfReportLiarAdapter a) {
        // attested inexact; self-report value is irrelevant to the guard.
        a = new SelfReportLiarAdapter(address(usdc), address(vault), false);
    }

    /// @notice A same-class add (a second EXACT adapter to an all-exact vault)
    ///         needs no arm, keeps `allExact()` true, and fires no transition.
    function test_sameClassExactAdd_needsNoArm_staysAllExact() public {
        SelfReportLiarAdapter a = new SelfReportLiarAdapter(address(usdc), address(vault), true);
        _register(address(a), uint16(MAX_BPS / 2), true);
        assertTrue(vault.allExact(), "one exact adapter => allExact");

        SelfReportLiarAdapter b = new SelfReportLiarAdapter(address(usdc), address(vault), true);
        _register(address(b), uint16(MAX_BPS / 2), true); // no arm, no revert
        assertTrue(vault.allExact(), "still all-exact after same-class add");
    }

    /// @notice Adding the first inexact adapter to an operating all-exact vault
    ///         reverts when the transition was never armed.
    function test_firstInexactAdd_revertsWithoutArm() public {
        SelfReportLiarAdapter e = new SelfReportLiarAdapter(address(usdc), address(vault), true);
        _register(address(e), uint16(MAX_BPS / 2), true);

        SelfReportLiarAdapter x = _newInexact();
        _allow(address(x));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                Vault.ExactnessTransitionNotReady.selector, address(x), uint64(0)
            )
        );
        vault.addAdapter(address(x), uint16(MAX_BPS / 2), false);
    }

    /// @notice Even once armed, the flip reverts until `EXACTNESS_TRANSITION_DELAY`
    ///         has elapsed.
    function test_firstInexactAdd_revertsBeforeDelayElapses() public {
        SelfReportLiarAdapter e = new SelfReportLiarAdapter(address(usdc), address(vault), true);
        _register(address(e), uint16(MAX_BPS / 2), true);

        SelfReportLiarAdapter x = _newInexact();
        _allow(address(x));

        vm.prank(admin);
        vault.armExactnessTransition(address(x));
        uint64 readyAt = uint64(block.timestamp + vault.EXACTNESS_TRANSITION_DELAY());

        // One second short of the delay: still blocked.
        vm.warp(readyAt - 1);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(Vault.ExactnessTransitionNotReady.selector, address(x), readyAt)
        );
        vault.addAdapter(address(x), uint16(MAX_BPS / 2), false);

        assertTrue(vault.allExact(), "class unchanged while flip is still blocked");
    }

    /// @notice After the delay elapses the flip lands: it emits
    ///         `ExactnessTransition(true, false, adapter)`, flips `allExact()`
    ///         to false, and the registry-visible flag mirrors the new class.
    function test_firstInexactAdd_succeedsAfterDelay_emitsEvent_flipsAllExact() public {
        SelfReportLiarAdapter e = new SelfReportLiarAdapter(address(usdc), address(vault), true);
        _register(address(e), uint16(MAX_BPS / 2), true);
        assertTrue(vault.allExact(), "starts all-exact");
        assertTrue(registry.isVaultAllExact(address(vault)), "registry flag matches (true)");

        SelfReportLiarAdapter x = _newInexact();
        _allow(address(x));

        vm.prank(admin);
        vault.armExactnessTransition(address(x));
        vm.warp(block.timestamp + vault.EXACTNESS_TRANSITION_DELAY());

        vm.expectEmit(true, false, false, true, address(vault));
        emit ExactnessTransition(true, false, address(x));
        vm.prank(admin);
        vault.addAdapter(address(x), uint16(MAX_BPS / 2), false);

        assertFalse(vault.allExact(), "allExact flipped to false");
        assertFalse(
            registry.isVaultAllExact(address(vault)), "registry flag mirrors the flip (false)"
        );
        assertEq(
            registry.isVaultAllExact(address(vault)),
            vault.allExact(),
            "registry-visible flag matches vault.allExact()"
        );

        // Arm is single-use: it was consumed by the successful add.
        assertEq(vault.exactnessTransitionReadyAt(address(x)), 0, "arm consumed on execution");
    }

    /// @notice The registry-visible flag tracks the vault's live class before and
    ///         after the flip (read-through, so it can never drift).
    function test_registryVisibleFlag_matchesVaultAllExact() public {
        assertEq(
            registry.isVaultAllExact(address(vault)),
            vault.allExact(),
            "empty vault: registry flag == vault.allExact() (vacuously true)"
        );

        SelfReportLiarAdapter e = new SelfReportLiarAdapter(address(usdc), address(vault), true);
        _register(address(e), uint16(MAX_BPS), true);
        assertTrue(registry.isVaultAllExact(address(vault)), "exact set: flag true");
        assertEq(registry.isVaultAllExact(address(vault)), vault.allExact(), "flag tracks vault");
    }
}
