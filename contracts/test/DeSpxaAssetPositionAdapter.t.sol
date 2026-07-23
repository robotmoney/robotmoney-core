// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0006-despxa-rwa-vault-design.md — deSPXA asset, Chronicle
//              oracle, Aerodrome swap-only entry/exit, freeze risk;
//            docs/adr/ADR-0010-unified-vault-architecture.md §4 (AssetPositionAdapter);
//            docs/technical/unified-vault-spec.md §4.3, §4.4 (Chronicle variant).
//
// Tests for the Chronicle-priced IPositionAdapter — DeSpxaAssetPositionAdapter (#1126):
//   * DeSpxaChronicleAdapterTest — mock-vault + mock-venue + mock-Chronicle harness
//     proving onlyVault deploy/withdraw, the minValueOut / composed-floor
//     SlippageExceeded reverts, Chronicle-priced totalAssets(), the SUP-5
//     zero-balance short-circuit, and the heartbeat-staleness fail-closed gate
//     (StalePriceFeed) on deploy/withdraw/totalAssets.
//   * DeSpxaFreezeSafeTest — an ERC-20 fixture that reverts real transfers while
//     "frozen" (modeling deSPXA issuer freeze-control risk, ADR-0006 §3) proving
//     totalAssets() keeps reporting a safe, correct NAV mark while frozen (never
//     bricked — it never attempts a transfer) while deploy/withdraw fail closed
//     (bubbling the frozen-transfer revert) without corrupting adapter state.
//
// Test plan:
//   - forge test --match-contract DeSpxaChronicleAdapterTest
//   - forge test --match-contract DeSpxaFreezeSafeTest
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {IChronicleOracle} from "../interfaces/IChronicleOracle.sol";
import {DeSpxaAssetPositionAdapter} from "../adapters/DeSpxaAssetPositionAdapter.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures (uniquely named to avoid forge-doc re-linking collisions).
// ─────────────────────────────────────────────────────────────────────────────

/// @dev 18-decimal ERC-20 stand-in for deSPXA. TEST FIXTURE.
contract DeSpxaPositionMockToken18 is ERC20 {
    constructor() ERC20("Mock deSPXA", "mDESPXA") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev deSPXA stand-in that reverts real (non-mint/non-burn) transfers while
///      `frozen`, modeling the issuer freeze-control risk in ADR-0006 §3. Mint
///      and burn (from/to == address(0)) are always allowed so test setup can
///      fund balances even while frozen. TEST FIXTURE.
contract DeSpxaFreezableToken18 is ERC20 {
    bool public frozen;

    error TransfersFrozen();

    constructor() ERC20("Freezable deSPXA", "fDESPXA") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFrozen(bool frozen_) external {
        frozen = frozen_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (frozen && from != address(0) && to != address(0)) revert TransfersFrozen();
        super._update(from, to, value);
    }
}

/// @dev Mock Chronicle oracle: independently settable price and timestamp.
contract DeSpxaPositionMockChronicle is IChronicleOracle {
    uint256 public price;
    uint256 public timestamp;

    constructor(uint256 price_, uint256 timestamp_) {
        price = price_;
        timestamp = timestamp_;
    }

    function setPrice(uint256 price_) external {
        price = price_;
    }

    function setTimestamp(uint256 timestamp_) external {
        timestamp = timestamp_;
    }

    function latestAnswer() external view returns (uint256) {
        return price;
    }

    function latestTimestamp() external view returns (uint256) {
        return timestamp;
    }
}

/// @dev Minimal vault harness: answers `hasRole(ADMIN_ROLE, .)` for the adapter's
///      onlyVaultAdmin setters and relays deploy/withdraw as the bound VAULT
///      (msg.sender == this) after funding the adapter with USDC. TEST FIXTURE.
contract DeSpxaPositionMockVault {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    mapping(bytes32 => mapping(address => bool)) internal _roles;

    function grantRole(bytes32 role, address account) external {
        _roles[role][account] = true;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    /// @dev Mirror the vault choreography: transfer USDC to the adapter first,
    ///      then call deploy (spec §2.2, same as v1 `_allocateTo`).
    function callDeploy(
        DeSpxaAssetPositionAdapter adapter,
        IERC20 usdc,
        uint256 usdcIn,
        uint256 minValueOut
    ) external returns (uint256) {
        usdc.safeTransfer(address(adapter), usdcIn);
        return adapter.deploy(usdcIn, minValueOut);
    }

    function callWithdraw(
        DeSpxaAssetPositionAdapter adapter,
        uint256 usdcWanted,
        uint256 minUsdcOut
    ) external returns (uint256) {
        return adapter.withdraw(usdcWanted, minUsdcOut);
    }
}

/// @dev Deterministic IBasketSwapAdapter mock standing in for a
///      `ChronicleOracleAdapter`-shaped venue: a fixed-price USDC<->TOKEN venue
///      with a configurable execution-slippage haircut. `pool`/`window` are
///      accepted but ignored (Chronicle pricing is pool- and epoch-independent,
///      matching the real `ChronicleOracleAdapter.twapPrice`). Pre-funded with
///      both tokens. TEST FIXTURE.
contract DeSpxaPositionMockVenue is IBasketSwapAdapter {
    using SafeERC20 for IERC20;

    /// @dev USDC (6-dec) per 1e18 whole TOKEN — mirrors a 5 USD Chronicle NAV mark.
    uint256 public constant PRICE = 5e6;
    uint256 internal constant BPS = 10_000;

    address public immutable USDC;
    address public immutable TOKEN;

    uint256 public venueSlippageBps;

    error VenueMinOut(uint256 got, uint256 want);
    error BadPair();

    constructor(address usdc_, address token_) {
        USDC = usdc_;
        TOKEN = token_;
    }

    function setVenueSlippageBps(uint256 bps) external {
        venueSlippageBps = bps;
    }

    function _quote(address base, address quote, uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        if (base == USDC && quote == TOKEN) return amount * 1e18 / PRICE;
        if (base == TOKEN && quote == USDC) return amount * PRICE / 1e18;
        revert BadPair();
    }

    function twapPrice(address, address base, address quote, uint256 amount, uint32)
        external
        view
        returns (uint256)
    {
        return _quote(base, quote, amount);
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint24,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256
    ) external returns (uint256 amountOut) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = _quote(tokenIn, tokenOut, amountIn) * (BPS - venueSlippageBps) / BPS;
        if (amountOut < minAmountOut) revert VenueMinOut(amountOut, minAmountOut);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DeSpxaChronicleAdapterTest — heartbeat staleness + in-window pricing.
// ─────────────────────────────────────────────────────────────────────────────

contract DeSpxaChronicleAdapterTest is Test {
    TestERC20 internal usdc; // 6-dec
    DeSpxaPositionMockToken18 internal token; // 18-dec
    DeSpxaPositionMockChronicle internal chronicle;
    DeSpxaPositionMockVenue internal venue;
    DeSpxaPositionMockVault internal vault;
    DeSpxaAssetPositionAdapter internal adapter;

    uint256 internal constant ONE_USDC = 1e6;
    address internal admin = makeAddr("admin");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        // Warp well past the default heartbeat so `chronicle.timestamp` (created
        // at 0) can be considered "fresh" once the constructor sets it to `now`,
        // without underflowing when tests want to age it into the past.
        vm.warp(10 * 365 days);

        usdc = new TestERC20();
        token = new DeSpxaPositionMockToken18();
        chronicle = new DeSpxaPositionMockChronicle(5e18, block.timestamp);
        venue = new DeSpxaPositionMockVenue(address(usdc), address(token));
        vault = new DeSpxaPositionMockVault();
        vault.grantRole(vault.ADMIN_ROLE(), admin);

        adapter = new DeSpxaAssetPositionAdapter(
            address(usdc), address(vault), address(token), address(chronicle), address(venue)
        );

        // Fund the venue reserves (it pays out both legs) and the vault (deploys).
        usdc.mint(address(venue), 100_000_000 * ONE_USDC);
        token.mint(address(venue), 100_000 ether);
        usdc.mint(address(vault), 10_000_000 * ONE_USDC);
    }

    // ── Identity + exactness ────────────────────────────────────────────────

    function test_identityViews_constructorBound() public view {
        assertEq(adapter.USDC(), address(usdc));
        assertEq(adapter.VAULT(), address(vault));
        assertEq(adapter.TOKEN(), address(token));
        assertEq(address(adapter.CHRONICLE()), address(chronicle));
        assertEq(address(adapter.SWAP_ADAPTER()), address(venue));
    }

    function test_isExact_isFalse() public view {
        assertFalse(adapter.isExact());
    }

    function test_oracleHeartbeat_defaultsToDefaultHeartbeat() public view {
        assertEq(adapter.oracleHeartbeat(), adapter.DEFAULT_HEARTBEAT());
    }

    // ── totalAssets: SUP-5 zero-balance short-circuit ───────────────────────

    function test_totalAssets_zeroBalanceReturnsZeroWithoutOracleRead() public {
        // Age the feed far beyond any heartbeat — if totalAssets() touched the
        // oracle on a zero balance it would revert StalePriceFeed here. It must
        // not: SUP-5 short-circuits before the freshness check.
        chronicle.setTimestamp(0);
        assertEq(adapter.totalAssets(), 0);
    }

    // ── totalAssets: heartbeat staleness (AC #1) ────────────────────────────

    function test_totalAssets_pricesCorrectlyWithinHeartbeat() public {
        vault.callDeploy(adapter, IERC20(address(usdc)), 1_000 * ONE_USDC, 0);
        assertApproxEqAbs(adapter.totalAssets(), 1_000 * ONE_USDC, 1);
    }

    function test_totalAssets_revertsWhenChroniclePriceOlderThanHeartbeat() public {
        vault.callDeploy(adapter, IERC20(address(usdc)), 1_000 * ONE_USDC, 0);

        uint256 heartbeat = adapter.oracleHeartbeat();
        // Age the feed to exactly the boundary: still fresh.
        chronicle.setTimestamp(block.timestamp - heartbeat);
        adapter.totalAssets(); // must not revert

        // One second past the heartbeat ⇒ stale ⇒ reverts, never silently used.
        chronicle.setTimestamp(block.timestamp - heartbeat - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeSpxaAssetPositionAdapter.StalePriceFeed.selector,
                block.timestamp - heartbeat - 1,
                heartbeat
            )
        );
        adapter.totalAssets();
    }

    // ── deploy ──────────────────────────────────────────────────────────────

    function test_deploy_custodiesTokenAndCreditsRealizedValue() public {
        uint256 usdcIn = 1_000 * ONE_USDC;
        uint256 valueAdded =
            vault.callDeploy(adapter, IERC20(address(usdc)), usdcIn, (usdcIn * 99) / 100);

        // No execution slippage ⇒ realized value == usdcIn, token custodied.
        assertEq(valueAdded, usdcIn, "valueAdded should equal usdcIn at zero slippage");
        assertGt(token.balanceOf(address(adapter)), 0, "adapter must custody the token");
        assertEq(usdc.balanceOf(address(adapter)), 0, "no idle USDC left after swap");
        assertApproxEqAbs(adapter.totalAssets(), usdcIn, 1, "totalAssets ~ deposited USDC");
    }

    function test_deploy_onlyVault() public {
        vm.prank(attacker);
        vm.expectRevert(IPositionAdapter.OnlyVault.selector);
        adapter.deploy(1_000 * ONE_USDC, 0);
    }

    function test_deploy_revertsWhenValueBelowMinValueOut() public {
        // 0.1% execution slippage — below the adapter's default 0.5%
        // maxSlippageBps floor (so the venue's own amountOutMinimum is met and
        // the swap itself succeeds) but realized value is still < usdcIn ⇒ the
        // ADAPTER's own composed-floor check reverts SlippageExceeded when
        // minValueOut == usdcIn (no clamp on the deploy path).
        venue.setVenueSlippageBps(10);
        uint256 usdcIn = 1_000 * ONE_USDC;
        vm.expectRevert(IPositionAdapter.SlippageExceeded.selector);
        vault.callDeploy(adapter, IERC20(address(usdc)), usdcIn, usdcIn);
    }

    function test_deploy_revertsWhenChroniclePriceStale() public {
        uint256 heartbeat = adapter.oracleHeartbeat();
        chronicle.setTimestamp(block.timestamp - heartbeat - 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                DeSpxaAssetPositionAdapter.StalePriceFeed.selector,
                block.timestamp - heartbeat - 1,
                heartbeat
            )
        );
        vault.callDeploy(adapter, IERC20(address(usdc)), 1_000 * ONE_USDC, 0);
    }

    // ── withdraw ────────────────────────────────────────────────────────────

    function test_withdraw_deliversUsdcToVault() public {
        uint256 usdcIn = 1_000 * ONE_USDC;
        vault.callDeploy(adapter, IERC20(address(usdc)), usdcIn, 0);

        uint256 vaultBefore = usdc.balanceOf(address(vault));
        uint256 out = vault.callWithdraw(adapter, type(uint256).max, 0); // withdraw all

        assertApproxEqAbs(out, usdcIn, 1, "round-trip returns ~ deposited USDC");
        assertEq(usdc.balanceOf(address(vault)) - vaultBefore, out, "vault credited exactly out");
        assertEq(token.balanceOf(address(adapter)), 0, "all token liquidated");
    }

    function test_withdraw_onlyVault() public {
        vm.prank(attacker);
        vm.expectRevert(IPositionAdapter.OnlyVault.selector);
        adapter.withdraw(1_000 * ONE_USDC, 0);
    }

    function test_withdraw_revertsBelowComposedFloor() public {
        uint256 usdcIn = 1_000 * ONE_USDC;
        vault.callDeploy(adapter, IERC20(address(usdc)), usdcIn, 0);

        // minUsdcOut above the achievable realized amount ⇒ SlippageExceeded
        // (composed floor = max(minUsdcOut, internalFloor)).
        vm.expectRevert(IPositionAdapter.SlippageExceeded.selector);
        vault.callWithdraw(adapter, usdcIn, usdcIn * 2);
    }

    function test_withdraw_clampsShortfallAboveFloor() public {
        uint256 usdcIn = 1_000 * ONE_USDC;
        vault.callDeploy(adapter, IERC20(address(usdc)), usdcIn, 0);

        // Ask for far more than custody holds; minUsdcOut = 0 ⇒ clamp at balance,
        // return realized (no revert).
        uint256 out = vault.callWithdraw(adapter, 1_000_000 * ONE_USDC, 0);
        assertApproxEqAbs(out, usdcIn, 1, "clamps at liquidatable balance");
    }

    function test_withdraw_revertsWhenChroniclePriceStale() public {
        uint256 usdcIn = 1_000 * ONE_USDC;
        vault.callDeploy(adapter, IERC20(address(usdc)), usdcIn, 0);

        uint256 heartbeat = adapter.oracleHeartbeat();
        chronicle.setTimestamp(block.timestamp - heartbeat - 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                DeSpxaAssetPositionAdapter.StalePriceFeed.selector,
                block.timestamp - heartbeat - 1,
                heartbeat
            )
        );
        vault.callWithdraw(adapter, type(uint256).max, 0);
    }

    function test_withdraw_zeroBalanceReturnsZeroWithoutOracleRead() public {
        // No custody yet, and the feed is stale — proves the zero-balance
        // short-circuit runs BEFORE the freshness check on withdraw too.
        chronicle.setTimestamp(0);
        uint256 out = vault.callWithdraw(adapter, type(uint256).max, 0);
        assertEq(out, 0);
    }

    // ── Config setter authority + bounds ────────────────────────────────────

    function test_setters_onlyVaultAdmin() public {
        vm.startPrank(attacker);
        vm.expectRevert(DeSpxaAssetPositionAdapter.OnlyVaultAdmin.selector);
        adapter.setMaxSlippageBps(100);
        vm.expectRevert(DeSpxaAssetPositionAdapter.OnlyVaultAdmin.selector);
        adapter.setOracleHeartbeat(12 hours);
        vm.stopPrank();
    }

    function test_setMaxSlippageBps_ceilingEnforced() public {
        uint256 aboveCeiling = adapter.MAX_SLIPPAGE_BPS() + 1;
        vm.prank(admin);
        vm.expectRevert(DeSpxaAssetPositionAdapter.InvalidParam.selector);
        adapter.setMaxSlippageBps(aboveCeiling);
    }

    function test_setOracleHeartbeat_boundsEnforced() public {
        uint256 belowMin = adapter.MIN_HEARTBEAT() - 1;
        uint256 aboveMax = adapter.MAX_HEARTBEAT() + 1;
        vm.startPrank(admin);
        vm.expectRevert(DeSpxaAssetPositionAdapter.InvalidParam.selector);
        adapter.setOracleHeartbeat(belowMin);
        vm.expectRevert(DeSpxaAssetPositionAdapter.InvalidParam.selector);
        adapter.setOracleHeartbeat(aboveMax);
        vm.stopPrank();
    }

    function test_setOracleHeartbeat_updatesEffectiveWindow() public {
        vm.prank(admin);
        adapter.setOracleHeartbeat(2 hours);
        assertEq(adapter.oracleHeartbeat(), 2 hours);

        vault.callDeploy(adapter, IERC20(address(usdc)), 1_000 * ONE_USDC, 0);
        chronicle.setTimestamp(block.timestamp - 2 hours - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeSpxaAssetPositionAdapter.StalePriceFeed.selector,
                block.timestamp - 2 hours - 1,
                uint256(2 hours)
            )
        );
        adapter.totalAssets();
    }

    // ── INV-1 / INV-2 custody quarantine ────────────────────────────────────

    function test_harvestRewards_isNoOpAndNeverReverts() public {
        adapter.harvestRewards(); // permissionless, must not revert
    }

    function test_sweepForeignToken_revertsForProtectedUsdcAndToken() public {
        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, address(usdc))
        );
        adapter.sweepForeignToken(address(usdc));

        vm.expectRevert(
            abi.encodeWithSelector(ForeignTokenQuarantine.TokenIsProtected.selector, address(token))
        );
        adapter.sweepForeignToken(address(token));
    }

    function test_sweepForeignToken_quarantinesForeignToken() public {
        DeSpxaPositionMockToken18 foreign = new DeSpxaPositionMockToken18();
        foreign.mint(address(adapter), 5 ether);

        adapter.sweepForeignToken(address(foreign)); // permissionless
        assertEq(foreign.balanceOf(ForeignTokenQuarantine.QUARANTINE), 5 ether);
        assertEq(foreign.balanceOf(address(adapter)), 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DeSpxaFreezeSafeTest — deSPXA issuer freeze-control risk (ADR-0006 §3).
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Freeze-aware IBasketSwapAdapter mock: identical pricing/execution to
///      `DeSpxaPositionMockVenue` but works against the freezable TOKEN fixture.
///      Its `swap` legitimately reverts (bubbling `TransfersFrozen`) when either
///      leg moves the frozen token — this IS the expected fail-closed behavior
///      the freeze test asserts on `deploy`/`withdraw`. TEST FIXTURE.
contract DeSpxaFreezeMockVenue is IBasketSwapAdapter {
    using SafeERC20 for IERC20;

    uint256 public constant PRICE = 5e6; // USDC (6-dec) per 1e18 whole TOKEN

    address public immutable USDC;
    address public immutable TOKEN;

    error BadPair();

    constructor(address usdc_, address token_) {
        USDC = usdc_;
        TOKEN = token_;
    }

    function _quote(address base, address quote, uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        if (base == USDC && quote == TOKEN) return amount * 1e18 / PRICE;
        if (base == TOKEN && quote == USDC) return amount * PRICE / 1e18;
        revert BadPair();
    }

    function twapPrice(address, address base, address quote, uint256 amount, uint32)
        external
        view
        returns (uint256)
    {
        return _quote(base, quote, amount);
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint24,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256
    ) external returns (uint256 amountOut) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = _quote(tokenIn, tokenOut, amountIn);
        require(amountOut >= minAmountOut, "venue min out");
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }
}

contract DeSpxaFreezeSafeTest is Test {
    TestERC20 internal usdc; // 6-dec
    DeSpxaFreezableToken18 internal token; // 18-dec, freeze-aware
    DeSpxaPositionMockChronicle internal chronicle;
    DeSpxaFreezeMockVenue internal venue;
    DeSpxaPositionMockVault internal vault;
    DeSpxaAssetPositionAdapter internal adapter;

    uint256 internal constant ONE_USDC = 1e6;

    function setUp() public {
        vm.warp(10 * 365 days);

        usdc = new TestERC20();
        token = new DeSpxaFreezableToken18();
        chronicle = new DeSpxaPositionMockChronicle(5e18, block.timestamp);
        venue = new DeSpxaFreezeMockVenue(address(usdc), address(token));
        vault = new DeSpxaPositionMockVault();

        adapter = new DeSpxaAssetPositionAdapter(
            address(usdc), address(vault), address(token), address(chronicle), address(venue)
        );

        usdc.mint(address(venue), 100_000_000 * ONE_USDC);
        token.mint(address(venue), 100_000 ether);
        usdc.mint(address(vault), 10_000_000 * ONE_USDC);

        // Custody a position while unfrozen, before any freeze test begins.
        vault.callDeploy(adapter, IERC20(address(usdc)), 1_000 * ONE_USDC, 0);
    }

    // ── totalAssets never bricks under a freeze ─────────────────────────────

    function test_totalAssets_reportsSafeValueWhileFrozen() public {
        uint256 taBeforeFreeze = adapter.totalAssets();
        assertGt(taBeforeFreeze, 0);

        token.setFrozen(true);

        // Balance + Chronicle price are unaffected by a transfer freeze — the
        // read is a pure balanceOf + view oracle call, never a transfer.
        uint256 taWhileFrozen = adapter.totalAssets();
        assertEq(taWhileFrozen, taBeforeFreeze, "NAV mark unchanged and not bricked while frozen");
    }

    function test_totalAssets_zeroBalanceStillSafeWhileFrozen() public {
        // A frozen adapter holding no position at all must also never brick.
        DeSpxaFreezableToken18 emptyToken = new DeSpxaFreezableToken18();
        DeSpxaFreezeMockVenue emptyVenue =
            new DeSpxaFreezeMockVenue(address(usdc), address(emptyToken));
        DeSpxaAssetPositionAdapter emptyAdapter = new DeSpxaAssetPositionAdapter(
            address(usdc),
            address(vault),
            address(emptyToken),
            address(chronicle),
            address(emptyVenue)
        );
        emptyToken.setFrozen(true);
        assertEq(emptyAdapter.totalAssets(), 0);
    }

    // ── deploy/withdraw fail closed while frozen, without corrupting state ──

    function test_deploy_revertsWhileFrozenButTotalAssetsSurvives() public {
        token.setFrozen(true);

        vm.expectRevert(DeSpxaFreezableToken18.TransfersFrozen.selector);
        vault.callDeploy(adapter, IERC20(address(usdc)), 1_000 * ONE_USDC, 0);

        // The failed attempt must not corrupt custody accounting — NAV is still
        // safely reportable immediately after.
        assertGt(adapter.totalAssets(), 0, "totalAssets still reports safely after a failed deploy");
    }

    function test_withdraw_revertsWhileFrozenButTotalAssetsSurvives() public {
        uint256 taBefore = adapter.totalAssets();
        token.setFrozen(true);

        vm.expectRevert(DeSpxaFreezableToken18.TransfersFrozen.selector);
        vault.callWithdraw(adapter, type(uint256).max, 0);

        assertEq(
            adapter.totalAssets(),
            taBefore,
            "totalAssets unchanged and safe after a failed withdraw"
        );
        assertGt(token.balanceOf(address(adapter)), 0, "custody untouched by the reverted withdraw");
    }

    function test_withdraw_succeedsAfterFreezeIsLifted() public {
        token.setFrozen(true);
        vm.expectRevert(DeSpxaFreezableToken18.TransfersFrozen.selector);
        vault.callWithdraw(adapter, type(uint256).max, 0);

        token.setFrozen(false);
        uint256 out = vault.callWithdraw(adapter, type(uint256).max, 0);
        assertGt(out, 0, "withdraw succeeds once the freeze is lifted");
        assertEq(token.balanceOf(address(adapter)), 0, "all token liquidated post-unfreeze");
    }
}
