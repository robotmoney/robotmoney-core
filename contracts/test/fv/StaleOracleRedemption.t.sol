// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (SUP-5, ORA-2)
//            docs/code-review/20260619-code-review-pekshield.md (NC-1, F-08)
//
// STALE-ORACLE REDEMPTION HARNESS (issue #964, AC4 — SCOUT STUB)
// ───────────────────────────────────────────────────────────────────────────────
// Pins two intertwined RWA-vault oracle properties:
//
//   - ORA-2 (HOLDS, fail-closed): a *price-sensitive* operation never executes
//     against a Chronicle feed older than the heartbeat. Today
//     RwaVault.totalAssets() → _checkOracleFreshness() reverts StalePriceFeed,
//     which correctly halts deposit/share-pricing when the feed is stale.
//
//   - SUP-5 (RED, NC-1): that same unconditional freshness check over-applies to
//     user `redeem` — it reverts even when the vault has already emergency-unwound
//     to idle USDC and holds zero priced RWA tokens, trapping already-safe funds
//     with no permissionless exit. The fix (remediation #966) must SHORT-CIRCUIT
//     freshness when no priced RWA is held, preserving ORA-2 for priced assets
//     while exempting idle-USDC redemption.
//
// SCOUT SCOPE: this file stands up the stale-feed handler shape — a mock Chronicle
// feed whose timestamp can be aged past the heartbeat — and two tests:
//   - test_ORA2_* (passing): documents the fail-closed property the fix must keep.
//   - test_SUP5_* (skipped/expected-fail): the NC-1 trap. Implementing it live
//     requires a faithful RwaVault deployment (swap router + Chronicle mock + a
//     seeded-then-unwound-to-idle state); that rig is built alongside the #966
//     freshness short-circuit. Until then the body is the expected-fail stub.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RwaVault} from "../../vaults/RwaVault.sol";
import {BasketVault} from "../../vaults/BasketVault.sol";
import {ChronicleOracleAdapter} from "../../adapters/ChronicleOracleAdapter.sol";
import {ISwapRouter} from "../../interfaces/ISwapRouter.sol";
import {IChronicleOracle} from "../../interfaces/IChronicleOracle.sol";
import {IAerodromeRouter} from "../../interfaces/IAerodromeRouter.sol";

/// @dev 18-dec deSPXA stand-in.
contract Sup5Token is ERC20 {
    constructor() ERC20("deSPXA", "deSPXA") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev 6-dec USDC stand-in.
contract Sup5Usdc is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Settable Chronicle NAV oracle.
contract Sup5Chronicle is IChronicleOracle {
    uint256 public price;
    uint256 public timestamp;

    constructor(uint256 price_, uint256 ts_) {
        price = price_;
        timestamp = ts_;
    }

    function setTimestamp(uint256 ts_) external {
        timestamp = ts_;
    }

    function latestAnswer() external view returns (uint256) {
        return price;
    }

    function latestTimestamp() external view returns (uint256) {
        return timestamp;
    }
}

/// @dev Uniswap V3 router stub (RwaVault never uses it; swaps go via Aerodrome).
contract Sup5StubV3Router is ISwapRouter {
    function exactInputSingle(ExactInputSingleParams calldata) external pure returns (uint256) {
        revert("unused");
    }
}

/// @dev Aerodrome router stub that disburses a pre-set output.
contract Sup5AeroRouter {
    using SafeERC20 for IERC20;

    uint256 public amountOut;

    error TooLittleReceived(uint256 amountOut, uint256 amountOutMin);

    function setAmountOut(uint256 v) external {
        amountOut = v;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        IAerodromeRouter.Route[] calldata routes,
        address to,
        uint256
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

/// @dev deSPXA pool stub: satisfies addAsset cardinality/liquidity gates.
contract Sup5Pool {
    address public immutable token0;
    address public immutable token1;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1 << 96), 0, 0, 100, 100, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        pure
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
    }

    function liquidity() external pure returns (uint128) {
        return 1e18;
    }
}

/// @dev Minimal Chronicle-feed mock: a settable latest-update timestamp so a test
///      can age the feed past any heartbeat. Mirrors the IChronicleOracle surface
///      RwaVault._checkOracleFreshness reads (`latestTimestamp()`).
contract MockChronicleFeed {
    uint256 public latestTimestamp;
    uint256 public latestValue;

    function set(uint256 value, uint256 updatedAt) external {
        latestValue = value;
        latestTimestamp = updatedAt;
    }

    /// @notice Age the feed so it is `staleness` seconds older than `now`.
    function age(uint256 staleness) external {
        latestTimestamp = block.timestamp > staleness ? block.timestamp - staleness : 0;
    }
}

contract StaleOracleRedemptionTest is Test {
    MockChronicleFeed internal feed;
    uint256 internal constant HEARTBEAT = 1 hours;

    function setUp() public {
        // Warp well past the heartbeat so a feed can be aged into the past without
        // underflowing to zero (forge's default block.timestamp is 1).
        vm.warp(365 days);
        feed = new MockChronicleFeed();
        feed.set(1e18, block.timestamp);
    }

    /// @notice ORA-2 (HOLDS): the freshness predicate the vault enforces — a feed
    ///         older than the heartbeat is stale (fail-closed). Asserts the mock's
    ///         staleness arithmetic so the SUP-5 harness builds on a verified
    ///         notion of "stale". The behavioural revert proof on a live RwaVault
    ///         lives in RwaVault.t.sol (deposit halts on stale feed).
    function test_ORA2_feedOlderThanHeartbeatIsStale() public {
        // Fresh: updatedAt == now → not stale.
        feed.set(1e18, block.timestamp);
        assertFalse(_isStale(feed.latestTimestamp(), HEARTBEAT), "fresh feed flagged stale");

        // Aged just past the heartbeat → stale.
        feed.age(HEARTBEAT + 1);
        assertTrue(_isStale(feed.latestTimestamp(), HEARTBEAT), "aged feed not flagged stale");
    }

    /// @notice SUP-5 (RED, NC-1): a user `redeem` succeeds when the vault holds
    ///         zero priced RWA tokens (already unwound to idle USDC), even while
    ///         the Chronicle feed is stale. On current HEAD redeem reverts
    ///         StalePriceFeed unconditionally, trapping safe funds. When #966 lands
    ///         the freshness short-circuit, remove the skip and assert the redeem
    ///         returns the holder's idle USDC.
    // SUP-5 rig fields (storage to keep the test body off the stack).
    RwaVault internal sup5Vault;
    Sup5Usdc internal sup5Usdc_;
    Sup5Token internal sup5Despxa;
    Sup5Chronicle internal sup5Chronicle;
    Sup5AeroRouter internal sup5Aero;
    address internal sup5Admin = makeAddr("sup5Admin");
    address internal sup5Emergency = makeAddr("sup5Emergency");
    address internal sup5Holder = makeAddr("sup5Holder");

    /// @dev Deploy + wire the RwaVault rig into storage (keeps the test body small
    ///      enough to avoid stack-too-deep without viaIR).
    function _deploySup5Rig() internal {
        sup5Usdc_ = new Sup5Usdc();
        sup5Despxa = new Sup5Token();
        sup5Chronicle = new Sup5Chronicle(5e18, block.timestamp); // 5 USDC/deSPXA, fresh
        sup5Aero = new Sup5AeroRouter();

        (address t0, address t1) = address(sup5Despxa) < address(sup5Usdc_)
            ? (address(sup5Despxa), address(sup5Usdc_))
            : (address(sup5Usdc_), address(sup5Despxa));
        Sup5Pool pool = new Sup5Pool(t0, t1);
        ChronicleOracleAdapter adapter = new ChronicleOracleAdapter(
            address(sup5Aero),
            address(0xF00D),
            false,
            address(sup5Chronicle),
            address(sup5Despxa),
            address(sup5Usdc_)
        );

        sup5Vault = new RwaVault(
            IERC20(address(sup5Usdc_)),
            ISwapRouter(address(new Sup5StubV3Router())),
            IChronicleOracle(address(sup5Chronicle)),
            type(uint256).max,
            type(uint256).max,
            0,
            sup5Admin,
            sup5Admin,
            sup5Emergency
        );

        vm.startPrank(sup5Admin);
        sup5Vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        sup5Vault.addAsset(
            address(sup5Despxa), address(pool), 0, address(adapter), BasketVault.Venue.Aerodrome
        );
        vm.stopPrank();
    }

    function test_SUP5_idleUsdcRedeemSurvivesStaleFeed() public {
        _deploySup5Rig();

        // Deposit while fresh: vault swaps USDC→deSPXA, holder gets shares.
        sup5Despxa.mint(address(sup5Aero), 200e18);
        sup5Aero.setAmountOut(200e18);
        sup5Usdc_.mint(sup5Holder, 1_000e6);
        vm.startPrank(sup5Holder);
        sup5Usdc_.approve(address(sup5Vault), 1_000e6);
        uint256 shares = sup5Vault.deposit(1_000e6, sup5Holder);
        vm.stopPrank();
        assertGt(shares, 0, "shares minted");

        // ADMIN arms stale-override (ACL-5); EMERGENCY unwinds to idle USDC.
        sup5Aero.setAmountOut(1_000e6);
        sup5Usdc_.mint(address(sup5Aero), 1_000e6);
        vm.prank(sup5Admin);
        sup5Vault.setEmergencyUnwindStaleOverride(true);
        vm.prank(sup5Emergency);
        sup5Vault.emergencyUnwind();
        assertEq(sup5Despxa.balanceOf(address(sup5Vault)), 0, "unwound to zero deSPXA");

        // Feed goes stale. SUP-5: redeem of idle USDC must NOT revert StalePriceFeed.
        sup5Chronicle.setTimestamp(1);
        uint256 before = sup5Usdc_.balanceOf(sup5Holder);
        vm.prank(sup5Holder);
        uint256 out = sup5Vault.redeem(shares, sup5Holder, sup5Holder);
        assertGt(out, 0, "idle-USDC redeem returns proceeds under a stale feed");
        assertGt(sup5Usdc_.balanceOf(sup5Holder) - before, 0, "holder received idle USDC");
    }

    /// @dev Mirror of RwaVault._checkOracleFreshness's staleness condition:
    ///      `block.timestamp > updatedAt + heartbeat`.
    function _isStale(uint256 updatedAt, uint256 heartbeat) internal view returns (bool) {
        return block.timestamp > updatedAt + heartbeat;
    }
}
