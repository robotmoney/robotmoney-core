// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0010-unified-vault-architecture.md §4 (AssetPositionAdapter);
//            docs/technical/unified-vault-spec.md §4.3, §4.5 (M-S6).
//
// Tests for the Uniswap V4 AssetPositionAdapter (#1124), the V4 sibling of the
// Uniswap V3 adapter (#1118, contracts/test/UniswapV3AssetPositionAdapter.t.sol):
//   * UniV4AssetPositionAdapterTest — mock-vault + mock-venue harness proving
//     onlyVault deploy/withdraw, the minValueOut / composed-floor SlippageExceeded
//     reverts, TWAP-window-threaded totalAssets(), the ORA-4 NAV-deviation guard,
//     the M-S6 `hooks == address(0)` construction assertion, and the INV-1/INV-2
//     sweep/harvest quarantine rules. Runs everywhere (no RPC).
//   * UniV4AssetPositionAdapterForkTest — Base-mainnet fork (pinnable via the
//     FORK_BLOCK env var; defaults to latest, matching UniV3AssetPositionAdapterForkTest
//     and VaultForkRegressions) exercising a full deploy/withdraw round-trip
//     against REAL Base-mainnet USDC (`deal`d balances, genuine ERC-20 6-decimal
//     token) through the concrete `UniswapV4SwapAdapter` venue seam. Unlike the
//     V3 fork sibling, this test cannot route through a genuinely deployed
//     third-party Uniswap V4 pool: official Uniswap v4-core keeps all pools as
//     entries inside the singleton PoolManager (keyed by PoolId/PoolKey), not as
//     standalone contracts exposing `token0()/observe()/slot0()/liquidity()` the
//     way this repo's `IUniswapV4Pool`/`IUniswapV4SwapRouter` seam models them —
//     a documented architecture gap (docs/code-review/20260623-code-review-
//     testmachine-azimuth.md, "Uniswap V4 TWAP path assumes non-existent
//     observable pool contracts", info-severity, not in #1124's scope to
//     redesign: #1124 scopes OUT "V4 hook support" and reuses the existing
//     UniswapV4SwapAdapter machinery verbatim). So this fork test deploys the
//     SAME mock V4 router/pool harness as the demo four-vault suite
//     (DeployDemoExtraVaults.t.sol's JUNO/V4 stub) fresh on the fork, paired
//     with genuine forked Base USDC — the real-world surface that matters for
//     this adapter (SafeERC20 semantics against the live USDC bytecode) is
//     exercised for real; the DEX mechanics are necessarily still a harness,
//     same as they are for every other V4-venue test in this repo. LOUD-SKIP:
//     setUp reverts when no fork RPC is configured (never a silent skip) — wired
//     into the CI fork job with FORK_RPC_URL set from the `vars.RMPC_FORK_RPC_URL`
//     repo variable (public-RPC fallback), matching UniV3AssetPositionAdapterForkTest.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {IUniswapV4SwapRouter} from "../interfaces/IUniswapV4SwapRouter.sol";
import {UniswapV4AssetPositionAdapter} from "../adapters/UniswapV4AssetPositionAdapter.sol";
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures (uniquely named to avoid forge-doc re-linking collisions).
// ─────────────────────────────────────────────────────────────────────────────

/// @dev 18-decimal ERC-20 stand-in for a basket token (e.g. JUNO). TEST FIXTURE.
contract UniV4PositionMockToken18 is ERC20 {
    constructor() ERC20("Mock Token 18", "mTKN18") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Minimal vault harness: answers `hasRole(ADMIN_ROLE, .)` for the adapter's
///      onlyVaultAdmin setters and relays deploy/withdraw as the bound VAULT
///      (msg.sender == this) after funding the adapter with USDC. TEST FIXTURE.
contract UniV4PositionMockVault {
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
        UniswapV4AssetPositionAdapter adapter,
        IERC20 usdc,
        uint256 usdcIn,
        uint256 minValueOut
    ) external returns (uint256) {
        usdc.safeTransfer(address(adapter), usdcIn);
        return adapter.deploy(usdcIn, minValueOut);
    }

    function callWithdraw(
        UniswapV4AssetPositionAdapter adapter,
        uint256 usdcWanted,
        uint256 minUsdcOut
    ) external returns (uint256) {
        return adapter.withdraw(usdcWanted, minUsdcOut);
    }
}

/// @dev Deterministic IBasketSwapAdapter mock: a fixed-price USDC<->TOKEN venue
///      with a configurable execution-slippage haircut and an optional
///      expected-window assertion (to prove the adapter threads the configured
///      TWAP window into pricing). Pre-funded with both tokens. TEST FIXTURE.
contract UniV4PositionMockVenue is IBasketSwapAdapter {
    using SafeERC20 for IERC20;

    /// @dev USDC (6-dec) per 1e18 whole TOKEN.
    uint256 public constant PRICE = 2000e6;
    uint256 internal constant BPS = 10_000;

    address public immutable USDC;
    address public immutable TOKEN;

    uint256 public venueSlippageBps;
    uint32 public expectedWindow;

    error WrongWindow(uint32 got, uint32 want);
    error VenueMinOut(uint256 got, uint256 want);
    error BadPair();

    constructor(address usdc_, address token_) {
        USDC = usdc_;
        TOKEN = token_;
    }

    function setVenueSlippageBps(uint256 bps) external {
        venueSlippageBps = bps;
    }

    function setExpectedWindow(uint32 window) external {
        expectedWindow = window;
    }

    function _quote(address base, address quote, uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        if (base == USDC && quote == TOKEN) return amount * 1e18 / PRICE;
        if (base == TOKEN && quote == USDC) return amount * PRICE / 1e18;
        revert BadPair();
    }

    function twapPrice(address, address base, address quote, uint256 amount, uint32 window)
        external
        view
        returns (uint256)
    {
        if (expectedWindow != 0 && window != expectedWindow) {
            revert WrongWindow(window, expectedWindow);
        }
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

/// @dev Duck-typed Uniswap V4 pool for the constructor pool-usability check and
///      the ORA-4 NAV-deviation guard. `spotTick` (slot0) and `meanTickVal`
///      (observe cumulatives) are independently settable to synthesize a
///      spot-vs-TWAP divergence. Same shape as `UniV3PositionMockPool` — V4
///      pools expose the identical EIP-7680 `observe()` ABI. TEST FIXTURE.
contract UniV4PositionMockPool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint128 public liquidity = 1e18;
    uint16 public cardinality = 2;
    int24 public spotTick;
    int24 public meanTickVal;

    constructor(address a, address b, uint24 fee_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
    }

    function setSpotTick(int24 t) external {
        spotTick = t;
    }

    function setMeanTick(int24 t) external {
        meanTickVal = t;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1) << 96, spotTick, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidity)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidity = new uint160[](secondsAgos.length);
        uint32 window = secondsAgos[0];
        // tc[0] at `window` ago = 0; tc[1] at now = meanTick * window ⇒ mean = meanTick.
        if (secondsAgos.length > 1) {
            tickCumulatives[1] = int56(meanTickVal) * int56(uint56(window));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock-vault + mock-venue harness (runs everywhere).
// ─────────────────────────────────────────────────────────────────────────────

contract UniV4AssetPositionAdapterTest is Test {
    TestERC20 internal usdc; // 6-dec
    UniV4PositionMockToken18 internal token; // 18-dec
    UniV4PositionMockVenue internal venue;
    UniV4PositionMockPool internal pool;
    UniV4PositionMockVault internal vault;
    UniswapV4AssetPositionAdapter internal adapter;

    uint24 internal constant FEE = 3000;
    uint256 internal constant ONE_USDC = 1e6;
    address internal admin = makeAddr("admin");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        usdc = new TestERC20();
        token = new UniV4PositionMockToken18();
        venue = new UniV4PositionMockVenue(address(usdc), address(token));
        pool = new UniV4PositionMockPool(address(token), address(usdc), FEE);
        vault = new UniV4PositionMockVault();
        vault.grantRole(vault.ADMIN_ROLE(), admin);

        adapter = new UniswapV4AssetPositionAdapter(
            address(usdc),
            address(vault),
            address(token),
            address(pool),
            FEE,
            address(0), // hooks: M-S6 requires address(0)
            address(venue)
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
        assertEq(adapter.POOL(), address(pool));
        assertEq(adapter.SWAP_FEE(), FEE);
        assertEq(adapter.HOOKS(), address(0));
        assertEq(address(adapter.SWAP_ADAPTER()), address(venue));
    }

    function test_isExact_isFalse() public view {
        assertFalse(adapter.isExact());
    }

    function test_effectiveTwapWindow_defaultsWhenUnset() public view {
        assertEq(adapter.effectiveTwapWindow(), adapter.DEFAULT_TWAP_WINDOW());
    }

    function test_totalAssets_zeroBalanceReturnsZeroWithoutOracle() public {
        // No custody yet: SUP-5 short-circuit. `expectedWindow` set so any oracle
        // read would revert — proving totalAssets() does NOT touch it on 0 balance.
        venue.setExpectedWindow(9_999);
        assertEq(adapter.totalAssets(), 0);
    }

    // ── M-S6: hooks == address(0) construction assertion ────────────────────

    function test_constructor_revertsWhenHooksNonZero() public {
        address hooks = makeAddr("hookContract");
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4AssetPositionAdapter.HookedPoolNotSupported.selector, hooks
            )
        );
        new UniswapV4AssetPositionAdapter(
            address(usdc), address(vault), address(token), address(pool), FEE, hooks, address(venue)
        );
    }

    function test_constructor_succeedsWhenHooksZero() public view {
        // setUp() already constructed with hooks == address(0); assert it stuck.
        assertEq(adapter.HOOKS(), address(0));
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
        // 3% execution slippage ⇒ realized value < usdcIn ⇒ SlippageExceeded when
        // minValueOut == usdcIn (no clamp on the deploy path).
        venue.setVenueSlippageBps(300);
        uint256 usdcIn = 1_000 * ONE_USDC;
        vm.expectRevert(IPositionAdapter.SlippageExceeded.selector);
        vault.callDeploy(adapter, IERC20(address(usdc)), usdcIn, usdcIn);
    }

    // ── totalAssets threads the configured TWAP window ──────────────────────

    function test_totalAssets_usesConfiguredTwapWindow() public {
        vault.callDeploy(adapter, IERC20(address(usdc)), 1_000 * ONE_USDC, 0);

        vm.prank(admin);
        adapter.setTwapWindow(3_600);
        assertEq(adapter.effectiveTwapWindow(), 3_600);

        // Oracle accepts ONLY the configured window ⇒ success proves totalAssets
        // priced via 3_600s.
        venue.setExpectedWindow(3_600);
        uint256 ta = adapter.totalAssets();
        assertGt(ta, 0);

        // A different expected window ⇒ totalAssets must revert (it is NOT passing
        // 9_999); confirms the window is genuinely threaded, not hardcoded.
        venue.setExpectedWindow(9_999);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniV4PositionMockVenue.WrongWindow.selector, uint32(3_600), uint32(9_999)
            )
        );
        adapter.totalAssets();
    }

    // ── ORA-4 NAV-deviation guard (entry-side inside deploy) ─────────────────

    function test_deploy_navDeviationGuardReverts_onOutOfWindowMark() public {
        vm.prank(admin);
        adapter.setNavDeviationGuardBps(50); // 0.50%

        // Spot far from the TWAP mean ⇒ divergence >> 50 bps ⇒ guard reverts.
        pool.setMeanTick(0);
        pool.setSpotTick(10_000);

        vm.expectRevert(); // TwapTickMath.NavMarketDeviationExceeded
        vault.callDeploy(adapter, IERC20(address(usdc)), 1_000 * ONE_USDC, 0);
    }

    function test_deploy_navDeviationGuardPasses_whenSpotTracksTwap() public {
        vm.prank(admin);
        adapter.setNavDeviationGuardBps(50);
        pool.setMeanTick(500);
        pool.setSpotTick(500); // identical ⇒ 0 bps divergence

        uint256 valueAdded = vault.callDeploy(adapter, IERC20(address(usdc)), 1_000 * ONE_USDC, 0);
        assertGt(valueAdded, 0);
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

    // ── Config setter authority ─────────────────────────────────────────────

    function test_setters_onlyVaultAdmin() public {
        vm.startPrank(attacker);
        vm.expectRevert(UniswapV4AssetPositionAdapter.OnlyVaultAdmin.selector);
        adapter.setTwapWindow(3_600);
        vm.expectRevert(UniswapV4AssetPositionAdapter.OnlyVaultAdmin.selector);
        adapter.setMaxSlippageBps(100);
        vm.expectRevert(UniswapV4AssetPositionAdapter.OnlyVaultAdmin.selector);
        adapter.setNavDeviationGuardBps(100);
        vm.stopPrank();
    }

    function test_setTwapWindow_boundsEnforced() public {
        uint32 belowMin = adapter.MIN_TWAP_WINDOW() - 1;
        uint32 aboveMax = adapter.MAX_TWAP_WINDOW() + 1;
        vm.startPrank(admin);
        vm.expectRevert(UniswapV4AssetPositionAdapter.InvalidParam.selector);
        adapter.setTwapWindow(belowMin);
        vm.expectRevert(UniswapV4AssetPositionAdapter.InvalidParam.selector);
        adapter.setTwapWindow(aboveMax);
        vm.stopPrank();
    }

    function test_setMaxSlippageBps_ceilingEnforced() public {
        uint256 aboveCeiling = adapter.MAX_SLIPPAGE_BPS() + 1;
        vm.prank(admin);
        vm.expectRevert(UniswapV4AssetPositionAdapter.InvalidParam.selector);
        adapter.setMaxSlippageBps(aboveCeiling);
    }

    function test_setNavDeviationGuardBps_ceilingEnforced() public {
        uint256 aboveCeiling = adapter.MAX_NAV_DEVIATION_BPS() + 1;
        vm.prank(admin);
        vm.expectRevert(UniswapV4AssetPositionAdapter.InvalidParam.selector);
        adapter.setNavDeviationGuardBps(aboveCeiling);
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
        UniV4PositionMockToken18 foreign = new UniV4PositionMockToken18();
        foreign.mint(address(adapter), 5 ether);

        adapter.sweepForeignToken(address(foreign)); // permissionless
        assertEq(foreign.balanceOf(ForeignTokenQuarantine.QUARANTINE), 5 ether);
        assertEq(foreign.balanceOf(address(adapter)), 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pinned Base-mainnet fork: real USDC through the concrete V4 swap executor,
// against a locally-deployed V4 router/pool harness (see file header for why —
// no genuinely deployed third-party Uniswap V4 pool is compatible with this
// repo's `IUniswapV4Pool`/`IUniswapV4SwapRouter` seam).
// LOUD-SKIP — setUp reverts when no fork RPC is configured.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev V4-style router mock: pays a caller-set `amountOut`, pulling `amountIn`
///      from the caller. Byte-identical in spirit to `MockUniswapV4Router` in
///      BasketVault.t.sol (the repo's established V4-stub pattern). TEST FIXTURE.
contract UniV4PositionForkMockRouter {
    using SafeERC20 for IERC20;

    uint256 public amountOut;

    error TooLittleReceived(uint256 amountOut, uint256 amountOutMinimum);

    function setAmountOut(uint256 amountOut_) external {
        amountOut = amountOut_;
    }

    function exactInputSingle(IUniswapV4SwapRouter.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256)
    {
        if (amountOut < params.amountOutMinimum) {
            revert TooLittleReceived(amountOut, params.amountOutMinimum);
        }
        address tokenIn = params.zeroForOne ? params.poolKey.currency0 : params.poolKey.currency1;
        address tokenOut = params.zeroForOne ? params.poolKey.currency1 : params.poolKey.currency0;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
        return amountOut;
    }
}

/// @dev V4-style pool mock for TWAP + NAV-deviation-guard reads. Independently
///      settable spot/mean ticks, same shape as `UniV4PositionMockPool` above
///      and `MockUniswapV4Pool` in BasketVault.t.sol. TEST FIXTURE.
contract UniV4PositionForkMockPool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint128 public liquidity = 1e18;
    uint16 public cardinality = 100;
    int24 public spotTick;
    int24 public meanTickVal;

    constructor(address a, address b, uint24 fee_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
    }

    function setSpotTick(int24 t) external {
        spotTick = t;
    }

    function setMeanTick(int24 t) external {
        meanTickVal = t;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1) << 96, spotTick, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidity)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidity = new uint160[](secondsAgos.length);
        uint32 window = secondsAgos[0];
        if (secondsAgos.length > 1) {
            tickCumulatives[1] = int56(meanTickVal) * int56(uint56(window));
        }
    }
}

contract UniV4AssetPositionAdapterForkTest is Test {
    using SafeERC20 for IERC20;

    // Base mainnet USDC — the only genuinely on-chain surface this fork test
    // exercises (see file header).
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint24 internal constant FEE = 3000;
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant DEPOSIT = 10_000 * ONE_USDC;

    UniV4PositionMockToken18 internal v4Token;
    UniV4PositionForkMockRouter internal router;
    UniV4PositionForkMockPool internal pool;
    UniV4PositionMockVault internal vault;
    UniswapV4SwapAdapter internal venue;
    UniswapV4AssetPositionAdapter internal adapter;
    address internal admin = makeAddr("admin");

    /// @dev LOUD-SKIP: return the fork RPC, or REVERT when none is configured.
    ///      Never silently skips — the CI fork job sets FORK_RPC_URL (from the
    ///      `vars.RMPC_FORK_RPC_URL` repo variable, falling back to a public Base
    ///      RPC) so these tests execute with a non-zero count.
    function _rpc() internal view returns (string memory) {
        string memory a = vm.envOr("RMPC_FORK_RPC_URL", string(""));
        if (bytes(a).length > 0) return a;
        string memory b = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(b).length > 0) return b;
        revert(
            "RMPC_FORK_RPC_URL (or FORK_RPC_URL) required for UniV4AssetPositionAdapterForkTest - loud-skip, do not silent-skip"
        );
    }

    function setUp() public {
        string memory rpc = _rpc();
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock > 0) {
            vm.createSelectFork(rpc, forkBlock);
        } else {
            vm.createSelectFork(rpc);
        }

        v4Token = new UniV4PositionMockToken18();
        router = new UniV4PositionForkMockRouter();
        pool = new UniV4PositionForkMockPool(address(v4Token), BASE_USDC, FEE);
        vault = new UniV4PositionMockVault();
        vault.grantRole(vault.ADMIN_ROLE(), admin);
        venue = new UniswapV4SwapAdapter(address(router));
        adapter = new UniswapV4AssetPositionAdapter(
            BASE_USDC,
            address(vault),
            address(v4Token),
            address(pool),
            FEE,
            address(0),
            address(venue)
        );

        // Real forked Base USDC into the mock vault (genuine ERC-20 semantics,
        // real 6-decimal token bytecode) AND into the router (pays out the
        // withdraw leg's TOKEN->USDC swap).
        deal(BASE_USDC, address(vault), 100_000_000 * ONE_USDC);
        deal(BASE_USDC, address(router), 100_000_000 * ONE_USDC);
        // Router needs v4Token inventory to pay out the deploy leg's swap.
        v4Token.mint(address(router), 100_000 ether);
        // At mean tick 0 the shared TwapTickMath conversion is raw-unit identity
        // (quoteAmount == baseAmount, decimals-agnostic — see TickMath.getSqrtRatioAtTick(0)
        // == 2^96 exactly, so ratioX192 == 1<<192 and the mulDiv is a no-op both
        // ways). Fixing the router's payout to the SAME raw value as the deposit
        // keeps `deploy`'s realized valueAdded and `totalAssets()` internally
        // consistent (both are raw-unit round-trips through the same tick).
        router.setAmountOut(DEPOSIT);
    }

    function test_fork_deploySwapsUsdcToTokenAndPricesViaTwap() public {
        // Flat tick (0) ⇒ 1:1 raw-unit TWAP conversion in the shared tick-math path.
        pool.setMeanTick(0);
        pool.setSpotTick(0);

        uint256 valueAdded = vault.callDeploy(adapter, IERC20(BASE_USDC), DEPOSIT, 0);

        assertGt(v4Token.balanceOf(address(adapter)), 0, "adapter custodies v4Token");
        assertEq(valueAdded, DEPOSIT, "TWAP-priced value == deposit at zero-slippage/tick-0");
        assertEq(adapter.totalAssets(), valueAdded, "totalAssets == valueAdded");
    }

    function test_fork_roundTripWithdrawAllReturnsUsdc() public {
        pool.setMeanTick(0);
        pool.setSpotTick(0);
        vault.callDeploy(adapter, IERC20(BASE_USDC), DEPOSIT, 0);

        uint256 vaultBefore = IERC20(BASE_USDC).balanceOf(address(vault));
        uint256 out = vault.callWithdraw(adapter, type(uint256).max, 0);

        assertEq(v4Token.balanceOf(address(adapter)), 0, "all v4Token liquidated");
        assertEq(IERC20(BASE_USDC).balanceOf(address(vault)) - vaultBefore, out, "vault credited");
        assertEq(out, DEPOSIT, "round-trip == deposit at zero-slippage/tick-0");
    }

    function test_fork_withdrawRevertsBelowSlippageFloor() public {
        pool.setMeanTick(0);
        pool.setSpotTick(0);
        vault.callDeploy(adapter, IERC20(BASE_USDC), DEPOSIT, 0);

        // Demand ~2x the achievable USDC ⇒ composed floor unmet ⇒ SlippageExceeded.
        vm.expectRevert(IPositionAdapter.SlippageExceeded.selector);
        vault.callWithdraw(adapter, DEPOSIT, DEPOSIT * 2);
    }

    function test_fork_navDeviationGuardRevertsOnManipulatedSpot() public {
        vm.prank(admin);
        adapter.setNavDeviationGuardBps(20); // 0.20%

        // Spot pinned far from the TWAP mean ⇒ divergence >> 20 bps ⇒ the
        // entry-side ORA-4 guard must halt the deposit.
        pool.setMeanTick(0);
        pool.setSpotTick(10_000);

        vm.expectRevert(); // TwapTickMath.NavMarketDeviationExceeded
        vault.callDeploy(adapter, IERC20(BASE_USDC), DEPOSIT, 0);
    }
}
