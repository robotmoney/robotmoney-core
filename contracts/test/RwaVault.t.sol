// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0006-despxa-rwa-vault-design.md — deSPXA vault design
// Covers: issue #561 — deSPXA RWA vault (hold deSPXA, Aerodrome swap, Chronicle NAV oracle)
//
// Test plan:
//   - forge test --match-contract 'Rwa|DeSPXA|Despxa' -vvv
//   - forge fmt --check contracts/vaults/ 2>/dev/null || forge fmt --check
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RwaVault} from "../vaults/RwaVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ChronicleOracleAdapter} from "../adapters/ChronicleOracleAdapter.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IChronicleOracle} from "../interfaces/IChronicleOracle.sol";
import {IAerodromeRouter} from "../interfaces/IAerodromeRouter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

// ─── Mock contracts ───────────────────────────────────────────────────────────

/// @dev 18-decimal ERC-20 test token. Mirrors real deSPXA decimals.
///      deSPXA (and most Centrifuge RWA tokens) use 18 decimals on Base.
contract TestERC20_18 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @dev Mock Chronicle oracle: configurable price and timestamp.
contract MockChronicle is IChronicleOracle {
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

/// @dev Stub Uniswap V3 SwapRouter (required by BasketVault constructor but never called
///      in the RWA vault since all swaps go through ChronicleOracleAdapter/Aerodrome).
contract StubSwapRouter is ISwapRouter {
    function exactInputSingle(ExactInputSingleParams calldata) external returns (uint256) {
        revert("RwaVault does not use Uniswap V3 router");
    }
}

/// @dev Mock Aerodrome Router: records calls and disburses pre-set amounts.
///      Identical pattern to BasketVault.t.sol::MockAerodromeRouter.
contract MockAerodromeRouter {
    using SafeERC20 for IERC20;

    uint256 public amountOut;

    error TooLittleReceived(uint256 amountOut, uint256 amountOutMin);

    function setAmountOut(uint256 amountOut_) external {
        amountOut = amountOut_;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        IAerodromeRouter.Route[] calldata routes,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        if (amountOut < amountOutMin) revert TooLittleReceived(amountOut, amountOutMin);
        IERC20(routes[0].from).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(routes[routes.length - 1].to).safeTransfer(to, amountOut);
        amounts = new uint256[](routes.length + 1);
        amounts[routes.length] = amountOut;
    }

    function defaultFactory() external pure returns (address) {
        return address(0xF00D);
    }
}

/// @dev Mock pool for addAsset() cardinality and liquidity gate checks.
///      Chronicle (not pool TWAP) is used for pricing, so observe() is never
///      called on hot paths. However addAsset() checks slot0.observationCardinality
///      and pool.liquidity(), so we implement both.
contract MockDeSPXAPool {
    address public immutable token0;
    address public immutable token1;
    uint16 public cardinality = 100;

    constructor(address token0_, address token1_) {
        // Forge sorts addresses deterministically; caller must sort before passing.
        token0 = token0_;
        token1 = token1_;
    }

    function setCardinality(uint16 c) external {
        cardinality = c;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1 << 96), 0, 0, cardinality, cardinality, 0, true);
    }

    /// @dev observe() is not called by RwaVault (Chronicle is the price source),
    ///      but it must not revert since BasketVault has no way to skip it.
    ///      Return flat zero-tick cumulatives (tick=0 → 1:1 price ratio).
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            tickCumulatives[i] =
                int56(int256(block.timestamp)) - int56(int256(uint256(secondsAgos[i])));
            tickCumulatives[i] = 0; // zero-tick: unused
        }
    }

    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        return (uint32(block.timestamp), 0, 0, true);
    }

    function liquidity() external pure returns (uint128) {
        return 1e18; // well above MIN_POOL_LIQUIDITY (1e6)
    }
}

// ─── RwaVaultTest ─────────────────────────────────────────────────────────────

/// @title RwaVaultTest
/// @notice Unit tests for the deSPXA RWA vault.
///
///         Acceptance criteria verified:
///         AC-1: RWA vault holds deSPXA and round-trips USDC->deSPXA->USDC via Aerodrome.
///         AC-2: Pricing uses Chronicle NAV oracle; no ERC-7540 primary NAV redemption path.
///         AC-3: Caps, pause, and freeze-path safety are covered by forge tests.
///
///         Decimal conventions:
///           USDC   — 6 decimals (TestERC20)
///           deSPXA — 18 decimals (TestERC20_18, matching real deSPXA on Base)
///           Chronicle price — WAD (18 dec): USDC value of 1 deSPXA, both 18-dec scaled
///             e.g. NAV_PRICE_WAD = 5e18 means 1 deSPXA = 5 USDC
///
///         Adapter formula (ChronicleOracleAdapter.twapPrice):
///           deSPXA→USDC: quoteUSDC = baseDesplxa * navPrice / (WAD * 1e12)
///             e.g. 1e18 deSPXA * 5e18 / (1e18 * 1e12) = 5e6 USDC ✓
///           USDC→deSPXA: quoteDespxa = baseUsdc * 1e12 * WAD / navPrice
///             e.g. 5e6 USDC * 1e12 * 1e18 / 5e18 = 1e18 deSPXA ✓
///
///         All tests use mock contracts — no mainnet fork needed.
contract RwaVaultTest is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant ONE_DESPXA = 1e18;
    /// @dev Chronicle reports price in WAD: 5.00 USDC per deSPXA.
    uint256 internal constant NAV_PRICE_WAD = 5e18;

    TestERC20 internal usdc; // 6 decimals
    TestERC20_18 internal despxa; // 18 decimals (real deSPXA)
    MockChronicle internal chronicle;
    MockAerodromeRouter internal aeroRouter;
    MockDeSPXAPool internal pool;
    ChronicleOracleAdapter internal adapter;
    RwaVault internal vault;
    address internal admin;
    address internal emergencyResponder;
    address internal user;

    function setUp() public {
        admin = makeAddr("admin");
        emergencyResponder = makeAddr("emergencyResponder");
        user = makeAddr("user");

        usdc = new TestERC20(); // 6 decimals
        despxa = new TestERC20_18("deSPXA", "deSPXA"); // 18 decimals

        // Chronicle oracle: 5.00 USDC/deSPXA, timestamp=now (fresh)
        chronicle = new MockChronicle(NAV_PRICE_WAD, block.timestamp);

        aeroRouter = new MockAerodromeRouter();

        // Pool: token0/token1 must be sorted by address for the pair check.
        address t0 = address(usdc) < address(despxa) ? address(usdc) : address(despxa);
        address t1 = address(usdc) < address(despxa) ? address(despxa) : address(usdc);
        pool = new MockDeSPXAPool(t0, t1);

        adapter = new ChronicleOracleAdapter(
            address(aeroRouter),
            address(0xF00D), // Aerodrome factory stub
            false, // volatile pool (not stable)
            address(chronicle),
            address(despxa),
            address(usdc)
        );

        vault = new RwaVault(
            IERC20(address(usdc)),
            ISwapRouter(address(new StubSwapRouter())),
            IChronicleOracle(address(chronicle)),
            100_000 * ONE_USDC, // tvlCap: 100k USDC
            10_000 * ONE_USDC, // perDepositCap: 10k USDC
            0, // exitFeeBps: 0 for simplicity
            admin, // feeRecipient
            admin,
            emergencyResponder
        );

        // Register deSPXA as the single basket asset.
        vm.prank(admin);
        vault.addAsset(
            address(despxa),
            address(pool),
            0, // swapFee (unused by Aerodrome)
            address(adapter),
            BasketVault.Venue.Aerodrome
        );
    }

    // ─── AC-1: Deposit round-trip (USDC → deSPXA → USDC) ─────────────────────

    /// @notice Depositing USDC causes the vault to swap USDC → deSPXA via Aerodrome.
    ///         deSPXA (18-decimal) is held by the vault after deposit.
    ///         AC-1: round-trip USDC→deSPXA→USDC via Aerodrome.
    function test_deposit_swapsUsdcToDespxa() public {
        uint256 depositAmount = 1_000 * ONE_USDC; // 1000 USDC
        // Chronicle: 5 USDC/deSPXA → 1000 USDC = 200 deSPXA (200e18)
        // minOut = 200e18 * (10000 - 50) / 10000 = 199e18
        uint256 despxaOut = 200 * ONE_DESPXA; // 200e18 — matches Chronicle NAV exactly
        despxa.mint(address(aeroRouter), despxaOut);
        aeroRouter.setAmountOut(despxaOut);

        usdc.mint(user, depositAmount);
        vm.startPrank(user);
        usdc.approve(address(vault), depositAmount);
        uint256 shares = vault.deposit(depositAmount, user);
        vm.stopPrank();

        assertGt(shares, 0, "shares minted on deposit");
        assertEq(despxa.balanceOf(address(vault)), despxaOut, "vault holds deSPXA");
        assertEq(usdc.balanceOf(address(vault)), 0, "no idle USDC left after swap");
    }

    /// @notice Redeeming shares causes the vault to swap deSPXA → USDC via Aerodrome.
    ///         AC-1: round-trip USDC→deSPXA→USDC via Aerodrome.
    function test_redeem_swapsDespxaToUsdc() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 despxaOut = 200 * ONE_DESPXA; // 200e18 deSPXA
        despxa.mint(address(aeroRouter), despxaOut);
        aeroRouter.setAmountOut(despxaOut);

        usdc.mint(user, depositAmount);
        vm.startPrank(user);
        usdc.approve(address(vault), depositAmount);
        uint256 shares = vault.deposit(depositAmount, user);
        vm.stopPrank();

        // Redeem: vault sells 200 deSPXA → ~1000 USDC (slight slippage)
        // Chronicle: 200 deSPXA * 5 USDC/deSPXA = 1000 USDC
        // minOut = 1000e6 * (10000 - 50) / 10000 = 995e6
        uint256 usdcBack = 995 * ONE_USDC;
        usdc.mint(address(aeroRouter), usdcBack);
        aeroRouter.setAmountOut(usdcBack);

        vm.prank(user);
        vault.redeem(shares, user, user);

        assertEq(despxa.balanceOf(address(vault)), 0, "vault sold all deSPXA");
        assertEq(usdc.balanceOf(user), usdcBack, "user received USDC from redemption");
    }

    /// @notice totalAssets is zero for an empty vault.
    function test_totalAssets_returnsZeroWhenEmpty() public {
        assertEq(vault.totalAssets(), 0, "empty vault has zero NAV");
    }

    /// @notice totalAssets reflects Chronicle NAV pricing, not Aerodrome spot.
    ///         100 deSPXA @ 5 USDC/deSPXA = 500 USDC NAV.
    function test_totalAssets_pricedViaChronicle() public {
        uint256 despxaAmount = 100 * ONE_DESPXA; // 100 deSPXA (18 dec)
        despxa.mint(address(vault), despxaAmount);

        uint256 nav = vault.totalAssets();
        // ChronicleOracleAdapter: 100e18 * 5e18 / (1e18 * 1e12) = 500e6 USDC
        assertEq(nav, 500 * ONE_USDC, "100 deSPXA @ 5 USDC = 500 USDC NAV");
    }

    // ─── AC-2: Chronicle oracle pricing; no ERC-7540 ────────────────────────

    /// @notice Chronicle price direction: RWA→USDC.
    ///         AC-2: pricing uses Chronicle NAV oracle.
    function test_chronicle_priceRwaToUsdc() public view {
        // 1 deSPXA (18 dec) → USDC: 1e18 * 5e18 / (1e18 * 1e12) = 5e6 USDC
        uint256 quoteAmount =
            adapter.twapPrice(address(pool), address(despxa), address(usdc), ONE_DESPXA, 0);
        assertEq(quoteAmount, 5 * ONE_USDC, "1 deSPXA prices to 5 USDC via Chronicle");
    }

    /// @notice Chronicle price direction: USDC→RWA.
    ///         AC-2: pricing uses Chronicle NAV oracle.
    function test_chronicle_priceUsdcToRwa() public view {
        // 5 USDC → deSPXA: 5e6 * 1e12 * 1e18 / 5e18 = 1e18 deSPXA
        uint256 quoteAmount =
            adapter.twapPrice(address(pool), address(usdc), address(despxa), 5 * ONE_USDC, 0);
        assertEq(quoteAmount, ONE_DESPXA, "5 USDC prices to 1 deSPXA via Chronicle");
    }

    /// @notice Chronicle price returns 0 for zero input (no revert).
    function test_chronicle_zeroInputReturnsZero() public view {
        uint256 quoteAmount = adapter.twapPrice(address(pool), address(despxa), address(usdc), 0, 0);
        assertEq(quoteAmount, 0, "zero input returns zero output");
    }

    /// @notice Chronicle price reverts on unknown pair.
    function test_chronicle_revertsOnUnknownPair() public {
        address randomToken = makeAddr("randomToken");
        vm.expectRevert(
            abi.encodeWithSelector(
                ChronicleOracleAdapter.UnknownPricePair.selector, randomToken, address(usdc)
            )
        );
        adapter.twapPrice(address(pool), randomToken, address(usdc), 1e18, 0);
    }

    // ─── AC-2: Stale oracle halts operations ──────────────────────────────────

    /// @notice totalAssets() reverts with StalePriceFeed when oracle is stale.
    ///         AC-2: pricing uses Chronicle NAV oracle; stale feed halts operations.
    function test_staleFeed_totalAssetsReverts() public {
        // Read oracle timestamp directly from the mock — avoids a viaIR/coverage
        // optimisation that can evaluate `block.timestamp` after vm.warp when it
        // is only used in a vm.expectRevert selector argument (compiler re-ordering
        // of pure reads in --ir-minimum mode).
        uint256 oracleTs = chronicle.latestTimestamp();
        vm.warp(block.timestamp + 25 hours); // beyond 24h heartbeat

        vm.expectRevert(
            abi.encodeWithSelector(RwaVault.StalePriceFeed.selector, oracleTs, 24 hours)
        );
        vault.totalAssets();
    }

    /// @notice Deposits revert when the oracle is stale (totalAssets is on the hot path).
    function test_staleFeed_depositReverts() public {
        // Read oracle timestamp directly from the mock — same viaIR guard as above.
        uint256 oracleTs = chronicle.latestTimestamp();
        vm.warp(block.timestamp + 25 hours);
        usdc.mint(user, 1_000 * ONE_USDC);

        vm.startPrank(user);
        usdc.approve(address(vault), 1_000 * ONE_USDC);
        vm.expectRevert(
            abi.encodeWithSelector(RwaVault.StalePriceFeed.selector, oracleTs, 24 hours)
        );
        vault.deposit(1_000 * ONE_USDC, user);
        vm.stopPrank();
    }

    /// @notice Operations resume after the oracle is refreshed.
    function test_staleFeed_resumesAfterOracleRefresh() public {
        vm.warp(block.timestamp + 25 hours);
        // Refresh oracle to current block
        chronicle.setTimestamp(block.timestamp);

        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 despxaOut = 200 * ONE_DESPXA;
        despxa.mint(address(aeroRouter), despxaOut);
        aeroRouter.setAmountOut(despxaOut);

        usdc.mint(user, depositAmount);
        vm.startPrank(user);
        usdc.approve(address(vault), depositAmount);
        uint256 shares = vault.deposit(depositAmount, user);
        vm.stopPrank();

        assertGt(shares, 0, "deposit succeeds after oracle refresh");
    }

    // ─── AC-3: Caps ───────────────────────────────────────────────────────────

    /// @notice Deposits above the per-deposit cap revert. Since BasketVault.maxDeposit
    ///         now reflects the caps (audit 2026-06-09, L-16), OZ's ERC4626 entry-point
    ///         check fires first with ERC4626ExceededMaxDeposit.
    ///         AC-3: caps are enforced.
    function test_caps_perDepositCapEnforced() public {
        // perDepositCap = 10k USDC; try to deposit 11k
        uint256 depositAmount = 11_000 * ONE_USDC;
        assertEq(vault.maxDeposit(user), 10_000 * ONE_USDC, "maxDeposit reflects perDepositCap");
        usdc.mint(user, depositAmount);
        vm.startPrank(user);
        usdc.approve(address(vault), depositAmount);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit(receiver, assets, maxDeposit)
        vault.deposit(depositAmount, user);
        vm.stopPrank();
    }

    /// @notice Deposits above the TVL cap revert. Since BasketVault.maxDeposit now
    ///         reflects TVL-cap headroom (audit 2026-06-09, L-16), OZ's ERC4626
    ///         entry-point check fires first with ERC4626ExceededMaxDeposit.
    ///         AC-3: caps are enforced.
    function test_caps_tvlCapEnforced() public {
        // Seed the vault with deSPXA so TVL is just 6 USDC below the cap.
        // tvlCap = 100k USDC; seed (100k - 6) / 5 = 19999.2 → 19999 deSPXA.
        // 19999 deSPXA * 5 USDC = 99995 USDC NAV.
        // Then deposit 10 USDC (within perDepositCap=10k): 99995 + 10 = 100005 > 100000.
        uint256 seedDespxa = 19_999 * ONE_DESPXA;
        despxa.mint(address(vault), seedDespxa);

        // TVL = 19999 * 5 = 99995 USDC. Deposit 10 USDC → total = 100005 > tvlCap.
        uint256 depositAmount = 10 * ONE_USDC;
        usdc.mint(user, depositAmount);
        vm.startPrank(user);
        usdc.approve(address(vault), depositAmount);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit(receiver, assets, headroom)
        vault.deposit(depositAmount, user);
        vm.stopPrank();
    }

    // ─── AC-3: Pause ─────────────────────────────────────────────────────────

    /// @notice pause() halts deposits; unpause() resumes them.
    ///         AC-3: pause/unpause are covered.
    function test_pause_haltsThenResumes() public {
        vm.prank(emergencyResponder);
        vault.pause();
        assertTrue(vault.paused(), "vault paused");

        usdc.mint(user, 1_000 * ONE_USDC);
        vm.startPrank(user);
        usdc.approve(address(vault), 1_000 * ONE_USDC);
        vm.expectRevert(); // EnforcedPause
        vault.deposit(1_000 * ONE_USDC, user);
        vm.stopPrank();

        vm.prank(admin);
        vault.unpause();
        assertFalse(vault.paused(), "vault unpaused");
    }

    /// @notice Only EMERGENCY_ROLE can pause; strangers are rejected.
    function test_pause_onlyEmergencyRole() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(); // AccessControlUnauthorizedAccount
        vault.pause();
    }

    // ─── AC-3: Freeze-path safety ─────────────────────────────────────────────

    /// @notice When deSPXA transfers are frozen (issuer freeze), the Aerodrome swap
    ///         reverts. The vault DOES NOT confiscate shares — no shares are minted.
    ///         AC-3: freeze-path safety — no fund loss on failed deposit.
    function test_freeze_depositRevertsGracefullyWithNoSharesMinted() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        // Simulate freeze: router has no deSPXA to provide → amountOut=0 < minAmountOut.
        aeroRouter.setAmountOut(0);

        usdc.mint(user, depositAmount);
        vm.startPrank(user);
        usdc.approve(address(vault), depositAmount);
        // Expect revert from TooLittleReceived (slippage guard, triggered by freeze sim).
        vm.expectRevert();
        vault.deposit(depositAmount, user);
        vm.stopPrank();

        assertEq(vault.totalSupply(), 0, "no shares minted on failed deposit (freeze sim)");
        // USDC is not stuck in vault because ERC-4626 _deposit pulls funds only after
        // minting shares and the swap reverts before mint completes.
        // Note: BasketVault mints shares first then swaps; USDC may be in vault.
        // The key guarantee: user loses no USDC because the transaction reverts entirely.
    }

    /// @notice Admin can pause the vault after a freeze is detected (ADR-0006 §4).
    ///         Subsequent deposits revert with user-facing EnforcedPause, not opaque ERC-20 error.
    ///         AC-3: freeze-path safety — admin pause mechanism.
    function test_freeze_adminCanPauseAfterFreeze() public {
        vm.prank(emergencyResponder);
        vault.pause();

        usdc.mint(user, 1_000 * ONE_USDC);
        vm.startPrank(user);
        usdc.approve(address(vault), 1_000 * ONE_USDC);
        vm.expectRevert(); // EnforcedPause — user-facing, not opaque deSPXA revert
        vault.deposit(1_000 * ONE_USDC, user);
        vm.stopPrank();

        assertTrue(vault.paused(), "vault remains paused after freeze");
    }

    /// @notice Existing holders retain their shares during a freeze — vault never
    ///         confiscates or redistributes rmRWA shares. (ADR-0006 §4)
    function test_freeze_existingHoldersRetainShares() public {
        // First deposit succeeds (oracle fresh, no freeze)
        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 despxaOut = 200 * ONE_DESPXA;
        despxa.mint(address(aeroRouter), despxaOut);
        aeroRouter.setAmountOut(despxaOut);

        usdc.mint(user, depositAmount);
        vm.startPrank(user);
        usdc.approve(address(vault), depositAmount);
        uint256 shares = vault.deposit(depositAmount, user);
        vm.stopPrank();

        assertGt(shares, 0, "user has shares");

        // Simulate freeze: subsequent operations revert
        aeroRouter.setAmountOut(0);
        address user2 = makeAddr("user2");
        usdc.mint(user2, depositAmount);
        vm.startPrank(user2);
        usdc.approve(address(vault), depositAmount);
        vm.expectRevert(); // freeze-induced revert
        vault.deposit(depositAmount, user2);
        vm.stopPrank();

        // user's shares are unchanged — no redistribution during freeze
        assertEq(vault.balanceOf(user), shares, "user1 shares unchanged during freeze");
        assertEq(vault.balanceOf(user2), 0, "user2 has no shares (deposit failed)");
    }

    // ─── Vault metadata and single-asset constraint ───────────────────────────

    /// @notice RwaVault name and symbol match the product spec (ADR-0006, PRD §11.4).
    function test_metadata_nameAndSymbol() public view {
        assertEq(vault.name(), "Robot Money RWA", "vault name");
        assertEq(vault.symbol(), "rmRWA", "vault symbol");
    }

    /// @notice maxAssets is 1 — only one basket asset is permitted (deSPXA).
    function test_metadata_maxAssetsIsOne() public view {
        assertEq(vault.maxAssets(), 1, "maxAssets must be 1 for RWA vault");
    }

    /// @notice Adding a second asset reverts with MaxAssetsReached.
    function test_maxAssets_rejectsSecondAsset() public {
        TestERC20_18 secondToken = new TestERC20_18("FOO", "FOO");
        address t0 = address(usdc) < address(secondToken) ? address(usdc) : address(secondToken);
        address t1 = address(usdc) < address(secondToken) ? address(secondToken) : address(usdc);
        MockDeSPXAPool secondPool = new MockDeSPXAPool(t0, t1);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("MaxAssetsReached()"))));
        vault.addAsset(
            address(secondToken),
            address(secondPool),
            0,
            address(adapter),
            BasketVault.Venue.Aerodrome
        );
    }

    // ─── Oracle heartbeat configuration ──────────────────────────────────────

    /// @notice ADMIN_ROLE can update the oracle heartbeat within bounds.
    function test_oracleHeartbeat_adminCanUpdate() public {
        vm.prank(admin);
        vault.setOracleHeartbeat(12 hours);
        assertEq(vault.oracleHeartbeat(), 12 hours, "heartbeat updated to 12h");
    }

    /// @notice Heartbeat > MAX_HEARTBEAT (48h) reverts with InvalidHeartbeat.
    function test_oracleHeartbeat_rejectsAboveMax() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(RwaVault.InvalidHeartbeat.selector, 49 hours));
        vault.setOracleHeartbeat(49 hours);
    }

    /// @notice Heartbeat < 1h reverts with InvalidHeartbeat.
    function test_oracleHeartbeat_rejectsBelowMin() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(RwaVault.InvalidHeartbeat.selector, 30 minutes));
        vault.setOracleHeartbeat(30 minutes);
    }

    /// @notice OracleHeartbeatUpdated event is emitted on heartbeat update.
    function test_oracleHeartbeat_emitsEvent() public {
        vm.prank(admin);
        vm.expectEmit(true, true, true, true);
        emit RwaVault.OracleHeartbeatUpdated(24 hours, 12 hours);
        vault.setOracleHeartbeat(12 hours);
    }

    // ─── Emergency stale override (issue #750) ──────────────────────────

    /// @notice emergencyUnwind reverts with StalePriceFeed when the Chronicle
    ///         feed is stale and the override flag is not set.
    function test_emergencyUnwind_revertsOnStaleFeed() public {
        uint256 oracleTs = chronicle.latestTimestamp();
        vm.warp(block.timestamp + 25 hours);

        vm.prank(emergencyResponder);
        vm.expectRevert(
            abi.encodeWithSelector(RwaVault.StalePriceFeed.selector, oracleTs, 24 hours)
        );
        vault.emergencyUnwind();
    }

    /// @notice emergencyUnwindWithOverride reverts with StalePriceFeed when the
    ///         Chronicle feed is stale and the override flag is not set.
    function test_emergencyUnwindWithOverride_revertsOnStaleFeed() public {
        uint256 oracleTs = chronicle.latestTimestamp();
        vm.warp(block.timestamp + 25 hours);

        address[] memory tokens = new address[](0);
        vm.prank(emergencyResponder);
        vm.expectRevert(
            abi.encodeWithSelector(RwaVault.StalePriceFeed.selector, oracleTs, 24 hours)
        );
        vault.emergencyUnwindWithOverride(tokens);
    }

    /// @notice emergencyUnwind succeeds when the override flag is set, even
    ///         when the Chronicle feed is stale.
    function test_emergencyUnwind_succeedsWithStaleOverride() public {
        vm.startPrank(emergencyResponder);
        vault.setEmergencyUnwindStaleOverride(true);
        vm.stopPrank();

        vm.warp(block.timestamp + 25 hours);

        vm.prank(emergencyResponder);
        vault.emergencyUnwind();
        assertTrue(vault.paused(), "vault paused by emergencyUnwind");
    }

    /// @notice emergencyUnwindWithOverride succeeds when the override flag is
    ///         set, even when the Chronicle feed is stale.
    function test_emergencyUnwindWithOverride_succeedsWithStaleOverride() public {
        vm.prank(emergencyResponder);
        vault.setEmergencyUnwindStaleOverride(true);

        vm.warp(block.timestamp + 25 hours);

        address[] memory tokens = new address[](0);
        vm.prank(emergencyResponder);
        vault.emergencyUnwindWithOverride(tokens);
        assertTrue(vault.paused(), "vault paused by emergencyUnwindWithOverride");
    }

    /// @notice Only EMERGENCY_ROLE can set the stale override flag.
    function test_emergencyUnwindStaleOverride_onlyEmergencyRole() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert();
        vault.setEmergencyUnwindStaleOverride(true);
    }

    /// @notice Setting the stale override flag emits the expected event.
    function test_emergencyUnwindStaleOverride_emitsEvent() public {
        vm.prank(emergencyResponder);
        vm.expectEmit(true, true, true, true);
        emit RwaVault.EmergencyUnwindStaleOverrideUpdated(true);
        vault.setEmergencyUnwindStaleOverride(true);

        assertTrue(vault.emergencyUnwindStaleOverride(), "override flag set");
    }

    // ─── ChronicleOracleAdapter: constructor validation ───────────────────────

    /// @notice ChronicleOracleAdapter rejects zero-address for router.
    function test_adapter_rejectsZeroRouter() public {
        vm.expectRevert(abi.encodeWithSelector(ChronicleOracleAdapter.ZeroAddress.selector));
        new ChronicleOracleAdapter(
            address(0), // router = zero
            address(0xF00D),
            false,
            address(chronicle),
            address(despxa),
            address(usdc)
        );
    }

    /// @notice ChronicleOracleAdapter rejects zero-address for oracle.
    function test_adapter_rejectsZeroOracle() public {
        vm.expectRevert(abi.encodeWithSelector(ChronicleOracleAdapter.ZeroAddress.selector));
        new ChronicleOracleAdapter(
            address(aeroRouter),
            address(0xF00D),
            false,
            address(0), // oracle = zero
            address(despxa),
            address(usdc)
        );
    }

    // ─── ChronicleOracleAdapter: NAV price validation ──────────────────────────

    /// @notice ChronicleOracleAdapter rejects zero NAV price.
    function test_adapter_rejectsZeroNavPrice() public {
        chronicle.setPrice(0);
        vm.expectRevert(abi.encodeWithSelector(ChronicleOracleAdapter.BadNavPrice.selector, 0));
        adapter.twapPrice(address(pool), address(despxa), address(usdc), 1e18, 0);
    }

    /// @notice ChronicleOracleAdapter rejects NAV price below MIN_NAV.
    function test_adapter_rejectsNavPriceBelowMin() public {
        uint256 lowPrice = ChronicleOracleAdapter(address(adapter)).MIN_NAV() - 1;
        chronicle.setPrice(lowPrice);
        vm.expectRevert(
            abi.encodeWithSelector(ChronicleOracleAdapter.BadNavPrice.selector, lowPrice)
        );
        adapter.twapPrice(address(pool), address(despxa), address(usdc), 1e18, 0);
    }

    /// @notice ChronicleOracleAdapter rejects NAV price above MAX_NAV.
    function test_adapter_rejectsNavPriceAboveMax() public {
        uint256 highPrice = ChronicleOracleAdapter(address(adapter)).MAX_NAV() + 1;
        chronicle.setPrice(highPrice);
        vm.expectRevert(
            abi.encodeWithSelector(ChronicleOracleAdapter.BadNavPrice.selector, highPrice)
        );
        adapter.twapPrice(address(pool), address(despxa), address(usdc), 1e18, 0);
    }

    /// @notice ChronicleOracleAdapter accepts NAV price at MIN_NAV boundary.
    function test_adapter_acceptsNavPriceAtMinBoundary() public {
        uint256 minNav = ChronicleOracleAdapter(address(adapter)).MIN_NAV();
        chronicle.setPrice(minNav);
        adapter.twapPrice(address(pool), address(despxa), address(usdc), 1e18, 0);
    }

    /// @notice ChronicleOracleAdapter accepts NAV price at MAX_NAV boundary.
    function test_adapter_acceptsNavPriceAtMaxBoundary() public {
        uint256 maxNav = ChronicleOracleAdapter(address(adapter)).MAX_NAV();
        chronicle.setPrice(maxNav);
        adapter.twapPrice(address(pool), address(despxa), address(usdc), 1e18, 0);
    }

    /// @notice ChronicleOracleAdapter rejects zero NAV price in USDC→RWA direction.
    function test_adapter_rejectsZeroNavPrice_usdcToRwa() public {
        chronicle.setPrice(0);
        vm.expectRevert(abi.encodeWithSelector(ChronicleOracleAdapter.BadNavPrice.selector, 0));
        adapter.twapPrice(address(pool), address(usdc), address(despxa), 5 * ONE_USDC, 0);
    }

    /// @notice ChronicleOracleAdapter rejects NAV price below MIN_NAV in USDC→RWA direction.
    function test_adapter_rejectsNavPriceBelowMin_usdcToRwa() public {
        uint256 lowPrice = ChronicleOracleAdapter(address(adapter)).MIN_NAV() - 1;
        chronicle.setPrice(lowPrice);
        vm.expectRevert(
            abi.encodeWithSelector(ChronicleOracleAdapter.BadNavPrice.selector, lowPrice)
        );
        adapter.twapPrice(address(pool), address(usdc), address(despxa), 5 * ONE_USDC, 0);
    }

    /// @notice ChronicleOracleAdapter rejects NAV price above MAX_NAV in USDC→RWA direction.
    function test_adapter_rejectsNavPriceAboveMax_usdcToRwa() public {
        uint256 highPrice = ChronicleOracleAdapter(address(adapter)).MAX_NAV() + 1;
        chronicle.setPrice(highPrice);
        vm.expectRevert(
            abi.encodeWithSelector(ChronicleOracleAdapter.BadNavPrice.selector, highPrice)
        );
        adapter.twapPrice(address(pool), address(usdc), address(despxa), 5 * ONE_USDC, 0);
    }

    /// @notice RwaVault rejects zero-address for Chronicle oracle.
    function test_vault_rejectsZeroChronicle() public {
        // We must deploy StubSwapRouter before the expectRevert scope.
        StubSwapRouter swapRouter = new StubSwapRouter();
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("ZeroAddress()"))));
        new RwaVault(
            IERC20(address(usdc)),
            ISwapRouter(address(swapRouter)),
            IChronicleOracle(address(0)), // zero chronicle — should revert
            100_000 * ONE_USDC,
            10_000 * ONE_USDC,
            0,
            admin,
            admin,
            emergencyResponder
        );
    }
}
