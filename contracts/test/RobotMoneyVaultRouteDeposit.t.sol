// SPDX-License-Identifier: MIT
// Canonical: none — Foundry tests for contracts/RobotMoneyVault.sol `_routeDeposit`
// Covers: issue #1391 — `_targetBpsFor()` floored `MAX_BPS / active` to 3333 for a
//         three-adapter vault, so pass 1's per-adapter targets summed to 9999 bps and
//         could never absorb a whole deposit into a balanced, fully-deployed vault.
//         Pass 2 therefore ran on EVERY such deposit and re-read every adapter's
//         `totalAssets()` — the expensive read for adapters wrapping live protocols.
//         Security round 2 — a lending venue that refuses a supply (Aave supply cap or frozen
//         reserve, MetaMorpho `AllCapsReached`, Comet supply pause) no longer reverts the deposit.
//         Security round 3 — a lending venue that shuts withdrawals too (Aave reserve paused or
//         inactive, Comet withdraw pause) closes rmUSDC deposits, and its adapter reverts instead
//         of handing a slice back, so no new idle USDC pays an exit at a NAV that counts the
//         stuck balance at face.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {Proxied} from "./helpers/Proxied.sol";
import {ExclusionLedgerFactory} from "../ExclusionLedgerFactory.sol";
import {MorphoAdapter} from "../adapters/MorphoAdapter.sol";
import {AaveV3Adapter} from "../adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../adapters/CompoundV3Adapter.sol";
import {MockMorphoVault} from "./MorphoAdapter.t.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {CappedAavePool, CappedMetaMorpho, PausableComet} from "./helpers/RefusingVenues.sol";

// ─── Minimal USDC mock ───────────────────────────────────────────────────────

contract RouteUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// ─── Read-counting adapter ───────────────────────────────────────────────────

/// @dev A lossless no-yield adapter whose `totalAssets()` reads a dedicated
///      storage slot NOTHING else in the contract touches. `totalAssets()` is
///      `view`, so the vault reaches it through `STATICCALL` and it cannot
///      increment a counter itself. Instead the test brackets the call under
///      test with `vm.record()` / `vm.accesses()` and counts `SLOAD`s of
///      `probe` (slot 0) — exactly one per `totalAssets()` call.
///
///      `setProbe` exists so the slot is provably writable and the optimizer
///      cannot fold the `SLOAD` away as a known zero.
contract ReadCountingAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    /// @dev Slot 0 — read ONLY by `totalAssets()`. See `PROBE_SLOT` in the test.
    uint256 private probe;

    /// @dev Assets this adapter reports BELOW the USDC it actually holds, so a
    ///      test can model a share-priced adapter whose `convertToAssets` rounds
    ///      down (`MorphoAdapter`). `0` reports at par.
    uint256 private underReport;

    /// @dev Gas each `totalAssets()` call should burn, so a test can price the
    ///      read at what a real protocol read costs (`MetaMorpho.totalAssets()`
    ///      measures 201 145 gas). `0` keeps the adapter cheap.
    uint256 private readCostGas;

    IERC20 public immutable USDC;
    address public immutable VAULT;

    error OnlyVault();

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address usdc_, address vault_) {
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    function setProbe(uint256 probe_) external {
        probe = probe_;
    }

    function setReadCostGas(uint256 gas_) external {
        readCostGas = gas_;
    }

    function setUnderReport(uint256 dust) external {
        underReport = dust;
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256) external onlyVault {}

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 amount) external onlyVault returns (uint256 actual) {
        uint256 bal = USDC.balanceOf(address(this));
        actual = amount > bal ? bal : amount;
        if (actual > 0) USDC.safeTransfer(VAULT, actual);
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view returns (uint256) {
        uint256 cost = readCostGas;
        if (cost != 0) {
            uint256 start = gasleft();
            // `gasleft()` is a side-effecting opcode, so the optimizer cannot
            // fold this spin away.
            while (start - gasleft() < cost) {}
        }
        uint256 held = USDC.balanceOf(address(this)) + probe;
        uint256 dust = underReport;
        return held > dust ? held - dust : 0;
    }

    /// @inheritdoc IStrategyAdapter
    function sweepForeignToken(address) external {}

    /// @inheritdoc IStrategyAdapter
    function harvestRewards() external {}
}

// ─── Vault harness ───────────────────────────────────────────────────────────

/// @dev Exposes the allocator on its own so a test can count the adapter reads
///      `_routeDeposit` makes, without the surrounding `deposit()` NAV reads.
contract RouteHarness is RobotMoneyVault {
    /// @dev Call with `amount` USDC ALREADY transferred into the vault — exactly
    ///      the state `_deposit` hands `_routeDeposit`.
    function exposed_routeDeposit(uint256 amount) external {
        _routeDeposit(amount);
    }

    /// @dev Reaches `_depositAt`'s own guards directly. Through `deposit()` the
    ///      `maxDeposit` pre-check (issue #1397) rejects first, so these guards are
    ///      defence in depth that only a direct call can execute.
    function exposed_depositAt(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares,
        uint256 nav
    ) external {
        _depositAt(caller, receiver, assets, shares, nav);
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

contract RobotMoneyVaultRouteDepositTest is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant TVL_CAP = 1_000_000_000 * ONE_USDC;
    uint256 internal constant PER_DEPOSIT_CAP = 100_000_000 * ONE_USDC;
    uint256 internal constant MAX_BPS = 10_000;

    /// @dev `ReadCountingAdapter.probe` — slot 0.
    bytes32 internal constant PROBE_SLOT = bytes32(uint256(0));

    /// @dev Reads per adapter that a CORRECT `_routeDeposit` makes: one for the
    ///      `totalAssets()` NAV snapshot at the top of the function, one in
    ///      pass 1. A third read means pass 2 ran and re-read the adapter.
    uint256 internal constant READS_PER_ADAPTER_ONE_ROUND = 2;

    /// @dev `MetaMorpho.totalAssets()` measured against the committed fork
    ///      fixture (issue #1391 / PR #1394). Used to price the mock adapter's
    ///      read at what the production read actually costs.
    uint256 internal constant METAMORPHO_TOTAL_ASSETS_GAS = 201_145;

    /// @dev The devnet cap set (the stage default): 3334 / 3333 / 3333, summing to
    ///      exactly `MAX_BPS`. Reproduced verbatim so the test models the real
    ///      three-adapter vault the out-of-gas failure was observed on.
    uint16[3] internal CAPS = [uint16(3334), uint16(3333), uint16(3333)];

    RouteUSDC internal usdc;
    RouteHarness internal vault;
    ReadCountingAdapter[3] internal adapters;

    address internal admin = makeAddr("admin");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");

    event Allocated(uint256 indexed index, address indexed adapter, uint256 amount);
    event UnroutedDeposit(uint256 amount);

    function setUp() public {
        usdc = new RouteUSDC();
        vault = RouteHarness(
            Proxied.proxy(
                address(new RouteHarness()),
                Proxied.robotMoneyVaultInit(
                    IERC20(address(usdc)),
                    TVL_CAP,
                    PER_DEPOSIT_CAP,
                    0,
                    feeRecipient,
                    admin,
                    admin,
                    new ExclusionLedgerFactory()
                )
            )
        );

        for (uint256 i = 0; i < 3; i++) {
            adapters[i] = new ReadCountingAdapter(address(usdc), address(vault));
            vm.startPrank(admin);
            vault.setAdapterAllowed(address(adapters[i]), true);
            vault.setAdapterCodeHashAllowed(address(adapters[i]).codehash, true);
            vault.addAdapter(address(adapters[i]), CAPS[i]);
            vm.stopPrank();
        }

        usdc.mint(alice, 1_000_000 * ONE_USDC);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Number of `totalAssets()` calls the recorded window made against
    ///      `adapter_`, counted as `SLOAD`s of its dedicated probe slot.
    function _reads(address adapter_) internal view returns (uint256 n) {
        (bytes32[] memory slots,) = vm.accesses(adapter_);
        for (uint256 i = 0; i < slots.length; i++) {
            if (slots[i] == PROBE_SLOT) n++;
        }
    }

    /// @dev Bring the vault to the steady state the failure was observed in: a
    ///      balanced, fully-deployed three-adapter vault with no idle USDC.
    function _bootstrapBalancedVault(uint256 seed) internal {
        vm.prank(alice);
        vault.deposit(seed, alice);
        assertEq(usdc.balanceOf(address(vault)), 0, "bootstrap left idle USDC");
    }

    /// @dev Fund the vault with `amount` idle USDC and run the allocator alone.
    function _routeAlone(uint256 amount) internal {
        vm.prank(alice);
        usdc.transfer(address(vault), amount);
        vm.record();
        vault.exposed_routeDeposit(amount);
    }

    /// @dev Reproduce the committed devnet fork fixture exactly: NAV
    ///      1 050 131 553 held as 350 098 606 / 350 033 503 / 349 999 444 with no
    ///      idle USDC (PR #1394's measurements). Shares are minted by a token
    ///      deposit first, then each adapter is topped up by direct transfer so
    ///      the composition does not depend on how routing happens to split it.
    function _seedDevnetForkFixtureComposition() internal {
        uint256[3] memory fixtureBalances =
            [uint256(350_098_606), uint256(350_033_503), uint256(349_999_444)];

        vm.prank(alice);
        vault.deposit(3 * ONE_USDC, alice);
        for (uint256 i = 0; i < 3; i++) {
            uint256 held = usdc.balanceOf(address(adapters[i]));
            assertLe(held, fixtureBalances[i], "bootstrap overshot the fixture balance");
            vm.prank(alice);
            usdc.transfer(address(adapters[i]), fixtureBalances[i] - held);
        }
        assertEq(usdc.balanceOf(address(vault)), 0, "fixture setup left idle USDC");
        assertEq(vault.totalAssets(), 1_050_131_553, "fixture NAV mismatch");
    }

    function _adapterBalances() internal view returns (uint256[3] memory bals) {
        for (uint256 i = 0; i < 3; i++) {
            bals[i] = usdc.balanceOf(address(adapters[i]));
        }
    }

    // ─── The defect ──────────────────────────────────────────────────────────

    /// @notice `_routeDeposit` into a balanced, fully-deployed vault must make
    ///         exactly ONE round of adapter reads in the allocator: pass 1
    ///         places the whole deposit and pass 2 never runs.
    ///
    /// @dev RED before #1391: `_targetBpsFor()` returned `10000 / 3 == 3333`, so
    ///      the three pass-1 targets summed to 9999 bps. Pass 1 could never place
    ///      the last ~1 bps of TVL, `remaining` stayed positive, and pass 2
    ///      walked all three adapters a second time — 3 reads each, not 2.
    function test_routeDeposit_balancedVault_readsEachAdapterOnce() public {
        _bootstrapBalancedVault(3_000 * ONE_USDC);

        _routeAlone(5 * ONE_USDC);

        for (uint256 i = 0; i < 3; i++) {
            assertEq(
                _reads(address(adapters[i])),
                READS_PER_ADAPTER_ONE_ROUND,
                "pass 2 ran and re-read the adapter"
            );
        }
        assertEq(usdc.balanceOf(address(vault)), 0, "routing left idle USDC");
    }

    /// @notice One `deposit()` performs ONE whole-vault `totalAssets()` sweep
    ///         (issue #1397): 1 NAV read + 1 pass-1 read per adapter = 6 total,
    ///         down from 15 when `maxDeposit`, `previewDeposit`, the TVL-cap
    ///         guard and `_routeDeposit` each re-swept.
    function test_deposit_balancedVault_sweepsNavOnce() public {
        _bootstrapBalancedVault(3_000 * ONE_USDC);

        vm.prank(alice);
        vm.record();
        vault.deposit(5 * ONE_USDC, alice);

        uint256 reads;
        for (uint256 i = 0; i < 3; i++) {
            assertEq(_reads(address(adapters[i])), 2, "more than NAV + pass-1 read");
            reads += _reads(address(adapters[i]));
        }
        assertEq(reads, 6, "deposit swept NAV more than once");
    }

    /// @notice The cached NAV is the value each replaced call site would read:
    ///         shares equal the standalone `previewDeposit`, the TVL-cap
    ///         headroom equals `maxDeposit`, and post-transfer NAV (what
    ///         `_routeDeposit` used to re-read) equals `nav + assets`.
    function testFuzz_deposit_cachedNavEqualsEveryReplacedRead(uint256 seed, uint256 amount)
        public
    {
        seed = bound(seed, 3_000 * ONE_USDC, 50_000 * ONE_USDC);
        amount = bound(amount, 1, 50_000 * ONE_USDC);
        vm.prank(alice);
        vault.deposit(seed, alice); // rounding dust may stay idle; irrelevant here

        uint256 navBefore = vault.totalAssets();
        uint256 expectedShares = vault.previewDeposit(amount);
        assertGe(vault.maxDeposit(alice), amount, "maxDeposit below amount");
        assertEq(vault.maxDeposit(alice), _min(PER_DEPOSIT_CAP, TVL_CAP - navBefore));

        // Post-transfer NAV, exactly what `_routeDeposit` used to re-read.
        vm.prank(alice);
        usdc.transfer(address(vault), amount);
        assertEq(vault.totalAssets(), navBefore + amount, "nav + assets != post-transfer NAV");
        vm.prank(address(vault));
        usdc.transfer(alice, amount);

        vm.prank(alice);
        uint256 shares = vault.deposit(amount, alice);
        assertEq(shares, expectedShares, "share accounting changed");
    }

    // ─── deposit() guard coverage (issue #1397) ──────────────────────────────

    function _expectExceeded(uint256 assets, uint256 max) internal {
        vm.expectRevert(
            abi.encodeWithSignature(
                "ERC4626ExceededMaxDeposit(address,uint256,uint256)", alice, assets, max
            )
        );
    }

    function test_deposit_whenPaused_revertsDepositsArePaused() public {
        vm.prank(admin);
        vault.pauseDeposits();
        vm.expectRevert(RobotMoneyVault.DepositsArePaused.selector);
        vm.prank(alice);
        vault.deposit(ONE_USDC, alice);
    }

    function test_mint_whenPaused_revertsDepositsArePaused() public {
        vm.prank(admin);
        vault.pauseDeposits();
        vm.expectRevert(RobotMoneyVault.DepositsArePaused.selector);
        vm.prank(alice);
        vault.mint(ONE_USDC, alice);
    }

    function test_deposit_aboveHeadroom_revertsWithHeadroomMax() public {
        vm.startPrank(admin);
        vault.setPerDepositCap(100 * ONE_USDC);
        vault.setTvlCap(1_000 * ONE_USDC);
        vm.stopPrank();
        vm.startPrank(alice);
        for (uint256 i = 0; i < 9; i++) {
            vault.deposit(100 * ONE_USDC, alice);
        }
        vault.deposit(50 * ONE_USDC, alice);
        // 50 USDC of TVL headroom, below the 100 USDC per-deposit cap.
        _expectExceeded(51 * ONE_USDC, 50 * ONE_USDC);
        vault.deposit(51 * ONE_USDC, alice);
        vm.stopPrank();
    }

    function test_deposit_atTvlCap_revertsWithZeroMax() public {
        vm.startPrank(admin);
        vault.setPerDepositCap(100 * ONE_USDC);
        vault.setTvlCap(1_000 * ONE_USDC);
        vm.stopPrank();
        vm.startPrank(alice);
        for (uint256 i = 0; i < 10; i++) {
            vault.deposit(100 * ONE_USDC, alice);
        }
        assertEq(vault.maxDeposit(alice), 0, "headroom left at the cap");
        _expectExceeded(1, 0);
        vault.deposit(1, alice);
        vm.stopPrank();
    }

    function test_mint_routesThroughSharedDepositPath() public {
        vm.prank(alice);
        uint256 assets = vault.mint(5 * ONE_USDC, alice);
        assertEq(vault.balanceOf(alice), 5 * ONE_USDC, "shares not minted");
        assertEq(vault.totalAssets(), assets, "mint assets not counted in NAV");
        assertLe(usdc.balanceOf(address(vault)), 3, "mint left more than rounding dust idle");
    }

    function test_depositAt_whenShutdown_reverts() public {
        vm.prank(admin);
        vault.shutdownVault();
        vm.expectRevert(RobotMoneyVault.VaultShutdown.selector);
        vault.exposed_depositAt(alice, alice, ONE_USDC, ONE_USDC, 0);
    }

    function test_depositAt_whenRetired_reverts() public {
        address registry = makeAddr("registry");
        vm.prank(admin);
        vault.setRegistry(registry);
        vm.prank(registry);
        vault.retire();
        vm.expectRevert(RobotMoneyVault.VaultRetired.selector);
        vault.exposed_depositAt(alice, alice, ONE_USDC, ONE_USDC, 0);
    }

    function test_depositAt_abovePerDepositCap_reverts() public {
        vm.expectRevert(RobotMoneyVault.PerDepositCapExceeded.selector);
        vault.exposed_depositAt(alice, alice, PER_DEPOSIT_CAP + 1, 1, 0);
    }

    function test_depositAt_pushingNavPastTvlCap_reverts() public {
        vm.expectRevert(RobotMoneyVault.TVLCapExceeded.selector);
        vault.exposed_depositAt(alice, alice, ONE_USDC, ONE_USDC, TVL_CAP);
    }

    function test_depositAt_withNoActiveAdapters_reverts() public {
        vm.startPrank(admin);
        for (uint256 i = 0; i < 3; i++) {
            vault.removeAdapter(i);
        }
        vm.stopPrank();
        vm.expectRevert(RobotMoneyVault.NoActiveAdapters.selector);
        vault.exposed_depositAt(alice, alice, ONE_USDC, ONE_USDC, 0);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Pass 1 alone absorbs the entire deposit into a balanced vault: no
    ///         adapter is allocated to twice and nothing is left unrouted.
    /// @dev RED before #1391 — pass 2 allocated the 9999-vs-10000 shortfall,
    ///      producing a second `Allocated` for the first adapter with headroom.
    function test_routeDeposit_balancedVault_passOneCompletesTheFill() public {
        _bootstrapBalancedVault(3_000 * ONE_USDC);

        uint256[3] memory balancesBefore = _adapterBalances();

        vm.recordLogs();
        vm.prank(alice);
        vault.deposit(5 * ONE_USDC, alice);

        uint256 allocations;
        uint256 unrouted;
        bool[3] memory seen;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(vault)) continue;
            if (logs[i].topics[0] == Allocated.selector) {
                uint256 index = uint256(logs[i].topics[1]);
                assertFalse(seen[index], "adapter allocated to twice: pass 2 ran");
                seen[index] = true;
                allocations++;
            } else if (logs[i].topics[0] == UnroutedDeposit.selector) {
                unrouted = abi.decode(logs[i].data, (uint256));
            }
        }

        assertEq(allocations, 3, "pass 1 did not fill every adapter");
        assertEq(unrouted, 0, "deposit left USDC unrouted");
        assertEq(usdc.balanceOf(address(vault)), 0, "deposit left idle USDC in the vault");

        uint256[3] memory balancesAfter = _adapterBalances();
        uint256 moved;
        for (uint256 i = 0; i < 3; i++) {
            moved += balancesAfter[i] - balancesBefore[i];
        }
        assertEq(moved, 5 * ONE_USDC, "adapters did not receive the whole deposit");
    }

    /// @notice A deposit smaller than 1 bps of TVL is the regime in which pass 1
    ///         placed literally NOTHING before #1391: every adapter already held
    ///         at least the floored 3333 bps target, so all three `continue`d and
    ///         pass 2 did the entire job on a second round of reads.
    function test_routeDeposit_dustDeposit_isPlacedByPassOne() public {
        _bootstrapBalancedVault(3_000 * ONE_USDC);

        // 0.10 USDC against 3 000 USDC TVL is ~0.33 bps — far below the 1 bps
        // shortfall the floored target set could never close.
        uint256 dust = ONE_USDC / 10;

        vm.recordLogs();
        _routeAlone(dust);

        for (uint256 i = 0; i < 3; i++) {
            assertEq(
                _reads(address(adapters[i])),
                READS_PER_ADAPTER_ONE_ROUND,
                "pass 2 ran and re-read the adapter"
            );
        }

        uint256 allocations;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == Allocated.selector) {
                allocations++;
            }
        }
        assertGt(allocations, 0, "pass 1 placed nothing at all");
        assertEq(usdc.balanceOf(address(vault)), 0, "dust deposit left idle USDC");
    }

    /// @notice The exact devnet fork-fixture composition the out-of-gas failure
    ///         was traced on (PR #1394): NAV 1 050 131 554 with the three
    ///         adapters at 350 098 606 / 350 033 503 / 349 999 444 and the
    ///         devnet cap set, taking the same 5 USDC deposit.
    /// @dev The trace's starving frame was the SECOND `totalAssets()` on the
    ///      Morpho adapter (registry index 2), i.e. pass 2 walked all the way to
    ///      the end of the registry. This pins that pass 2 no longer runs at all.
    function test_routeDeposit_devnetForkFixtureComposition_readsOnce() public {
        _seedDevnetForkFixtureComposition();

        _routeAlone(5 * ONE_USDC);

        for (uint256 i = 0; i < 3; i++) {
            assertEq(
                _reads(address(adapters[i])),
                READS_PER_ADAPTER_ONE_ROUND,
                "pass 2 ran on the devnet fixture composition"
            );
        }

        // The devnet cap set sums to exactly MAX_BPS, so the three floored cap
        // balances add up to a couple of wei LESS than NAV. Those wei are
        // unplaceable by construction — the pre-fix implementation left the same
        // 2 wei idle after walking every adapter a second time to discover it.
        assertLe(usdc.balanceOf(address(vault)), 2, "fixture deposit left more than cap dust");
    }

    // ─── Invariants the fix must preserve ────────────────────────────────────

    /// @notice The per-adapter equal-weight targets sum to the whole NAV. Before
    ///         #1391 they summed to 9999 bps of it, leaving 1 bps permanently
    ///         un-targetable.
    /// @dev Asserted through the public drift view so the claim is about
    ///      observable contract state, not an internal helper.
    function test_targetBalances_sumToTotalAssets() public {
        _bootstrapBalancedVault(3_000 * ONE_USDC);

        (, uint256[] memory targets,) = vault.getAdapterDrift();
        uint256 sum;
        for (uint256 i = 0; i < targets.length; i++) {
            sum += targets[i];
        }

        uint256 total = vault.totalAssets();
        // Per-adapter flooring of `total * bps / MAX_BPS` can lose at most 1 wei
        // per adapter; anything more means the bps themselves do not sum to 100%.
        assertLe(sum, total, "targets sum above totalAssets");
        assertGe(sum + targets.length, total, "targets sum more than dust below totalAssets");
    }

    /// @notice No adapter may ever be pushed above its `capBps` share of NAV —
    ///         distributing the rounding remainder must go through
    ///         `min(capBps, targetBps)`, never around it.
    function test_routeDeposit_neverExceedsCapBps() public {
        _bootstrapBalancedVault(3_000 * ONE_USDC);
        vm.prank(alice);
        vault.deposit(5 * ONE_USDC, alice);

        uint256 total = vault.totalAssets();
        for (uint256 i = 0; i < 3; i++) {
            uint256 capBalance = (total * CAPS[i]) / MAX_BPS;
            assertLe(usdc.balanceOf(address(adapters[i])), capBalance, "adapter above capBps");
        }
    }

    /// @notice Fuzzed: routing any deposit into any starting composition must
    ///         never push an adapter above its `capBps` share of NAV.
    function testFuzz_routeDeposit_neverExceedsCapBps(uint256 seed, uint256 amount) public {
        seed = bound(seed, 1 * ONE_USDC, 100_000 * ONE_USDC);
        amount = bound(amount, 1, 100_000 * ONE_USDC);

        vm.prank(alice);
        vault.deposit(seed, alice);
        vm.prank(alice);
        vault.deposit(amount, alice);

        uint256 total = vault.totalAssets();
        for (uint256 i = 0; i < 3; i++) {
            assertLe(
                usdc.balanceOf(address(adapters[i])),
                (total * CAPS[i]) / MAX_BPS,
                "adapter above capBps"
            );
        }
    }

    /// @notice A tight cap still binds: when one adapter's `capBps` is below its
    ///         equal-weight share, pass 1 stops at the cap and pass 2 places the
    ///         leftover in an adapter that still has absolute headroom.
    function test_routeDeposit_tightCapBindsAndLeftoverGoesElsewhere() public {
        vm.startPrank(admin);
        vault.setAdapterCap(0, 10_000); // absorbs whatever the tight cap rejects
        vault.setAdapterCap(2, 100); // 1% cap on the last adapter
        vm.stopPrank();

        vm.prank(alice);
        vault.deposit(3_000 * ONE_USDC, alice);

        uint256 total = vault.totalAssets();
        assertLe(
            usdc.balanceOf(address(adapters[2])),
            (total * 100) / MAX_BPS,
            "capped adapter above its capBps"
        );
        assertEq(usdc.balanceOf(address(vault)), 0, "capped routing left idle USDC");
    }

    /// @notice When pass 1 allocates NOTHING and pass 2 still has to run, pass 2
    ///         reuses pass 1's reads instead of paying for a second round: only
    ///         staticcalls happened in between, so the cached values are exact
    ///         (#1391 caching remedy).
    ///
    /// @dev The rounding fix alone does not reach this state — it needs adapters
    ///      sitting ABOVE their effective target, which is what accrued interest
    ///      against a binding `capBps` produces. Modelled here by tight caps plus
    ///      a direct transfer into the adapters (the protocol-donation path).
    function test_routeDeposit_passTwoReusesPassOneReadsWhenPassOnePlacesNothing() public {
        vm.startPrank(admin);
        vault.setAdapterCap(0, 2_000);
        vault.setAdapterCap(1, 2_000);
        vault.setAdapterCap(2, 10_000);
        vm.stopPrank();

        vm.prank(alice);
        vault.deposit(3_000 * ONE_USDC, alice);
        assertEq(usdc.balanceOf(address(vault)), 0, "setup left idle USDC");

        // Push the two capped adapters above their cap share of NAV, the way
        // accrued interest does between deposits.
        vm.startPrank(alice);
        usdc.transfer(address(adapters[0]), 200 * ONE_USDC);
        usdc.transfer(address(adapters[1]), 200 * ONE_USDC);
        vm.stopPrank();

        vm.recordLogs();
        _routeAlone(5 * ONE_USDC);

        // Pass 1 must have placed nothing, or this is not the case under test.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 allocations;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == Allocated.selector) {
                allocations++;
            }
        }
        assertEq(allocations, 1, "expected exactly the pass-2 allocation");
        assertEq(usdc.balanceOf(address(vault)), 0, "pass 2 did not place the deposit");

        for (uint256 i = 0; i < 3; i++) {
            assertEq(
                _reads(address(adapters[i])),
                READS_PER_ADAPTER_ONE_ROUND,
                "pass 2 re-read an adapter instead of reusing pass 1's read"
            );
        }
    }

    /// @notice The cache is NOT used once pass 1 has allocated: a cached balance
    ///         would then be a modelled value, and pass 2's `capBps` headroom
    ///         check must only ever be computed from a real read.
    function test_routeDeposit_passTwoRereadsAfterPassOneAllocated() public {
        // A binding middle cap is what makes pass 2 run at all once the targets
        // sum to MAX_BPS: pass 1's deficits then no longer cover the deposit.
        vm.startPrank(admin);
        vault.setAdapterCap(0, 10_000);
        vault.setAdapterCap(1, 1_000);
        vault.setAdapterCap(2, 10_000);
        vm.stopPrank();

        vm.prank(alice);
        vault.deposit(3_000 * ONE_USDC, alice);
        assertEq(usdc.balanceOf(address(vault)), 0, "setup left idle USDC");

        // Adapter 0 absorbed the capped adapter's share in pass 2 above, so it
        // now sits over its equal-weight target and pass 1 will skip it — while
        // adapters 1 and 2 still take allocations.
        _routeAlone(500 * ONE_USDC);

        assertEq(
            _reads(address(adapters[0])),
            READS_PER_ADAPTER_ONE_ROUND + 1,
            "pass 2 reused a cached read after pass 1 allocated"
        );
        uint256 total = vault.totalAssets();
        assertLe(
            usdc.balanceOf(address(adapters[1])),
            (total * 1_000) / MAX_BPS,
            "capped adapter above its capBps"
        );
    }

    /// @notice A share-priced adapter reports back slightly less than was
    ///         deployed into it, so pass 1's cap-headroom score under-states the
    ///         real headroom by that dust and pass 2 is skipped. The dust stays
    ///         idle rather than costing a second full round of adapter reads.
    ///
    /// @dev This is the unit-test twin of
    ///      `VaultForkRegressions.test_fork_unroutedDeposit_emitsEventAndStaysIdle`,
    ///      where pass 2's entire contribution to a cap-bound deposit was ONE wei.
    ///      Pinned here so the trade does not depend on fork CI to stay honest.
    function test_routeDeposit_shareRoundingDustStaysIdleRatherThanCostingASecondRound() public {
        vm.startPrank(admin);
        vault.setAdapterCap(0, 5_000);
        vault.removeAdapter(1);
        vault.removeAdapter(2);
        vm.stopPrank();

        // Model MetaMorpho: report one wei less than was deployed.
        adapters[0].setUnderReport(1);

        uint256 depositAmt = 100_000 * ONE_USDC;

        vm.recordLogs();
        _routeAlone(depositAmt);

        // Half the deposit is over the 5000 bps cap and stays idle, plus the one
        // wei of share-rounding dust pass 2 would have placed.
        assertEq(usdc.balanceOf(address(vault)), depositAmt / 2, "unexpected idle balance");

        // Pass 2 did not run: one round of reads only.
        assertEq(
            _reads(address(adapters[0])),
            READS_PER_ADAPTER_ONE_ROUND,
            "pass 2 ran to place share-rounding dust"
        );

        // The cap is still respected against the adapter's REAL reported assets.
        uint256 total = vault.totalAssets();
        assertLe(adapters[0].totalAssets(), (total * 5_000) / MAX_BPS, "adapter above its capBps");

        uint256 unrouted;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == UnroutedDeposit.selector)
            {
                unrouted = abi.decode(logs[i].data, (uint256));
            }
        }
        assertEq(unrouted, depositAmt / 2, "UnroutedDeposit must report the idle USDC");
    }

    // ─── Morpho exposure cap (security round 1, QA plan D8 follow-up) ────────

    /// @notice The production rmUSDC set (Aave 3334, Compound 3333, Morpho 3333 bps,
    ///         `DeployVault.s.sol`) with a Morpho `maxExposure` below Morpho's equal-weight
    ///         target. A deposit succeeds, Morpho stays at its cap, Aave and Compound take their
    ///         full slices, and what no adapter can take stays idle in NAV with
    ///         `UnroutedDeposit`. Raise another adapter's `capBps` and the next deposit routes
    ///         around Morpho into it. Before the fix pass 1 handed Morpho its whole third,
    ///         `MorphoAdapter._deposit` reverted `ExposureCapExceeded`, and so did every
    ///         deposit, every keeper `rebalance` and every router deposit with an rmUSDC leg.
    function test_maxExposureBelowTargetRoutesAroundMorpho() public {
        RouteHarness v = RouteHarness(
            Proxied.proxy(
                address(new RouteHarness()),
                Proxied.robotMoneyVaultInit(
                    IERC20(address(usdc)),
                    TVL_CAP,
                    PER_DEPOSIT_CAP,
                    0,
                    feeRecipient,
                    admin,
                    admin,
                    new ExclusionLedgerFactory()
                )
            )
        );
        ReadCountingAdapter aave = new ReadCountingAdapter(address(usdc), address(v));
        ReadCountingAdapter compound = new ReadCountingAdapter(address(usdc), address(v));
        MorphoAdapter morpho = new MorphoAdapter(
            address(new MockMorphoVault(address(usdc))), address(usdc), address(v)
        );
        address[3] memory set = [address(aave), address(compound), address(morpho)];
        uint256 cap = 100 * ONE_USDC;
        vm.startPrank(admin);
        for (uint256 i = 0; i < 3; i++) {
            v.setAdapterAllowed(set[i], true);
            v.setAdapterCodeHashAllowed(set[i].codehash, true);
            v.addAdapter(set[i], CAPS[i]);
        }
        v.setAdapterMaxExposure(2, cap);
        vm.stopPrank();
        vm.prank(alice);
        usdc.approve(address(v), type(uint256).max);

        // 3 000 in: Morpho's equal-weight slice is 999.9; the cap allows 100.
        uint256 amount = 3_000 * ONE_USDC;
        uint256 aaveSlice = (amount * CAPS[0]) / MAX_BPS;
        uint256 compoundSlice = (amount * (CAPS[0] + CAPS[1])) / MAX_BPS - aaveSlice;
        uint256 unplaced = amount - aaveSlice - compoundSlice - cap;
        vm.expectEmit(false, false, false, true, address(v));
        emit UnroutedDeposit(unplaced);
        vm.prank(alice);
        uint256 shares = v.deposit(amount, alice);
        assertGt(shares, 0, "the deposit succeeds");
        assertEq(morpho.totalAssets(), cap, "Morpho stays at its exposure cap");
        assertEq(usdc.balanceOf(address(aave)), aaveSlice, "Aave takes its slice");
        assertEq(usdc.balanceOf(address(compound)), compoundSlice, "Compound takes its slice");
        assertEq(usdc.balanceOf(address(v)), unplaced, "the rest stays idle");
        assertEq(v.totalAssets(), amount, "idle USDC stays in NAV");

        // With room at Aave, the next deposit routes around Morpho into it.
        vm.prank(admin);
        v.setAdapterCap(0, 10_000);
        uint256 aaveBefore = usdc.balanceOf(address(aave));
        vm.prank(alice);
        v.deposit(1_000 * ONE_USDC, alice);
        assertEq(morpho.totalAssets(), cap, "Morpho still at its cap");
        assertEq(usdc.balanceOf(address(v)), unplaced, "the new deposit is fully placed");
        assertGt(usdc.balanceOf(address(aave)), aaveBefore, "Aave absorbs Morpho's share");
    }

    // ─── A lending venue that refuses a supply (security round 2) ────────────

    /// @dev The production rmUSDC set on the real lending adapters, over venues that can refuse.
    struct VenueSet {
        RouteHarness v;
        AaveV3Adapter aave;
        CompoundV3Adapter compound;
        MorphoAdapter morpho;
        CappedAavePool pool;
        PausableComet comet;
        CappedMetaMorpho metaMorpho;
    }

    /// @dev Aave 3334, Compound 3333, Morpho 3333 bps (`DeployVault.s.sol`), with the Aave
    ///      reserve's remaining supply-cap room and MetaMorpho's remaining cap room as given.
    function _venueSet(uint256 aaveHeadroom, uint256 morphoHeadroom)
        internal
        returns (VenueSet memory s)
    {
        s.v = RouteHarness(
            Proxied.proxy(
                address(new RouteHarness()),
                Proxied.robotMoneyVaultInit(
                    IERC20(address(usdc)),
                    TVL_CAP,
                    PER_DEPOSIT_CAP,
                    0,
                    feeRecipient,
                    admin,
                    admin,
                    new ExclusionLedgerFactory()
                )
            )
        );
        TestERC20 aToken = new TestERC20();
        s.pool = new CappedAavePool(address(usdc), address(aToken), aaveHeadroom);
        s.comet = new PausableComet(address(usdc));
        s.metaMorpho = new CappedMetaMorpho(address(usdc), morphoHeadroom);
        s.aave = new AaveV3Adapter(address(s.pool), address(usdc), address(aToken), address(s.v));
        s.compound = new CompoundV3Adapter(address(s.comet), address(usdc), address(s.v));
        s.morpho = new MorphoAdapter(address(s.metaMorpho), address(usdc), address(s.v));
        address[3] memory set = [address(s.aave), address(s.compound), address(s.morpho)];
        vm.startPrank(admin);
        for (uint256 i = 0; i < 3; i++) {
            s.v.setAdapterAllowed(set[i], true);
            s.v.setAdapterCodeHashAllowed(set[i].codehash, true);
            s.v.addAdapter(set[i], CAPS[i]);
        }
        vm.stopPrank();
        vm.prank(alice);
        usdc.approve(address(s.v), type(uint256).max);
    }

    /// @notice Security round 2. Aave's USDC reserve has 100 USDC of supply-cap room left and
    ///         every MetaMorpho market cap is full. A 3 000 USDC deposit succeeds: Aave's slice
    ///         (above the room) and Morpho's slice come straight back from the adapters
    ///         (`DeployRefused`), Compound takes its slice, and the two refused slices stay idle
    ///         in NAV with `UnroutedDeposit`. Raise Compound's `capBps` and the next deposit
    ///         routes around both full venues into Compound. Before the fix `AaveV3Adapter.deploy`
    ///         reverted "51" (`SUPPLY_CAP_EXCEEDED`), and so did every rmUSDC deposit, every
    ///         router deposit with an rmUSDC leg and keeper `rebalance`.
    function test_venueRefusesSupply_depositSucceedsAndRefusedSlicesStayIdle() public {
        VenueSet memory s = _venueSet(100 * ONE_USDC, 0);
        uint256 amount = 3_000 * ONE_USDC;
        uint256 aaveSlice = (amount * CAPS[0]) / MAX_BPS;
        uint256 compoundSlice = (amount * (CAPS[0] + CAPS[1])) / MAX_BPS - aaveSlice;
        uint256 morphoSlice = amount - aaveSlice - compoundSlice;
        assertGt(aaveSlice, s.pool.headroom(), "Aave's slice is above its supply-cap room");
        assertEq(s.metaMorpho.maxDeposit(address(s.morpho)), 0, "MetaMorpho: all caps reached");

        vm.expectEmit(true, true, true, true, address(s.aave));
        emit AaveV3Adapter.DeployRefused(aaveSlice, abi.encodeWithSignature("Error(string)", "51"));
        vm.expectEmit(true, true, true, true, address(s.v));
        emit Allocated(1, address(s.compound), compoundSlice);
        vm.expectEmit(true, true, true, true, address(s.morpho));
        emit MorphoAdapter.DeployRefused(
            morphoSlice, abi.encodeWithSelector(CappedMetaMorpho.AllCapsReached.selector)
        );
        vm.expectEmit(true, true, true, true, address(s.v));
        emit UnroutedDeposit(aaveSlice + morphoSlice);
        vm.prank(alice);
        uint256 shares = s.v.deposit(amount, alice);

        assertGt(shares, 0, "the deposit succeeds");
        assertEq(s.aave.totalAssets(), 0, "Aave holds nothing");
        assertEq(s.morpho.totalAssets(), 0, "Morpho holds nothing");
        assertEq(s.compound.totalAssets(), compoundSlice, "Compound takes its slice");
        assertEq(usdc.balanceOf(address(s.v)), aaveSlice + morphoSlice, "refused slices idle");
        assertEq(usdc.balanceOf(address(s.aave)), 0, "no USDC stranded on the Aave adapter");
        assertEq(usdc.balanceOf(address(s.morpho)), 0, "no USDC stranded on the Morpho adapter");
        assertEq(usdc.allowance(address(s.aave), address(s.pool)), 0, "no Aave allowance left");
        assertEq(
            usdc.allowance(address(s.morpho), address(s.metaMorpho)), 0, "no Morpho allowance left"
        );
        assertEq(s.v.totalAssets(), amount, "the idle USDC stays in NAV");
        assertEq(s.v.convertToAssets(shares), amount, "the depositor is not diluted");

        // With room at Compound, the next deposit routes around both full venues into it.
        vm.prank(admin);
        s.v.setAdapterCap(1, 10_000);
        uint256 idleBefore = usdc.balanceOf(address(s.v));
        uint256 compoundBefore = s.compound.totalAssets();
        vm.prank(alice);
        s.v.deposit(1_000 * ONE_USDC, alice);
        assertEq(usdc.balanceOf(address(s.v)), idleBefore, "the new deposit is fully placed");
        assertEq(
            s.compound.totalAssets() - compoundBefore, 1_000 * ONE_USDC, "Compound absorbs it all"
        );
        assertEq(s.aave.totalAssets(), 0, "the full Aave reserve was not asked twice");
    }

    /// @notice Security round 2. Every venue refuses at once: the Aave reserve is frozen, Comet's
    ///         supply is paused and MetaMorpho is full. A deposit still succeeds with its whole
    ///         amount idle, and keeper `rebalance` runs instead of reverting. Once the venues
    ///         accept again, the next `rebalance` places the idle USDC.
    function test_venueRefusesSupply_keeperRebalanceDoesNotRevert() public {
        VenueSet memory s = _venueSet(type(uint128).max, type(uint128).max);
        vm.prank(alice);
        s.v.deposit(3_000 * ONE_USDC, alice);
        assertEq(usdc.balanceOf(address(s.v)), 0, "open venues take the whole deposit");

        // The vault is balanced, so each adapter's deficit is its slice of the new 300 USDC.
        s.pool.setFrozen(true);
        s.comet.setSupplyPaused(true);
        s.metaMorpho.setHeadroom(0);
        uint256 aaveDeficit = (300 * ONE_USDC * CAPS[0]) / MAX_BPS;
        uint256 compoundDeficit = (300 * ONE_USDC * (CAPS[0] + CAPS[1])) / MAX_BPS - aaveDeficit;
        vm.expectEmit(true, true, true, true, address(s.aave));
        emit AaveV3Adapter.DeployRefused(
            aaveDeficit, abi.encodeWithSignature("Error(string)", "28")
        );
        vm.expectEmit(true, true, true, true, address(s.compound));
        emit CompoundV3Adapter.DeployRefused(
            compoundDeficit, abi.encodeWithSelector(PausableComet.Paused.selector)
        );
        vm.expectEmit(true, true, true, true, address(s.v));
        emit UnroutedDeposit(300 * ONE_USDC);
        vm.prank(alice);
        s.v.deposit(300 * ONE_USDC, alice);
        assertEq(usdc.balanceOf(address(s.v)), 300 * ONE_USDC, "the whole deposit stays idle");

        vm.warp(block.timestamp + s.v.minRebalanceInterval() + 1);
        vm.prank(admin);
        s.v.rebalance();
        assertEq(usdc.balanceOf(address(s.v)), 300 * ONE_USDC, "rebalance leaves it idle");
        assertEq(s.v.totalAssets(), 3_300 * ONE_USDC, "NAV intact");

        s.pool.setFrozen(false);
        s.comet.setSupplyPaused(false);
        s.metaMorpho.setHeadroom(type(uint128).max);
        vm.warp(block.timestamp + s.v.minRebalanceInterval() + 1);
        vm.prank(admin);
        s.v.rebalance();
        assertEq(usdc.balanceOf(address(s.v)), 0, "the next rebalance places the idle USDC");
        assertEq(s.v.totalAssets(), 3_300 * ONE_USDC, "NAV intact");
    }

    // ─── A lending venue that shuts withdrawals too (security round 3) ───────

    /// @notice Security round 3. rmUSDC holds Aave, Compound and Morpho at equal weight, and
    ///         Aave's guardian pauses the USDC reserve: supply and withdraw both revert "29"
    ///         (`RESERVE_PAUSED`) while the aToken balance still counts at face in NAV. rmUSDC's
    ///         `maxDeposit` and `maxMint` read 0, so a deposit reverts and no new USDC sits idle
    ///         to pay a redeem at that NAV. Before the fix the Aave adapter handed its slice back,
    ///         the deposit minted at a NAV counting the paused balance, and the idle slice paid an
    ///         informed holder's redeem at par while a later haircut fell on the holders who
    ///         stayed (FS-VLT-8). An inactive reserve and a Comet withdraw pause close deposits
    ///         the same way. A frozen reserve and a Comet supply-only pause still pay withdrawals
    ///         and keep deposits open (round 2 hand-back). Deposits reopen with the venue.
    function test_venueShutsWithdrawals_depositsCloseAndNoIdleFundsParExit() public {
        VenueSet memory s = _venueSet(type(uint128).max, type(uint128).max);
        vm.prank(alice);
        s.v.deposit(3_000 * ONE_USDC, alice);
        assertEq(usdc.balanceOf(address(s.v)), 0, "open venues take the whole deposit");
        uint256 aaveHeld = s.aave.totalAssets();
        assertGt(aaveHeld, 0, "Aave holds its slice");

        s.pool.setPaused(true);
        assertFalse(s.aave.venueWithdrawable(), "Aave reports its withdrawals shut");
        assertEq(s.v.totalAssets(), 3_000 * ONE_USDC, "NAV still counts the paused aToken balance");
        assertEq(s.v.maxDeposit(alice), 0, "deposits close");
        assertEq(s.v.maxMint(alice), 0, "mints close");

        uint256 amount = 300 * ONE_USDC;
        uint256 walletBefore = usdc.balanceOf(alice);
        vm.expectRevert(
            abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, alice, amount, 0)
        );
        vm.prank(alice);
        s.v.deposit(amount, alice);
        assertEq(usdc.balanceOf(alice), walletBefore, "the depositor keeps the USDC");
        assertEq(usdc.balanceOf(address(s.v)), 0, "no idle USDC to pay an exit at par");
        assertEq(s.aave.totalAssets(), aaveHeld, "the paused balance is untouched");

        // With no idle, a redeem needs Aave's pro-rata part, which the paused reserve refuses.
        // The exit waits for `emergencyExcludeAdapter` (exclude first, FS-VLT-8), not for idle.
        uint256 someShares = s.v.balanceOf(alice) / 10;
        vm.expectRevert(bytes("29"));
        vm.prank(alice);
        s.v.redeem(someShares, alice, alice);

        s.pool.setPaused(false);
        assertEq(s.v.maxDeposit(alice), PER_DEPOSIT_CAP, "deposits reopen with the reserve");

        s.pool.setInactive(true);
        assertFalse(s.aave.venueWithdrawable(), "an inactive reserve refuses withdrawals");
        assertEq(s.v.maxDeposit(alice), 0, "an inactive reserve closes deposits");
        s.pool.setInactive(false);

        s.pool.setFrozen(true);
        assertTrue(s.aave.venueWithdrawable(), "a frozen reserve still pays withdrawals");
        assertEq(s.v.maxDeposit(alice), PER_DEPOSIT_CAP, "a frozen reserve keeps deposits open");
        s.pool.setFrozen(false);

        s.comet.setSupplyPaused(true);
        assertTrue(s.compound.venueWithdrawable(), "a supply-only pause leaves withdrawals open");
        assertEq(s.v.maxDeposit(alice), PER_DEPOSIT_CAP, "a supply-only pause keeps deposits open");
        s.comet.setWithdrawPaused(true);
        assertFalse(s.compound.venueWithdrawable(), "Comet reports isWithdrawPaused");
        assertEq(s.v.maxDeposit(alice), 0, "a Comet withdraw pause closes deposits");
        s.comet.setSupplyPaused(false);
        s.comet.setWithdrawPaused(false);

        vm.prank(alice);
        s.v.deposit(amount, alice);
        assertEq(s.v.totalAssets(), 3_000 * ONE_USDC + amount, "the deposit lands once reopened");
    }

    /// @notice Security round 3. Compound is overweight and Aave underweight when Aave's reserve
    ///         is paused. A keeper `rebalance` pulls Compound's excess into idle and offers it to
    ///         the Aave adapter, which now reverts `VenueWithdrawalsClosed` instead of handing it
    ///         back, so the rebalance reverts and no healthy-venue USDC turns into idle that pays
    ///         exits at a NAV counting the paused balance. Before the fix the slice came back and
    ///         stayed idle. A Comet whose supply and withdraw are both paused reverts the same way.
    function test_venueShutsWithdrawals_adapterRevertsSoRebalanceIdlesNothing() public {
        VenueSet memory s = _venueSet(type(uint128).max, type(uint128).max);
        vm.prank(alice);
        s.v.deposit(3_000 * ONE_USDC, alice);
        // A frozen reserve hands Aave's slice of the next deposit back, and with Compound's
        // `capBps` at 100 percent pass 2 spills it into Compound.
        vm.prank(admin);
        s.v.setAdapterCap(1, 10_000);
        s.pool.setFrozen(true);
        vm.prank(alice);
        s.v.deposit(3_000 * ONE_USDC, alice);
        s.pool.setFrozen(false);
        assertEq(usdc.balanceOf(address(s.v)), 0, "nothing idle");
        uint256 aaveHeld = s.aave.totalAssets();
        uint256 compoundHeld = s.compound.totalAssets();
        uint256 equalSlice = s.v.totalAssets() / 3;
        assertLt(aaveHeld, equalSlice, "Aave is underweight");
        assertGt(compoundHeld, equalSlice, "Compound is overweight");

        s.pool.setPaused(true);
        vm.warp(block.timestamp + s.v.minRebalanceInterval() + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                AaveV3Adapter.VenueWithdrawalsClosed.selector,
                abi.encodeWithSignature("Error(string)", "29")
            )
        );
        vm.prank(admin);
        s.v.rebalance();
        assertEq(usdc.balanceOf(address(s.v)), 0, "the rebalance left nothing idle");
        assertEq(s.compound.totalAssets(), compoundHeld, "Compound keeps its balance");
        assertEq(s.aave.totalAssets(), aaveHeld, "the paused balance is untouched");

        s.comet.setSupplyPaused(true);
        s.comet.setWithdrawPaused(true);
        usdc.mint(address(s.compound), ONE_USDC);
        vm.expectRevert(
            abi.encodeWithSelector(
                CompoundV3Adapter.VenueWithdrawalsClosed.selector,
                abi.encodeWithSelector(PausableComet.Paused.selector)
            )
        );
        vm.prank(address(s.v));
        s.compound.deploy(ONE_USDC);
    }

    // ─── Recorded gas for the ordinary balanced-vault deposit path ───────────

    /// @notice Not an assertion — records the headline number for #1391: gas for
    ///         one ordinary deposit into a balanced, fully-deployed three-adapter
    ///         vault, plus the adapter `totalAssets()` reads it pays for.
    function test_gas_balancedVaultDeposit() public {
        _bootstrapBalancedVault(3_000 * ONE_USDC);

        vm.prank(alice);
        vm.record();
        uint256 gasBefore = gasleft();
        vault.deposit(5 * ONE_USDC, alice);
        uint256 gasUsed = gasBefore - gasleft();

        uint256 reads;
        for (uint256 i = 0; i < 3; i++) {
            reads += _reads(address(adapters[i]));
        }

        console2.log("balanced-vault deposit gas", gasUsed);
        console2.log("balanced-vault deposit adapter totalAssets() reads", reads);
    }

    /// @notice Not an assertion — the same ordinary balanced-vault deposit with
    ///         each adapter's `totalAssets()` priced at the 201 145 gas
    ///         `MetaMorpho.totalAssets()` measures on the committed fork fixture,
    ///         so the recorded number reflects the production deposit path rather
    ///         than a free mock read.
    function test_gas_balancedVaultDeposit_realisticAdapterReadCost() public {
        _bootstrapBalancedVault(3_000 * ONE_USDC);

        for (uint256 i = 0; i < 3; i++) {
            adapters[i].setReadCostGas(METAMORPHO_TOTAL_ASSETS_GAS);
        }

        vm.prank(alice);
        uint256 gasBefore = gasleft();
        vault.deposit(5 * ONE_USDC, alice);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("balanced-vault deposit gas (adapter reads priced at 201145)", gasUsed);
    }

    /// @notice Not an assertion — the headline number for #1391: the 5 USDC
    ///         deposit into the EXACT devnet fork-fixture composition, with each
    ///         adapter read priced at the 201 145 gas `MetaMorpho.totalAssets()`
    ///         measures. This is the composition whose pass-2 Morpho read starved
    ///         under EIP-150 and produced the dapp-e2e out-of-gas.
    function test_gas_devnetForkFixtureDeposit_realisticAdapterReadCost() public {
        _seedDevnetForkFixtureComposition();

        for (uint256 i = 0; i < 3; i++) {
            adapters[i].setReadCostGas(METAMORPHO_TOTAL_ASSETS_GAS);
        }

        vm.prank(alice);
        vm.record();
        uint256 gasBefore = gasleft();
        vault.deposit(5 * ONE_USDC, alice);
        uint256 gasUsed = gasBefore - gasleft();

        uint256 reads;
        for (uint256 i = 0; i < 3; i++) {
            reads += _reads(address(adapters[i]));
        }

        console2.log("devnet-fixture deposit gas (reads priced at 201145)", gasUsed);
        console2.log("devnet-fixture deposit adapter totalAssets() reads", reads);
    }
}
