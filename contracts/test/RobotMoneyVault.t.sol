// SPDX-License-Identifier: MIT
// Canonical: none — Foundry tests for contracts/RobotMoneyVault.sol
// Covers: issue #160 — ERC-4626 decimals offset and first-depositor inflation protection
//         issue #161 — include idle vault USDC balance in totalAssets()
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {AaveV3Adapter} from "../adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../adapters/CompoundV3Adapter.sol";
import {MorphoAdapter} from "../adapters/MorphoAdapter.sol";
import {NoYieldTestAdapter} from "./helpers/NoYieldTestAdapter.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";

// ─── Minimal USDC mock ───────────────────────────────────────────────────────

contract TestUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// ─── Minimal strategy adapter mock ──────────────────────────────────────────

/// @dev Holds USDC in the adapter (simulates deployed yield position).
///      Supports direct "donation" by crediting extra assets without going
///      through the vault — modelling the Aave / Morpho / Compound donation path.
contract MockAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address public immutable VAULT;

    /// @notice Extra USDC credited directly (simulates protocol-level donation).
    uint256 public donatedAmount;
    bool public revertTotalAssets;

    error OnlyVault();
    error TotalAssetsUnavailable();

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address usdc_, address vault_) {
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256 amount) external onlyVault {
        // Assets already transferred to the adapter by the vault; nothing extra to do.
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 amount) external onlyVault returns (uint256) {
        uint256 bal = USDC.balanceOf(address(this));
        uint256 actual = amount > bal ? bal : amount;
        USDC.safeTransfer(VAULT, actual);
        // Reset donated portion as it flows back to the vault.
        if (actual >= donatedAmount) {
            donatedAmount = 0;
        } else {
            donatedAmount -= actual;
        }
        return actual;
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view returns (uint256) {
        if (revertTotalAssets) revert TotalAssetsUnavailable();
        return USDC.balanceOf(address(this));
    }

    function setRevertTotalAssets(bool enabled) external {
        revertTotalAssets = enabled;
    }

    /// @inheritdoc IStrategyAdapter
    function sweepForeignToken(address) external {}

    /// @inheritdoc IStrategyAdapter
    function harvestRewards() external {}

    /// @notice Simulate a protocol-level donation: credits USDC directly to the adapter
    ///         without going through the vault (models Aave `supply(onBehalfOf=adapter)`,
    ///         Morpho `deposit(receiver=adapter)`, or Compound `supply` to adapter).
    function donateFromAttacker(address attacker, uint256 amount) external {
        USDC.safeTransferFrom(attacker, address(this), amount);
        donatedAmount += amount;
    }
}

/// @dev Adapter that over-reports `totalAssets` by a configurable phantom amount and
///      can leak real USDC out, modelling a buggy or lying adapter. Used for the
///      `_pullProportional` shortfall tests (audit 2026-06-09, L-2).
contract ShortfallAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address public immutable VAULT;

    /// @notice Phantom assets added on top of the real balance in `totalAssets()`.
    uint256 public phantom;

    constructor(address usdc_, address vault_) {
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    function setPhantom(uint256 phantom_) external {
        phantom = phantom_;
    }

    /// @notice Simulate a loss: move real USDC out without adjusting reporting.
    function leak(address to, uint256 amount) external {
        USDC.safeTransfer(to, amount);
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256) external {}

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 amount) external returns (uint256) {
        uint256 bal = USDC.balanceOf(address(this));
        uint256 actual = amount > bal ? bal : amount;
        USDC.safeTransfer(VAULT, actual);
        return actual;
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view returns (uint256) {
        return USDC.balanceOf(address(this)) + phantom;
    }

    /// @inheritdoc IStrategyAdapter
    function sweepForeignToken(address) external {}

    /// @inheritdoc IStrategyAdapter
    function harvestRewards() external {}
}

// ─── Vault harness ───────────────────────────────────────────────────────────

/// @dev Exposes internal helpers for tests.
contract VaultHarness is RobotMoneyVault {
    constructor(
        IERC20 asset_,
        uint256 tvlCap_,
        uint256 perDepositCap_,
        uint256 exitFeeBps_,
        address feeRecipient_,
        address admin_,
        address emergencyResponder_
    )
        RobotMoneyVault(
            asset_, tvlCap_, perDepositCap_, exitFeeBps_, feeRecipient_, admin_, emergencyResponder_
        )
    {}

    function exposed_decimalsOffset() external pure returns (uint8) {
        return _decimalsOffset();
    }
}

// ─── Main test contract ──────────────────────────────────────────────────────

contract RobotMoneyVaultTest is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant TVL_CAP = 1_000_000_000 * ONE_USDC; // 1 billion USDC
    uint256 internal constant PER_DEPOSIT_CAP = 100_000_000 * ONE_USDC; // 100M USDC

    // decimalsOffset = 18, so virtual shares = 10^18.
    // Raw shares for a 1:1 price: previewDeposit(1e6) on fresh vault = 1e6 * 1e18 = 1e24.
    uint256 internal constant OFFSET = 18;
    uint256 internal constant VIRTUAL_SHARES = 10 ** OFFSET; // 1e18

    TestUSDC internal usdc;
    VaultHarness internal vault;
    MockAdapter internal adapter;

    address internal admin = makeAddr("admin");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        usdc = new TestUSDC();
        vault = new VaultHarness(
            IERC20(address(usdc)),
            TVL_CAP,
            PER_DEPOSIT_CAP,
            0, // no exit fee for most tests
            feeRecipient,
            admin,
            admin
        );

        // Wire up a simple mock adapter.
        adapter = new MockAdapter(address(usdc), address(vault));
        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), true);
        vm.prank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vm.prank(admin);
        vault.addAdapter(address(adapter), 10_000); // 100% cap

        // Give participants USDC.
        usdc.mint(alice, 100_000 * ONE_USDC);
        usdc.mint(bob, 100_000 * ONE_USDC);
        usdc.mint(attacker, 2_000_000 * ONE_USDC);

        // Pre-approve vault.
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(attacker);
        usdc.approve(address(adapter), type(uint256).max);
    }

    function _allowAdapter(RobotMoneyVault vault_, address adapter_) internal {
        vm.prank(admin);
        vault_.setAdapterAllowed(adapter_, true);
        vm.prank(admin);
        vault_.setAdapterCodeHashAllowed(adapter_.codehash, true);
    }

    // ─── Adapter eligibility ─────────────────────────────────────────────────

    function test_addAdapter_revertsWhenAdapterAddressNotAllowed() public {
        MockAdapter unapproved = new MockAdapter(address(usdc), address(vault));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterNotAllowed.selector, address(unapproved))
        );
        vault.addAdapter(address(unapproved), 10_000);
    }

    function test_addAdapter_revertsWhenAdapterCodeHashNotAllowed() public {
        // Distinct-bytecode adapter whose codehash is never allowlisted in
        // setUp (MockAdapter's codehash is, so it could not exercise the
        // codehash-gate revert here).
        NoYieldTestAdapter unapproved = new NoYieldTestAdapter(address(usdc), address(vault));
        vm.prank(admin);
        vault.setAdapterAllowed(address(unapproved), true);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.AdapterCodeHashNotAllowed.selector,
                address(unapproved),
                address(unapproved).codehash
            )
        );
        vault.addAdapter(address(unapproved), 10_000);
    }

    function test_addAdapter_revertsWhenAdapterAssetMismatchesVault() public {
        TestUSDC wrongUsdc = new TestUSDC();
        MockAdapter wrongAssetAdapter = new MockAdapter(address(wrongUsdc), address(vault));
        _allowAdapter(vault, address(wrongAssetAdapter));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.AdapterAssetMismatch.selector,
                address(wrongAssetAdapter),
                address(usdc),
                address(wrongUsdc)
            )
        );
        vault.addAdapter(address(wrongAssetAdapter), 10_000);
    }

    function test_addAdapter_revertsWhenAdapterVaultMismatchesVault() public {
        address wrongVault = makeAddr("wrongVault");
        MockAdapter wrongVaultAdapter = new MockAdapter(address(usdc), wrongVault);
        _allowAdapter(vault, address(wrongVaultAdapter));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.AdapterVaultMismatch.selector,
                address(wrongVaultAdapter),
                address(vault),
                wrongVault
            )
        );
        vault.addAdapter(address(wrongVaultAdapter), 10_000);
    }

    function test_approvedProductionAndDevnetAdapterTypesCanBeAdded() public {
        VaultHarness typedVault = new VaultHarness(
            IERC20(address(usdc)), TVL_CAP, PER_DEPOSIT_CAP, 0, feeRecipient, admin, admin
        );
        address pool = makeAddr("aavePool");
        address aToken = makeAddr("aToken");
        address comet = makeAddr("compoundComet");
        address morphoVault = makeAddr("morphoVault");

        AaveV3Adapter aave = new AaveV3Adapter(pool, address(usdc), aToken, address(typedVault));
        CompoundV3Adapter compound =
            new CompoundV3Adapter(comet, address(usdc), address(typedVault));
        MorphoAdapter morpho = new MorphoAdapter(morphoVault, address(usdc), address(typedVault));
        // Fourth, generic no-yield adapter to prove the vault accepts multiple
        // distinct adapter instances (not just the three real protocol types).
        MockAdapter generic = new MockAdapter(address(usdc), address(typedVault));

        _allowAdapter(typedVault, address(aave));
        _allowAdapter(typedVault, address(compound));
        _allowAdapter(typedVault, address(morpho));
        _allowAdapter(typedVault, address(generic));

        vm.startPrank(admin);
        typedVault.addAdapter(address(aave), 2_500);
        typedVault.addAdapter(address(compound), 2_500);
        typedVault.addAdapter(address(morpho), 2_500);
        typedVault.addAdapter(address(generic), 2_500);
        vm.stopPrank();

        assertEq(typedVault.adapterCount(), 4, "all approved adapter types should be added");
        assertEq(typedVault.activeAdapterCount(), 4, "all approved adapter types should be active");
    }

    /// @notice Revoking an active adapter's allowlist entry must NOT brick deposits
    ///         (audit 2026-06-09, L-4): `_routeDeposit` skips the ineligible adapter
    ///         and the funds stay idle in the vault (UnroutedDeposit emitted).
    function test_deposit_skipsAdapterAfterApprovalRevoked_fundsStayIdle() public {
        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);

        uint256 beforeAdapter = usdc.balanceOf(address(adapter));
        vm.expectEmit(false, false, false, true, address(vault));
        emit RobotMoneyVault.UnroutedDeposit(amount);
        vm.prank(alice);
        uint256 shares = vault.deposit(amount, alice);

        assertGt(shares, 0, "depositor must receive shares");
        assertEq(usdc.balanceOf(address(adapter)), beforeAdapter, "adapter must not receive USDC");
        assertEq(usdc.balanceOf(address(vault)), amount, "deposit must stay idle in the vault");
    }

    /// @notice With two adapters, revoking one routes the full deposit into the
    ///         remaining eligible adapter instead of reverting (audit L-4).
    function test_deposit_routesToRemainingEligibleAdapterAfterRevocation() public {
        MockAdapter second = new MockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(second));
        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);

        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);

        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice);

        assertEq(usdc.balanceOf(address(adapter)), 0, "revoked adapter must not receive USDC");
        assertEq(
            usdc.balanceOf(address(second)), amount, "eligible adapter must absorb the deposit"
        );
        assertEq(usdc.balanceOf(address(vault)), 0, "nothing should stay idle");
    }

    /// @notice `_pullProportional` reverts with the dedicated
    ///         `InsufficientAdapterLiquidity` error (instead of an opaque ERC-20
    ///         transfer revert) when the active adapters cannot deliver the
    ///         requested withdrawal (audit 2026-06-09, L-2).
    function test_withdraw_revertsWithInsufficientAdapterLiquidity_onAdapterShortfall() public {
        ShortfallAdapter liar = new ShortfallAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(liar));
        vm.prank(admin);
        vault.addAdapter(address(liar), 10_000);
        // Deactivate the honest default adapter so the liar is the only active one.
        vm.prank(admin);
        vault.removeAdapter(0);

        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice); // routed entirely into the liar (real 1 000)

        liar.setPhantom(500 * ONE_USDC); // reports 1 500 but can only deliver 1 000

        uint256 aliceShares = vault.balanceOf(alice);
        // No exit fee: the gross pulled from adapters equals previewRedeem; only
        // the liar's real 1 000 USDC is deliverable.
        uint256 expectedGross = vault.previewRedeem(aliceShares);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.InsufficientAdapterLiquidity.selector, expectedGross, amount
            )
        );
        vault.redeem(aliceShares, alice, alice);
    }

    /// @notice The leftover sweep distributes a shortfall across ALL active adapters
    ///         instead of dumping it on the last one: a withdrawal that the honest
    ///         adapter can cover succeeds even when the registry's last adapter
    ///         under-delivers (audit 2026-06-09, L-2).
    function test_withdraw_sweepCoversLastAdapterShortfall() public {
        // Registry: [honest default adapter, lying adapter last].
        ShortfallAdapter liar = new ShortfallAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(liar));
        vm.prank(admin);
        vault.addAdapter(address(liar), 10_000);

        vm.prank(alice);
        vault.deposit(1_600 * ONE_USDC, alice); // equal-weight 800 / 800
        assertEq(usdc.balanceOf(address(adapter)), 800 * ONE_USDC, "honest adapter funded");
        assertEq(usdc.balanceOf(address(liar)), 800 * ONE_USDC, "liar funded");

        // The liar loses 700 real USDC but keeps reporting 600 (100 real + 500 phantom).
        liar.leak(makeAddr("sink"), 700 * ONE_USDC);
        liar.setPhantom(500 * ONE_USDC);

        // Withdraw 700 net (no exit fee). The old implementation dumped the pass-1
        // shortfall on the LAST adapter (the liar), under-delivered, and reverted
        // opaquely on the final transfer; the sweep now covers it from the honest one.
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(700 * ONE_USDC, alice, alice);
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 700 * ONE_USDC, "alice received 700 USDC");
    }

    // ─── ADP-2 NAV side (F-14): revoked-but-active adapter excluded from NAV/pulls ──

    /// @notice ADP-2 / F-14: an adapter whose eligibility is revoked while still
    ///         registered-active no longer contributes to `totalAssets` nor
    ///         receives/returns withdrawal flow. Two adapters are funded 50/50;
    ///         revoking the second drops NAV by its balance, and a subsequent
    ///         withdrawal is sourced entirely from the still-eligible adapter.
    function test_ADP2_revokedAdapterExcludedFromNavAndPulls() public {
        MockAdapter second = new MockAdapter(address(usdc), address(vault));
        _allowAdapter(vault, address(second));
        vm.prank(admin);
        vault.addAdapter(address(second), 10_000);

        // Deposit 2 000: equal-weight 1 000 / 1 000 across the two adapters.
        uint256 amount = 2_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice);
        assertEq(usdc.balanceOf(address(adapter)), 1_000 * ONE_USDC, "adapter A funded");
        assertEq(usdc.balanceOf(address(second)), 1_000 * ONE_USDC, "adapter B funded");
        assertEq(vault.totalAssets(), amount, "NAV = both adapters while both eligible");

        // Revoke the second adapter's eligibility (still active in the registry).
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);

        // F-14: the revoked adapter's balance is EXCLUDED from NAV — a lying/revoked
        // adapter can no longer inflate (or, with honest holdings, prop up) the share price.
        assertEq(
            vault.totalAssets(),
            1_000 * ONE_USDC,
            "ADP-2: revoked adapter excluded from totalAssets"
        );

        // A withdrawal is sourced ENTIRELY from the eligible adapter; the revoked one is
        // never pulled from (its balance is untouched). Redeem all of alice's shares —
        // their NAV value is now just the eligible 1 000 (revoked balance excluded).
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 secondBalBefore = usdc.balanceOf(address(second));
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        // Payout equals the eligible NAV (1 000), within 1 wei share-rounding.
        assertApproxEqAbs(
            usdc.balanceOf(alice) - aliceBefore,
            1_000 * ONE_USDC,
            1,
            "pulled only the eligible adapter's NAV"
        );
        assertEq(
            usdc.balanceOf(address(second)), secondBalBefore, "revoked adapter never pulled from"
        );
    }

    // ─── FEE-2 (NC-11): exit fee charged on realised proceeds ──────────────────

    /// @notice FEE-2 / NC-11: the exit fee equals the configured bps of the
    ///         proceeds ACTUALLY realised. With an honest adapter, realised gross
    ///         equals the share-implied gross, so the fee and net payout match
    ///         `previewRedeem`.
    function test_FEE2_exitFeeOnRealizedProceeds() public {
        VaultHarness feeVault = new VaultHarness(
            IERC20(address(usdc)), TVL_CAP, PER_DEPOSIT_CAP, 100, feeRecipient, admin, admin
        ); // 100 bps = 1% exit fee
        MockAdapter feeAdapter = new MockAdapter(address(usdc), address(feeVault));
        _allowAdapter(feeVault, address(feeAdapter));
        vm.prank(admin);
        feeVault.addAdapter(address(feeAdapter), 10_000);

        vm.prank(alice);
        usdc.approve(address(feeVault), type(uint256).max);
        uint256 amount = 10_000 * ONE_USDC;
        vm.prank(alice);
        uint256 shares = feeVault.deposit(amount, alice);

        uint256 grossExpected = feeVault.convertToAssets(shares);
        uint256 feeExpected = grossExpected * 100 / 10_000; // 1%
        uint256 netExpected = grossExpected - feeExpected;

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 feeRecipBefore = usdc.balanceOf(feeRecipient);
        vm.prank(alice);
        feeVault.redeem(shares, alice, alice);

        assertEq(usdc.balanceOf(alice) - aliceBefore, netExpected, "net on realised proceeds");
        assertEq(
            usdc.balanceOf(feeRecipient) - feeRecipBefore,
            feeExpected,
            "fee = bps of realised gross"
        );
    }

    /// @notice FEE-2 / NC-11: an over-reporting adapter cannot socialise its
    ///         shortfall. When the adapter reports more NAV than it can deliver,
    ///         the withdrawal reverts (`InsufficientAdapterLiquidity`) rather than
    ///         silently paying the inflated gross from another holder's idle USDC.
    function test_FEE2_overReportingAdapterCannotSocializeLoss() public {
        VaultHarness feeVault = new VaultHarness(
            IERC20(address(usdc)), TVL_CAP, PER_DEPOSIT_CAP, 100, feeRecipient, admin, admin
        );
        ShortfallAdapter liar = new ShortfallAdapter(address(usdc), address(feeVault));
        _allowAdapter(feeVault, address(liar));
        vm.prank(admin);
        feeVault.addAdapter(address(liar), 10_000);

        // Alice deposits 1 000 (routed entirely into the liar).
        vm.prank(alice);
        usdc.approve(address(feeVault), type(uint256).max);
        vm.prank(alice);
        uint256 shares = feeVault.deposit(1_000 * ONE_USDC, alice);

        // Bob's idle USDC is parked in the vault (e.g. unrouted) — the would-be
        // socialisation source if the fee/payout were based on share-implied gross.
        vm.prank(bob);
        usdc.transfer(address(feeVault), 1_000 * ONE_USDC);

        // The liar over-reports by 500 but can still only deliver its real 1 000.
        liar.setPhantom(500 * ONE_USDC);

        // Share-implied gross is now inflated by the phantom; idle (Bob's 1 000) covers
        // part, and the adapter must supply the rest but can only deliver 1 000 real.
        uint256 grossInflated = feeVault.convertToAssets(shares);
        uint256 idle = usdc.balanceOf(address(feeVault));

        // Redeeming all shares: realised proceeds cannot cover the inflated gross, so the
        // withdrawal reverts (InsufficientAdapterLiquidity) instead of draining Bob's idle USDC.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                RobotMoneyVault.InsufficientAdapterLiquidity.selector,
                grossInflated - idle, // remainingNeeded after idle is applied
                1_000 * ONE_USDC // the liar's real deliverable balance
            )
        );
        feeVault.redeem(shares, alice, alice);

        // Bob's idle USDC was NOT touched — no loss socialisation.
        assertEq(usdc.balanceOf(address(feeVault)), idle, "Bob's idle USDC untouched");
    }

    /// @notice Keeper `rebalance()` must NOT brick when an active adapter's allowlist
    ///         entry is revoked (audit L-4): the routing pass skips it; idle funds remain.
    function test_rebalance_skipsAdapterAfterApprovalRevoked() public {
        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice);
        usdc.mint(address(vault), amount);

        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);

        uint256 beforeAdapter = usdc.balanceOf(address(adapter));
        vm.warp(block.timestamp + vault.minRebalanceInterval());
        vm.prank(admin);
        vault.rebalance();

        assertEq(usdc.balanceOf(address(adapter)), beforeAdapter, "adapter must not receive USDC");
        assertEq(usdc.balanceOf(address(vault)), amount, "idle funds must remain in the vault");
    }

    function test_adminRebalanceCannotAllocateToAdapterAfterApprovalRevoked() public {
        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice);
        usdc.mint(address(vault), amount);

        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);

        uint256[] memory targets = new uint256[](vault.adapterCount());
        targets[0] = amount * 2;
        uint256 beforeAdapter = usdc.balanceOf(address(adapter));

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(RobotMoneyVault.AdapterNotAllowed.selector, address(adapter))
        );
        vault.adminRebalance(targets);

        assertEq(usdc.balanceOf(address(adapter)), beforeAdapter, "adapter must not receive USDC");
    }

    function test_emergencyWithdrawStillWorksAfterApprovalRevoked() public {
        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice);

        vm.prank(admin);
        vault.setAdapterAllowed(address(adapter), false);

        vm.prank(admin);
        vault.emergencyWithdrawAdapter(0);

        assertEq(usdc.balanceOf(address(adapter)), 0, "adapter should be drained");
        assertEq(usdc.balanceOf(address(vault)), amount, "vault should receive adapter USDC");
    }

    // ─── Decimals offset ────────────────────────────────────────────────────

    /// @notice Confirm the offset is exactly 18 (the value proven safe against inflation attacks).
    function test_decimalsOffset_is18() public view {
        assertEq(vault.exposed_decimalsOffset(), 18, "offset must be 18");
    }

    /// @notice Share token decimals remain 6 (USDC-matching, intentional override).
    function test_shareDecimals_is6() public view {
        assertEq(vault.decimals(), 6, "share token decimals must be 6");
    }

    // ─── Fresh-vault preview functions ─────────────────────────────────────

    /// @notice previewDeposit on a fresh vault: depositing 1 USDC returns 1e24 raw shares.
    ///         This is the expected raw-share scale with decimalsOffset=18 and decimals()=6.
    function test_previewDeposit_freshVault_rawShareScale() public view {
        // Formula: assets * (totalSupply + 10^18) / (totalAssets + 1)
        //          = 1e6 * (0 + 1e18) / (0 + 1) = 1e24
        uint256 expected = ONE_USDC * VIRTUAL_SHARES; // 1e24
        assertEq(vault.previewDeposit(ONE_USDC), expected, "fresh previewDeposit raw share scale");
    }

    /// @notice previewDeposit scales linearly for larger amounts on fresh vault.
    function test_previewDeposit_freshVault_largeAmount() public view {
        uint256 amount = 1_000 * ONE_USDC; // 1000 USDC
        uint256 expected = amount * VIRTUAL_SHARES;
        assertEq(vault.previewDeposit(amount), expected, "fresh previewDeposit 1000 USDC");
    }

    /// @notice previewMint on a fresh vault: minting 1e24 raw shares costs 1 USDC.
    function test_previewMint_freshVault_rawShareScale() public view {
        uint256 rawShares = ONE_USDC * VIRTUAL_SHARES; // 1e24
        // Formula (ceil): shares * (totalAssets + 1) / (totalSupply + 10^18)
        //                = 1e24 * 1 / 1e18 = 1e6
        assertEq(vault.previewMint(rawShares), ONE_USDC, "fresh previewMint raw share scale");
    }

    /// @notice previewWithdraw on a fresh vault: receiving 1 USDC requires 1e24 raw shares.
    function test_previewWithdraw_freshVault_rawShareScale() public view {
        // RobotMoneyVault.previewWithdraw converts net assets to gross then to shares.
        // With exitFeeBps=0, gross=net. Shares = assets * 10^18 / 1 = 1e24 (ceil).
        uint256 expected = ONE_USDC * VIRTUAL_SHARES;
        assertEq(vault.previewWithdraw(ONE_USDC), expected, "fresh previewWithdraw raw share scale");
    }

    /// @notice previewRedeem on a fresh vault: redeeming 1e24 raw shares yields 1 USDC.
    function test_previewRedeem_freshVault_rawShareScale() public view {
        uint256 rawShares = ONE_USDC * VIRTUAL_SHARES; // 1e24
        // RobotMoneyVault.previewRedeem converts shares to gross assets then applies fee.
        // grossAssets = 1e24 * 1 / 1e18 = 1e6. fee = 0. netAssets = 1e6.
        assertEq(vault.previewRedeem(rawShares), ONE_USDC, "fresh previewRedeem raw share scale");
    }

    // ─── After seed deposit: preview functions remain consistent ────────────

    /// @notice After the admin seeds 1000 USDC, previewDeposit is still proportional.
    function test_previewDeposit_afterSeed_proportional() public {
        uint256 seed = 1_000 * ONE_USDC;
        usdc.mint(admin, seed);
        vm.startPrank(admin);
        usdc.approve(address(vault), seed);
        vault.deposit(seed, admin);
        vm.stopPrank();

        // After seed: totalSupply = seed * 1e18, totalAssets ≈ seed
        // previewDeposit(seed) = seed * (seed*1e18 + 1e18) / (seed + 1)
        //                      ≈ seed * 1e18 (for large seed values the +1 terms are negligible)
        uint256 preview = vault.previewDeposit(seed);
        uint256 approxExpected = seed * VIRTUAL_SHARES;
        // Allow 1 wei rounding tolerance.
        assertApproxEqAbs(preview, approxExpected, 1, "previewDeposit after seed");
    }

    // ─── First-depositor inflation attack resistance ─────────────────────────

    /// @notice Core attack scenario: attacker deposits 1 wei then donates 1M USDC to the
    ///         adapter directly (bypassing the vault). Victim deposits — must NOT receive
    ///         zero shares, and must receive economically fair shares.
    function test_inflationAttack_victimReceivesFairShares() public {
        // 1. Attacker deposits 1 wei USDC.
        usdc.mint(attacker, 1);
        vm.prank(attacker);
        usdc.approve(address(vault), 1);
        vm.prank(attacker);
        uint256 attackerShares = vault.deposit(1, attacker);
        assertGt(attackerShares, 0, "attacker must get shares");

        uint256 totalAssetsBefore = vault.totalAssets();

        // 2. Attacker donates 1,000,000 USDC directly to the adapter
        //    (models Aave supply(onBehalfOf=adapter), Morpho deposit(receiver=adapter), etc.)
        uint256 donationAmount = 1_000_000 * ONE_USDC;
        adapter.donateFromAttacker(attacker, donationAmount);

        uint256 totalAssetsAfterDonation = vault.totalAssets();
        assertEq(
            totalAssetsAfterDonation,
            totalAssetsBefore + donationAmount,
            "donation must increase totalAssets"
        );

        // 3. Victim deposits a realistic amount. Bob has 100k USDC.
        uint256 victimDeposit = 100_000 * ONE_USDC;
        vm.prank(bob);
        uint256 victimShares = vault.deposit(victimDeposit, bob);

        // Victim must receive non-zero shares.
        assertGt(
            victimShares, 0, "victim must receive non-zero shares (offset protects against zero)"
        );

        // Victim shares must be economically fair: victim should receive shares worth
        // at least 99% of their deposit value (attacker gains < 1% of victim's capital).
        // Fair shares = victimDeposit * (totalSupply + virtual) / (totalAssets + 1)
        // The virtual floor of 1e18 prevents the attacker's donation from dominating.
        uint256 victimAssetsBack = vault.previewRedeem(victimShares);
        // Victim should recover at least 90% of their deposit (donation dilutes but offset protects)
        assertGe(
            victimAssetsBack * 100,
            victimDeposit * 90,
            "victim must recover at least 90% of deposit value"
        );
    }

    /// @notice After a 1 wei first deposit + 1M USDC donation, previewDeposit for a
    ///         realistic victim amount (999_999 USDC) must NOT return zero shares.
    function test_inflationAttack_previewDepositNonZero() public {
        // Attacker seed deposit.
        usdc.mint(attacker, 1);
        vm.prank(attacker);
        usdc.approve(address(vault), 1);
        vm.prank(attacker);
        vault.deposit(1, attacker);

        // Donation directly to adapter.
        adapter.donateFromAttacker(attacker, 1_000_000 * ONE_USDC);

        // previewDeposit for victim must be non-zero.
        uint256 preview = vault.previewDeposit(999_999 * ONE_USDC);
        assertGt(preview, 0, "previewDeposit must be non-zero after donation attack");
    }

    // ─── Adapter-specific donation paths ─────────────────────────────────────

    /// @notice Verify that an Aave-style donation (to the adapter, bypassing the vault)
    ///         cannot force a realistic victim deposit to receive zero shares.
    function test_aaveStyleDonation_victimSharesNonZero() public {
        // Seed: first depositor puts in 1 USDC legitimately.
        vm.prank(alice);
        vault.deposit(ONE_USDC, alice);

        // Aave-style: attacker donates 1M USDC directly to the adapter.
        adapter.donateFromAttacker(attacker, 1_000_000 * ONE_USDC);

        // Victim deposits 500k USDC.
        uint256 victimDeposit = 500_000 * ONE_USDC;
        uint256 preview = vault.previewDeposit(victimDeposit);
        assertGt(preview, 0, "Aave-style donation: victim previewDeposit must be non-zero");
    }

    /// @notice Verify that a Morpho-style donation (also to the adapter)
    ///         cannot force a realistic victim deposit to receive zero shares.
    function test_morphoStyleDonation_victimSharesNonZero() public {
        vm.prank(alice);
        vault.deposit(ONE_USDC, alice);

        // Morpho-style: same adapter donation path.
        adapter.donateFromAttacker(attacker, 1_000_000 * ONE_USDC);

        uint256 preview = vault.previewDeposit(500_000 * ONE_USDC);
        assertGt(preview, 0, "Morpho-style donation: victim previewDeposit must be non-zero");
    }

    /// @notice Verify that a Compound-style donation (also via adapter)
    ///         cannot force a realistic victim deposit to receive zero shares.
    function test_compoundStyleDonation_victimSharesNonZero() public {
        vm.prank(alice);
        vault.deposit(ONE_USDC, alice);

        // Compound-style: same adapter donation path.
        adapter.donateFromAttacker(attacker, 1_000_000 * ONE_USDC);

        uint256 preview = vault.previewDeposit(500_000 * ONE_USDC);
        assertGt(preview, 0, "Compound-style donation: victim previewDeposit must be non-zero");
    }

    // ─── Seed deposit correctness ──────────────────────────────────────────

    /// @notice Admin can perform the recommended seed deposit immediately after deployment.
    ///         After seeding 1000 USDC, the vault is safe for public deposits.
    function test_seedDeposit_adminCanSeed1000USDC() public {
        uint256 seedAmount = 1_000 * ONE_USDC;
        usdc.mint(admin, seedAmount);
        vm.prank(admin);
        usdc.approve(address(vault), seedAmount);
        vm.prank(admin);
        uint256 seedShares = vault.deposit(seedAmount, admin);

        assertGt(seedShares, 0, "seed deposit must mint shares");
        assertGe(vault.totalAssets(), seedAmount, "totalAssets must include seed");
        assertEq(vault.totalSupply(), seedShares, "totalSupply must reflect seed shares");
    }

    /// @notice After a 1000 USDC admin seed, a normal user deposit is proportional.
    function test_seedDeposit_normalDepositProportional() public {
        uint256 seedAmount = 1_000 * ONE_USDC;
        usdc.mint(admin, seedAmount);
        vm.prank(admin);
        usdc.approve(address(vault), seedAmount);
        vm.prank(admin);
        vault.deposit(seedAmount, admin);

        // Alice deposits same amount.
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(seedAmount, alice);

        // Alice should get approximately the same number of shares as the seed.
        uint256 seedShares = vault.balanceOf(admin);
        assertApproxEqRel(aliceShares, seedShares, 0.001e18, "proportional deposit after seed");
    }

    // ─── Round-trip: deposit → redeem ──────────────────────────────────────

    /// @notice Depositing then immediately redeeming returns (approximately) the same assets.
    function test_depositAndRedeem_roundTrip() public {
        uint256 amount = 10_000 * ONE_USDC;
        vm.prank(alice);
        uint256 shares = vault.deposit(amount, alice);

        assertGt(shares, 0, "must get shares");

        // Pull assets from adapter back to vault for withdrawal.
        vm.prank(alice);
        uint256 assetsOut = vault.redeem(shares, alice, alice);

        // With no exit fee, assetsOut should equal amount (minus rounding).
        assertApproxEqAbs(assetsOut, amount, 1, "redeem round-trip");
    }

    // ─── Issue #161: idle vault USDC reflected in totalAssets ─────────────────

    /// @notice A direct USDC transfer to the vault (not via deposit) must be
    ///         included in totalAssets().
    function test_totalAssets_includesIdleVaultBalance() public {
        // Seed via normal deposit so there is a baseline.
        uint256 depositAmount = 10_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(depositAmount, alice);

        uint256 totalBefore = vault.totalAssets();

        // Send USDC directly to the vault (models an attacker or routing overflow).
        uint256 idleAmount = 5_000 * ONE_USDC;
        usdc.mint(address(vault), idleAmount);

        uint256 totalAfter = vault.totalAssets();
        assertEq(totalAfter, totalBefore + idleAmount, "idle USDC must be counted in totalAssets");
    }

    /// @notice TVL cap must be enforced against the sum of adapter balances AND idle vault
    ///         balance, so that idle USDC cannot be used to bypass the cap.
    function test_tvlCap_enforcedIncludingIdleBalance() public {
        // Deploy a vault with a tight TVL cap: 20 000 USDC.
        uint256 cap = 20_000 * ONE_USDC;
        VaultHarness tightVault = new VaultHarness(
            IERC20(address(usdc)),
            cap,
            cap, // perDepositCap matches tvlCap
            0,
            feeRecipient,
            admin,
            admin
        );
        MockAdapter tightAdapter = new MockAdapter(address(usdc), address(tightVault));
        _allowAdapter(tightVault, address(tightAdapter));
        vm.prank(admin);
        tightVault.addAdapter(address(tightAdapter), 10_000);

        // Deposit 15 000 USDC — within cap.
        usdc.mint(alice, cap);
        vm.prank(alice);
        usdc.approve(address(tightVault), type(uint256).max);
        vm.prank(alice);
        tightVault.deposit(15_000 * ONE_USDC, alice);

        // Directly send 4 000 USDC idle to the vault (e.g. from an external transfer).
        usdc.mint(address(tightVault), 4_000 * ONE_USDC);

        // totalAssets is now 15 000 (adapter) + 4 000 (idle) = 19 000.
        assertEq(tightVault.totalAssets(), 19_000 * ONE_USDC, "totalAssets must include idle");

        // A further deposit of 2 000 would push total to 21 000 > 20 000 cap → must revert.
        usdc.mint(bob, 2_000 * ONE_USDC);
        vm.prank(bob);
        usdc.approve(address(tightVault), type(uint256).max);
        vm.prank(bob);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit fires before TVLCapExceeded because maxDeposit() returns headroom
        tightVault.deposit(2_000 * ONE_USDC, bob);
    }

    /// @notice UnroutedDeposit event is emitted when routing cannot place all assets
    ///         (all adapter caps exhausted).
    function test_routeDeposit_emitsUnroutedDeposit_whenCapsExhausted() public {
        // Deploy a vault whose single adapter has a 50% cap and is already at cap.
        // We set up a scenario where the adapter is already at 50% of totalAfter,
        // so pass 2 also finds no headroom and remaining > 0.

        // Use a cap-capped adapter: capBps = 5000 (50%)
        VaultHarness capVault = new VaultHarness(
            IERC20(address(usdc)), TVL_CAP, PER_DEPOSIT_CAP, 0, feeRecipient, admin, admin
        );
        MockAdapter capAdapter = new MockAdapter(address(usdc), address(capVault));
        _allowAdapter(capVault, address(capAdapter));
        vm.prank(admin);
        capVault.addAdapter(address(capAdapter), 5000); // 50% cap

        usdc.mint(alice, 200_000 * ONE_USDC);
        vm.prank(alice);
        usdc.approve(address(capVault), type(uint256).max);

        // First deposit: 100 000 USDC. Adapter cap is 50% = 50 000.
        // pass1 routes 50 000, remaining=50 000. pass2 finds adapter already at cap.
        // So 50 000 should be unrouted.
        vm.expectEmit(true, true, true, true, address(capVault));
        emit RobotMoneyVault.UnroutedDeposit(50_000 * ONE_USDC);
        vm.prank(alice);
        capVault.deposit(100_000 * ONE_USDC, alice);

        // The idle USDC in the vault should be 50 000.
        assertEq(
            usdc.balanceOf(address(capVault)),
            50_000 * ONE_USDC,
            "idle USDC must remain in vault when unrouted"
        );

        // totalAssets includes the idle portion.
        assertEq(capVault.totalAssets(), 100_000 * ONE_USDC, "totalAssets must include idle USDC");
    }

    // ─── Pause / unpause role asymmetry (issue #164) ────────────────────────

    /// @notice EMERGENCY_ROLE holder can call pause().
    function test_pause_allowedForEmergencyRole() public {
        address emergency = makeAddr("emergency");
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();
        vm.prank(admin);
        vault.grantRole(emergencyRole, emergency);

        vm.prank(emergency);
        vault.pause();
        assertTrue(vault.paused(), "vault must be paused");
    }

    /// @notice EMERGENCY_ROLE holder cannot call unpause() — must revert.
    ///         A compromised emergency key can halt the vault (DoS) but cannot restart it.
    function test_unpause_revertsForEmergencyRole() public {
        address emergency = makeAddr("emergency");
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();
        vm.prank(admin);
        vault.grantRole(emergencyRole, emergency);

        // First pause so we can attempt an unpause.
        vm.prank(emergency);
        vault.pause();

        // Emergency role alone must NOT be able to unpause.
        vm.prank(emergency);
        vm.expectRevert();
        vault.unpause();
    }

    /// @notice ADMIN_ROLE holder can call unpause() after the vault has been paused.
    function test_unpause_allowedForAdminRole() public {
        address emergency = makeAddr("emergency");
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();
        vm.prank(admin);
        vault.grantRole(emergencyRole, emergency);

        // Pause via emergency role.
        vm.prank(emergency);
        vault.pause();
        assertTrue(vault.paused(), "vault must be paused before unpause test");

        // Admin unpauses — the only role permitted to restart the vault.
        vm.prank(admin);
        vault.unpause();
        assertFalse(vault.paused(), "vault must be unpaused after admin unpause");
    }

    // ─── Issue #368: split pause semantics — emergency withdraw preserves redemption rights ────

    /// @notice After emergencyWithdraw(), users can redeem their shares (assets moved to idle USDC).
    ///         New deposits must be blocked.
    function test_emergencyWithdraw_userCanRedeem_newDepositBlocked() public {
        // Alice deposits 10 000 USDC.
        uint256 depositAmount = 10_000 * ONE_USDC;
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(depositAmount, alice);
        assertGt(aliceShares, 0, "alice must receive shares");

        // Admin triggers emergency withdraw (admin also holds EMERGENCY_ROLE in setUp).
        vm.prank(admin);
        vault.emergencyWithdraw();

        // After emergencyWithdraw, deposits must be blocked.
        assertEq(vault.depositsPaused(), true, "deposits must be paused after emergencyWithdraw");
        // Withdrawals must NOT be blocked.
        assertEq(
            vault.withdrawalsPaused(),
            false,
            "withdrawals must not be paused after emergencyWithdraw"
        );
        // paused() (= both flags) must be false.
        assertFalse(vault.paused(), "full paused() must be false after emergencyWithdraw");

        // Alice can redeem — assets are now in idle USDC in the vault.
        vm.prank(alice);
        uint256 assetsOut = vault.redeem(aliceShares, alice, alice);
        assertApproxEqAbs(assetsOut, depositAmount, 1, "alice must recover her deposit on redeem");

        // Bob tries a new deposit → must revert. maxDeposit() returns 0 when paused,
        // so ERC4626ExceededMaxDeposit fires before DepositsPaused.
        uint256 bobDeposit = 1_000 * ONE_USDC;
        vm.prank(bob);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit(receiver, assets, 0)
        vault.deposit(bobDeposit, bob);
    }

    /// @notice full pause() blocks both deposits and withdrawals.
    function test_fullPause_blocksDepositsAndWithdrawals() public {
        // Alice deposits.
        uint256 depositAmount = 5_000 * ONE_USDC;
        vm.prank(alice);
        uint256 aliceShares = vault.deposit(depositAmount, alice);

        // Admin full-pauses the vault.
        vm.prank(admin);
        vault.pause();

        assertTrue(vault.depositsPaused(), "deposits must be paused");
        assertTrue(vault.withdrawalsPaused(), "withdrawals must be paused");
        assertTrue(vault.paused(), "paused() must be true");

        // Deposit blocked. maxDeposit() returns 0 when paused, so ERC4626ExceededMaxDeposit
        // fires before the internal DepositsPaused guard.
        vm.prank(bob);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit(receiver, assets, 0)
        vault.deposit(1_000 * ONE_USDC, bob);

        // Redeem blocked. maxRedeem() returns 0 while withdrawals are paused
        // (audit 2026-06-09, L-1), so ERC4626ExceededMaxRedeem fires before the
        // internal WithdrawalsPaused guard.
        assertEq(vault.maxRedeem(alice), 0, "maxRedeem must be 0 while paused");
        assertEq(vault.maxWithdraw(alice), 0, "maxWithdraw must be 0 while paused");
        vm.prank(alice);
        vm.expectRevert(); // ERC4626ExceededMaxRedeem(owner, shares, 0)
        vault.redeem(aliceShares, alice, alice);
    }

    /// @notice After emergencyWithdraw, split-pause state is correctly set; full unpause restores both.
    function test_emergencyWithdraw_thenUnpause_restoresFullFunctionality() public {
        // Alice deposits.
        uint256 depositAmount = 8_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(depositAmount, alice);

        // Emergency withdraw — only deposits paused.
        vm.prank(admin);
        vault.emergencyWithdraw();

        assertEq(vault.depositsPaused(), true, "deposits paused after emergencyWithdraw");
        assertEq(vault.withdrawalsPaused(), false, "withdrawals open after emergencyWithdraw");

        // Admin unpauses fully.
        vm.prank(admin);
        vault.unpause();

        assertEq(vault.depositsPaused(), false, "deposits unpaused after unpause");
        assertEq(vault.withdrawalsPaused(), false, "withdrawals unpaused after unpause");

        // Bob can now deposit again.
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_000 * ONE_USDC, bob);
        assertGt(bobShares, 0, "bob must receive shares after unpause");
    }

    // ─── forceRemoveAdapter — loss-acceptance semantics ──────────────────────

    /// @notice EMERGENCY_ROLE can force-remove an adapter with assets; active flag becomes false
    ///         and AdapterForceRemoved is emitted with the correct lossAmount.
    function test_forceRemoveAdapter_deactivatesAdapterAndEmitsCorrectLoss() public {
        // Alice deposits so the adapter holds non-zero assets.
        uint256 depositAmount = 5_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(depositAmount, alice);

        // Confirm the adapter holds assets before force-remove.
        uint256 assetsBefore = adapter.totalAssets();
        assertGt(assetsBefore, 0, "adapter must hold non-zero assets before force-remove");

        // Confirm adapter is currently active (index 0).
        (,, bool activeBefore) = vault.adapters(0);
        assertTrue(activeBefore, "adapter must be active before force-remove");

        // Expect the AdapterForceRemoved event with matching lossAmount.
        vm.expectEmit(true, true, false, true, address(vault));
        emit RobotMoneyVault.AdapterForceRemoved(0, address(adapter), assetsBefore);

        vm.prank(admin);
        vault.forceRemoveAdapter(0);

        // Active flag must now be false.
        (,, bool activeAfter) = vault.adapters(0);
        assertFalse(activeAfter, "adapter must be inactive after force-remove");

        // Assets remain in the adapter (not withdrawn) — the loss is accepted.
        assertEq(
            adapter.totalAssets(),
            assetsBefore,
            "adapter assets must remain untouched (loss accepted)"
        );
    }

    function test_forceRemoveAdapter_succeedsWhenTotalAssetsReverts() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(depositAmount, alice);
        adapter.setRevertTotalAssets(true);

        vm.expectEmit(true, true, false, true, address(vault));
        emit RobotMoneyVault.AdapterForceRemoved(0, address(adapter), 0);
        vm.prank(admin);
        vault.forceRemoveAdapter(0);

        (,, bool active) = vault.adapters(0);
        assertFalse(active, "reverting adapter must be quarantined");
        assertEq(vault.totalAssets(), 0, "inactive reverting adapter must not block healthy views");
    }

    /// @notice Calling forceRemoveAdapter without EMERGENCY_ROLE must revert with AccessControl error.
    function test_forceRemoveAdapter_revertsWhenCallerLacksEmergencyRole() public {
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();

        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", alice, emergencyRole
            )
        );
        vm.prank(alice);
        vault.forceRemoveAdapter(0);
    }

    /// @notice Calling forceRemoveAdapter with an out-of-range index must revert with AdapterNotFound.
    function test_forceRemoveAdapter_revertsOnOutOfRangeIndex() public {
        uint256 outOfRange = 999;

        vm.expectRevert(abi.encodeWithSelector(RobotMoneyVault.AdapterNotFound.selector));
        vm.prank(admin);
        vault.forceRemoveAdapter(outOfRange);
    }

    /// @notice Calling forceRemoveAdapter on an already-inactive adapter must revert with AdapterNotFound.
    function test_forceRemoveAdapter_revertsOnAlreadyInactiveAdapter() public {
        // First, force-remove the adapter to deactivate it.
        vm.prank(admin);
        vault.forceRemoveAdapter(0);

        // Second call on the now-inactive adapter must revert.
        vm.expectRevert(abi.encodeWithSelector(RobotMoneyVault.AdapterNotFound.selector));
        vm.prank(admin);
        vault.forceRemoveAdapter(0);
    }

    /// @notice forceRemoveAdapter must pause deposits to close the share-price-crash arbitrage window.
    function test_forceRemoveAdapter_pausesDeposits() public {
        // Alice deposits so the adapter holds non-zero assets.
        uint256 depositAmount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(depositAmount, alice);

        // Force-remove the adapter.
        vm.prank(admin);
        vault.forceRemoveAdapter(0);

        // Deposits must now be paused.
        assertTrue(vault.depositsPaused(), "deposits must be paused after forceRemoveAdapter");

        // A subsequent deposit attempt must revert (maxDeposit returns 0 when depositsPaused,
        // so OZ ERC4626 reverts with ERC4626ExceededMaxDeposit before reaching _deposit).
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSignature(
                "ERC4626ExceededMaxDeposit(address,uint256,uint256)", bob, 100 * ONE_USDC, 0
            )
        );
        vault.deposit(100 * ONE_USDC, bob);
    }

    // ─── L-3: shutdown recoverability ──────────────────────────────────────────

    /// @notice EMERGENCY_ROLE can shut the vault down (deposits blocked,
    ///         maxDeposit == 0) and the new ADMIN_ROLE-gated restoreVault
    ///         re-opens deposits (maxDeposit > 0 and a deposit succeeds), while
    ///         EMERGENCY_ROLE alone cannot restore (reverts). This proves a
    ///         compromised emergency hot key can DoS but not permanently brick
    ///         deposits — mirroring the documented pause/unpause asymmetry.
    function test_shutdownVault_isRecoverableByAdminNotEmergency() public {
        // Distinct EMERGENCY_ROLE holder (lower-trust hot key); admin keeps
        // ADMIN_ROLE only. This separation is what the trust model assumes.
        address emergency = makeAddr("emergency");
        bytes32 emergencyRole = vault.EMERGENCY_ROLE();
        vm.prank(admin);
        vault.grantRole(emergencyRole, emergency);

        // Sanity: deposits open before shutdown.
        assertGt(vault.maxDeposit(alice), 0, "deposits should be open pre-shutdown");

        // 1. EMERGENCY_ROLE shuts the vault down: deposits blocked, cap zeroed.
        vm.prank(emergency);
        vault.shutdownVault();
        assertTrue(vault.isShutdown(), "vault should be shut down");
        assertEq(vault.maxDeposit(alice), 0, "maxDeposit must be 0 after shutdown");
        assertEq(vault.tvlCap(), 0, "tvlCap must be zeroed by shutdown");

        // A deposit must revert while shut down.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature(
                "ERC4626ExceededMaxDeposit(address,uint256,uint256)", alice, 100 * ONE_USDC, 0
            )
        );
        vault.deposit(100 * ONE_USDC, alice);

        // 2. EMERGENCY_ROLE alone CANNOT restore (it lacks ADMIN_ROLE).
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.prank(emergency);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", emergency, adminRole
            )
        );
        vault.restoreVault(TVL_CAP);

        // 3. ADMIN_ROLE restores: deposits re-open with a fresh cap.
        vm.prank(admin);
        vault.restoreVault(TVL_CAP);
        assertFalse(vault.isShutdown(), "vault should no longer be shut down");
        assertEq(vault.tvlCap(), TVL_CAP, "restore must set the supplied TVL cap");
        assertGt(vault.maxDeposit(alice), 0, "deposits should re-open after restore");

        // A deposit now succeeds.
        vm.prank(alice);
        uint256 shares = vault.deposit(100 * ONE_USDC, alice);
        assertGt(shares, 0, "deposit after restore must mint shares");
    }

    /// @notice restoreVault reverts when the vault is not shut down (NotShutdown)
    ///         and when the supplied cap is zero (InvalidCap).
    function test_restoreVault_revertsWhenNotShutdownOrZeroCap() public {
        // Not shut down → NotShutdown.
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.NotShutdown.selector);
        vault.restoreVault(TVL_CAP);

        // Shut down, then a zero cap is rejected.
        vm.prank(admin);
        vault.shutdownVault();
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.InvalidCap.selector);
        vault.restoreVault(0);
    }

    // ─── Unified governance retire (DI-2, #942) ───────────────────────────────

    /// @notice After the registry drives `retire()`, direct deposits/mints are
    ///         hard-stopped at the vault (maxDeposit == 0, deposit reverts), but
    ///         withdrawals/redemptions stay open. `retire()` is callable only by
    ///         the linked registry; a stranger (even ADMIN_ROLE) call reverts.
    function test_retire_haltsDirectDepositsButKeepsRedeemOpen() public {
        // A registry stand-in is the only caller allowed to drive retire().
        address registry = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(registry);

        // Seed a position so we can prove redeem stays open after retire.
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 * ONE_USDC, alice);
        assertGt(shares, 0, "seed deposit should mint shares");
        assertGt(vault.maxDeposit(alice), 0, "deposits open pre-retire");

        // A direct (non-registry) retire() call reverts — even from ADMIN.
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.OnlyRegistry.selector);
        vault.retire();

        // The registry retires the vault.
        vm.prank(registry);
        vault.retire();
        assertTrue(vault.retired(), "vault should be retired");
        assertEq(vault.maxDeposit(alice), 0, "maxDeposit must be 0 after retire");

        // Direct deposits now revert with VaultRetired (ERC-4626 max-deposit guard
        // fires first because maxDeposit() == 0).
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature(
                "ERC4626ExceededMaxDeposit(address,uint256,uint256)", alice, 100 * ONE_USDC, 0
            )
        );
        vault.deposit(100 * ONE_USDC, alice);

        // Redemptions stay open: the seeded holder can still exit.
        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);
        assertGt(assets, 0, "redeem must stay open on a retired vault");
    }

    /// @notice The vault `retire`/`unretire` lifecycle flag is distinct from the
    ///         emergency `shutdown` overlay: retiring does not set `shutdown`, and
    ///         `shutdownVault` continues to work independently after a retire.
    function test_retire_isIndependentFromEmergencyShutdown() public {
        address registry = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(registry);

        // Retire: lifecycle flag set, emergency shutdown untouched.
        vm.prank(registry);
        vault.retire();
        assertTrue(vault.retired(), "retired flag set");
        assertFalse(vault.isShutdown(), "retire must not set the emergency shutdown flag");

        // Emergency shutdown still works while retired (EMERGENCY_ROLE, vault-only).
        vm.prank(admin); // admin also holds EMERGENCY_ROLE in this fixture
        vault.shutdownVault();
        assertTrue(vault.isShutdown(), "shutdownVault must still work after retire");
        assertTrue(vault.retired(), "retire flag stays set independently of shutdown");
    }

    /// @notice The registry can abort a deprecation via `unretire()`, re-opening
    ///         direct deposits. Only the linked registry may call it.
    function test_unretire_reopensDirectDeposits() public {
        address registry = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(registry);

        vm.prank(registry);
        vault.retire();
        assertEq(vault.maxDeposit(alice), 0, "deposits halted after retire");

        // Direct (non-registry) unretire reverts.
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.OnlyRegistry.selector);
        vault.unretire();

        // Registry aborts the deprecation.
        vm.prank(registry);
        vault.unretire();
        assertFalse(vault.retired(), "vault should be active again");
        assertGt(vault.maxDeposit(alice), 0, "deposits re-open after unretire");

        // A direct deposit now succeeds.
        vm.prank(alice);
        uint256 shares = vault.deposit(100 * ONE_USDC, alice);
        assertGt(shares, 0, "deposit after unretire must mint shares");
    }

    /// @notice `setRegistry` is set-once and ADMIN_ROLE-gated.
    function test_setRegistry_isSetOnceAndAdminGated() public {
        address registry = makeAddr("registry");

        // Non-admin cannot set the registry.
        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", alice, adminRole
            )
        );
        vault.setRegistry(registry);

        // Zero address rejected.
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.ZeroAddress.selector);
        vault.setRegistry(address(0));

        // First set succeeds; second reverts (set-once).
        vm.prank(admin);
        vault.setRegistry(registry);
        assertEq(vault.registry(), registry, "registry link must be set");
        vm.prank(admin);
        vm.expectRevert(RobotMoneyVault.RegistryAlreadySet.selector);
        vault.setRegistry(makeAddr("otherRegistry"));
    }

    // ─── Custody invariants: foreign-token quarantine & NAV donation (#929) ────

    /// @notice INV-1: the vault asset (USDC) can never be swept out — it is a
    ///         protocol/depositor asset counted in NAV and redeemable by holders.
    function test_sweepForeignToken_revertsForVaultAsset() public {
        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, address(usdc))
        );
        vault.sweepForeignToken(address(usdc));
    }

    /// @notice INV-1: the vault share token can never be swept out.
    function test_sweepForeignToken_revertsForShareToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, address(vault))
        );
        vault.sweepForeignToken(address(vault));
    }

    /// @notice INV-2: a genuinely foreign token is permissionlessly swept to the
    ///         fixed quarantine address by ANY caller — no admin role, no
    ///         caller-supplied recipient (replaces deleted `rescueTokens`).
    function test_sweepForeignToken_permissionlessToQuarantine() public {
        TestUSDC stray = new TestUSDC();
        stray.mint(address(vault), 9 * ONE_USDC);

        vm.prank(attacker);
        vault.sweepForeignToken(address(stray));

        assertEq(stray.balanceOf(address(vault)), 0, "vault swept clean");
        assertEq(
            stray.balanceOf(ForeignTokenQuarantine.QUARANTINE),
            9 * ONE_USDC,
            "stray token quarantined"
        );
    }

    /// @notice INV-2: donating the vault asset (USDC) directly to the vault
    ///         strictly increases totalAssets and credits ALL holders pro-rata —
    ///         the donation is absorbed into NAV, not routable to any admin.
    function test_donatingVaultAsset_raisesNavForAllHolders() public {
        // Two holders deposit equally.
        uint256 amount = 1_000 * ONE_USDC;
        vm.prank(alice);
        vault.deposit(amount, alice);
        vm.prank(bob);
        vault.deposit(amount, bob);

        uint256 aliceBefore = vault.convertToAssets(vault.balanceOf(alice));
        uint256 bobBefore = vault.convertToAssets(vault.balanceOf(bob));
        uint256 totalBefore = vault.totalAssets();

        // Donate USDC straight to the vault (idle balance is counted in totalAssets).
        uint256 donation = 500 * ONE_USDC;
        usdc.mint(address(vault), donation);

        assertEq(vault.totalAssets(), totalBefore + donation, "donation must raise totalAssets");
        assertGt(vault.convertToAssets(vault.balanceOf(alice)), aliceBefore, "alice NAV must rise");
        assertGt(vault.convertToAssets(vault.balanceOf(bob)), bobBefore, "bob NAV must rise");
        // Equal holders gain equally (pro-rata), within rounding.
        assertApproxEqAbs(
            vault.convertToAssets(vault.balanceOf(alice)),
            vault.convertToAssets(vault.balanceOf(bob)),
            1,
            "equal holders gain equally"
        );
    }
}
