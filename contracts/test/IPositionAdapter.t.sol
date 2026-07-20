// SPDX-License-Identifier: MIT
// Canonical: docs/technical/unified-vault-spec.md §2 (`IPositionAdapter`),
//            docs/adr/ADR-0010-unified-vault-architecture.md §2.
//
// Compile/conformance test for the FROZEN IPositionAdapter surface (#1116).
// It proves (a) a concrete adapter can implement every member and the frozen
// error set, (b) the constructor-bound `VAULT()`/`USDC()` identity views, and
// (c) that `IStrategyAdapter` is a strict subset of `IPositionAdapter`
// (unchanged members share selectors; `deploy`/`withdraw` are extended; three
// identity/exactness members are added). No runtime behavior beyond the
// interface + this test is introduced.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Minimal exact-style `IPositionAdapter` implementation used only to prove
///      the frozen surface is implementable end-to-end. It is a 1:1 USDC holder
///      (`isExact() == true`): `deploy` adds exactly `usdcIn`, `withdraw`
///      clamps at balance, `totalAssets()` is the held USDC balance. It is a
///      TEST FIXTURE — never a production adapter.
contract MockPositionAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;

    address public immutable USDC;
    address public immutable VAULT;

    /// @dev Fixed quarantine sink for swept foreign tokens (INV-1: never
    ///      caller-supplied). A test-local constant mirrors the production
    ///      `ForeignTokenQuarantine.QUARANTINE` pattern without the dependency.
    address public constant QUARANTINE = address(0xdead);

    error ZeroAddress();
    error TokenIsProtected(address token);

    constructor(address usdc_, address vault_) {
        if (usdc_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        USDC = usdc_;
        VAULT = vault_;
    }

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    /// @inheritdoc IPositionAdapter
    function deploy(uint256 usdcIn, uint256 minValueOut)
        external
        onlyVault
        returns (uint256 valueAdded)
    {
        // Exact adapter: the vault has already `safeTransfer`ed `usdcIn`; the
        // value added is exactly `usdcIn`. Belt-and-suspenders min-out check.
        valueAdded = usdcIn;
        if (valueAdded < minValueOut) revert SlippageExceeded();
    }

    /// @inheritdoc IPositionAdapter
    function withdraw(uint256 usdcWanted, uint256 minUsdcOut)
        external
        onlyVault
        returns (uint256 usdcOut)
    {
        uint256 bal = IERC20(USDC).balanceOf(address(this));
        // Clamp at liquidatable balance; `type(uint256).max` ⇒ withdraw all.
        usdcOut = usdcWanted > bal ? bal : usdcWanted;
        // Shortfall against the floor reverts; shortfall against `usdcWanted`
        // above the floor clamps (spec §2.2).
        if (usdcOut < minUsdcOut) revert SlippageExceeded();
        IERC20(USDC).safeTransfer(VAULT, usdcOut);
    }

    /// @inheritdoc IPositionAdapter
    function totalAssets() external view returns (uint256) {
        return IERC20(USDC).balanceOf(address(this));
    }

    /// @inheritdoc IPositionAdapter
    function isExact() external pure returns (bool) {
        return true;
    }

    /// @inheritdoc IPositionAdapter
    function harvestRewards() external {
        // Exact USDC holder has no discrete rewards — MUST NOT revert (INV-2).
    }

    /// @inheritdoc IPositionAdapter
    function sweepForeignToken(address token) external {
        // Permissionless; USDC is protected and may never be swept (INV-1/INV-2).
        if (token == USDC) revert TokenIsProtected(token);
        IERC20(token).safeTransfer(QUARANTINE, IERC20(token).balanceOf(address(this)));
    }
}

contract IPositionAdapterInterfaceTest is Test {
    TestERC20 internal usdc;
    MockPositionAdapter internal adapter;

    address internal vault = makeAddr("vault");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant ONE_USDC = 1_000_000; // 6-decimal

    function setUp() public {
        usdc = new TestERC20();
        adapter = new MockPositionAdapter(address(usdc), vault);
    }

    // ── Identity views (constructor-bound) ──────────────────────────────────

    function test_identityViews_returnConstructorBound() public view {
        assertEq(adapter.USDC(), address(usdc), "USDC() not constructor-bound");
        assertEq(adapter.VAULT(), vault, "VAULT() not constructor-bound");
    }

    function test_constructor_revertsOnZeroIdentity() public {
        vm.expectRevert(MockPositionAdapter.ZeroAddress.selector);
        new MockPositionAdapter(address(0), vault);
        vm.expectRevert(MockPositionAdapter.ZeroAddress.selector);
        new MockPositionAdapter(address(usdc), address(0));
    }

    // ── deploy: exactness, min-out floor, authority ─────────────────────────

    function test_deploy_exactReturnsUsdcIn() public {
        usdc.mint(address(adapter), ONE_USDC); // vault-choreographed transfer
        vm.prank(vault);
        uint256 valueAdded = adapter.deploy(ONE_USDC, ONE_USDC);
        assertEq(valueAdded, ONE_USDC, "exact adapter must return usdcIn");
        assertEq(adapter.totalAssets(), ONE_USDC, "totalAssets after deploy");
    }

    function test_deploy_revertsBelowFloor() public {
        vm.prank(vault);
        vm.expectRevert(IPositionAdapter.SlippageExceeded.selector);
        adapter.deploy(ONE_USDC, ONE_USDC + 1); // valueAdded < minValueOut
    }

    function test_deploy_revertsForNonVault() public {
        vm.prank(attacker);
        vm.expectRevert(IPositionAdapter.OnlyVault.selector);
        adapter.deploy(ONE_USDC, 0);
    }

    // ── withdraw: clamp, floor revert, authority ────────────────────────────

    function test_withdraw_clampsAtBalanceAndDelivers() public {
        usdc.mint(address(adapter), 3 * ONE_USDC);
        vm.prank(vault);
        uint256 usdcOut = adapter.withdraw(type(uint256).max, 0); // sentinel: all
        assertEq(usdcOut, 3 * ONE_USDC, "withdraw-all must clamp at balance");
        assertEq(usdc.balanceOf(vault), 3 * ONE_USDC, "proceeds delivered to vault");
        assertEq(adapter.totalAssets(), 0, "adapter drained");
    }

    function test_withdraw_revertsBelowFloor() public {
        usdc.mint(address(adapter), ONE_USDC);
        vm.prank(vault);
        vm.expectRevert(IPositionAdapter.SlippageExceeded.selector);
        adapter.withdraw(ONE_USDC, ONE_USDC + 1); // realized < minUsdcOut
    }

    function test_withdraw_revertsForNonVault() public {
        vm.prank(attacker);
        vm.expectRevert(IPositionAdapter.OnlyVault.selector);
        adapter.withdraw(ONE_USDC, 0);
    }

    // ── remaining members exercised ─────────────────────────────────────────

    function test_isExact_true() public view {
        assertTrue(adapter.isExact(), "mock is an exact adapter");
    }

    function test_harvestRewards_neverReverts() public {
        adapter.harvestRewards(); // permissionless no-op, MUST NOT revert
    }

    function test_sweepForeignToken_quarantinesForeignRevertsOnUsdc() public {
        TestERC20 foreign = new TestERC20();
        foreign.mint(address(adapter), 7e18);
        vm.prank(attacker); // permissionless
        adapter.sweepForeignToken(address(foreign));
        assertEq(foreign.balanceOf(adapter.QUARANTINE()), 7e18, "not quarantined");

        vm.expectRevert(
            abi.encodeWithSelector(MockPositionAdapter.TokenIsProtected.selector, address(usdc))
        );
        adapter.sweepForeignToken(address(usdc));
    }

    // ── IStrategyAdapter ⊂ IPositionAdapter (strict subset) ─────────────────

    /// @dev Members carried verbatim from v1 keep identical selectors.
    function test_subset_unchangedMembersShareSelectors() public pure {
        assertEq(
            IPositionAdapter.totalAssets.selector,
            IStrategyAdapter.totalAssets.selector,
            "totalAssets selector drifted"
        );
        assertEq(
            IPositionAdapter.harvestRewards.selector,
            IStrategyAdapter.harvestRewards.selector,
            "harvestRewards selector drifted"
        );
        assertEq(
            IPositionAdapter.sweepForeignToken.selector,
            IStrategyAdapter.sweepForeignToken.selector,
            "sweepForeignToken selector drifted"
        );
    }

    /// @dev `deploy`/`withdraw` are strictly extended (min-out params + a
    ///      realized-value return), so their selectors MUST differ from v1.
    function test_subset_extendedMembersHaveNewSelectors() public pure {
        assertTrue(
            IPositionAdapter.deploy.selector != IStrategyAdapter.deploy.selector,
            "deploy must be extended (new selector)"
        );
        assertTrue(
            IPositionAdapter.withdraw.selector != IStrategyAdapter.withdraw.selector,
            "withdraw must be extended (new selector)"
        );
    }

    /// @dev The three members IPositionAdapter adds on top of v1. Referencing
    ///      their selectors is a compile-time proof they exist on the surface;
    ///      the runtime asserts they are non-empty and mutually distinct.
    function test_superset_addsIsExactUsdcVault() public pure {
        bytes4 isExactSel = IPositionAdapter.isExact.selector;
        bytes4 usdcSel = IPositionAdapter.USDC.selector;
        bytes4 vaultSel = IPositionAdapter.VAULT.selector;
        assertTrue(
            isExactSel != bytes4(0) && usdcSel != bytes4(0) && vaultSel != bytes4(0), "empty"
        );
        assertTrue(
            isExactSel != usdcSel && usdcSel != vaultSel && isExactSel != vaultSel, "collide"
        );
    }

    /// @dev interfaceId is the XOR of all eight member selectors and MUST be
    ///      stable. The hardcoded literal freezes the surface: any signature
    ///      add/remove/rename changes the XOR and fails this loudly. It also
    ///      MUST differ from the v1 interfaceId (the two are distinct types).
    function test_interfaceId_isStableAndDistinct() public pure {
        bytes4 expected = IPositionAdapter.deploy.selector ^ IPositionAdapter.withdraw.selector
            ^ IPositionAdapter.totalAssets.selector ^ IPositionAdapter.isExact.selector
            ^ IPositionAdapter.harvestRewards.selector ^ IPositionAdapter.sweepForeignToken.selector
            ^ IPositionAdapter.USDC.selector ^ IPositionAdapter.VAULT.selector;
        assertEq(type(IPositionAdapter).interfaceId, expected, "interfaceId != XOR of members");
        assertEq(type(IPositionAdapter).interfaceId, FROZEN_INTERFACE_ID, "interfaceId changed");
        assertTrue(
            type(IPositionAdapter).interfaceId != type(IStrategyAdapter).interfaceId,
            "must differ from IStrategyAdapter"
        );
    }

    /// @dev The frozen normative error selectors (#1116). Hardcoded so a rename
    ///      of a shared error breaks the freeze loudly.
    function test_errorSet_selectorsFrozen() public pure {
        assertEq(IPositionAdapter.OnlyVault.selector, bytes4(keccak256("OnlyVault()")), "OnlyVault");
        assertEq(
            IPositionAdapter.SlippageExceeded.selector,
            bytes4(keccak256("SlippageExceeded()")),
            "SlippageExceeded"
        );
    }

    /// @dev The frozen ERC-165 interfaceId of the eight-member IPositionAdapter
    ///      surface (#1116). Recompute and update only via a coordinated
    ///      surface change; a silent drift fails `test_interfaceId_*`.
    bytes4 internal constant FROZEN_INTERFACE_ID = 0xa301918b;
}
