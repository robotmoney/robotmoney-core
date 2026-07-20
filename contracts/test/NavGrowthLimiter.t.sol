// SPDX-License-Identifier: MIT
// Canonical: docs/technical/unified-vault-spec.md §4.3a (residual vault-side
//            price sanity check), §5 (Unified `Vault`),
//            docs/technical/unified-vault-open-questions-resolution.md (the
//            GLOBAL aggregate NAV-growth-rate limiter decision),
//            docs/adr/ADR-0010-unified-vault-architecture.md.
//
// Behaviour tests for the #1120 GLOBAL NAV-growth-rate limiter on
// `contracts/Vault.sol` — the single vault-wide, adapter-INDEPENDENT residual
// price check that gates DEPOSITS only (§4.3a). They assert:
//   * an implausible aggregate-NAV jump reverts a deposit closed
//     (`NavGrowthRateExceeded`);
//   * normal/expected growth within the per-elapsed-time budget is ALLOWED, and
//     a longer gap widens the budget (the rate scales with elapsed time);
//   * the limiter NEVER gates redemptions — a spike that blocks a deposit still
//     lets an owner redeem in the identical state;
//   * the checkpoint is a SINGLE vault-wide slot advanced to the post-deposit
//     aggregate NAV on every deposit;
//   * governance/config surface (`maxNavGrowthRateBps` construction guard +
//     `setMaxNavGrowthRateBps` role-gated setter).
//
// These run in the default `forge test` CI job (the always-on unit suite), so
// the diff is EXECUTED with a non-zero test count — no external resource, no
// skip. Contract/mock names are UNIQUE (no forge-doc re-link collisions).
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Vault} from "../Vault.sol";
import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Mis-marking `IPositionAdapter` test fixture: it custodies real USDC 1:1
///      but its self-reported `totalAssets()` is `heldUSDC + phantomMark`, where
///      `phantomMark` is a test lever (`setPhantomMark`) that inflates the
///      adapter's mark with NO backing USDC — exactly the ORA-6/F-17
///      over-mark/mis-scale class the §4.3a limiter defends against. Attested
///      INEXACT so redemptions take the no-revert `_sellProportional` path;
///      `withdraw` delivers what it actually holds and NEVER reverts on the floor
///      (a mis-marking adapter cannot realize its inflated mark — the honest
///      shortfall, not a fault). UNIQUE name to avoid forge-doc re-link.
contract MarkSpikeAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;

    address public immutable USDC;
    address public immutable VAULT;
    uint256 public phantomMark; // adapter-reported mark with no backing USDC
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

    /// @notice TEST LEVER: inflate the adapter's self-reported NAV without any
    ///         backing USDC, simulating an over-mark / mis-scale bug.
    function setPhantomMark(uint256 mark) external {
        phantomMark = mark;
    }

    function deploy(uint256 usdcIn, uint256 minValueOut)
        external
        onlyVault
        returns (uint256 valueAdded)
    {
        valueAdded = usdcIn; // marked at par on entry
        if (valueAdded < minValueOut) revert SlippageExceeded();
    }

    function withdraw(
        uint256 usdcWanted,
        uint256 /*minUsdcOut*/
    )
        external
        onlyVault
        returns (uint256 usdcOut)
    {
        // No-revert realize: deliver at most what is actually held. A mis-marking
        // adapter realizes below its inflated mark; it does NOT revert the floor.
        uint256 bal = IERC20(USDC).balanceOf(address(this));
        usdcOut = usdcWanted > bal ? bal : usdcWanted;
        IERC20(USDC).safeTransfer(VAULT, usdcOut);
    }

    function totalAssets() external view returns (uint256) {
        return IERC20(USDC).balanceOf(address(this)) + phantomMark;
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

/// @dev Suite for the global NAV-growth-rate limiter (§4.3a). One vault, one
///      mis-marking adapter, an explicit `maxNavGrowthRateBps` chosen so the
///      per-hour budget is easy to reason about.
contract NavGrowthLimiterTest is Test {
    using SafeERC20 for IERC20;

    TestERC20 internal usdc;
    Vault internal vault;
    MarkSpikeAdapter internal adapter;

    address internal admin = makeAddr("admin");
    address internal emergency = makeAddr("emergency");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal outsider = makeAddr("outsider");

    uint256 internal constant ONE_USDC = 1_000_000; // 6-decimal
    uint256 internal constant MAX_BPS = 10_000;
    uint256 internal constant MAX_SLIPPAGE_BPS = 200; // 2%
    // 100 bps (1%) of the checkpoint NAV allowed to grow per HOUR
    // (`NAV_GROWTH_RATE_PERIOD == 1 hours`). The budget scales linearly with
    // elapsed time, so 1h ⇒ 100 bps, 50h ⇒ 5000 bps.
    uint256 internal constant RATE_BPS_PER_HOUR = 100;

    function setUp() public {
        usdc = new TestERC20();
        vault = new Vault(
            IERC20(address(usdc)),
            "Robot Money USDC",
            "rmUSDC",
            type(uint256).max, // tvlCap
            type(uint256).max, // perDepositCap
            0, // exitFeeBps — isolate the limiter
            MAX_SLIPPAGE_BPS,
            RATE_BPS_PER_HOUR, // maxNavGrowthRateBps
            feeRecipient,
            admin,
            emergency
        );

        adapter = new MarkSpikeAdapter(address(usdc), address(vault));
        vm.startPrank(admin);
        vault.setAdapterAllowed(address(adapter), true);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAdapter(address(adapter), uint16(MAX_BPS), false); // attested INEXACT
        vm.stopPrank();
    }

    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        usdc.mint(who, assets);
        vm.startPrank(who);
        usdc.approve(address(vault), assets);
        shares = vault.deposit(assets, who);
        vm.stopPrank();
    }

    // ── AC: implausible aggregate-NAV jump reverts a deposit closed ──────────

    function test_deposit_revertsOnImplausibleNavJump() public {
        // Alice's first deposit bootstraps the single checkpoint (no gating).
        _deposit(alice, 1_000 * ONE_USDC);
        assertEq(vault.lastNavCheckpoint(), 1_000 * ONE_USDC, "checkpoint bootstrapped to NAV");

        // One hour later the budget is 1% of 1000 USDC = 10 USDC of allowed growth.
        vm.warp(block.timestamp + 1 hours);

        // The adapter over-marks by 500 USDC (a 50% aggregate jump) — far beyond
        // the 1%/hour budget. The next deposit must FAIL CLOSED.
        adapter.setPhantomMark(500 * ONE_USDC);

        usdc.mint(bob, 100 * ONE_USDC);
        vm.startPrank(bob);
        usdc.approve(address(vault), 100 * ONE_USDC);
        vm.expectRevert(
            abi.encodeWithSelector(
                Vault.NavGrowthRateExceeded.selector,
                1_500 * ONE_USDC, // observed pre-deposit aggregate NAV
                1_000 * ONE_USDC, // checkpoint NAV
                uint256(1 hours) // elapsed
            )
        );
        vault.deposit(100 * ONE_USDC, bob);
        vm.stopPrank();

        // Fail-closed: no shares minted, checkpoint untouched (deposit reverted).
        assertEq(vault.balanceOf(bob), 0, "no shares minted on a blocked deposit");
        assertEq(vault.lastNavCheckpoint(), 1_000 * ONE_USDC, "checkpoint not advanced on revert");
    }

    // ── AC: normal/expected growth within the budget is ALLOWED ──────────────

    function test_deposit_allowsGrowthWithinBudget() public {
        _deposit(alice, 1_000 * ONE_USDC);

        // One hour ⇒ 1% budget (10 USDC). A 5 USDC over-mark (0.5%) is within it.
        vm.warp(block.timestamp + 1 hours);
        adapter.setPhantomMark(5 * ONE_USDC);

        uint256 shares = _deposit(bob, 100 * ONE_USDC);
        assertGt(shares, 0, "within-budget deposit mints");
        // Checkpoint advanced to the post-deposit aggregate NAV.
        assertEq(vault.lastNavCheckpoint(), vault.totalAssets(), "checkpoint == post-deposit NAV");
    }

    /// @notice The budget scales with elapsed time: the SAME 50% jump that reverts
    ///         after 1 hour is ALLOWED once enough time has passed (50h ⇒ 5000 bps
    ///         budget ≥ the 5000 bps jump). Demonstrates the rate is per-time.
    function test_deposit_longerElapsedWidensBudget() public {
        _deposit(alice, 1_000 * ONE_USDC);

        vm.warp(block.timestamp + 50 hours); // budget = 100 * 50 = 5000 bps
        adapter.setPhantomMark(500 * ONE_USDC); // exactly a 5000 bps jump

        uint256 shares = _deposit(bob, 100 * ONE_USDC);
        assertGt(shares, 0, "the same jump is allowed once the budget widens");
    }

    // ── AC: the limiter NEVER gates redemptions ──────────────────────────────

    function test_redeem_isNeverGatedByLimiter() public {
        uint256 aliceShares = _deposit(alice, 1_000 * ONE_USDC);

        vm.warp(block.timestamp + 1 hours);
        // A jump large enough to block ANY deposit in this state.
        adapter.setPhantomMark(10_000 * ONE_USDC);

        // Sanity: a deposit IS blocked here (proves the spike is limiter-tripping).
        usdc.mint(bob, 100 * ONE_USDC);
        vm.startPrank(bob);
        usdc.approve(address(vault), 100 * ONE_USDC);
        vm.expectRevert(
            abi.encodeWithSelector(
                Vault.NavGrowthRateExceeded.selector,
                11_000 * ONE_USDC,
                1_000 * ONE_USDC,
                uint256(1 hours)
            )
        );
        vault.deposit(100 * ONE_USDC, bob);
        vm.stopPrank();

        // In the IDENTICAL spiked state, redemption is NOT gated: Alice redeems
        // her full position and receives the real USDC (the phantom mark is not
        // realizable, but the exit path never reverts on the limiter).
        uint256 checkpointBefore = vault.lastNavCheckpoint();
        vm.prank(alice);
        uint256 got = vault.redeem(aliceShares, alice, alice);

        assertGt(got, 0, "redeem realizes proceeds despite the spike");
        assertEq(usdc.balanceOf(alice), got, "receiver funded");
        // Redemptions do NOT touch the deposit-only checkpoint.
        assertEq(vault.lastNavCheckpoint(), checkpointBefore, "redeem leaves checkpoint untouched");
    }

    // ── AC: single vault-wide checkpoint advanced on every deposit ───────────

    function test_checkpoint_isSingleSlotUpdatedPerDeposit() public {
        // Bootstrap.
        _deposit(alice, 1_000 * ONE_USDC);
        uint256 t1 = block.timestamp;
        assertEq(vault.lastNavCheckpoint(), 1_000 * ONE_USDC, "slot after 1st deposit");
        assertEq(vault.lastNavCheckpointTime(), t1, "timestamp after 1st deposit");

        // A second deposit advances the SAME slot to the new aggregate NAV.
        vm.warp(block.timestamp + 1 hours);
        _deposit(bob, 500 * ONE_USDC);
        assertEq(vault.lastNavCheckpoint(), vault.totalAssets(), "slot advanced to new NAV");
        assertEq(vault.lastNavCheckpointTime(), block.timestamp, "timestamp advanced");
        assertEq(vault.lastNavCheckpoint(), 1_500 * ONE_USDC, "aggregate, not per-adapter");
    }

    // ── Config / governance surface ──────────────────────────────────────────

    function test_constructor_rejectsZeroRate() public {
        vm.expectRevert(Vault.InvalidParam.selector);
        new Vault(
            IERC20(address(usdc)),
            "Robot Money USDC",
            "rmUSDC",
            type(uint256).max,
            type(uint256).max,
            0,
            MAX_SLIPPAGE_BPS,
            0, // zero rate — rejected
            feeRecipient,
            admin,
            emergency
        );
    }

    function test_setMaxNavGrowthRateBps_roleGatedAndRejectsZero() public {
        // Non-admin cannot change it.
        vm.prank(outsider);
        vm.expectRevert();
        vault.setMaxNavGrowthRateBps(500);

        // Admin can; zero is rejected.
        vm.startPrank(admin);
        vm.expectRevert(Vault.InvalidParam.selector);
        vault.setMaxNavGrowthRateBps(0);

        vault.setMaxNavGrowthRateBps(500);
        assertEq(vault.maxNavGrowthRateBps(), 500, "rate updated by admin");
        vm.stopPrank();
    }

    /// @notice Loosening the rate via the setter lets a previously-blocked deposit
    ///         through — the setter is wired into the live gate.
    function test_setter_loosensTheGate() public {
        _deposit(alice, 1_000 * ONE_USDC);
        vm.warp(block.timestamp + 1 hours);
        adapter.setPhantomMark(500 * ONE_USDC); // 5000 bps jump, blocked at 100 bps/h

        // Raise the per-hour budget above the jump.
        vm.prank(admin);
        vault.setMaxNavGrowthRateBps(6_000); // 6000 bps/h > 5000 bps jump

        uint256 shares = _deposit(bob, 100 * ONE_USDC);
        assertGt(shares, 0, "loosened rate admits the deposit");
    }
}
