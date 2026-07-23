// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0010-unified-vault-architecture.md §4 (AssetPositionAdapter);
//            docs/technical/unified-vault-spec.md §4.3.
//
// Tests for the Aerodrome inexact IPositionAdapter (#1125), invariant-parity
// counterpart of the Uniswap V3 AssetPositionAdapter (#1118):
//   * AerodromeAssetPositionAdapterTest — mock-vault + mock-venue harness proving
//     onlyVault deploy/withdraw, the minValueOut / composed-floor SlippageExceeded
//     reverts, TWAP-window-threaded totalAssets(), the ORA-4 NAV-deviation guard,
//     and the INV-1/INV-2 sweep/harvest quarantine rules. Runs everywhere (no RPC).
//   * AerodromeAssetPositionAdapterForkTest — Base-mainnet fork (pinnable via the
//     FORK_BLOCK env var; defaults to latest, matching VaultForkRegressions and
//     the sibling UniV3AssetPositionAdapterForkTest) swapping USDC<->wETH through
//     a real Aerodrome Slipstream CL pool via the concrete AerodromeSwapAdapter
//     venue seam, asserting TWAP-priced totalAssets, the slippage-floor revert,
//     and the NAV-deviation guard. LOUD-SKIP: setUp reverts when no fork RPC is
//     configured (never a silent skip) — wired into the `fork-regressions` job in
//     .github/workflows/suite-01-02-forge-tests.yml. It cannot use the offline
//     golden fixture the other fork tests in this repo share: that snapshot never
//     touched the Aerodrome Slipstream factory/pool, so it has no code there.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {IAerodromeSlipstreamRouter} from "../interfaces/IAerodromeSlipstreamRouter.sol";
import {IAerodromeCLFactory} from "../interfaces/IAerodromeCLFactory.sol";
import {AerodromeAssetPositionAdapter} from "../adapters/AerodromeAssetPositionAdapter.sol";
import {AerodromeSwapAdapter} from "../adapters/AerodromeSwapAdapter.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures (uniquely named to avoid forge-doc re-linking collisions).
// ─────────────────────────────────────────────────────────────────────────────

/// @dev 18-decimal ERC-20 stand-in for a basket token (e.g. wETH). TEST FIXTURE.
contract AeroPositionMockToken18 is ERC20 {
    constructor() ERC20("Mock Token 18", "mTKN18") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Minimal vault harness: answers `hasRole(ADMIN_ROLE, .)` for the adapter's
///      onlyVaultAdmin setters and relays deploy/withdraw as the bound VAULT
///      (msg.sender == this) after funding the adapter with USDC. TEST FIXTURE.
contract AeroPositionMockVault {
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
        AerodromeAssetPositionAdapter adapter,
        IERC20 usdc,
        uint256 usdcIn,
        uint256 minValueOut
    ) external returns (uint256) {
        usdc.safeTransfer(address(adapter), usdcIn);
        return adapter.deploy(usdcIn, minValueOut);
    }

    function callWithdraw(
        AerodromeAssetPositionAdapter adapter,
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
contract AeroPositionMockVenue is IBasketSwapAdapter {
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

/// @dev Duck-typed Aerodrome Slipstream CL pool for the constructor
///      pool-usability check and the ORA-4 NAV-deviation guard. Exposes the
///      identical `slot0`/`observe`/`liquidity`/`token0`/`token1` ABI as
///      Uniswap V3 (per `IAerodromePool`), plus `tickSpacing()`. `spotTick`
///      (slot0) and `meanTickVal` (observe cumulatives) are independently
///      settable to synthesize a spot-vs-TWAP divergence. TEST FIXTURE.
contract AeroPositionMockPool {
    address public immutable token0;
    address public immutable token1;
    int24 public immutable tickSpacing;
    uint128 public liquidity = 1e18;
    uint16 public cardinality = 2;
    int24 public spotTick;
    int24 public meanTickVal;

    constructor(address a, address b, int24 tickSpacing_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        tickSpacing = tickSpacing_;
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

contract AerodromeAssetPositionAdapterTest is Test {
    TestERC20 internal usdc; // 6-dec
    AeroPositionMockToken18 internal token; // 18-dec
    AeroPositionMockVenue internal venue;
    AeroPositionMockPool internal pool;
    AeroPositionMockVault internal vault;
    AerodromeAssetPositionAdapter internal adapter;

    int24 internal constant TICK_SPACING = 100;
    uint256 internal constant ONE_USDC = 1e6;
    address internal admin = makeAddr("admin");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        usdc = new TestERC20();
        token = new AeroPositionMockToken18();
        venue = new AeroPositionMockVenue(address(usdc), address(token));
        pool = new AeroPositionMockPool(address(token), address(usdc), TICK_SPACING);
        vault = new AeroPositionMockVault();
        vault.grantRole(vault.ADMIN_ROLE(), admin);

        adapter = new AerodromeAssetPositionAdapter(
            address(usdc),
            address(vault),
            address(token),
            address(pool),
            uint24(TICK_SPACING),
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
        assertEq(adapter.TICK_SPACING(), uint24(TICK_SPACING));
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
                AeroPositionMockVenue.WrongWindow.selector, uint32(3_600), uint32(9_999)
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
        vm.expectRevert(AerodromeAssetPositionAdapter.OnlyVaultAdmin.selector);
        adapter.setTwapWindow(3_600);
        vm.expectRevert(AerodromeAssetPositionAdapter.OnlyVaultAdmin.selector);
        adapter.setMaxSlippageBps(100);
        vm.expectRevert(AerodromeAssetPositionAdapter.OnlyVaultAdmin.selector);
        adapter.setNavDeviationGuardBps(100);
        vm.stopPrank();
    }

    function test_setTwapWindow_boundsEnforced() public {
        uint32 belowMin = adapter.MIN_TWAP_WINDOW() - 1;
        uint32 aboveMax = adapter.MAX_TWAP_WINDOW() + 1;
        vm.startPrank(admin);
        vm.expectRevert(AerodromeAssetPositionAdapter.InvalidParam.selector);
        adapter.setTwapWindow(belowMin);
        vm.expectRevert(AerodromeAssetPositionAdapter.InvalidParam.selector);
        adapter.setTwapWindow(aboveMax);
        vm.stopPrank();
    }

    function test_setMaxSlippageBps_ceilingEnforced() public {
        uint256 aboveCeiling = adapter.MAX_SLIPPAGE_BPS() + 1;
        vm.prank(admin);
        vm.expectRevert(AerodromeAssetPositionAdapter.InvalidParam.selector);
        adapter.setMaxSlippageBps(aboveCeiling);
    }

    function test_setNavDeviationGuardBps_ceilingEnforced() public {
        uint256 aboveCeiling = adapter.MAX_NAV_DEVIATION_BPS() + 1;
        vm.prank(admin);
        vm.expectRevert(AerodromeAssetPositionAdapter.InvalidParam.selector);
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
        AeroPositionMockToken18 foreign = new AeroPositionMockToken18();
        foreign.mint(address(adapter), 5 ether);

        adapter.sweepForeignToken(address(foreign)); // permissionless
        assertEq(foreign.balanceOf(ForeignTokenQuarantine.QUARANTINE), 5 ether);
        assertEq(foreign.balanceOf(address(adapter)), 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pinned Base-mainnet fork: real USDC/wETH Aerodrome Slipstream CL pool via the
// concrete executor. LOUD-SKIP — setUp reverts when no fork RPC is configured.
// ─────────────────────────────────────────────────────────────────────────────

contract AerodromeAssetPositionAdapterForkTest is Test {
    using SafeERC20 for IERC20;

    // Base mainnet addresses (verified on-chain, 2026-07-23):
    // - USDC / wETH: canonical Base tokens.
    // - CL_FACTORY / SLIPSTREAM_ROUTER: Aerodrome Slipstream deployment
    //   (aerodrome-finance/slipstream), independently confirmed via
    //   `factory.getPool(wETH, USDC, 100) == POOL` and `pool.tickSpacing() == 100`
    //   at the current chain head.
    // - POOL: the wETH/USDC 0.05%-fee (tickSpacing 100) Slipstream CL pool,
    //   ~$9M TVL / ~$30M 24h volume at verification time — ample cardinality
    //   (900+ observations) and in-range liquidity for the pool-usability guard.
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CL_FACTORY = 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A;
    address internal constant SLIPSTREAM_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address internal constant WETH_USDC_POOL = 0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59;
    int24 internal constant TICK_SPACING = 100;

    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant DEPOSIT = 10_000 * ONE_USDC;

    AeroPositionMockVault internal vault;
    AerodromeSwapAdapter internal venue;
    AerodromeAssetPositionAdapter internal adapter;
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
            "RMPC_FORK_RPC_URL (or FORK_RPC_URL) required for AerodromeAssetPositionAdapterForkTest - loud-skip, do not silent-skip"
        );
    }

    function setUp() public {
        // Deterministic when the CI archive pins FORK_BLOCK; otherwise forks at
        // latest (matching the repo's VaultForkRegressions convention). Public
        // non-archive RPCs prune old blocks, so latest keeps the seam runnable
        // anywhere the wETH/USDC Slipstream pool is live.
        string memory rpc = _rpc();
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock > 0) {
            vm.createSelectFork(rpc, forkBlock);
        } else {
            vm.createSelectFork(rpc);
        }

        address resolvedPool =
            IAerodromeCLFactory(CL_FACTORY).getPool(BASE_WETH, BASE_USDC, TICK_SPACING);
        require(resolvedPool == WETH_USDC_POOL, "wETH/USDC Slipstream pool mismatch at fork block");

        vault = new AeroPositionMockVault();
        vault.grantRole(vault.ADMIN_ROLE(), admin);
        venue = new AerodromeSwapAdapter(SLIPSTREAM_ROUTER, CL_FACTORY);
        adapter = new AerodromeAssetPositionAdapter(
            BASE_USDC,
            address(vault),
            BASE_WETH,
            WETH_USDC_POOL,
            uint24(TICK_SPACING),
            address(venue)
        );

        deal(BASE_USDC, address(vault), 100_000_000 * ONE_USDC);
    }

    function test_fork_deploySwapsUsdcToWethAndPricesViaTwap() public {
        uint256 valueAdded = vault.callDeploy(adapter, IERC20(BASE_USDC), DEPOSIT, 0);

        assertGt(IERC20(BASE_WETH).balanceOf(address(adapter)), 0, "adapter custodies wETH");
        // TWAP-priced NAV within a generous slippage band of the deposit.
        assertGt(valueAdded, (DEPOSIT * 90) / 100, "TWAP-priced value within 10% of deposit");
        assertApproxEqRel(adapter.totalAssets(), valueAdded, 0.02e18, "totalAssets ~ valueAdded");
    }

    function test_fork_roundTripWithdrawAllReturnsUsdc() public {
        vault.callDeploy(adapter, IERC20(BASE_USDC), DEPOSIT, 0);

        uint256 vaultBefore = IERC20(BASE_USDC).balanceOf(address(vault));
        uint256 out = vault.callWithdraw(adapter, type(uint256).max, 0);

        assertEq(IERC20(BASE_WETH).balanceOf(address(adapter)), 0, "all wETH liquidated");
        assertEq(IERC20(BASE_USDC).balanceOf(address(vault)) - vaultBefore, out, "vault credited");
        // Round-trip loses only pool fee + slippage (well under 5%).
        assertGt(out, (DEPOSIT * 95) / 100, "round-trip within 5%");
    }

    function test_fork_withdrawRevertsBelowSlippageFloor() public {
        vault.callDeploy(adapter, IERC20(BASE_USDC), DEPOSIT, 0);

        // Demand ~2x the achievable USDC ⇒ composed floor unmet ⇒ SlippageExceeded.
        vm.expectRevert(IPositionAdapter.SlippageExceeded.selector);
        vault.callWithdraw(adapter, DEPOSIT, DEPOSIT * 2);
    }

    function test_fork_navDeviationGuardRevertsOnManipulatedSpot() public {
        vm.prank(admin);
        adapter.setNavDeviationGuardBps(20); // 0.20%

        // Push spot away from the lagging 30-min TWAP with a real swap against the
        // Aerodrome pool. Empirically calibrated against live Base mainnet state
        // (2026-07): 1M USDC moves this pool ~200bps — a 10x safety margin over
        // the 20bps threshold — while staying far smaller than a manipulation
        // large enough to matter for archive-node RPC cost. An earlier 8M-USDC
        // size (a much larger safety margin, ~2900bps) crossed enough ticks to
        // trip the public RPC's 429 rate limit in CI (issue #1125 review), since
        // this step runs immediately after the sibling V3 fork test in the same
        // job and shares its rate budget; 1M keeps the same guard-tripping
        // behavior with a fraction of the storage-slot RPC calls.
        uint256 manipUsdc = 1_000_000 * ONE_USDC;
        deal(BASE_USDC, address(this), manipUsdc);
        IERC20(BASE_USDC).forceApprove(SLIPSTREAM_ROUTER, manipUsdc);
        IAerodromeSlipstreamRouter(SLIPSTREAM_ROUTER)
            .exactInputSingle(
                IAerodromeSlipstreamRouter.ExactInputSingleParams({
                tokenIn: BASE_USDC,
                tokenOut: BASE_WETH,
                tickSpacing: TICK_SPACING,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: manipUsdc,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
            );

        // Entry-side guard must halt the deposit at the diverged mark.
        vm.expectRevert(); // TwapTickMath.NavMarketDeviationExceeded
        vault.callDeploy(adapter, IERC20(BASE_USDC), DEPOSIT, 0);
    }
}
