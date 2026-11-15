// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md §4.1 (A1 to A19: the attacker's full profit and loss),
//            §5 work packages 2 and 6; docs/technical/one-vault-rebalancer-proposal.md §5.9 (hardened flows: §5.9.1 the
//            attack and the principle, §5.9.3 one settlement, §5.9.4 exits and emergency powers), §7 (RB-10 to RB-18,
//            RB-20 to RB-22), §10 step 3d, §13 G8; scaffold plan §7.6 (`attack-tests`)
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PrototypeHarness} from "./PrototypeHarness.sol";
import {BaselineHarness} from "./baseline/BaselineHarness.sol";
import {SimLib} from "./sim/SimLib.sol";
import {
    AssetConfig,
    AssetKind,
    BPS,
    IDLE_INDEX,
    IFundEvents,
    PRICE_SCALE,
    PlanParams,
    PlanStatus,
    SkipReason,
    StepOrder,
    Venue
} from "./src/FundTypes.sol";
import {
    PlanParams as BaselinePlanParams,
    PlanStatus as PlanStatusB
} from "./baseline/src/FundTypes.sol";
import {
    Claim,
    FlowBooks,
    FlowLevers,
    FlowParams,
    IFlowEvents,
    QueueLiveness,
    Quote,
    Request,
    RequestKind,
    RequestStatus,
    Settlement,
    SettleCheck
} from "./src/FlowTypes.sol";
import {IRobotMoneyFund} from "./src/interfaces/IRobotMoneyFund.sol";
import {IRobotMoneyFund as IBaselineFund} from "./baseline/src/interfaces/IRobotMoneyFund.sol";
import {IRebalancer} from "./src/interfaces/IRebalancer.sol";
import {FundExclusionLedger} from "./src/FundExclusionLedger.sol";
import {FundValuationLib} from "./src/lib/FundValuationLib.sol";
import {MechAaveAdapter} from "./mocks/MechAaveAdapter.sol";
import {MechSwapAdapter} from "./mocks/MechSwapAdapter.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  Shared types and interfaces (named so they never clash with the two harnesses' own)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/// @notice One attack's profit and loss (eng plan §4.1, gate G8). Every amount is in USDC units (6 decimals), valued
///         at the REFERENCE prices: each basket token at its pool's spot when the attack starts, each fund share at the
///         fund's NAV per share at those prices. A held token or share therefore counts at what it was worth before
///         the attacker touched anything, so a price the attacker moved never inflates its own result.
/// @param attackerNet   The attacker's value at the end minus its value at the start, with a flash-loan fee of 0
///                      (Morpho). This is the number G8 scores (the stricter case for the defender).
/// @param flashBorrowed The USDC value the attacker spent in its one-transaction price moves: what a flash loan had
///                      to lend. The report also shows the net after Aave V3's 5 bps fee on it.
/// @param holdersLoss   NAV the share supply after the attack lost against the NAV per share before it, at the
///                      reference prices (0 when it rose). Every holder's loss is inside this number.
/// @param pendingLoss   What pending users paid more (or received less) than in the same settlement without the
///                      attack. 0 where no counterfactual applies.
/// @param navRef        NAV at the reference prices when the attack started (the G8 1 bps scale).
struct AttackPnl {
    int256 attackerNet;
    uint256 flashBorrowed;
    uint256 holdersLoss;
    uint256 pendingLoss;
    uint256 navRef;
}

interface IAtkPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function tickSpacing() external view returns (int24);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount,
        bytes calldata data
    ) external returns (uint256 amount0, uint256 amount1);
    function burn(int24 tickLower, int24 tickUpper, uint128 amount)
        external
        returns (uint256 amount0, uint256 amount1);
    function collect(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external returns (uint128 amount0, uint128 amount1);
}

/// @dev SwapRouter02 `exactInputSingle` (no deadline field). A non-zero `sqrtPriceLimitX96` stops the swap at that
///      price and the router pulls only the input the pool used, so the pool sizes a push to a target price.
interface IAtkRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        payable
        returns (uint256 amountOut);
}

interface IAtkAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getReserveNormalizedIncome(address asset) external view returns (uint256);
}

interface IAtkLendingAdapter {
    function totalAssets() external view returns (uint256);
}

interface IAtkRateAdapter {
    function ratePerUnit() external view returns (uint256);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  AttackBook: the profit-and-loss report and the price-move helpers both attack contracts share
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/// @notice Mixin for the two attack contracts (timed fund, frozen baseline). It holds no state and names no harness
///         symbol, so it linearizes after either harness without a clash.
abstract contract AttackBook is Test {
    using Math for uint256;

    /// @dev Aave V3's flash-loan premium (eng plan §4.1). Morpho's is 0.
    uint256 internal constant AAVE_FLASH_FEE_BPS = 5;
    /// @dev G8: holders lose at most 1 bps of NAV (proposal §13).
    uint256 internal constant G8_HOLDER_LOSS_BPS = 1;
    /// @dev G8: no way to block settlement for a day may cost less than 1,000 USDC (proposal §13, a proposal the
    ///      owner can change until step 3d runs).
    uint256 internal constant G8_BLOCK_FLOOR_USDC = 1_000e6;
    /// @dev SwapRouter02 on Base (the harnesses' `ROUTER`).
    address internal constant ATK_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    /// @notice Log one attack's result, human-readable and as one `G8` line that the verify agent can collect:
    ///         `id,attackerNet,attackerNetAaveFee,flashBorrowed,holdersLoss,pendingLoss,navRef`.
    function _reportPnl(string memory id, AttackPnl memory r) internal {
        int256 aave = r.attackerNet - int256(r.flashBorrowed.mulDiv(AAVE_FLASH_FEE_BPS, BPS));
        emit log_named_string("attack", id);
        emit log_named_int("  attacker net (flash fee 0, Morpho)", r.attackerNet);
        emit log_named_int("  attacker net (flash fee 5 bps, Aave V3)", aave);
        emit log_named_uint(
            "  flash borrowed (USDC value of the one-transaction legs)", r.flashBorrowed
        );
        emit log_named_uint("  holders' loss at reference prices", r.holdersLoss);
        emit log_named_uint("  pending users' loss against the honest settlement", r.pendingLoss);
        emit log_named_uint("  NAV at reference prices", r.navRef);
        emit log_named_string(
            "G8",
            string.concat(
                id,
                ",",
                vm.toString(r.attackerNet),
                ",",
                vm.toString(aave),
                ",",
                vm.toString(r.flashBorrowed),
                ",",
                vm.toString(r.holdersLoss),
                ",",
                vm.toString(r.pendingLoss),
                ",",
                vm.toString(r.navRef)
            )
        );
    }

    /// @notice G8 (proposal §13): the attacker's net is at most zero and the holders lose at most 1 bps of NAV.
    function _assertG8(string memory id, AttackPnl memory r) internal pure {
        assertLe(r.attackerNet, 0, string.concat(id, ": G8 fail, the attacker's net is positive"));
        assertLe(
            r.holdersLoss,
            r.navRef.mulDiv(G8_HOLDER_LOSS_BPS, BPS),
            string.concat(id, ": G8 fail, holders lost more than 1 bps of NAV")
        );
    }

    /// @notice G8 where the measured result may be a design finding rather than a code defect: when the attacker's
    ///         net is positive (or a blocking way costs less than its floor), the test does not pass and does not
    ///         weaken the check. It logs `G8 FINDING` and is skipped with the measured number in the reason (scaffold
    ///         plan §7.6: a failing test that shows a defect stays in place, skipped with the reason, and goes into
    ///         defects.md). The holders' bound is always asserted.
    function _g8OrFinding(string memory id, AttackPnl memory r) internal {
        assertLe(
            r.holdersLoss,
            r.navRef.mulDiv(G8_HOLDER_LOSS_BPS, BPS),
            string.concat(id, ": G8 fail, holders lost more than 1 bps of NAV")
        );
        if (r.attackerNet <= 0) return;
        string memory why = string.concat(
            id,
            ": G8 FINDING, the attacker nets +",
            vm.toString(r.attackerNet),
            " USDC units (see defects.md)"
        );
        _finding(why);
    }

    /// @dev Record a G8 finding: skipped with the reason by default; PROTO_ATTACK_FINDINGS_FAIL=1 makes it fail
    ///      instead, so `forge test -vv` prints every log line of the attack (a skipped test prints none).
    function _finding(string memory why) internal {
        emit log_named_string("G8 FINDING", why);
        if (vm.envOr("PROTO_ATTACK_FINDINGS_FAIL", false)) revert(why);
        vm.skip(true, why);
    }

    /// @notice G8's blocking floor (proposal §13): a way to block settlement for a day must cost at least
    ///         1,000 USDC. Below it the test logs `G8 FINDING` and is skipped with the measured cost (see
    ///         `_g8OrFinding`).
    function _g8BlockFloorOrFinding(string memory id, uint256 costPerDayUsdc) internal {
        emit log_named_uint(
            string.concat(id, ": cost to block for a day (USDC units)"), costPerDayUsdc
        );
        if (costPerDayUsdc >= G8_BLOCK_FLOOR_USDC) return;
        _finding(
            string.concat(
                id,
                ": G8 FINDING, blocking for a day costs ",
                vm.toString(costPerDayUsdc),
                " USDC units < 1,000 USDC"
            )
        );
    }

    /// @notice Spot price of one whole `token` in USDC units at `pool` (raw `slot0`, no TWAP).
    function _spotPx(address pool, address token, address usdc) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IAtkPool(pool).slot0();
        uint256 unit = 10 ** IERC20Metadata(token).decimals();
        return SimLib.spotUsdc(unit, sqrtP, IAtkPool(pool).token0() == usdc);
    }

    /// @notice `who` moves `token`'s USDC price at `pool` by `bps` (positive: buys the token with USDC; negative:
    ///         sells the token) through SwapRouter02 with a price limit, so the pool stops exactly at the target and
    ///         `who` pays only the input it used. `who` must already hold enough of the input (a flash loan in the
    ///         test). Returns the input spent (USDC, or token units when selling) and the output received.
    function _pushBps(address who, address pool, address token, address usdc, int256 bps)
        internal
        returns (uint256 spent, uint256 got)
    {
        require(bps != 0, "push: zero");
        IAtkPool p = IAtkPool(pool);
        (uint160 sqrtP,,,,,,) = p.slot0();
        bool up = bps > 0;
        uint256 a = up ? uint256(bps) : uint256(-bps);
        // sqrt of the price factor, 1e18 scale.
        uint256 sqrtF = Math.sqrt((up ? BPS + a : BPS - a) * 1e36 / BPS);
        // The token's USDC price moves with sqrtP² when the token is token0 (price = token1 per token0), and with
        // 1 / sqrtP² when it is token1. `sqrtF` already carries the direction (above or below 1e18).
        uint160 target = p.token0() == token
            ? uint160(uint256(sqrtP).mulDiv(sqrtF, 1e18))
            : uint160(uint256(sqrtP).mulDiv(1e18, sqrtF));
        (spent, got) = _swapTo(who, pool, up ? usdc : token, up ? token : usdc, target);
    }

    /// @notice `who` swaps `tokenIn` for `tokenOut` at `pool` until the pool's sqrt price reaches `target`, using
    ///         at most its whole `tokenIn` balance. Returns the input spent and the output received.
    function _swapTo(address who, address pool, address tokenIn, address tokenOut, uint160 target)
        internal
        returns (uint256 spent, uint256 got)
    {
        uint256 inBefore = IERC20(tokenIn).balanceOf(who);
        uint256 outBefore = IERC20(tokenOut).balanceOf(who);
        vm.startPrank(who);
        IERC20(tokenIn).approve(ATK_ROUTER, inBefore);
        IAtkRouter(ATK_ROUTER)
            .exactInputSingle(
                IAtkRouter.ExactInputSingleParams(
                    tokenIn, tokenOut, IAtkPool(pool).fee(), who, inBefore, 0, target
                )
            );
        IERC20(tokenIn).approve(ATK_ROUTER, 0);
        vm.stopPrank();
        spent = inBefore - IERC20(tokenIn).balanceOf(who);
        got = IERC20(tokenOut).balanceOf(who) - outBefore;
        (uint160 sqrtNow,,,,,,) = IAtkPool(pool).slot0();
        assertEq(sqrtNow, target, "push: the pool reached the target price (input was enough)");
    }

    /// @notice `who` sells exactly `amountIn` of `tokenIn` for `tokenOut` at `pool` (no limit). The unwind of a push.
    function _sellExact(
        address who,
        address pool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal returns (uint256 got) {
        if (amountIn == 0) return 0;
        vm.startPrank(who);
        IERC20(tokenIn).approve(ATK_ROUTER, amountIn);
        got = IAtkRouter(ATK_ROUTER)
            .exactInputSingle(
                IAtkRouter.ExactInputSingleParams(
                    tokenIn, tokenOut, IAtkPool(pool).fee(), who, amountIn, 0, 0
                )
            );
        vm.stopPrank();
    }

    /// @notice Signed difference `a − b` of two USDC values.
    function _diff(uint256 a, uint256 b) internal pure returns (int256) {
        return int256(a) - int256(b);
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  A1 to A19 against the timed fund (step 3d)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/// @title AttacksTimedTest
/// @notice Eng plan §4.1 against the step 3d fund and its FlowQueue, on the real Base fixture (no RPC). Each test plays
///         the attacker on real pools and real lending venues, then computes the attacker's full net result, the
///         holders' loss and the pending users' loss (`AttackPnl`), logs them (`G8` lines) and asserts G8 where the
///         design claims it.
///
///         The market model is deterministic and has NO arbitrageur: a price the attacker moves stays where it is
///         until the attacker moves it back. That is the attacker's best case for holding a price (holding is free)
///         and the defender's worst. The sim's arbitrage model (A2, A6, A9, A10 in `sim/AttackSim.t.sol`) prices
///         holding against arbitrage; it is not built in this scaffold.
///
///         Valuation: see `AttackPnl`. The reference prices are the pools' spot when the attack starts, after the
///         world's own trades and `alignFeedsToPools` (a market at rest, feed and pool agreeing).
///
///         Fixture coverage: every test carries `fixtureCovered` and calls `coverageCheckpoint()` between phases.
///         Until the verify agent re-records the fixture, every test here stops at the queue's first USDC slot
///         (requests.md, integrate's entry). Run with PROTO_FIXTURE_CHECK=0 to see the attack logic (diagnostic only).
contract AttacksTimedTest is PrototypeHarness, AttackBook {
    using Math for uint256;

    address internal attacker = makeAddr("attacker");
    address internal alice = makeAddr("alice");
    address internal victim = makeAddr("victim");
    address internal victim2 = makeAddr("victim2");
    address internal dave = makeAddr("dave");

    /// @dev Alice, the holder the attacks aim at, deposits this through the queue in `_world`.
    uint256 internal constant ALICE_USDC = 100_000e6;
    /// @dev A flash loan large enough for every push below; only what a push spends counts as borrowed.
    uint256 internal constant FLASH_USDC = 30_000_000e6;
    /// @dev A pending user's margin over the quote when setting a limit (E21: a client sets the limit from it).
    uint256 internal constant LIMIT_MARGIN_BPS = 50;

    /// @dev Reference prices (USDC per whole token) fixed at the attack start (`_setRef`).
    uint256 internal refWeth;
    uint256 internal refCbbtc;

    /// @dev The fund's state at the attack start (`_snap`).
    struct Snap {
        uint256 navRef;
        uint256 supply;
        uint256 idle;
        uint256[] held;
    }

    // Per-attack bookkeeping, in storage because the attack bodies are long (`_begin`, `_startAttacker`, `_end`).
    Snap internal s0;
    uint256 internal v0;
    uint256 internal borrowed;
    uint256 internal pending;
    /// @dev A result the attacker made outside its own address (A18: the LP position this contract holds).
    int256 internal extraNet;

    function setUp() public override {
        super.setUp();
        vm.label(attacker, "attacker");
        vm.label(alice, "alice");
        vm.label(victim, "victim");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A1: Makina replay. One transaction: a flash loan, a pushed pool, then every flow the attacker can start.
    //  Expected (eng plan §4.1): no flow settles in one transaction.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_A1_makinaReplay_oneTransaction_wethPool() public fixtureCovered {
        _a1(WETH_POOL, WETH, "A1 timed wETH");
    }

    function test_A1_makinaReplay_oneTransaction_cbbtcPool() public fixtureCovered {
        _a1(CBBTC_POOL, CBBTC, "A1 timed cbBTC");
    }

    /// @dev The attacker already holds shares from an honest deposit. In ONE transaction (no warp, no roll) it
    ///      borrows, pushes `pool` 300 bps up (past every band), and then tries every flow: the fund's own entry
    ///      points, a deposit request, a redemption request, `settle` (as itself and as the keeper would), and an
    ///      in-kind exit of the rest. It cancels the requests, takes its credits and sells back what it bought.
    function _a1(address pool, address token, string memory id) private {
        _world();
        uint256 atkShares = deposit(attacker, 20_000e6);
        _takeCredit(attacker);
        alignFeedsToPools();
        refreshFeeds();
        coverageCheckpoint();
        _begin();
        uint256 t0 = block.timestamp;
        uint256 b0 = block.number;
        uint256 claims0 = queue.claimCount();
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        uint256 bought;
        (borrowed, bought) = _pushBps(attacker, pool, token, USDC, 300);
        _a1Flows(atkShares);
        _sellExact(attacker, pool, token, USDC, bought);
        assertEq(block.timestamp, t0, "one transaction: no time passed");
        assertEq(block.number, b0, "one transaction: no block passed");
        assertEq(queue.claimCount(), claims0, "no claim was made: nothing settled");
        _end(id, true);
    }

    /// @dev A1's flows, all inside the one transaction, with the pool pushed.
    function _a1Flows(uint256 atkShares) private {
        // The fund itself takes no flow (E2).
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.UseFlowQueue.selector, address(queue))
        );
        fund.deposit(1e6, attacker);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.UseFlowQueue.selector, address(queue))
        );
        fund.redeem(1, attacker, attacker);

        // Requests only escrow. Nothing settles in this transaction (check 1, the window).
        uint256 dep = _reqDeposit(attacker, 100_000e6, type(uint256).max);
        uint256 red = openRedeemRequest(attacker, atkShares / 2, 0);
        bytes memory window = abi.encodeWithSelector(
            IFlowEvents.SettleBlocked.selector, SettleCheck.Window, IDLE_INDEX, 0
        );
        vm.prank(attacker);
        vm.expectRevert(window);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        vm.prank(keeper);
        vm.expectRevert(window);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);

        // E29 / RB-26: in-kind exit is closed while the fund is running (opens only in WindDown).
        uint256 rest = fund.balanceOf(attacker);
        vm.prank(attacker);
        vm.expectRevert(IRobotMoneyFund.InKindClosed.selector);
        fund.redeemInKind(rest, attacker, attacker);

        // Price-free exits of the requests.
        vm.startPrank(attacker);
        queue.cancel(dep);
        queue.cancel(red);
        queue.withdrawCredit();
        vm.stopPrank();
        assertEq(
            uint8(queue.requestStatus(dep)),
            uint8(RequestStatus.Closed),
            "the deposit request never filled"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A2 (deterministic part): a TWAP push held through the settlement window, with no arbitrage.
    //  Expected: holders lose nothing; a push past refBandBps blocks; inside it the per-swap limit bounds a user's
    //  loss and the attacker's net is at most zero. The sim version (against arbitrage) is sim/AttackSim.t.sol.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev The attacker holds shares and asks to redeem all of them. It pushes wETH up to 10 bps inside the band
    ///      (`refBandBps` − 10: +80 bps at the default band of 90; it was +40 inside 50) right after the request and
    ///      holds it, free, through the window and every block the redemption takes to fill (the per-call cap
    ///      splits it, one keeper call per block), so the fund sells the attacker's wETH slice into the pushed pool.
    ///      Then it sells back what it bought and takes its USDC.
    function test_A2_pushHeldInsideBand_redeemerSellsIntoIt_noArbitrage() public fixtureCovered {
        _world();
        uint256 atkShares = deposit(attacker, 100_000e6);
        _takeCredit(attacker);
        alignFeedsToPools();
        refreshFeeds();
        coverageCheckpoint();
        _begin();
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        uint256 id = openRedeemRequest(attacker, atkShares, 0);
        int256 push = int256(uint256(queue.flowParams().refBandBps)) - 10;
        uint256 bought;
        (borrowed, bought) = _pushBps(attacker, WETH_POOL, WETH, USDC, push);
        warpToSettleable(id);
        refreshFeeds();
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Ok), "a push inside refBandBps passes check 4");
        assertGt(_settleOverBlocks(keeper, id, 64), 0, "the redemption traded");
        assertEq(
            uint8(queue.requestStatus(id)), uint8(RequestStatus.Closed), "the redemption settled"
        );
        _sellExact(attacker, WETH_POOL, WETH, USDC, bought);
        _claimRedeemUsdc(attacker);
        _end(
            string.concat(
                "A2 timed, push +",
                vm.toString(push),
                " bps (band - 10) held through the window, no arbitrage"
            ),
            true
        );
    }

    /// @dev A push past `refBandBps` (band + 20 bps: +110 at the default 90) held over the window blocks the
    ///      settlement at check 4: nothing trades, the request stays pending, and the attacker pays the round trip
    ///      for nothing.
    function test_A2_pushHeldPastBand_blocksAndNothingTrades() public fixtureCovered {
        _world();
        _begin();
        uint256 vid = _victimDeposit(victim, 50_000e6);
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        int256 push = int256(uint256(queue.flowParams().refBandBps)) + 20;
        uint256 bought;
        (borrowed, bought) = _pushBps(attacker, WETH_POOL, WETH, USDC, push);
        warpToSettleable(vid);
        refreshFeeds();
        uint256 queueUsdc = IERC20(USDC).balanceOf(address(queue));
        uint256 supply = fund.totalSupply();
        vm.prank(keeper);
        (SettleCheck check, uint256 index) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.TwapVsFeed), "check 4 names the push");
        assertEq(index, IDX_WETH, "on wETH");
        vm.prank(keeper);
        vm.expectPartialRevert(IFlowEvents.SettleBlocked.selector);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertEq(IERC20(USDC).balanceOf(address(queue)), queueUsdc, "RB-12: nothing traded");
        assertEq(fund.totalSupply(), supply, "RB-12: nothing minted");
        assertEq(queue.getRequest(vid).remaining, 50_000e6, "the request stays pending");
        _sellExact(attacker, WETH_POOL, WETH, USDC, bought);
        _end(
            string.concat("A2 timed, push +", vm.toString(push), " bps (band + 20) held: blocked"),
            true
        );
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A3: deflate, deposit, exit. Expected: the mint reads no price.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev The attacker sells wETH to deflate the pool 10 bps inside the band (`refBandBps` − 10: −80 bps at the
    ///      default 90; it was −40 inside 50) and holds it through the window and every block its deposit takes to
    ///      fill, asks to deposit, lets the fund buy its pro-rata wETH cheap, then buys its wETH back, waits out the
    ///      hold and exits through the queue. The mint is by quantity, so cheaper wETH lowers the depositor's cost by
    ///      exactly what the attacker's own deflation gave away to the pool.
    function test_A3_deflateDepositExit_mintReadsNoPrice() public fixtureCovered {
        _world();
        _begin();
        fundUsdc(attacker, 1_000_000e6);
        deal(WETH, attacker, uint256(1_000_000e6).mulDiv(1e18, refWeth));
        _startAttacker();

        uint256 id = _reqDeposit(attacker, 100_000e6, type(uint256).max);
        int256 push = 10 - int256(uint256(queue.flowParams().refBandBps));
        (uint256 sold, uint256 usdcGot) = _pushBps(attacker, WETH_POOL, WETH, USDC, push);
        borrowed = sold.mulDiv(refWeth, 1e18);
        warpToSettleable(id);
        refreshFeeds();
        assertGt(_settleOverBlocks(keeper, id, 64), 0, "the deposit traded");
        assertEq(
            uint8(queue.requestStatus(id)),
            uint8(RequestStatus.Closed),
            "the deposit settled in the deflation"
        );
        _sellExact(attacker, WETH_POOL, USDC, WETH, usdcGot);
        coverageCheckpoint();
        uint256 shares = deliverAfterHold(attacker);
        _takeCredit(attacker);
        redeem(attacker, shares);
        _end(
            string.concat(
                "A3 timed, deflate ", vm.toString(push), " bps (band - 10), deposit, exit"
            ),
            true
        );
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A4: lending exchange rate moved by a gift or by supply. Expected: a gift to the adapter is a gift to holders
    //  and does not move the venue's rate; a real rate jump over the bound blocks.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_A4_lendingRate_giftDoesNotMoveRate_realJumpBlocks() public fixtureCovered {
        _world();
        _begin();
        // Step 3f (D17/E25): requests carry no per-request limit; both pending deposits fill after a gift, and
        // the gift accrues pro rata to holders.
        uint256 tight = _victimDeposit(victim, 50_000e6);
        uint256 loose = openDepositRequest(victim2, 50_000e6, type(uint256).max);
        warpToSettleable(loose);
        refreshFeeds();

        // A gift to the adapter, by supply on its behalf: the venue's rate does not move, check 5 passes.
        uint256 rate0 = IAtkRateAdapter(address(aaveAdapter)).ratePerUnit();
        uint256 gift = 10_000e6;
        fundUsdc(attacker, gift);
        _startAttacker();
        vm.startPrank(attacker);
        IERC20(USDC).approve(AAVE_POOL, gift);
        IAtkAavePool(AAVE_POOL).supply(USDC, gift, address(aaveAdapter), 0);
        vm.stopPrank();
        assertEq(
            IAtkRateAdapter(address(aaveAdapter)).ratePerUnit(),
            rate0,
            "a gift does not move the venue rate"
        );
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Ok), "check 5 passes after the gift");
        assertGt(_settleOverBlocks(keeper, loose, 8), 0, "gift-era deposits settle across blocks");
        assertEq(
            uint8(queue.requestStatus(tight)),
            uint8(RequestStatus.Closed),
            "first forward deposit settled after the gift"
        );
        assertEq(
            uint8(queue.requestStatus(loose)),
            uint8(RequestStatus.Closed),
            "second forward deposit settled"
        );
        AttackPnl memory r = _end("A4 timed, a 10,000 USDC gift to the Aave adapter", true);
        assertLe(
            r.attackerNet,
            -int256(gift * 99 / 100),
            "the gifter loses its gift (less any pro-rata share)"
        );

        // E36 / SAFE-09 / RB-28: a real jump of the venue's own rate (+1 %, far over 10 bps/day) stops
        // deposits & matching for that round (DepositStoppedForRound, cause 2), while redemptions still settle.
        uint256 v2 = openDepositRequest(dave, 50_000e6, type(uint256).max);
        uint256 r2 = openRedeemRequest(alice, fund.balanceOf(alice) / 10, 0);
        warpToSettleable(v2);
        refreshFeeds();
        // Mock the adapter's rate view directly so the Aave V3 pool's own `aToken.balanceOf` / `withdraw`
        // index math stays internally consistent while Check 5 sees a +1% venue rate jump.
        uint256 rate1 = IAtkRateAdapter(address(aaveAdapter)).ratePerUnit();
        vm.mockCall(
            address(aaveAdapter),
            abi.encodeWithSelector(IAtkRateAdapter.ratePerUnit.selector),
            abi.encode(rate1 + rate1 / 100)
        );
        vm.prank(keeper);
        (check,) = queue.checkSettle();
        assertEq(
            uint8(check),
            uint8(SettleCheck.Ok),
            "E36: preTrade stays Ok so redemptions settle during rate stop"
        );
        uint256 aliceShares0 = queue.getRequest(r2).remaining;
        uint256 supply0 = fund.totalSupply();
        uint64 stopEpoch = queue.getRequest(v2).epoch;
        vm.recordLogs();
        vm.prank(keeper);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertTrue(
            _sawDepositStopped(stopEpoch, 2),
            "E36: DepositStoppedForRound cause 2 emitted on rate jump"
        );
        assertEq(queue.getRequest(v2).remaining, 50_000e6, "the deposit waits under check 5 stop");
        assertLt(queue.getRequest(r2).remaining, aliceShares0, "redemptions still settle under rate stop");
        assertLt(fund.totalSupply(), supply0, "no deposit minted; net redemption burned shares");
        vm.clearMockedCalls();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A5: round trip in one block and in consecutive blocks. Expected: impossible (RB-10, RB-11).
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_A5_roundTrip_oneBlockAndConsecutiveBlocks_impossible() public fixtureCovered {
        _world();
        _begin();
        fundUsdc(attacker, 50_000e6);
        _startAttacker();
        uint256 id = _reqDeposit(attacker, 50_000e6, type(uint256).max);
        _a5OneBlock(id);
        uint64 unlockAt = _a5SettleAndHold(id);
        coverageCheckpoint();

        // The fastest full round trip: delivery at the unlock, a redemption in the next epoch.
        uint256 shares = deliverAfterHold(attacker);
        _takeCredit(attacker);
        uint256 rid = openRedeemRequest(attacker, shares, 0);
        settleUntilFilled(rid);
        _claimRedeemUsdc(attacker);
        assertGe(
            block.timestamp,
            uint256(unlockAt) + queue.flowParams().settleWindow,
            "USDC comes back no sooner than the hold plus a window"
        );
        _end("A5 timed, the fastest round trip", true);
    }

    /// @dev In the request's block, then in the next block: nothing settles, nothing is delivered, no exit.
    function _a5OneBlock(uint256 id) private {
        bytes memory window = abi.encodeWithSelector(
            IFlowEvents.SettleBlocked.selector, SettleCheck.Window, IDLE_INDEX, 0
        );
        vm.prank(keeper);
        vm.expectRevert(window);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, 1, 0));
        queue.mint(1, attacker);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.WrongRequestKind.selector, id));
        queue.giveRedemptionNotice(id);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 2);
        vm.prank(keeper);
        vm.expectRevert(window);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
    }

    /// @dev The settlement, then the hold: no share leaves before settle time + minHold (RB-11).
    function _a5SettleAndHold(uint256 id) private returns (uint64 unlockAt) {
        warpToSettleable(id);
        refreshFeeds();
        vm.prank(keeper);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        uint256 claimId = queue.claimCount();
        Claim memory c = queue.getClaim(claimId);
        assertEq(c.owner, attacker, "the attacker's claim");
        assertEq(
            c.unlockAt,
            block.timestamp + queue.flowParams().minHold,
            "unlocks minHold after the settlement"
        );
        unlockAt = c.unlockAt;
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, 1, 0));
        queue.mint(1, attacker);
        vm.prank(attacker);
        vm.expectRevert(IRobotMoneyFund.InKindClosed.selector);
        fund.redeemInKind(1, attacker, attacker);
        vm.roll(block.number + 1);
        vm.warp(unlockAt - 1);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, 1, 0));
        queue.mint(1, attacker);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A6 (deterministic part): TWAP lag with a hedge, no manipulation. Expected: not profitable on the timed fund.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev A real move: an outside trader lifts wETH 150 bps and the Chainlink feed follows at once, 30 minutes
    ///      before the window of the attacker's request ends. The attacker asked to deposit before the move, betting
    ///      on filling at the lagging TWAP. While the slice median still lags the feed, check 4 blocks; once it caught
    ///      up, the fund buys the pro-rata slice at today's prices. The hedge (a short of the attacker's wETH exposure)
    ///      has no P&L here because the price does not move again.
    function test_A6_twapLagAfterRealMove_noGainOnTheTimedFund() public fixtureCovered {
        _world();
        uint64 epoch = queue.currentEpoch();
        uint256 windowEnd = queue.settleableAt(epoch);
        fundUsdc(attacker, 100_000e6);
        uint256 id = _reqDeposit(attacker, 100_000e6, type(uint256).max);
        assertEq(
            queue.getRequest(id).epoch,
            epoch,
            "the request is in the epoch whose window ends in the lag"
        );

        // The move lands 30 minutes before the window ends, so half the window's slices lag the feed.
        vm.warp(windowEnd - 30 minutes);
        refreshFeeds();
        _moveMarket(WETH_POOL, WETH, 150);
        setFeedPrice(IDX_WETH, poolPrice8(WETH_POOL, WETH));
        _begin();
        _startAttacker();

        vm.warp(windowEnd);
        refreshFeeds();
        // Half the window's slices sit at the old price: the quorum (check 3) fails before check 4 is reached.
        vm.prank(keeper);
        (SettleCheck check, uint256 index) = queue.checkSettle();
        assertTrue(
            check == SettleCheck.TwapQuorum || check == SettleCheck.TwapVsFeed,
            "the lagging TWAP blocks (check 3 or 4)"
        );
        assertEq(index, IDX_WETH, "on wETH");
        emit log_named_uint(
            "A6: the check that blocked in the lag (7 quorum, 8 TWAP vs feed)", uint8(check)
        );

        vm.warp(windowEnd + queue.flowParams().settleWindow);
        refreshFeeds();
        vm.prank(keeper);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertEq(
            uint8(queue.requestStatus(id)),
            uint8(RequestStatus.Closed),
            "settled once the TWAP caught up"
        );
        coverageCheckpoint();
        uint256 shares = deliverAfterHold(attacker);
        _takeCredit(attacker);
        redeem(attacker, shares);
        _end("A6 timed, deposit into a 150 bps real move", true);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A7: sandwich of a settlement, by its caller and by a third party. Expected: the gain is capped by
    //  legBandBps on the basket part; the caller is the keeper before keeperGrace; the attacker's costs must
    //  exceed the cap, or G8 fails and the band is the finding.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev E34 / RB-20: `keeperGrace` is retired in Step 3f; only `KEEPER_ROLE` may settle. An attacker trying to
    ///      settle after `keeperGrace` reverts with `SettleBlocked(Caller, ...)`.
    function test_A7_sandwich_byTheCallerAfterKeeperGrace() public fixtureCovered {
        _world();
        uint256 vid = _victimDeposit(victim, 250_000e6);
        warpToSettleable(vid);
        vm.warp(block.timestamp + queue.flowParams().keeperGrace);
        refreshFeeds();
        _begin();
        vm.prank(attacker);
        (SettleCheck check, uint256 idx) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Caller), "non-keeper blocked at Check 0");
        assertEq(idx, IDLE_INDEX, "caller check returns idle index");
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(IFlowEvents.SettleBlocked.selector, SettleCheck.Caller, IDLE_INDEX, 0)
        );
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertEq(queue.getRequest(vid).remaining, 250_000e6, "victim request untouched");
    }

    /// @dev Before keeperGrace only the keeper settles. A third party who can order its trades around the keeper's
    ///      call (the sequencer, or a keeper that colludes) runs the same sandwich around it.
    function test_A7_sandwich_ofTheKeeperByAThirdParty() public fixtureCovered {
        _a7(false, "A7 timed sandwich around the keeper's settlement");
    }

    /// @dev The honest settlement first (a state snapshot), for the pending user's loss; then each push size from
    ///      the same state. Since the per-call cap is on by default (2026-11-12) the victim's 250,000 USDC fills in
    ///      parts, one call per block: the honest run settles them all, and each attack sandwiches EVERY part in
    ///      its own block (push both pools, settle, sell back).
    function _a7(bool attackerSettles, string memory id) private {
        _world();
        uint256 vid = _victimDeposit(victim, 250_000e6);
        warpToSettleable(vid);
        if (attackerSettles) vm.warp(block.timestamp + queue.flowParams().keeperGrace);
        refreshFeeds();
        _begin();
        address caller = attackerSettles ? attacker : keeper;

        uint256 snap = vm.snapshotState();
        {
            uint256 parts = _settleOverBlocks(caller, vid, A7_MAX_PARTS);
            assertGt(parts, 0, "the honest settlement trades");
            assertTrue(queue.getRequest(vid).closed, "the honest run fills the victim");
            emit log_named_uint(string.concat(id, ": honest parts (one per block)"), parts);
        }
        (uint256 hu, uint256 hs) = _victimFills(vid);
        vm.revertToState(snap); // reverts this contract's storage too: keep the honest totals in locals until here
        (honestUsdc, honestShares) = (hu, hs);

        int256[3] memory pushes = [int256(20), int256(50), int256(80)];
        AttackPnl memory best;
        best.attackerNet = type(int256).min;
        for (uint256 k; k < pushes.length; ++k) {
            snap = vm.snapshotState();
            AttackPnl memory r = _a7Once(pushes[k], caller, vid, id);
            if (r.attackerNet > best.attackerNet) best = r;
            vm.revertToState(snap);
            coverageCheckpoint();
        }
        _reportPnl(string.concat(id, ", best push"), best);
        _g8OrFinding(id, best);
    }

    /// @dev The most parts an A7 run settles (one per block) before it stops.
    uint256 internal constant A7_MAX_PARTS = 40;
    /// @dev The honest run's USDC and shares for the victim (A7), in storage for the stack.
    uint256 internal honestUsdc;
    uint256 internal honestShares;

    /// @dev One sandwich of `pushBps` on both basket pools around each of `caller`'s settlements, one per block,
    ///      until the victim's request closes or a call records nothing (the per-swap limit refused it). The honest
    ///      run's USDC and shares for the victim are `honestUsdc`, `honestShares`.
    function _a7Once(int256 pushBps, address caller, uint256 vid, string memory id)
        private
        returns (AttackPnl memory r)
    {
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        uint256 parts;
        for (uint256 k; k < A7_MAX_PARTS && !queue.getRequest(vid).closed; ++k) {
            if (k != 0) _nextBlock();
            else vm.roll(block.number + 1);
            (uint256 sw, uint256 bw) = _pushBps(attacker, WETH_POOL, WETH, USDC, pushBps);
            (uint256 sc, uint256 bc) = _pushBps(attacker, CBBTC_POOL, CBBTC, USDC, pushBps);
            borrowed += sw + sc; // one flash loan per block: the 5 bps fee is paid on each
            uint256 sid = _settleAs(caller);
            _sellExact(attacker, WETH_POOL, WETH, USDC, bw);
            _sellExact(attacker, CBBTC_POOL, CBBTC, USDC, bc);
            if (sid == 0) break;
            ++parts;
        }
        string memory label = string.concat(id, ", push +", vm.toString(pushBps), " bps");
        emit log_named_uint(string.concat(label, ": parts sandwiched"), parts);
        (uint256 u, uint256 sh) = _victimFills(vid);
        if (queue.getRequest(vid).closed) {
            assertApproxEqRel(
                sh,
                honestShares,
                1e15,
                "the bound sets the shares: the push cannot change them (to 0.1 %)"
            );
        } else {
            emit log_named_string(label, "the per-swap limit refused a part: the rest waits");
        }
        pending = _extraCost(u, sh, honestUsdc, honestShares);
        r = _end(label, false);
        _assertPerShareNotLower(label);
    }

    function _settleAs(address caller) internal returns (uint256 sid) {
        vm.prank(caller);
        sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
    }

    /// @dev `caller` settles once per block (Base: a block every 2 s) until request `id` closes, a call records no
    ///      settlement, or `maxCalls` calls ran. Since 2026-11-12 the per-call basket cap (5 bps of each pool's
    ///      time-weighted USDC depth, a budget per block) is on by default, so a flow larger than one call's room
    ///      fills in parts over blocks. Returns the settlements recorded.
    function _settleOverBlocks(address caller, uint256 id, uint256 maxCalls)
        internal
        returns (uint256 parts)
    {
        for (uint256 k; k < maxCalls && !queue.getRequest(id).closed; ++k) {
            if (k != 0) _nextBlock();
            else vm.roll(block.number + 1);
            if (_settleAs(caller) == 0) break;
            ++parts;
        }
    }

    /// @dev Request `vid`'s fills so far (deposit claims): the USDC paid and the shares got.
    function _victimFills(uint256 vid) internal view returns (uint256 usdc, uint256 shares) {
        uint256 n = queue.claimCount();
        for (uint256 c = 1; c <= n; ++c) {
            Claim memory cl = queue.getClaim(c);
            if (cl.requestId != vid) continue;
            usdc += cl.usdc;
            shares += cl.shares;
        }
    }

    /// @dev The victim's extra USDC against the honest run (`hu` USDC for `hs` shares): what it paid less what its
    ///      `shares` cost at the honest price per share.
    function _extraCost(uint256 usdc, uint256 shares, uint256 hu, uint256 hs)
        internal
        pure
        returns (uint256)
    {
        if (shares == 0 || hs == 0) return 0;
        uint256 fair = shares.mulDiv(hu, hs);
        return usdc > fair ? usdc - fair : 0;
    }

    /// @dev The caller variant WITHOUT the 6-hour warp (step 3 finish plan §3.2, added by `levers` 2026-11-12). The
    ///      attacker leaves a never-fillable deposit (limit 1) one epoch before the victim's. In the scaffold the
    ///      keeper's grace counted from the oldest open epoch, so at the victim's own window end the bait's grace had
    ///      passed and the attacker could settle the victim's epoch (review finding behind fix-queue item 1). Since
    ///      item 1 a stranger reaches an epoch only after that epoch's own window end plus keeperGrace. The test
    ///      first asks whether the attacker's plain call at the victim's window end fills the victim (in a snapshot):
    ///      if not, the keeper-free path is closed, and one sandwich attempt is still played to log its cost; if
    ///      it does, the three pushes of `_a7` are played and scored. The same body runs on the scaffold queue (the
    ///      "before" copy, notes/levers.md) and on the fixed one.
    function test_A7_sandwich_byTheCallerAtWindowEnd_viaANeverFillableRequest()
        public
        fixtureCovered
    {
        uint256 vid = _a7BaitWorld();
        (bool reaches, uint256 hu, uint256 hs) = _a7BaitProbe(vid);
        emit log_named_string(
            "A7 bait: the attacker's plain call at the victim's window end",
            reaches ? "fills the victim" : "does not reach the victim"
        );
        if (reaches) {
            (honestUsdc, honestShares) = (hu, hs);
            _a7BaitSandwich(vid);
        } else {
            _a7BaitClosed(vid);
        }
    }

    string internal constant A7_BAIT_ID =
        "A7 timed sandwich, the attacker settles at the window end through a never-fillable bait";

    /// @dev The world, the bait (minRequestUsdc at limit 1) one epoch before the victim's 250,000 USDC deposit, then
    ///      the victim's own window end (no keeperGrace warp), feeds fresh, the attack's reference fixed.
    function _a7BaitWorld() internal returns (uint256 vid) {
        _world();
        uint256 minUsdc = queue.flowParams().minRequestUsdc;
        fundUsdc(attacker, minUsdc);
        uint256 bait = _reqDeposit(attacker, minUsdc, 1);
        vm.warp(block.timestamp + queue.flowParams().epochLength);
        vid = _victimDeposit(victim, 250_000e6);
        assertEq(
            queue.getRequest(vid).epoch,
            queue.getRequest(bait).epoch + 1,
            "the victim asks one epoch after the bait"
        );
        warpToSettleable(vid);
        refreshFeeds();
        _begin();
    }

    /// @dev In a snapshot: does the attacker's plain call now fill any of the victim (the per-call cap may fill
    ///      only a part)? If so, the honest run (the attacker's plain calls, one per block, until the victim closes)
    ///      gives the victim's honest USDC and shares.
    function _a7BaitProbe(uint256 vid) internal returns (bool reaches, uint256 hu, uint256 hs) {
        uint256 snap = vm.snapshotState();
        vm.roll(block.number + 1);
        vm.prank(attacker);
        (bool callOk,) = address(queue)
            .call(abi.encodeCall(queue.settle, (SETTLE_MAX_REQUESTS, type(uint256).max)));
        reaches = callOk && queue.getRequest(vid).remaining < 250_000e6;
        if (reaches) {
            _settleOverBlocks(attacker, vid, A7_MAX_PARTS);
            (hu, hs) = _victimFills(vid);
        }
        vm.revertToState(snap);
    }

    /// @dev The keeper-free path is closed: one sandwich attempt (+20 bps on both pools) to log what it costs.
    function _a7BaitClosed(uint256 vid) internal {
        assertEq(queue.getRequest(vid).remaining, 250_000e6, "the victim waits for the keeper");
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        (uint256 sw, uint256 bw) = _pushBps(attacker, WETH_POOL, WETH, USDC, 20);
        (uint256 sc, uint256 bc) = _pushBps(attacker, CBBTC_POOL, CBBTC, USDC, 20);
        borrowed = sw + sc;
        vm.prank(attacker);
        (bool tried,) = address(queue)
            .call(abi.encodeCall(queue.settle, (SETTLE_MAX_REQUESTS, type(uint256).max)));
        emit log_named_string(
            "A7 bait: the sandwiched call",
            tried ? "returned (nothing of the victim's)" : "reverted"
        );
        _sellExact(attacker, WETH_POOL, WETH, USDC, bw);
        _sellExact(attacker, CBBTC_POOL, CBBTC, USDC, bc);
        assertEq(
            queue.getRequest(vid).remaining, 250_000e6, "the push changed nothing for the victim"
        );
        _end(string.concat(A7_BAIT_ID, ", push +20 bps, keeper-free path closed"), true);
    }

    /// @dev The keeper-free path is open: the pushes of `_a7`, best scored.
    function _a7BaitSandwich(uint256 vid) internal {
        int256[3] memory pushes = [int256(20), int256(50), int256(80)];
        AttackPnl memory best;
        best.attackerNet = type(int256).min;
        for (uint256 k; k < pushes.length; ++k) {
            uint256 snap = vm.snapshotState();
            AttackPnl memory r = _a7Once(pushes[k], attacker, vid, A7_BAIT_ID);
            if (r.attackerNet > best.attackerNet) best = r;
            vm.revertToState(snap);
        }
        _reportPnl(string.concat(A7_BAIT_ID, ", best push"), best);
        _g8OrFinding(A7_BAIT_ID, best);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A8: blocking a settlement, by every way found. Expected: nobody loses value; report the cost per day of
    //  each way; G8 fails if a way costs less than 1,000 USDC a day.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Way 1: hold a basket pool past refBandBps (check 4; band + 10 bps). With no arbitrage a hold costs one round trip
    ///      whatever its length, so the number logged here is a LOWER BOUND; the real cost of holding a price
    ///      against arbitrage for a day is the sim's (AttackSim A2/A10, not built). This way is not scored here.
    function test_A8_block_holdPastBandForADay_noArbitrageLowerBound() public fixtureCovered {
        _world();
        _begin();
        uint256 vid = _victimDeposit(victim, 50_000e6);
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        int256 push = int256(uint256(queue.flowParams().refBandBps)) + 10;
        uint256 bought;
        (borrowed, bought) = _pushBps(attacker, WETH_POOL, WETH, USDC, push);
        warpToSettleable(vid);
        uint256 supply = fund.totalSupply();
        uint256 twapBlockedHours;
        for (uint256 h; h < 24; ++h) {
            refreshFeeds();
            vm.prank(keeper);
            (SettleCheck check,) = queue.checkSettle();
            if (check == SettleCheck.TwapVsFeed) {
                ++twapBlockedHours;
            } else {
                assertEq(
                    uint8(check),
                    uint8(SettleCheck.Window),
                    "check 1 Window precedes check 4 only inside settlement observation windows"
                );
            }
            vm.warp(block.timestamp + 1 hours);
        }
        assertGe(twapBlockedHours, 18, "blocked at check 4 outside observation windows all day");
        assertEq(fund.totalSupply(), supply, "nothing settled, nothing moved");
        assertEq(queue.getRequest(vid).remaining, 50_000e6, "the request waits, whole");
        _sellExact(attacker, WETH_POOL, WETH, USDC, bought);
        AttackPnl memory r = _end(
            string.concat(
                "A8 way 1, hold +",
                vm.toString(push),
                " bps (band + 10) a day (no arbitrage: lower bound)"
            ),
            true
        );
        emit log_named_uint(
            "A8 way 1: cost for a day, NO arbitrage (lower bound, not scored)",
            uint256(-r.attackerNet)
        );
        // After the hold, the next window settles.
        warpForward(block.timestamp + queue.flowParams().settleWindow);
        refreshFeeds();
        _settleOverBlocks(keeper, vid, 64);
        assertEq(
            uint8(queue.requestStatus(vid)),
            uint8(RequestStatus.Closed),
            "it settles once the push ends"
        );
    }

    /// @dev Way 2: break the slice quorum (check 3). Every hour the attacker pushes wETH 130 bps for 25 minutes and
    ///      releases it, so any trailing settle window holds about five slices out of the band. Each cycle is a real
    ///      round trip, so 24 cycles a day are a lower bound that does not depend on arbitrage.
    function test_A8_block_quorumDispersion_shortPushEveryHour() public fixtureCovered {
        _world();
        _begin();
        uint256 vid = _victimDeposit(victim, 50_000e6);
        warpToSettleable(vid);
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        uint256 supply = fund.totalSupply();
        uint256 cycles = 3;
        for (uint256 k; k < cycles; ++k) {
            (uint256 spent, uint256 bought) = _pushBps(attacker, WETH_POOL, WETH, USDC, 130);
            if (spent > borrowed) borrowed = spent;
            vm.warp(block.timestamp + 25 minutes);
            _sellExact(attacker, WETH_POOL, WETH, USDC, bought);
            for (uint256 m; m < 7; ++m) {
                vm.warp(block.timestamp + 5 minutes);
                refreshFeeds();
                vm.prank(keeper);
                (SettleCheck check,) = queue.checkSettle();
                assertTrue(check != SettleCheck.Ok, "blocked at every keeper attempt");
            }
        }
        assertEq(fund.totalSupply(), supply, "nothing settled, nothing moved");
        assertEq(queue.getRequest(vid).remaining, 50_000e6, "the request waits, whole");
        AttackPnl memory r = _end("A8 way 2, quorum dispersion, 3 hourly cycles", true);
        _g8BlockFloorOrFinding(
            "A8 way 2 (quorum dispersion)", uint256(-r.attackerNet) * 24 / cycles
        );
    }

    /// @dev Way 3: push past the per-swap limit right before each keeper call and back right after (one
    ///      transaction around the keeper's). The deposit side fails and waits; the redemption side still settles
    ///      in the same call. Cost per attempt; per day at one keeper attempt per settle window (24), the slowest
    ///      cadence the design implies.
    function test_A8_block_perSwapLimit_aroundEachKeeperCall() public fixtureCovered {
        _world();
        _begin();
        uint256 vid = _victimDeposit(victim, 50_000e6);
        uint256 rid = openRedeemRequest(alice, fund.balanceOf(alice) / 4, 0);
        warpToSettleable(vid);
        refreshFeeds();
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        uint256 bought;
        (borrowed, bought) = _pushBps(attacker, WETH_POOL, WETH, USDC, 110);
        vm.recordLogs();
        _settleAs(keeper);
        assertTrue(
            _sawSideFailed(RequestKind.Deposit), "the deposit side failed its per-swap limit"
        );
        _sellExact(attacker, WETH_POOL, WETH, USDC, bought);
        assertEq(queue.getRequest(vid).remaining, 50_000e6, "the deposit waits, whole");
        assertEq(
            uint8(queue.requestStatus(rid)),
            uint8(RequestStatus.Closed),
            "the redemption still settled"
        );
        AttackPnl memory r = _end("A8 way 3, per-swap push around one keeper call", true);
        _g8BlockFloorOrFinding(
            "A8 way 3 (per-swap limit, 24 keeper attempts a day)", uint256(-r.attackerNet) * 24
        );
    }

    /// @dev Way 4: cursor griefing (D-AT-3; queue notes §4 item 12). In the scaffold, after keeperGrace anyone could
    ///      call `settle(1, 0)`: it filled nothing but moved the shared cursor one request on, so a griefing call
    ///      before each keeper call kept the keeper's walk past the OLDEST request (measured then: 448.27 USDC a day,
    ///      under the 1,000 floor; test `test_A8_block_cursorGriefing_starvesTheOldestRequest`, rewritten here by
    ///      `levers` 2026-11-12, step 3 finish plan §3.2). Since fix-queue's item 2 a call with no room walks
    ///      nothing and moves no cursor, and the keeper keeps its own cursor, which no other caller moves.
    ///      Rerun: four rounds, each with two fresh requests past keeperGrace and three griefing calls before the
    ///      keeper's one call (`settle(1, 0)`, `settle(0, max)`, and `settle(1, 1)`, a room too small for any fill).
    ///      The defence holds when the keeper's FIRST call of every round fills the oldest request. The way then
    ///      blocks nothing, so it has no cost per day to score against the floor; the griefer's gas is logged.
    function test_A8_block_cursorGriefing_cannotStarveTheOldestRequest() public fixtureCovered {
        _world();
        _begin();
        uint256 griefGas;
        uint256 blockedRounds;
        for (uint256 k; k < 4; ++k) {
            uint256 oldest = openDepositRequest(victim, 50_000e6, type(uint256).max);
            uint256 newer = openDepositRequest(victim2, 50_000e6, type(uint256).max);
            warpToSettleable(oldest);
            vm.warp(block.timestamp + queue.flowParams().keeperGrace);
            refreshFeeds();
            (uint64 ke, uint256 ki) = queue.settleCursor(true, RequestKind.Deposit);
            bytes memory callerErr = abi.encodeWithSelector(
                IFlowEvents.SettleBlocked.selector, SettleCheck.Caller, IDLE_INDEX, 0
            );
            uint256 g = gasleft();
            vm.startPrank(attacker);
            vm.expectRevert(callerErr);
            queue.settle(1, 0);
            vm.expectRevert(callerErr);
            queue.settle(0, type(uint256).max);
            vm.expectRevert(callerErr);
            queue.settle(1, 1);
            vm.stopPrank();
            griefGas = g - gasleft();
            (uint64 ke2, uint256 ki2) = queue.settleCursor(true, RequestKind.Deposit);
            assertEq(ke2, ke, "no stranger moves the keeper's cursor (epoch)");
            assertEq(ki2, ki, "no stranger moves the keeper's cursor (index)");
            assertEq(
                queue.getRequest(oldest).remaining, 50_000e6, "the griefing calls filled nothing"
            );
            vm.roll(block.number + 1);
            _settleAs(keeper);
            if (!queue.getRequest(oldest).closed) ++blockedRounds;
            assertEq(
                uint8(queue.requestStatus(oldest)),
                uint8(RequestStatus.Closed),
                "the keeper's first call fills the oldest"
            );
            // The per-call cap (a budget per block, on by default) leaves the newer one to the next blocks.
            _settleOverBlocks(keeper, newer, 64);
            assertEq(
                uint8(queue.requestStatus(newer)), uint8(RequestStatus.Closed), "and the newer one"
            );
            vm.warp(block.timestamp + 1 hours);
            coverageCheckpoint();
        }
        uint256 perCallUsdc = griefGas.mulDiv(block.basefee, 1).mulDiv(refWeth, 1e18);
        emit log_named_uint(
            "A8 way 4: rounds of 4 in which the oldest request was passed over", blockedRounds
        );
        emit log_named_uint("A8 way 4: gas of the three griefing calls of the last round", griefGas);
        emit log_named_uint(
            "A8 way 4: their cost at the pin's base fee (USDC units, L1 data fee not counted)",
            perCallUsdc
        );
        emit log_named_string(
            "A8 way 4",
            "no block achieved: the way costs the griefer gas and holds back nothing (no cost per day applies)"
        );
        _end("A8 way 4, cursor griefing after fix-queue item 2 (gas only)", true);
    }

    /// @dev Way 5: a gift cannot skip or block pending deposits once per-request limits are retired (E25).
    ///      The deposit fills (receiving slightly fewer shares at the higher NAV) and holders keep the gift.
    function test_A8_block_giftAboveLimitMargins_skipsTightRequests() public fixtureCovered {
        _world();
        _begin();
        uint256 vid = _victimDeposit(victim, 50_000e6);
        warpToSettleable(vid);
        refreshFeeds();
        uint256 gift = s0.navRef.mulDiv(LIMIT_MARGIN_BPS * 2, BPS);
        fundUsdc(attacker, gift);
        _startAttacker();
        vm.prank(attacker);
        IERC20(USDC).transfer(address(fund), gift);
        _settleAs(keeper);
        assertEq(
            uint8(queue.requestStatus(vid)),
            uint8(RequestStatus.Closed),
            "with limits retired, the gift cannot skip or block the deposit"
        );
        AttackPnl memory r = _end("A8 way 5, a gift cannot block limit-free deposits", true);
        assertLe(r.attackerNet, -int256(gift * 99 / 100), "the gift is lost to the holders");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A9 (deterministic part): a run. Expected: oldest first under the cap; in-kind exits get basket tokens at
    //  once and lending USDC up to the allowance, then position claims; stayers carry only their share of a venue
    //  loss. The sim version (with arbitrage) is sim/AttackSim.t.sol.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    address[4] internal runners;
    uint256[3] internal runIds;
    uint256[3] internal runAmounts;

    function test_A9_run_oldestFirstUnderCap_inKindThenClaims() public fixtureCovered {
        _world();
        _a9Holders();
        _begin();
        // ADMIN (the timelock) lowers the in-kind floor so a 100,000 USDC exit reaches position claims (E20).
        timelockExecute(
            address(fund),
            abi.encodeCall(
                IRobotMoneyFund.setInKindAllowance,
                (uint16(500), uint128(10_000e6), uint32(6 hours))
            )
        );
        refreshFeeds();
        for (uint256 k; k < 3; ++k) {
            runAmounts[k] = fund.balanceOf(runners[k]);
            runIds[k] = openRedeemRequest(runners[k], runAmounts[k], 0);
        }
        // E29 / RB-26: in-kind exit is closed while running; timed redemptions fill FIFO under the period cap.
        uint256 runner3Shares = fund.balanceOf(runners[3]);
        vm.prank(runners[3]);
        vm.expectRevert(IRobotMoneyFund.InKindClosed.selector);
        fund.redeemInKind(runner3Shares, runners[3], runners[3]);
        _a9FirstSettlement();
        _assertPerShareNotLower("A9 run");
        coverageCheckpoint();
        // The next period fills the rest, oldest first.
        vm.warp(block.timestamp + queue.flowParams().epochLength);
        settleAll();
        for (uint256 k; k < 3; ++k) {
            assertEq(
                uint8(queue.requestStatus(runIds[k])),
                uint8(RequestStatus.Closed),
                "the run fills over periods"
            );
        }
        // Per proposal §10 step 3f: A9 uses the in-kind exit only in a wind-down.
        _a9InKindExit(runners[3]);
        _a9VenueLoss(runners[3]);
    }

    /// @dev Four more holders deposit 100,000 USDC each in one epoch.
    function _a9Holders() private {
        runners =
            [makeAddr("runner1"), makeAddr("runner2"), makeAddr("runner3"), makeAddr("runner4")];
        uint256 last;
        for (uint256 k; k < 4; ++k) {
            last = openDepositRequest(runners[k], 100_000e6, type(uint256).max);
        }
        settleUntilFilled(last);
        for (uint256 k; k < 4; ++k) {
            deliverAfterHold(runners[k]);
            _takeCredit(runners[k]);
        }
        alignFeedsToPools();
        refreshFeeds();
        coverageCheckpoint();
    }

    /// @dev In wind-down (`shutdown()`), the fourth runner exits in kind: basket tokens now, lending USDC up to the
    ///      period's allowance, the rest as position claims.
    function _a9InKindExit(address who) private {
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.shutdown, ()));
        uint256 shares = fund.balanceOf(who);
        (uint16 bps, uint128 floorUsdc,, uint256 used0) = fund.inKindAllowance();
        // The allowance is measured on the venues' holdings before the exit (FundPositionLib.allowanceLeft).
        (, uint256[] memory held) = fund.heldBalances();
        uint256 lending;
        for (uint256 i; i < held.length; ++i) {
            if (!isBasketIndex(i)) lending += held[i];
        }
        uint256 cap = Math.max(lending.mulDiv(bps, BPS), floorUsdc);
        vm.prank(who);
        fund.redeemInKind(shares, who, who);
        assertGt(IERC20(WETH).balanceOf(who), 0, "wETH at once");
        assertGt(IERC20(CBBTC).balanceOf(who), 0, "cbBTC at once");
        assertGt(IERC20(USDC).balanceOf(who), 0, "idle and lending USDC up to the allowance");
        (,,, uint256 used1) = fund.inKindAllowance();
        assertLe(
            used1 - used0, cap + 10, "E20: lending USDC in kind stays within the period's allowance"
        );
        (uint256 units,) = fund.positionClaimOf(IDX_AAVE, who);
        assertGt(units, 0, "beyond the allowance: a claim on a share of the Aave position");
        emit log_named_uint("A9: lending USDC paid in kind this period", used1 - used0);
    }

    /// @dev The first period's settlements after the window (one call per block until the period's cap stops
    ///      them): the redemptions fill in the order they were made, up to the period's cap; a request the cap
    ///      reaches fills in part and the ones behind it wait.
    function _a9FirstSettlement() private {
        warpToSettleable(runIds[0]);
        refreshFeeds();
        FlowParams memory p = queue.flowParams();
        // One keeper call per block until the period's cap stops it (a call that records nothing): the per-call
        // basket cap (on by default) splits the period's fills over blocks.
        assertGt(_settleOverBlocks(keeper, runIds[2], 64), 0, "the run trades");
        (, uint256 redeemUsed) = queue.periodFlow(block.timestamp / p.epochLength);
        uint256 cap = Math.max(s0.navRef.mulDiv(p.maxEpochFlowBps, BPS), p.epochFlowFloorUsdc);
        assertLe(
            redeemUsed, cap + cap / 50, "RB-16: the period's fills stay within its cap (feed NAV)"
        );
        bool touched;
        for (uint256 k = 3; k > 0; --k) {
            uint256 rem = queue.getRequest(runIds[k - 1]).remaining;
            if (touched) {
                assertEq(rem, 0, "an older request filled in full before a newer one got anything");
            }
            if (rem < runAmounts[k - 1]) touched = true;
        }
        assertEq(queue.getRequest(runIds[0]).remaining, 0, "the oldest filled first");
        assertGt(queue.getRequest(runIds[2]).remaining, 0, "the cap left the newest waiting");
        emit log_named_uint("A9: redemption USDC value filled in the first period", redeemUsed);
    }

    /// @dev Aave loses 10 %. The in-kind exiter's Aave claim and the stayers' Aave holding lose the same fraction
    ///      (RB-21): no later loss is pushed onto the holders who stayed.
    function _a9VenueLoss(address exiter) private {
        (, uint256 claim0) = fund.positionClaimOf(IDX_AAVE, exiter);
        (, uint256[] memory held0) = fund.heldBalances();
        uint256 index = IAtkAavePool(AAVE_POOL).getReserveNormalizedIncome(USDC);
        vm.mockCall(
            AAVE_POOL,
            abi.encodeWithSelector(IAtkAavePool.getReserveNormalizedIncome.selector, USDC),
            abi.encode(index - index / 10)
        );
        (, uint256 claim1) = fund.positionClaimOf(IDX_AAVE, exiter);
        (, uint256[] memory held1) = fund.heldBalances();
        assertLt(claim1, claim0, "the claim lost value");
        assertApproxEqRel(
            claim1 * 1e18 / claim0,
            held1[IDX_AAVE] * 1e18 / held0[IDX_AAVE],
            1e14,
            "exiter and stayers lose alike"
        );
        emit log_named_uint("A9: Aave claim, value before the loss", claim0);
        emit log_named_uint("A9: Aave claim, value after the loss", claim1);
        refreshFeeds();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A10 (deterministic part): a slow ramp of a pool, with no arbitrage. Expected: the feed band blocks a ramp
    //  past refBandBps; inside it the result is as A2. The sim version is sim/AttackSim.t.sol.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev The attacker ramps wETH every 5 minutes over the last hour of a pending deposit's window, so check 4
    ///      passes and the fund buys into the ramp. Two rates, the best scored: +5 bps (spot +60 bps at the end, the
    ///      slice median about +30 bps), and the steepest the bands let through, `min((refBandBps − 10) / 6,
    ///      (legBandBps − 10) / 12)` (+7 at the defaults 90 and 100: median about +42, spot +84 inside the per-swap
    ///      band). The ramp is held while the keeper settles the victim's 250,000 USDC in parts, one call per block
    ///      (the per-call cap, on by default since 2026-11-12), then sold back.
    function test_A10_slowRampInsideBand_noArbitrage() public fixtureCovered {
        _world();
        uint256 vid = _victimDeposit(victim, 250_000e6);
        uint256 windowEnd = queue.settleableAt(queue.getRequest(vid).epoch);
        vm.warp(windowEnd - 1 hours);
        refreshFeeds();
        _begin();
        uint256 snap = vm.snapshotState();
        vm.warp(windowEnd);
        refreshFeeds();
        assertGt(_settleOverBlocks(keeper, vid, A7_MAX_PARTS), 0, "the honest settlement trades");
        (uint256 hu, uint256 hs) = _victimFills(vid);
        vm.revertToState(snap);

        FlowParams memory p = queue.flowParams();
        int256[2] memory rates = [
            int256(5),
            int256(Math.min((uint256(p.refBandBps) - 10) / 6, (uint256(p.legBandBps) - 10) / 12))
        ];
        AttackPnl memory best;
        best.attackerNet = type(int256).min;
        for (uint256 k; k < rates.length; ++k) {
            snap = vm.snapshotState();
            AttackPnl memory r = _a10Once(vid, windowEnd, rates[k], hu, hs);
            if (r.attackerNet > best.attackerNet) best = r;
            vm.revertToState(snap);
            coverageCheckpoint();
        }
        _reportPnl("A10 timed ramp inside the band, best rate", best);
        _g8OrFinding("A10 timed ramp inside the band", best);
    }

    /// @dev One A10 ramp of `rate` bps per 5 minutes, held through the keeper's parts (one per block).
    function _a10Once(uint256 vid, uint256 windowEnd, int256 rate, uint256 hu, uint256 hs)
        internal
        returns (AttackPnl memory r)
    {
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        uint256 bought = _ramp(rate, 12);
        vm.warp(windowEnd > block.timestamp ? windowEnd : block.timestamp);
        refreshFeeds();
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(
            uint8(check), uint8(SettleCheck.Ok), "a ramp the median keeps inside the band passes"
        );
        assertGt(_settleOverBlocks(keeper, vid, A7_MAX_PARTS), 0, "the victim filled");
        _sellExact(attacker, WETH_POOL, WETH, USDC, bought);
        (uint256 u, uint256 sh) = _victimFills(vid);
        pending = _extraCost(u, sh, hu, hs);
        string memory label = string.concat(
            "A10 timed, ramp +", vm.toString(rate), " bps / 5 min over the window (no arbitrage)"
        );
        r = _end(label, false);
        _assertPerShareNotLower(label);
    }

    /// @dev The same ramp, steep enough that the slice median leaves the band: +(band + 30) / 6 bps every 5 minutes
    ///      (+20 at the default band of 90, median about +120; it was +10 against 50), and check 4 (or the quorum)
    ///      blocks.
    function test_A10_slowRampPastBand_blocks() public fixtureCovered {
        _world();
        uint256 vid = _victimDeposit(victim, 250_000e6);
        uint256 windowEnd = queue.settleableAt(queue.getRequest(vid).epoch);
        vm.warp(windowEnd - 1 hours);
        refreshFeeds();
        _begin();
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        int256 rate = (int256(uint256(queue.flowParams().refBandBps)) + 30) / 6;
        uint256 bought = _ramp(rate, 12);
        refreshFeeds();
        vm.prank(keeper);
        (SettleCheck check, uint256 index) = queue.checkSettle();
        assertTrue(
            check == SettleCheck.TwapVsFeed || check == SettleCheck.TwapQuorum,
            "the ramp is blocked"
        );
        assertEq(index, IDX_WETH, "on wETH");
        uint256 supply = fund.totalSupply();
        vm.prank(keeper);
        vm.expectPartialRevert(IFlowEvents.SettleBlocked.selector);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertEq(fund.totalSupply(), supply, "nothing settled");
        _sellExact(attacker, WETH_POOL, WETH, USDC, bought);
        _end(string.concat("A10 timed, ramp +", vm.toString(rate), " bps / 5 min: blocked"), true);
    }

    /// @dev `steps` pushes of `bps` on wETH, one every 5 minutes, ending 5 minutes after the last. Returns the wETH
    ///      bought; `borrowed` is the USDC the ramp spent (capital held, not a flash loan).
    function _ramp(int256 bps, uint256 steps) private returns (uint256 bought) {
        for (uint256 k; k < steps; ++k) {
            (uint256 s, uint256 b) = _pushBps(attacker, WETH_POOL, WETH, USDC, bps);
            borrowed += s;
            bought += b;
            vm.warp(block.timestamp + 5 minutes);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A11: griefing the hold of a pooled account. Expected: each fill unlocks on its own date; a stranger's
    //  deposit for a victim is a gift.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_A11_holdGriefing_pooledAccount_eachFillUnlocksOnItsOwnDate()
        public
        fixtureCovered
    {
        _world();
        _begin();
        address pooled = makeAddr("pooledAccount");
        uint256 id1 = openDepositRequest(pooled, 50_000e6, type(uint256).max);
        settleUntilFilled(id1);
        Claim memory c1 = queue.getClaim(queue.claimCount());
        assertEq(c1.owner, pooled, "the pooled account's claim");

        // The stranger deposits the minimum FOR the pooled account in the next epoch, hoping to reset its hold.
        uint256 minUsdc = queue.flowParams().minRequestUsdc;
        fundUsdc(attacker, minUsdc);
        _startAttacker();
        Request memory before1 = queue.getRequest(id1);
        vm.startPrank(attacker);
        IERC20(USDC).approve(address(queue), minUsdc);
        uint256 id2 = queue.requestDeposit(minUsdc, pooled);
        vm.stopPrank();
        assertTrue(id2 != id1, "a stranger's request is a new request");
        assertEq(
            keccak256(abi.encode(queue.getRequest(id1))),
            keccak256(abi.encode(before1)),
            "the owner's request is untouched"
        );
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotRequestOwner.selector, id2, attacker));
        queue.cancel(id2);
        settleUntilFilled(id2);
        Claim memory c2 = queue.getClaim(queue.claimCount());
        assertEq(c2.owner, pooled, "the gift's shares belong to the pooled account");
        assertGt(c2.unlockAt, c1.unlockAt, "the gift unlocks later");

        // At its own unlock the first fill is deliverable in full; the gift's shares wait for theirs.
        warpForward(c1.unlockAt);
        refreshFeeds();
        assertEq(queue.maxMint(pooled), c1.shares, "the first fill unlocked on its own date");
        queue.mint(c1.shares, pooled);
        assertEq(fund.balanceOf(pooled), c1.shares, "delivered to the owner");
        warpForward(c2.unlockAt);
        refreshFeeds();
        queue.mint(c2.shares, pooled);
        AttackPnl memory r = _end("A11 timed, a stranger's deposit for a pooled account", true);
        assertLe(r.attackerNet, -int256(minUsdc * 99 / 100), "the stranger's deposit is a gift");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A12: a batch larger than pool depth. Expected: no call trades more than the pool bears; the batch settles
    //  in parts. Before the per-call cap was on by default (2026-11-12) the whole batch failed its per-swap limit
    //  and changed nothing; at the defaults the cap (5 bps of each pool's time-weighted depth per block) sizes
    //  every call so it never reaches that limit.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_A12_batchLargerThanPoolDepth_failsWhole_settlesInParts() public fixtureCovered {
        _bigWorld();
        for (uint256 k; k < 2; ++k) {
            openDepositRequest(
                makeAddr(string.concat("big", vm.toString(k))), 1_000_000e6, type(uint256).max
            );
        }
        warpToSettleable(queue.requestCount());
        refreshFeeds();
        _begin();
        (uint160 sqrt0,,,,,,) = IAtkPool(WETH_POOL).slot0();
        uint256 wethPx0 = _spotPx(WETH_POOL, WETH, USDC);
        uint256 room = _callRoomUsdc();
        emit log_named_uint("A12: one call's room under the per-call cap (USDC units)", room);
        assertLt(room, 2_000_000e6, "the batch is larger than one call's room");

        // The keeper's call with no USDC bound: the cap sizes it, the deposit side does not fail, the pool moves less
        // than legBandBps.
        vm.recordLogs();
        vm.roll(block.number + 1);
        uint256 sid0 = _settleAs(keeper);
        assertGt(sid0, 0, "the capped call trades");
        assertFalse(
            _sawSideFailed(RequestKind.Deposit), "no part of the batch failed its per-swap limit"
        );
        assertLe(
            queue.getSettlement(sid0).usdcIn,
            room + room / 100,
            "the call's USDC stays inside its room"
        );
        uint256 moved = (_spotPx(WETH_POOL, WETH, USDC) - wethPx0) * BPS / wethPx0;
        emit log_named_uint("A12: wETH pool move of one capped call (bps)", moved);
        assertLt(
            moved,
            queue.flowParams().legBandBps,
            "one call moves the pool less than the per-swap band"
        );
        _arbBackWeth(sqrt0);

        // The keeper settles it in parts, one call per block (maxUsdc 200,000 USDC); an arbitrageur brings the pool
        // back between parts.
        uint256 parts = 1;
        for (uint256 k; k < 4; ++k) {
            _nextBlock();
            vm.prank(keeper);
            uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, 200_000e6);
            assertGt(sid, 0, "a part settles");
            assertLe(
                queue.getSettlement(sid).usdcIn, 200_000e6, "RB-20: maxUsdc only limits the call"
            );
            ++parts;
            _arbBackWeth(sqrt0);
        }
        emit log_named_uint("A12: parts settled", parts);
        _assertPerShareNotLower("A12");
    }

    /// @dev One call's room under the per-call cap: `min_i(callBps × depth_i × navFeed / value_i)` over the basket
    ///      assets (`FlowSettleLib._basketCallRoom`), at the feeds, with the depth over one settlement window.
    function _callRoomUsdc() internal view returns (uint256 room) {
        uint256 callBps = queue.flowLevers().basketCallBps;
        uint32 window = queue.flowParams().settleWindow;
        (uint256 navFeed,) = fund.lastGoodNav();
        room = type(uint256).max;
        for (uint256 i; i < listedAssets(); ++i) {
            if (!isBasketIndex(i)) continue;
            uint256 value = fund.assetValue(i);
            if (value == 0) continue;
            (bool ok, uint256 depth) =
                FundValuationLib.poolUsdcDepth(fund.assetConfig(i).pool, USDC, window);
            assertTrue(ok, "A12: depth read");
            uint256 r = depth.mulDiv(callBps, BPS).mulDiv(navFeed, value);
            if (r < room) room = r;
        }
    }

    /// @dev A fund that is 60 % wETH (the pool-share rule allows 6M of a 10M cap on the 26.8M-deep pool) with the
    ///      flow cap raised by ADMIN to 5M a period, so one batch can outgrow the pool.
    function _bigWorld() internal {
        investFund(assetVec(2_000, 2_000, 6_000, 0, 0));
        FlowParams memory p = defaultFlowParams();
        p.epochFlowFloorUsdc = 5_000_000e6;
        timelockExecute(address(queue), abi.encodeCall(queue.setFlowParams, (p)));
        alignFeedsToPools();
        refreshFeeds();
        coverageCheckpoint();
    }

    /// @dev An arbitrageur sells wETH until the pool is back at `sqrtTarget` (a market that pulls a moved pool back
    ///      to the outside price). Not part of any attacker's result.
    function _arbBackWeth(uint160 sqrtTarget) internal {
        (uint160 sqrtNow,,,,,,) = IAtkPool(WETH_POOL).slot0();
        if (sqrtNow <= sqrtTarget) return;
        address arb = makeAddr("arbitrageur");
        deal(WETH, arb, 10_000e18);
        _swapTo(arb, WETH_POOL, WETH, USDC, sqrtTarget);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A13: a flood of requests whose limits never fill. Expected: they are skipped; honest requests still fill.
    //  Report the keeper's gas against the attacker's cost.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    // A13 (flood of unfillable-limit requests) retired in Step 3f with per-request price limits (E25, D17;
    // docs/technical/one-vault-timed-flows-eng-plan.md §8.3).

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A14: a lending venue that is impaired, at its supply cap, or fully borrowed.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Impaired (E29, proposal §10 step 3f): `redeemInKind` is closed while running and opens only in
    ///      `shutdown()` wind-down; an in-kind exit in wind-down leaves a position claim. Exiter and stayers share a
    ///      later venue loss pro rata; after `restore(TVL_CAP)`, a timed redemption settles at the impaired value.
    function test_A14_venueImpaired_exitersAndStayersShareTheLoss() public fixtureCovered {
        _world();
        timelockExecute(
            address(fund),
            abi.encodeCall(
                IRobotMoneyFund.setInKindAllowance, (uint16(500), uint128(1_000e6), uint32(6 hours))
            )
        );
        refreshFeeds();
        uint256 half = fund.balanceOf(alice) / 2;
        vm.prank(alice);
        vm.expectRevert(IRobotMoneyFund.InKindClosed.selector);
        fund.redeemInKind(half, alice, alice);

        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.shutdown, ()));
        vm.prank(alice);
        fund.redeemInKind(half, alice, alice);
        (uint256 units,) = fund.positionClaimOf(IDX_AAVE, alice);
        assertGt(units, 0, "the wind-down in-kind exit left an Aave claim");
        _a9VenueLoss(alice);

        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.restore, (TVL_CAP)));
        refreshFeeds();
        uint256 supply = fund.totalSupply();
        (, uint256[] memory held) = fund.heldBalances();
        uint256 aavePerShare = held[IDX_AAVE].mulDiv(1e36, supply);
        uint256 rest = fund.balanceOf(alice);
        uint256 rid = openRedeemRequest(alice, rest, 0);
        settleUntilFilled(rid);
        (, held) = fund.heldBalances();
        assertGe(
            held[IDX_AAVE].mulDiv(1e36, fund.totalSupply()) + 1,
            aavePerShare,
            "stayers keep their Aave per share"
        );
        vm.clearMockedCalls();
    }

    /// @dev At its supply cap Aave refuses the purchase's lending leg: the deposit side fails and waits, the
    ///      redemption side of the same call settles. Once the venue takes supply again, the deposit settles.
    function test_A14_venueAtSupplyCap_depositsWait_redemptionsSettle() public fixtureCovered {
        _world();
        uint256 vid = openDepositRequest(victim, 50_000e6, type(uint256).max);
        uint256 rid = openRedeemRequest(alice, fund.balanceOf(alice) / 4, 0);
        warpToSettleable(vid);
        refreshFeeds();
        vm.mockCallRevert(
            AAVE_POOL, abi.encodeWithSelector(IAtkAavePool.supply.selector), bytes("51")
        );
        vm.recordLogs();
        _settleAs(keeper);
        assertTrue(_sawSideFailed(RequestKind.Deposit), "the deposit side failed at the venue");
        assertEq(queue.getRequest(vid).remaining, 50_000e6, "the deposit waits, whole");
        assertEq(
            uint8(queue.requestStatus(rid)), uint8(RequestStatus.Closed), "the redemption settled"
        );
        vm.clearMockedCalls();
        vm.warp(block.timestamp + queue.flowParams().epochLength);
        settleAll();
        assertEq(
            uint8(queue.requestStatus(vid)),
            uint8(RequestStatus.Closed),
            "the deposit settles once supply opens"
        );
    }

    /// @dev Fully borrowed (E36, E37, RB-28): no deposit settles and no match happens (`DepositStoppedForRound`
    ///      cause 3), while the net redemption still settles and turns the borrowed venue leg into position claim
    ///      units. `redeemInKind` stays closed while running and gives `alice` direct claims in wind-down.
    function test_A14_venueFullyBorrowed_redemptionsWait_depositsSettle_inKindOpen()
        public
        fixtureCovered
    {
        _world();
        uint256 vid = openDepositRequest(victim, 50_000e6, type(uint256).max);
        uint256 quarter = fund.balanceOf(alice) / 4;
        uint256 rid = openRedeemRequest(alice, quarter, 0);
        warpToSettleable(vid);
        refreshFeeds();
        vm.mockCallRevert(
            AAVE_POOL, abi.encodeWithSelector(IAtkAavePool.withdraw.selector), bytes("32")
        );
        vm.mockCall(
            address(aaveAdapter),
            abi.encodeWithSignature("availableLiquidity()"),
            abi.encode(uint256(0))
        );
        vm.recordLogs();
        _settleAs(keeper);
        assertTrue(
            _sawDepositStopped(queue.getRequest(vid).epoch, 3),
            "E36: DepositStoppedForRound cause 3 on illiquid venue"
        );
        assertEq(queue.getRequest(vid).remaining, 50_000e6, "no match and no net deposit settled");
        assertEq(
            uint8(queue.requestStatus(rid)),
            uint8(RequestStatus.Closed),
            "E37: net redemption settled with shortfall claim"
        );
        (, uint256 claimUnits) = fund.positionUnits(IDX_AAVE);
        assertGt(claimUnits, 0, "E37: Aave shortfall left position claim units");

        // In-kind exit stays closed while running and opens only in wind-down (E29).
        vm.prank(alice);
        vm.expectRevert(IRobotMoneyFund.InKindClosed.selector);
        fund.redeemInKind(quarter, alice, alice);
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.shutdown, ()));
        vm.prank(alice);
        fund.redeemInKind(quarter, alice, alice);
        (uint256 units,) = fund.positionClaimOf(IDX_AAVE, alice);
        assertGt(units, 0, "wind-down in-kind: the Aave leg is a direct claim on the position");
        assertGt(IERC20(WETH).balanceOf(alice), 0, "wind-down in-kind: basket legs paid at once");
        vm.clearMockedCalls();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A15: a gift to a lending adapter or to the fund, also on a freshly seeded fund. Expected: a gift to holders;
    //  the mix of a new fund moves by at most the gift over minSeedUsdc.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_A15_giftsToAdapterAndFund_areGiftsToHolders() public fixtureCovered {
        _world();
        _begin();
        uint256 g = 5_000e6;
        fundUsdc(attacker, 3 * g);
        deal(WETH, attacker, g.mulDiv(1e18, refWeth));
        _startAttacker();
        vm.startPrank(attacker);
        IERC20(USDC).approve(AAVE_POOL, g);
        IAtkAavePool(AAVE_POOL).supply(USDC, g, address(aaveAdapter), 0);
        IERC20(USDC).transfer(address(fund), g);
        IERC20(WETH).transfer(address(fund), IERC20(WETH).balanceOf(attacker));
        IERC20(USDC).transfer(address(queue), g);
        vm.stopPrank();
        uint256 nav1 = _navRef();
        assertGe(
            nav1 + 10,
            s0.navRef + 3 * g - 2,
            "the adapter, idle and wETH gifts all count for the holders"
        );
        FlowBooks memory b = queue.books();
        assertEq(
            IERC20(USDC).balanceOf(address(queue)),
            b.pendingUsdc + b.owedUsdc + b.creditUsdc + b.dustUsdc + g,
            "a gift to the queue sits outside its books: nobody's"
        );
        // A deposit after the gifts pays the new amount per share: no free ride on the gift.
        uint256 vid = _victimDeposit(victim, 50_000e6);
        settleUntilFilled(vid);
        AttackPnl memory r =
            _end("A15 timed, gifts to the Aave adapter, the fund and the queue", true);
        assertLe(r.attackerNet, -int256(4 * g * 99 / 100), "the gifter loses every gift");
    }

    function test_A15_giftToAFreshlySeededFund_movesTheMixAtMostGiftOverMinSeed()
        public
        fixtureCovered
    {
        refreshFeeds();
        _begin();
        uint256 g = 1_000e6;
        deal(WETH, attacker, g.mulDiv(1e18, refWeth));
        _startAttacker();
        vm.startPrank(attacker);
        IERC20(WETH).transfer(address(fund), IERC20(WETH).balanceOf(attacker));
        vm.stopPrank();
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        uint256 wethValue = held[IDX_WETH].mulDiv(refWeth, 1e18);
        uint256 weightBps = wethValue.mulDiv(BPS, idle + wethValue);
        assertLe(
            weightBps,
            g.mulDiv(BPS, fund.minSeedUsdc()),
            "the mix moved by at most gift / minSeedUsdc"
        );
        emit log_named_uint("A15: wETH weight after the gift (bps)", weightBps);
        uint256 vid = openDepositRequest(victim, 50_000e6, type(uint256).max);
        settleUntilFilled(vid);
        Claim memory c = queue.getClaim(queue.claimCount());
        assertEq(c.owner, victim, "the next deposit settles on the gifted mix");
        _end("A15 timed, a 1,000 USDC wETH gift to a fresh fund", true);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A16: the emergency key freezes every settlement's deposits. Expected: depositors wait at most minHold plus
    //  maxFreeze; no value moves.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_A16_emergencyFreezesEverySettlement_waitBoundedNoValueMoves()
        public
        fixtureCovered
    {
        _world();
        uint256 v1 = openDepositRequest(victim, 50_000e6, type(uint256).max);
        settleUntilFilled(v1);
        uint256 sid1 = queue.settlementCount();
        Claim memory c1 = queue.getClaim(queue.claimCount());
        uint256 v2 = openDepositRequest(victim2, 50_000e6, type(uint256).max);
        settleUntilFilled(v2);
        uint256 sid2 = queue.settlementCount();
        Claim memory c2 = queue.getClaim(queue.claimCount());
        FlowParams memory p = queue.flowParams();
        uint256 supply = fund.totalSupply();
        uint256 queueShares = fund.balanceOf(address(queue));

        // E49 / RB-18: settlement 1 is frozen at the last second of its hold (longest wait); any second
        // freeze inside `maxFreeze` reverts with `FreezeOnCooldown`.
        vm.warp(c1.unlockAt - 1);
        vm.prank(emergency);
        queue.freezeSettlement(sid1);
        uint64 cooldownUntil = uint64(block.timestamp) + p.maxFreeze;
        vm.prank(emergency);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.FreezeOnCooldown.selector, cooldownUntil));
        queue.freezeSettlement(sid1);
        vm.prank(emergency);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.FreezeOnCooldown.selector, cooldownUntil));
        queue.freezeSettlement(sid2);
        uint64 until1 = queue.getSettlement(sid1).frozenUntil;
        assertLe(
            until1, uint256(c1.unlockAt) + p.maxFreeze, "RB-18: a freeze ends by unlock + maxFreeze"
        );

        // Nothing moves while frozen; freeze 1 ends by itself; after cooldown, a fresh freeze can be
        // released by ADMIN or immediately lifted by wind-down (`shutdown()`).
        vm.warp(until1 - 1);
        refreshFeeds();
        assertEq(queue.maxMint(victim), 0, "frozen: nothing deliverable");
        assertEq(fund.totalSupply(), supply, "no value moved");
        assertEq(fund.balanceOf(address(queue)), queueShares, "the held shares stay in the queue");
        vm.warp(until1);
        queue.mint(c1.shares, victim);
        assertEq(
            fund.balanceOf(victim),
            c1.shares,
            "the depositor gets exactly its shares when the freeze ends"
        );
        vm.prank(emergency);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.FreezeOutsideHold.selector, sid1));
        queue.freezeSettlement(sid1);

        // Release test after cooldown on settlement 3 (frozen inside its hold).
        uint256 v3 = openDepositRequest(victim2, 50_000e6, type(uint256).max);
        settleUntilFilled(v3);
        uint256 sid3 = queue.settlementCount();
        Claim memory c3 = queue.getClaim(queue.claimCount());
        vm.warp(c3.unlockAt - 1);
        refreshFeeds();
        vm.prank(emergency);
        queue.freezeSettlement(sid3);
        assertLe(
            queue.getSettlement(sid3).frozenUntil,
            uint256(c3.unlockAt) + p.maxFreeze,
            "RB-18: freeze ends by unlock + maxFreeze"
        );
        timelockExecute(address(queue), abi.encodeCall(queue.releaseSettlement, (sid3)));
        refreshFeeds();
        queue.mint(c3.shares, victim2);
        assertEq(
            fund.balanceOf(victim2),
            c3.shares,
            "the released depositor gets all shares immediately"
        );
        // After waiting for minHold of sid2 too, victim2 delivers sid2.
        warpForward(c2.unlockAt);
        refreshFeeds();
        queue.mint(c2.shares, victim2);
        assertEq(fund.balanceOf(victim2), c2.shares + c3.shares, "the second depositor too");
        emit log_named_uint(
            "A16: longest wait after settlement (s)", until1 - (c1.unlockAt - p.minHold)
        );
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A17: a USDC depeg past the band. Expected: settlement blocks; the exits stay open.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_A17_usdcDepeg_blocksSettlement_exitsStayOpen() public fixtureCovered {
        _world();
        uint256 d1 = openDepositRequest(victim2, 50_000e6, type(uint256).max);
        settleUntilFilled(d1);
        uint256 unlocked = deliverAfterHold(victim2) == 0 ? 0 : 1;
        unlocked;
        uint256 rid = openRedeemRequest(alice, fund.balanceOf(alice) / 4, 0);
        uint256 vid = openDepositRequest(victim, 50_000e6, type(uint256).max);
        warpToSettleable(vid);
        refreshFeeds();
        _begin();
        setUsdcFeedPrice(99_400_000);
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.UsdcPeg), "check 2: USDC off its peg");
        vm.prank(keeper);
        vm.expectPartialRevert(IFlowEvents.SettleBlocked.selector);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        // E31: forward-priced terms view never reverts on feeds/peg.
        Quote memory qDep = queue.quoteDeposit(1_000e6);
        Quote memory qRed = queue.quoteRedeem(1e18);
        assertEq(qDep.feeBps, 0, "E31: deposit quote has zero exit fee even during depeg");
        assertEq(qRed.feeBps, EXIT_FEE_BPS, "E31: redeem quote returns fee even during depeg");
        assertGt(qDep.holdEnds, qDep.earliestSettle, "E31: terms quote computes schedule during depeg");

        // E29 / RB-25: locked redemption cannot exit in kind while live; it may give notice after maxRoll.
        vm.prank(alice);
        vm.expectRevert(IRobotMoneyFund.InKindClosed.selector);
        fund.redeemInKind(1, alice, alice);
        // A locked deposit cannot cancel in a quiet depeg either (only in open epoch or under a deposit stop),
        // and exits via withdrawExpired once maxRoll epochs have passed.
        vm.warp(block.timestamp + uint256(queue.flowParams().maxRoll + 1) * queue.flowParams().epochLength);
        vm.prank(victim);
        queue.withdrawExpired(vid);
        assertEq(IERC20(USDC).balanceOf(victim), 50_000e6, "the expired escrow came back whole");
        vm.prank(alice);
        assertGt(queue.giveRedemptionNotice(rid), 0, "E40: aged redemption enters notice cleanly");
        uint256 w = fund.balanceOf(victim2) / 2;
        vm.prank(victim2);
        vm.expectRevert(IRobotMoneyFund.InKindClosed.selector);
        fund.redeemInKind(w, victim2, victim2);
        // Once Safe enters wind-down (`shutdown()`), holders exit in kind cleanly even during depeg.
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.shutdown, ()));
        vm.prank(victim2);
        fund.redeemInKind(w, victim2, victim2);
        _assertPerShareNotLower("A17");
        setUsdcFeedPrice(1e8);
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.restore, (TVL_CAP)));
        refreshFeeds();
        // Inside an epoch window vs outside: ensure peg check specifically cleared.
        vm.prank(keeper);
        (check,) = queue.checkSettle();
        assertTrue(check != SettleCheck.UsdcPeg, "the peg check clears with the peg");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A18: liquidity pulled from a pool just before a settlement. Expected: the per-swap limit fails; nothing
    //  settles and nobody loses.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    int24 internal lpLower;
    int24 internal lpUpper;
    uint128 internal lpLiquidity;
    uint256 internal lpPaidUsdc;
    uint256 internal lpPaidWeth;
    uint256 internal lpGotUsdc;
    uint256 internal lpGotWeth;

    /// @dev The attacker (this contract, as an LP) adds ten times the pool's liquidity in a 3 % band around the
    ///      price before the window, so a large batch sized for that depth fits. Right before the keeper's call it
    ///      pulls it. The LP's own round trip (tokens paid in, tokens collected) is the attacker's result.
    ///      Before the per-call cap was on by default (2026-11-12) the batch then failed its per-swap limit: nothing
    ///      settled. At the defaults the call is sized by the cap from the pool's TIME-WEIGHTED depth, which the
    ///      liquidity held through the window still inflates (logged): either the per-swap limit refuses the call
    ///      (nothing settles), or the capped call settles a part inside every limit. Either way nobody loses.
    function test_A18_liquidityPulledBeforeSettlement_limitFailsNothingSettles()
        public
        fixtureCovered
    {
        _bigWorld();
        _setRef();
        _lpAdd(10, 300);
        uint256 vid = openDepositRequest(victim, 1_000_000e6, type(uint256).max);
        warpToSettleable(vid);
        refreshFeeds();
        _begin();
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        assertGt(
            queue.settle(SETTLE_MAX_REQUESTS, 600_000e6),
            0,
            "with the liquidity in place, the batch fits"
        );
        vm.revertToState(snap);

        uint256 roomHeld = _callRoomUsdc();
        _lpRemove();
        emit log_named_uint(
            "A18: one call's room with the LP's liquidity held through the window (USDC units)",
            roomHeld
        );
        emit log_named_uint(
            "A18: the same room right after the pull (time-weighted, so unchanged)", _callRoomUsdc()
        );
        uint256 supply = fund.totalSupply();
        uint256 queueUsdc = IERC20(USDC).balanceOf(address(queue));
        (uint160 sqrt0,,,,,,) = IAtkPool(WETH_POOL).slot0();
        uint256 px0 = _spotPx(WETH_POOL, WETH, USDC);
        vm.recordLogs();
        vm.roll(block.number + 1);
        vm.prank(keeper);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, 600_000e6);
        bool failed = _sawSideFailed(RequestKind.Deposit);
        if (sid == 0) {
            assertTrue(failed, "pulled: the per-swap limit refused it");
            assertEq(fund.totalSupply(), supply, "nothing minted");
            assertEq(IERC20(USDC).balanceOf(address(queue)), queueUsdc, "nobody's USDC moved");
            assertEq(queue.getRequest(vid).remaining, 1_000_000e6, "the request waits, whole");
            emit log_named_string(
                "A18: after the pull", "the per-swap limit refused the call: nothing settled"
            );
        } else {
            assertFalse(failed, "a call that recorded a settlement had no failed deposit side");
            uint256 usdcIn = queue.getSettlement(sid).usdcIn;
            assertLe(
                usdcIn, roomHeld + roomHeld / 100, "pulled: the call stays inside the cap's room"
            );
            assertLt(usdcIn, 600_000e6, "pulled: the cap, not maxUsdc, sized the call");
            (uint256 u,) = _victimFills(vid); // RB-14 on the fill
            assertEq(u, usdcIn, "the part is the victim's");
            emit log_named_uint("A18: after the pull, the capped call settled (USDC units)", usdcIn);
            emit log_named_uint(
                "A18: wETH pool move of that call in the thinned pool (bps)",
                (_spotPx(WETH_POOL, WETH, USDC) - px0) * BPS / px0
            );
            // An arbitrageur brings the thinned pool back before the next part (as A12).
            _arbBackWeth(sqrt0);
        }
        _assertPerShareNotLower("A18 pulled");
        _nextBlock();
        vm.prank(keeper);
        assertGt(queue.settle(SETTLE_MAX_REQUESTS, 100_000e6), 0, "a smaller call settles a part");
        extraNet = _lpNet();
        _end("A18 timed, liquidity pulled before the settlement (the LP's round trip)", true);
    }

    /// @dev The LP's result at the reference price: what `_lpRemove` collected less what `_lpAdd` paid.
    function _lpNet() internal view returns (int256) {
        uint256 paid = lpPaidUsdc + lpPaidWeth.mulDiv(refWeth, 1e18);
        uint256 got = lpGotUsdc + lpGotWeth.mulDiv(refWeth, 1e18);
        return _diff(got, paid);
    }

    /// @dev Mint `mult` times the pool's active liquidity in ±`halfBps` around the current tick, from this contract.
    function _lpAdd(uint256 mult, int24 halfTicks) internal {
        IAtkPool p = IAtkPool(WETH_POOL);
        (, int24 tick,,,,,) = p.slot0();
        int24 sp = p.tickSpacing();
        lpLower = ((tick - halfTicks) / sp) * sp;
        lpUpper = ((tick + halfTicks) / sp + 1) * sp;
        lpLiquidity = uint128(uint256(p.liquidity()) * mult);
        p.mint(address(this), lpLower, lpUpper, lpLiquidity, "");
    }

    function _lpRemove() internal {
        IAtkPool p = IAtkPool(WETH_POOL);
        p.burn(lpLower, lpUpper, lpLiquidity);
        (uint128 a0, uint128 a1) =
            p.collect(address(this), lpLower, lpUpper, type(uint128).max, type(uint128).max);
        (lpGotWeth, lpGotUsdc) =
            p.token0() == WETH ? (uint256(a0), uint256(a1)) : (uint256(a1), uint256(a0));
    }

    /// @dev Uniswap V3 mint callback: pay the pool what it asks, minting the tokens to this contract first.
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata)
        external
    {
        require(msg.sender == WETH_POOL, "mint callback: only the pool");
        address t0 = IAtkPool(WETH_POOL).token0();
        address t1 = IAtkPool(WETH_POOL).token1();
        _payPool(t0, amount0Owed);
        _payPool(t1, amount1Owed);
    }

    function _payPool(address token, uint256 amount) private {
        if (amount == 0) return;
        if (token == USDC) {
            fundUsdc(address(this), amount);
            lpPaidUsdc += amount;
        } else {
            deal(token, address(this), IERC20(token).balanceOf(address(this)) + amount);
            lpPaidWeth += amount;
        }
        IERC20(token).transfer(msg.sender, amount);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A19: the exclusion ledger. Expected: an address filled after a record opened gets nothing; a redeemer whose
    //  shares were burned keeps its claim.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_A19_exclusionLedger_freshAddressGetsNothing_burnedRedeemerKeepsClaim()
        public
        fixtureCovered
    {
        _world();
        FundExclusionLedger ledger = FundExclusionLedger(fund.exclusionLedger());
        address carol = makeAddr("carol");
        uint256 cid = openDepositRequest(carol, 50_000e6, type(uint256).max);
        settleUntilFilled(cid); // carol's shares are in their hold: queued, not in her wallet
        uint256 aliceShares = fund.balanceOf(alice);
        uint256 rid = openRedeemRequest(alice, aliceShares / 2, 0);
        uint256 did = openDepositRequest(dave, 50_000e6, type(uint256).max);
        uint256 aliceLedger = fund.ledgerBalanceOf(alice);
        uint256 carolLedger = fund.ledgerBalanceOf(carol);
        assertEq(aliceLedger, aliceShares, "alice: wallet plus escrow");
        assertGt(carolLedger, 0, "carol: held shares count");

        // The record opens: Moonwell is excluded (ADMIN revokes its code hash).
        timelockExecute(
            address(fund),
            abi.encodeCall(
                IRobotMoneyFund.setAdapterCodeHashAllowed,
                (address(moonwellAdapter).codehash, false)
            )
        );
        uint256 id = fund.openExclusionOf(IDX_MOONWELL);
        assertGt(id, 0, "a record opened");

        // Redemptions settle alone while excluded (check 1); alice's escrow is burned. The excluded venue left the
        // NAV at the feeds, so the share-price breaker (check 6) holds every settlement until enough epochs passed
        // (design observation, defects.md): wait it out, as a keeper would.
        warpToSettleable(rid);
        uint256 blockedEpochs = _waitOutSharePriceBreaker();
        emit log_named_uint(
            "A19: epochs check 6 held every settlement after the exclusion", blockedEpochs
        );
        settleAll();
        assertEq(
            uint8(queue.requestStatus(rid)),
            uint8(RequestStatus.Closed),
            "alice's redemption settled"
        );
        assertEq(
            queue.getRequest(did).remaining, 50_000e6, "deposits are not processed while excluded"
        );
        // A fresh address gets shares after the record by transfer.
        uint256 moved = fund.balanceOf(alice) / 2;
        vm.prank(alice);
        fund.transfer(attacker, moved);

        // Restore: the excluded position drains into the record; deposits reopen; dave is filled after the record.
        timelockExecute(
            address(fund),
            abi.encodeCall(
                IRobotMoneyFund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, true)
            )
        );
        vm.warp(block.timestamp + queue.flowParams().epochLength);
        settleAll();
        assertEq(
            uint8(queue.requestStatus(did)),
            uint8(RequestStatus.Closed),
            "dave filled after the record"
        );
        deliverAfterHold(dave);

        assertEq(
            ledger.balanceAt(alice, id), aliceLedger, "alice keeps wallet + escrow at the record"
        );
        assertEq(
            ledger.balanceAt(carol, id), carolLedger, "carol keeps her held shares at the record"
        );
        assertEq(ledger.balanceAt(dave, id), 0, "dave, filled after the record, has none");
        assertEq(ledger.balanceAt(attacker, id), 0, "a transfer after the record carries no claim");
        assertEq(ledger.balanceAt(address(queue), id), 0, "the queue itself has no entitlement");
        assertGt(ledger.claimable(id, alice), 0, "alice, whose escrow burned, can claim");
        assertEq(ledger.claimable(id, dave), 0, "dave can claim nothing");
        assertEq(ledger.claimable(id, attacker), 0, "the fresh address can claim nothing");
        emit log_named_uint("A19: alice's claim (USDC units)", ledger.claimable(id, alice));
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Step 3f attacks (A21, A23 to A28, A30 to A45; A22 and A29 withdrawn in D20 and D24)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _etchAaveMech() internal returns (MechAaveAdapter m) {
        MechAaveAdapter impl = new MechAaveAdapter(AAVE_POOL, USDC, AAVE_A_USDC, address(fund));
        timelockExecute(
            address(fund),
            abi.encodeCall(IRobotMoneyFund.setAdapterCodeHashAllowed, (address(impl).codehash, true))
        );
        vm.etch(address(aaveAdapter), address(impl).code);
        m = MechAaveAdapter(address(aaveAdapter));
    }

    function _etchSwapMech() internal returns (MechSwapAdapter m) {
        MechSwapAdapter impl = new MechSwapAdapter(ROUTER);
        timelockExecute(
            address(fund),
            abi.encodeCall(IRobotMoneyFund.setAdapterCodeHashAllowed, (address(impl).codehash, true))
        );
        vm.etch(address(swapAdapter), address(impl).code);
        m = MechSwapAdapter(address(swapAdapter));
    }

    function _seedHolder(address who, uint256 usdc) internal returns (uint256 shares) {
        deposit(who, usdc);
        _takeCredit(who);
        shares = fund.balanceOf(who);
    }

    /// @dev Fair share value in USDC at the fixed reference prices (`_navRef`).
    function _sharesRefUsdc(uint256 shares) internal view returns (uint256) {
        return _shareValue(shares);
    }

    /// @notice A21: lagging TWAP — an informed user joins the side the TWAP lag favors (within `refBandBps`)
    ///         against an uninformed counterparty in a whole-match round. Logs matched loss and attacker net.
    function test_A21_laggingTwap_informedJoinsFavoredSideInsideGuard() public fixtureCovered {
        _world();
        uint256 vShares = fund.balanceOf(alice) / 2;
        uint64 ep = queue.currentEpoch();
        uint256 windowEnd = queue.settleableAt(ep);
        openRedeemRequest(alice, vShares);

        // Move market +80 bps near the end of the settle window so 11/12 slices keep TWAP near pre-move price
        // while the Chainlink feed jumps to spot: |TWAP - feed| < refBandBps (100 bps).
        _begin();
        fundUsdc(attacker, 60_000e6);
        _startAttacker();

        // Informed attacker joins the deposit side to match alice's redemption at the lagging TWAP.
        uint256 vValueRef = _sharesRefUsdc(vShares);
        _reqDeposit(attacker, vValueRef, 0);

        vm.warp(windowEnd - 5 minutes);
        refreshFeeds();
        _moveMarket(WETH_POOL, WETH, 80);
        setFeedPrice(IDX_WETH, poolPrice8(WETH_POOL, WETH));

        vm.warp(windowEnd);
        refreshFeeds();
        vm.prank(keeper);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertGt(sid, 0, "A21: round settled inside feed guard");
        Settlement memory st = queue.getSettlement(sid);
        assertGt(st.matchedShares, 0, "A21: whole match executed");

        // Matched redeemer loss against true current spot NAV at `_begin()` (before exit fee).
        uint256 aliceGot = _claimRedeemUsdc(alice);
        uint256 fairAfterFee = vValueRef - vValueRef.mulDiv(10, BPS);
        pending = fairAfterFee > aliceGot ? fairAfterFee - aliceGot : 0;
        assertLe(
            pending,
            vValueRef.mulDiv(queue.flowParams().refBandBps, BPS),
            "A21: matched user loss within refBandBps"
        );

        // Wait until TWAP catches up, deliver shares, and redeem net back to USDC so exit + swap fees apply.
        vm.warp(block.timestamp + queue.flowParams().minHold + queue.flowParams().epochLength);
        refreshFeeds();
        uint256 atkShares = deliverAfterHold(attacker);
        _takeCredit(attacker);
        if (atkShares != 0) redeem(attacker, atkShares);
        AttackPnl memory r = _end("A21: lagging TWAP informed match inside guard", false);
        _assertPerShareNotLower("A21");
        _g8OrFinding("A21: lagging TWAP informed match", r);
    }

    /// @notice A23: self-match — one owner on both sides pays the exit fee, gains nothing, uses epoch cap, and
    ///         stays bound by `minHold`.
    function test_A23_selfMatch_paysFeeGainsNothing_respectsCapAndHold() public fixtureCovered {
        _world();
        uint256 initShares = _seedHolder(attacker, 100_000e6);
        _begin();
        fundUsdc(attacker, 60_000e6);
        _startAttacker();

        uint256 feeBefore = IERC20(USDC).balanceOf(feeRecipient);
        uint256 depAmt = 50_000e6;
        uint256 redShares = initShares / 2;
        uint256 did = _reqDeposit(attacker, depAmt, 0);
        uint256 rid = openRedeemRequest(attacker, redShares);

        uint64 ep = queue.getRequest(did).epoch;
        warpToSettleable(did);
        refreshFeeds();
        vm.prank(keeper);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertGt(sid, 0, "A23: settled");
        Settlement memory st = queue.getSettlement(sid);
        assertGt(st.matchedShares, 0, "A23: self-match booked");

        // Exit fee was still paid on matched shares.
        uint256 feePaid = IERC20(USDC).balanceOf(feeRecipient) - feeBefore;
        assertGt(feePaid, 0, "A23: self-match paid exit fee");

        // Epoch cap was consumed by matched USDC (`periodFlow`).
        FlowParams memory p = queue.flowParams();
        uint256 cap = Math.max(_navRef().mulDiv(p.maxEpochFlowBps, BPS), p.epochFlowFloorUsdc);
        (uint256 depUsed, uint256 redUsed) = queue.periodFlow(block.timestamp / p.epochLength);
        ep;
        assertGt(cap, 0);
        assertGe(depUsed, st.matchedUsdc, "A23: self-match counted against deposit cap");
        assertGe(redUsed, st.matchedUsdc, "A23: self-match counted against redeem cap");

        // Newly matched deposit shares are STILL under minHold (`maxDeposit == 0`).
        assertEq(queue.maxDeposit(attacker), 0, "A23: matched deposit shares remain held during minHold");
        assertGt(queue.claimableRedeemRequest(rid, attacker), 0, "A23: matched redeem claim created");
        deliverAfterHold(attacker);
        _claimRedeemUsdc(attacker);
        _takeCredit(attacker);
        AttackPnl memory r = _end("A23: self-match pays fee and obeys cap+hold", true);
        assertLt(r.attackerNet, 0, "A23: self-matcher lost at least the exit fee");
    }

    /// @notice A24: cancel cutoff (`cancelBuffer`) — cancelling past cutoff reverts `RequestLocked`, and a request
    ///         created in the last block of an epoch locks immediately against cancel.
    function test_A24_cutoff_cancelAfterCloseReverts_lastBlockRequestLocksOneBlockLater()
        public
        fixtureCovered
    {
        _world();
        _begin();
        fundUsdc(attacker, 60_000e6);
        _startAttacker();

        FlowParams memory p = queue.flowParams();
        uint64 ep = queue.currentEpoch();
        uint256 epEnd = (uint256(ep) + 1) * p.epochLength;
        uint256 cutoff = epEnd - p.cancelBuffer;

        // Open early request -> cancellable before cutoff, locked at cutoff.
        uint256 didEarly = _reqDeposit(attacker, 10_000e6, 0);
        vm.warp(cutoff - 1);
        vm.prank(attacker);
        queue.cancel(didEarly);
        _takeCredit(attacker);

        uint256 didLocked = _reqDeposit(attacker, 10_000e6, 0);
        uint256 aliceShares = fund.balanceOf(alice);
        uint256 ridLocked = openRedeemRequest(alice, aliceShares / 4);

        vm.warp(cutoff);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.RequestLocked.selector, didLocked));
        queue.cancel(didLocked);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.RequestLocked.selector, ridLocked));
        queue.cancel(ridLocked);

        // Request in the very last second of epoch `ep` (within cancelBuffer) -> locked now and 1s later (`ep + 1`).
        vm.warp(epEnd - 1);
        uint256 didLast = _reqDeposit(attacker, 10_000e6, 0);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.RequestLocked.selector, didLast));
        queue.cancel(didLast);
        vm.warp(epEnd + 1);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.RequestLocked.selector, didLast));
        queue.cancel(didLast);

        // Clean settlement closes locked requests without gain.
        warpToSettleable(didLocked);
        refreshFeeds();
        settleAll();
        // Lending interest accrues with time and every holder earns it. Record the share price at settlement so
        // the yield on the attacker's shares afterwards is taken out of the net: it is not attack profit.
        uint256 navAtSettle = _navRef();
        uint256 supplyAtSettle = fund.totalSupply();
        // The match prices at the TWAP NAV, which trails the rising NAV by the yield of the window (design: feeds
        // are guards only). Any depositor matched in that settlement gets the same, so it is the benchmark, not an
        // edge from the cancel cutoff. A21 measures the lag on its own.
        {
            Settlement memory sm = queue.getSettlement(queue.settlementCount());
            uint256 refNow = navAtSettle.mulDiv(sm.matchedShares, supplyAtSettle);
            uint256 paid = sm.matchedShares.mulDiv(sm.matchSharePrice, 1e36);
            if (refNow > paid) extraNet -= int256(refNow - paid);
        }
        deliverAfterHold(attacker);
        vm.warp(block.timestamp + p.minHold);
        refreshFeeds();
        uint256 mShares = queue.maxMint(attacker);
        if (mShares > 0) {
            vm.prank(attacker);
            queue.mint(mShares, attacker);
        }
        _claimRedeemUsdc(alice);
        _takeCredit(attacker);
        {
            uint256 held = fund.balanceOf(attacker);
            uint256 supplyNow = fund.totalSupply();
            uint256 yieldGain = held.mulDiv(_navRef(), supplyNow) - held.mulDiv(navAtSettle, supplyAtSettle);
            extraNet -= int256(yieldGain);
        }
        _end("A24: cancel cutoff and last-block lock", true);
    }

    /// @notice A25: attacker pushes the pool spot past `legBandBps` right at settle so the net side fails while
    ///         the whole match still settles cleanly at TWAP.
    function test_A25_pushedNetSideFailsWhileMatchSettles() public fixtureCovered {
        _world();
        uint256 rShares = fund.balanceOf(alice) / 4; // ~25k shares
        uint256 vid = _victimDeposit(victim, 60_000e6); // larger deposit -> net deposit
        uint256 rid = openRedeemRequest(alice, rShares);

        warpToSettleable(vid);
        refreshFeeds();
        _begin();
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();

        // Push WETH pool spot by +250 bps right in the settle block (> legBandBps, while 12-slice median TWAP is
        // unchanged -> Check 4 still passes, whole match settles, net deposit fails Swap/Check 11).
        (, uint256 boughtWeth) = _pushBps(attacker, WETH_POOL, WETH, USDC, 250);
        borrowed += _sharesRefUsdc(0); // only push spending counts
        vm.recordLogs();
        vm.prank(keeper);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertGt(sid, 0, "A25: settlement created for match");
        Settlement memory st = queue.getSettlement(sid);
        assertGt(st.matchedShares, 0, "A25: whole match settled despite net-side failure");
        assertEq(st.sharesMinted, 0, "A25: net deposit failed and minted zero shares");
        assertTrue(_sawSideFailed(RequestKind.Deposit), "A25: SideFailed(Deposit) emitted");
        assertEq(
            uint8(queue.requestStatus(rid)),
            uint8(RequestStatus.Closed),
            "A25: matched redemption fully closed"
        );
        assertGt(queue.getRequest(vid).remaining, 0, "A25: unmatched deposit remainder kept safely pending");

        _sellExact(attacker, WETH_POOL, WETH, USDC, boughtWeth);
        _claimRedeemUsdc(alice);
        _end("A25: net deposit fails while match settles", true);
    }

    /// @notice A26: stuck fund — settlement blocked for `maxRoll` epochs. Reports blocker cost, holder actions
    ///         before expiry, expired/notice exits, and Safe timelock wind-down.
    function test_A26_stuckFund_blockedMaxRollEpochs_reportsCostAndWindDown() public fixtureCovered {
        _world();
        uint256 vid = _victimDeposit(victim, 50_000e6);
        uint256 initAlice = fund.balanceOf(alice);
        uint256 half = initAlice / 2;
        uint256 rid = openRedeemRequest(alice, half);
        _begin();
        fundUsdc(attacker, 100_000e6);
        _startAttacker();

        // While stuck (USDC off-peg): redeemInKind MUST stay closed (only Safe timelock shuts down),
        // and emergency CANNOT call shutdown.
        setUsdcFeedPrice(0.95e8);
        FlowParams memory p = queue.flowParams();
        for (uint256 k; k < p.maxRoll + 1; ++k) {
            if (k == 0) warpToSettleable(vid);
            else vm.warp(block.timestamp + p.epochLength);
            refreshFeeds();
            vm.prank(keeper);
            (SettleCheck chk,) = queue.checkSettle();
            assertEq(uint8(chk), uint8(SettleCheck.UsdcPeg), "A26: usdc off-peg keeps blocking");
        }
        vm.prank(alice);
        vm.expectRevert(IRobotMoneyFund.InKindClosed.selector);
        fund.redeemInKind(half, alice, alice);
        vm.prank(emergency);
        vm.expectPartialRevert(0xe2517d3f); // AccessControlUnauthorizedAccount
        fund.shutdown();

        // After maxRoll epochs: expired deposit withdraws USDC directly; old redemption gives notice & recovers
        // when notice round closes; rest of Alice's wallet shares exit in kind once Safe shuts down.
        vm.prank(victim);
        assertEq(queue.withdrawExpired(vid), 50_000e6, "A26: expired deposit returned whole");
        vm.prank(alice);
        assertGt(queue.giveRedemptionNotice(rid), 0, "A26: old redemption gave notice while stuck");
        vm.warp(block.timestamp + 2 * uint256(p.epochLength) + p.settleWindow);
        refreshFeeds();
        vm.prank(alice);
        queue.withdrawCredit();
        assertEq(fund.balanceOf(alice), initAlice, "A26: all shares restored");

        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.shutdown, ()));
        uint256 aliceWallet = fund.balanceOf(alice); // read first: a prank covers only the next call
        vm.prank(alice);
        fund.redeemInKind(aliceWallet, alice, alice);
        assertGt(IERC20(WETH).balanceOf(alice), 0, "A26: wind-down pays basket tokens in kind");
        _end("A26: stuck fund maxRoll exits & Safe wind-down", true);
    }

    /// @notice A27: held pool TWAP — pushes pool steadily inside `refBandBps` so check 4 passes, measures match
    ///         price lean, matched loss, holding cost, and verifies check 4 blocks past `refBandBps`.
    function test_A27_heldPoolTwap_measuresMatchLeanAndHoldCost() public fixtureCovered {
        _world();
        uint256 matchAmt = 100_000e6;
        uint256 dShares = _seedHolder(dave, matchAmt);
        uint256 vDep = _victimDeposit(victim, matchAmt);
        openRedeemRequest(dave, dShares);
        uint256 windowEnd = queue.settleableAt(queue.getRequest(vDep).epoch);

        vm.warp(windowEnd - 1 hours);
        refreshFeeds();
        _begin();

        // Counterfactual honest match price.
        uint256 snap = vm.snapshotState();
        vm.warp(windowEnd);
        refreshFeeds();
        vm.prank(keeper);
        uint256 hSid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        uint256 honestMatchPrice = queue.getSettlement(hSid).matchSharePrice;
        vm.revertToState(snap);

        // Ramp WETH inside refBandBps across 12 x 5-min slices (+7 bps/slice ~ +84 bps < 100 bps refBand).
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        uint256 bought;
        for (uint256 k; k < 12; ++k) {
            (uint256 spent, uint256 tok) = _pushBps(attacker, WETH_POOL, WETH, USDC, 7);
            borrowed += spent;
            bought += tok;
            vm.warp(block.timestamp + 5 minutes);
        }
        vm.warp(windowEnd > block.timestamp ? windowEnd : block.timestamp);
        refreshFeeds();
        vm.prank(keeper);
        (SettleCheck chk,) = queue.checkSettle();
        assertEq(uint8(chk), uint8(SettleCheck.Ok), "A27: held ramp inside refBand passes check 4");
        vm.prank(keeper);
        uint256 aSid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        uint256 leanMatchPrice = queue.getSettlement(aSid).matchSharePrice;
        _sellExact(attacker, WETH_POOL, WETH, USDC, bought);

        uint256 leanBps = leanMatchPrice > honestMatchPrice
            ? (leanMatchPrice - honestMatchPrice) * BPS / honestMatchPrice
            : 0;
        emit log_named_uint("A27: honest match price (1e36)", honestMatchPrice);
        emit log_named_uint("A27: leaned match price (1e36)", leanMatchPrice);
        emit log_named_uint("A27: match price lean (bps)", leanBps);
        pending = matchAmt.mulDiv(leanBps, BPS);
        AttackPnl memory r = _end("A27: held pool TWAP match lean", false);
        _assertPerShareNotLower("A27");
        _g8OrFinding("A27: held pool TWAP match", r);
    }

    /// @notice A28: bank run with a match — many redeemers and one small depositor over cap: equal match fraction
    ///         across same-round redeemers, FIFO oldest-first net redemption, and tracked final wait time.
    function test_A28_runWithMatch_manyRedeemersFewDepositors_proRataFillsAndWait()
        public
        fixtureCovered
    {
        _world();
        address r2 = makeAddr("redeemer2");
        address r3 = makeAddr("redeemer3");
        uint256 s1 = fund.balanceOf(alice);
        uint256 s2 = _seedHolder(r2, 200_000e6);
        uint256 s3 = _seedHolder(r3, 200_000e6);
        _begin();
        _startAttacker();

        // Same epoch: 100k deposit vs ~500k redemptions (> 250k epoch cap).
        uint256 depId = _victimDeposit(victim, 100_000e6);
        uint64 tStart = uint64(block.timestamp);
        uint256 id1 = openRedeemRequest(alice, s1);
        uint256 id2 = openRedeemRequest(r2, s2);
        uint256 id3 = openRedeemRequest(r3, s3);

        warpToSettleable(depId);
        refreshFeeds();
        vm.prank(keeper);
        uint256 sid1 = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        Settlement memory st1 = queue.getSettlement(sid1);
        assertGt(st1.matchedShares, 0, "A28: match booked");
        // All three redeemers got matched first pro-rata (all have positive claimable shares in round 1).
        assertGt(queue.claimableRedeemRequest(id1, alice), 0, "A28: r1 received match fill");
        assertGt(queue.claimableRedeemRequest(id2, r2), 0, "A28: r2 received match fill");
        assertGt(queue.claimableRedeemRequest(id3, r3), 0, "A28: r3 received match fill");
        assertEq(
            uint8(queue.requestStatus(depId)), uint8(RequestStatus.Closed), "A28: depositor filled"
        );
        // FIFO net side: r1 closed first while r3 waits for subsequent cap periods.
        assertEq(uint8(queue.requestStatus(id1)), uint8(RequestStatus.Closed), "A28: oldest redeemer closed");

        uint256 settledEpochs = 1;
        while (uint8(queue.requestStatus(id3)) != uint8(RequestStatus.Closed) && settledEpochs < 12) {
            vm.warp(block.timestamp + queue.flowParams().epochLength);
            refreshFeeds();
            settleAll();
            ++settledEpochs;
        }
        assertEq(uint8(queue.requestStatus(id3)), uint8(RequestStatus.Closed), "A28: last redeemer drained");
        emit log_named_uint("A28: wait time to drain last redeemer (seconds)", block.timestamp - tStart);
        _claimRedeemUsdc(alice);
        _claimRedeemUsdc(r2);
        _claimRedeemUsdc(r3);
        _end("A28: run with match pro-rata and FIFO wait", true);
    }

    /// @notice A30: fully borrowed or impaired lending venue while both sides have requests — no match is booked
    ///         and net redemptions produce position claims (impaired venue uses exclusion ledger).
    function test_A30_venueFullyBorrowedOrImpairedWithBothSides_noMatchAndClaim()
        public
        fixtureCovered
    {
        // Part 1: Impaired venue (revoked adapter -> open exclusion ledger).
        _world();
        _begin();
        _startAttacker();
        uint256 vid = _victimDeposit(victim, 50_000e6);
        uint256 half = fund.balanceOf(alice) / 2;
        uint256 rid = openRedeemRequest(alice, half);
        warpToSettleable(vid);
        refreshFeeds();

        timelockExecute(
            address(fund),
            abi.encodeCall(
                IRobotMoneyFund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, false)
            )
        );
        refreshFeeds();
        vm.recordLogs();
        vm.prank(keeper);
        uint256 sid1 = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertGt(sid1, 0, "A30-impaired: redemption settled");
        assertEq(queue.getSettlement(sid1).matchedShares, 0, "A30-impaired: no match during exclusion");
        assertTrue(
            _sawDepositStopped(queue.getRequest(vid).epoch, 1),
            "A30-impaired: DepositStopped cause 1 emitted"
        );
        assertEq(
            uint8(queue.requestStatus(rid)), uint8(RequestStatus.Closed), "A30-impaired: redeem settled"
        );
        assertEq(queue.getRequest(vid).remaining, 50_000e6, "A30-impaired: deposit stayed pending");

        // Part 2: Fully borrowed lending venue while both sides have requests (same E36/E37 flow).
        // Restore Moonwell first so only Check 5 venue liquidity stops deposits.
        timelockExecute(
            address(fund),
            abi.encodeCall(
                IRobotMoneyFund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, true)
            )
        );
        uint256 quarter = fund.balanceOf(alice) / 2;
        uint256 vid2 = openDepositRequest(victim2, 40_000e6);
        uint256 rid2 = openRedeemRequest(alice, quarter);
        warpToSettleable(vid2);
        refreshFeeds();
        vm.mockCallRevert(
            AAVE_POOL, abi.encodeWithSelector(IAtkAavePool.withdraw.selector), bytes("32")
        );
        vm.mockCall(
            address(aaveAdapter),
            abi.encodeWithSignature("availableLiquidity()"),
            abi.encode(uint256(0))
        );
        vm.recordLogs();
        vm.prank(keeper);
        uint256 sid2 = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        vm.clearMockedCalls();
        assertTrue(_sawDepositStopped(queue.getRequest(vid2).epoch, 3), "A30-borrowed: cause 3 emitted");
        assertEq(queue.getSettlement(sid2).matchedShares, 0, "A30-borrowed: no match while illiquid");
        assertEq(
            uint8(queue.requestStatus(rid2)), uint8(RequestStatus.Closed), "A30-borrowed: redeem closed"
        );
        (, uint256 aliceClaimUsdc) = fund.positionClaimOf(IDX_AAVE, alice);
        assertGt(aliceClaimUsdc, 0, "A30-borrowed: redeemer received Aave position claim");
        // No per-share check: the exclusion in part 1 moved Moonwell's balance into the ledger, for the holders.
        _end("A30: illiquid/impaired venue blocks match and issues claims", false);
    }

    /// @notice A31: plan in progress — basket steps interleaved with settlement windows across a whole plan;
    ///         reports blocked settlements (`StepInWindow`) and match price lean vs reference.
    function test_A31_planInProgress_stepsAtWindowEdges_reportsBlockedAndMatchLean()
        public
        fixtureCovered
    {
        _world();
        _begin();
        _startAttacker();
        setTargetViaTimelock(bucketVec(5_500, 4_500), PlanParams(1 days, 500));
        vm.warp(block.timestamp + 1 days + 1);
        refreshFeeds();

        uint256 stepsDone;
        uint256 blockedRounds;
        uint256 roundNum;
        while (fund.planStatus() == PlanStatus.Open && roundNum < 5) {
            ++roundNum;
            vm.prank(keeper);
            (bool did,) = rebalancer.step();
            if (did) ++stepsDone;

            // Open equal match orders in this epoch; try settle inside window before `settleWindow` passes.
            uint256 dep = _victimDeposit(victim, 25_000e6);
            uint256 rShares = fund.balanceOf(alice) / 10;
            openRedeemRequest(alice, rShares);
            uint64 ep = queue.getRequest(dep).epoch;
            warpToSettleable(dep);
            refreshFeeds();

            // If basket step ran inside `settleWindow` of settle time, keeper settle reverts `StepInWindow`.
            uint64 lastBasket = rebalancer.lastBasketStepAt();
            if (lastBasket != 0 && block.timestamp - lastBasket < queue.flowParams().settleWindow) {
                ++blockedRounds;
                vm.prank(keeper);
                vm.expectPartialRevert(IFlowEvents.StepInWindow.selector);
                queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
                vm.warp(uint256(lastBasket) + queue.flowParams().settleWindow);
                refreshFeeds();
            }
            vm.prank(keeper);
            uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
            assertGt(sid, 0, "A31: round settled after StepInWindow clears");
            deliverAfterHold(victim);
            _claimRedeemUsdc(alice);
            uint64 nextEp = ep + 1;
            uint256 tNext = (uint256(nextEp) + 1) * queue.flowParams().epochLength;
            if (block.timestamp < tNext) {
                vm.warp(tNext);
                refreshFeeds();
            }
        }
        emit log_named_uint("A31: steps executed across plan", stepsDone);
        emit log_named_uint("A31: settlements delayed by StepInWindow", blockedRounds);
        assertGt(stepsDone, 0, "A31: plan steps progressed alongside queue");
        AttackPnl memory r = _end("A31: plan steps vs settle windows", false);
        _assertG8("A31: plan steps vs settle windows", r);
    }

    /// @notice A32: compromised emergency key — `pauseQueue` & `pauseRebalance` end by themselves, trigger
    ///         cooldown against immediate re-pause, and emergency cannot call `shutdown` or `emergencyUnwind`.
    function test_A32_compromisedEmergencyKey_pauseEndsSelf_cannotShutdownOrUnwind()
        public
        fixtureCovered
    {
        _world();
        setTargetViaTimelock(bucketVec(5_500, 4_500), PlanParams(1 days, 500));
        _begin();
        _startAttacker();

        // Compromised emergency key cannot shutdown or unwind.
        vm.startPrank(emergency);
        vm.expectPartialRevert(0xe2517d3f);
        fund.shutdown();
        vm.expectPartialRevert(0xe2517d3f);
        fund.emergencyUnwind();
        vm.expectPartialRevert(0xe2517d3f);
        fund.emergencyUnwind(IDX_WETH);

        // Self-expiring pauses and mandatory cooldowns.
        queue.pauseQueue();
        uint64 pausedUntil = queue.queuePausedUntil();
        vm.expectPartialRevert(IFlowEvents.PauseOnCooldown.selector);
        queue.pauseQueue();
        fund.pauseRebalance();
        vm.expectPartialRevert(IRobotMoneyFund.PauseOnCooldown.selector);
        fund.pauseRebalance();
        vm.stopPrank();

        assertTrue(queue.queuePaused(), "A32: queue paused initially");
        vm.warp(pausedUntil);
        refreshFeeds();
        assertFalse(queue.queuePaused(), "A32: queue pause self-expired at pausedUntil");
        assertEq(
            uint8(fund.planStatus()), uint8(PlanStatus.Open), "A32: plan pause self-expired cleanly"
        );

        // Emergency STILL locked out of re-pausing for another maxPause cooldown window.
        vm.prank(emergency);
        vm.expectPartialRevert(IFlowEvents.PauseOnCooldown.selector);
        queue.pauseQueue();
        _end("A32: compromised emergency key bounded by cooldown", true);
    }

    /// @notice A33: timelock parameter change while requests are locked does not alter their fee, hold, or expiry.
    function test_A33_timelockParamChangeWhileLocked_keepsFeeHoldExpiry() public fixtureCovered {
        _world();
        _begin();
        _startAttacker();

        uint256 v1 = _victimDeposit(victim, 25_000e6);
        uint256 vHold = _victimDeposit(victim2, 25_000e6); // held/cancelled/expired test
        uint256 half = fund.balanceOf(alice) / 2;
        uint256 rid = openRedeemRequest(alice, half);

        FlowParams memory oldP = queue.flowParams();
        uint64 ep = queue.getRequest(v1).epoch;
        uint256 cutoff = (uint256(ep) + 1) * oldP.epochLength - oldP.cancelBuffer;
        vm.warp(cutoff);

        // Record locked terms before timelock mutates params.
        Request memory rDepBefore = queue.getRequest(vHold);
        Request memory rRedBefore = queue.getRequest(rid);
        assertEq(rRedBefore.exitFeeBps, 10, "A33: initial exit fee 10 bps");
        assertEq(rDepBefore.minHold, oldP.minHold, "A33: initial minHold snapshotted");

        // Timelock raises exit fee to 100 bps, triples minHold, cuts maxRoll to 2.
        uint32 oldMinHold = oldP.minHold;
        FlowParams memory newP = queue.flowParams(); // a fresh copy: memory structs alias on assignment
        newP.minHold = oldMinHold * 3;
        newP.maxRoll = 2;
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.setExitFeeBps, (100)));
        timelockExecute(address(queue), abi.encodeCall(queue.setFlowParams, (newP)));

        // Locked request struct retains old fee, minHold, maxRoll, expiryEpoch.
        Request memory rDepAfter = queue.getRequest(vHold);
        Request memory rRedAfter = queue.getRequest(rid);
        assertEq(rRedAfter.exitFeeBps, 10, "A33: exitFeeBps immutable on locked redeem");
        assertEq(rDepAfter.minHold, oldP.minHold, "A33: minHold immutable on locked deposit");
        assertEq(rDepAfter.expiryEpoch, rDepBefore.expiryEpoch, "A33: expiryEpoch immutable");

        // Settle in round 1: feePaid uses 10 bps (NOT 100 bps) and claims unlock after old minHold!
        uint256 feeBefore = IERC20(USDC).balanceOf(feeRecipient);
        warpToSettleable(v1);
        refreshFeeds();
        vm.prank(keeper);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        Settlement memory st = queue.getSettlement(sid);
        uint256 feePaid = IERC20(USDC).balanceOf(feeRecipient) - feeBefore;
        assertLe(
            feePaid,
            st.matchedUsdc.mulDiv(15, BPS) + st.usdcOut.mulDiv(15, BPS) + 10,
            "A33: fee charged at original 10 bps, not raised 100 bps"
        );
        assertLe(st.holdEndsAt, block.timestamp + oldP.minHold, "A33: deposit unlocked on old hold");

        vm.warp(block.timestamp + oldP.minHold);
        refreshFeeds();
        assertGt(queue.maxDeposit(victim), 0, "A33: deposit delivered at old minHold before tripled hold");
        deliverAfterHold(victim);
        deliverAfterHold(victim2);
        _claimRedeemUsdc(alice);
        _end("A33: param change keeps locked fee, hold, and expiry", true);
    }

    /// @notice A34: short-paying lending adapter — defeated in recovery (`openExclusion`), in net redemption
    ///         Check 11 (`RealizedPrice`), and in pre-match venue liquidity test (`availableLiquidity`).
    function test_A34_shortPayingAdapter_rejectedInRecoveryPositionClaimAndVenueTest()
        public
        fixtureCovered
    {
        _world();
        _begin();
        fundUsdc(attacker, 50_000e6);
        _startAttacker();
        MechAaveAdapter mech = _etchAaveMech();

        // 1) Pre-match venue test: zero/short available liquidity stops deposits and blocks match.
        uint256 vid = _victimDeposit(victim, 30_000e6);
        uint256 quarter = fund.balanceOf(alice) / 4;
        openRedeemRequest(alice, quarter);
        warpToSettleable(vid);
        refreshFeeds();
        mech.setAvailableLiquidity(0);
        vm.recordLogs();
        vm.prank(keeper);
        uint256 sid1 = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertTrue(_sawDepositStopped(queue.getRequest(vid).epoch, 3), "A34: venue liquidity stopped match");
        assertEq(queue.getSettlement(sid1).matchedShares, 0, "A34: no match booked under short liquidity");
        mech.clearAvailableLiquidity();

        // 2) Net redemption short-pay: Check 11 (`RealizedPrice`) blocks settlement without paying inflated shares.
        mech.setMode(mech.SHORT_PAY(), 2_500);
        uint256 r2Shares = fund.balanceOf(alice) / 2;
        uint256 rid2 = openRedeemRequest(alice, r2Shares);
        warpToSettleable(rid2);
        refreshFeeds();
        vm.recordLogs();
        vm.prank(keeper);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertTrue(_sawSideFailed(RequestKind.Redeem), "A34: short-paying net redeem rejected");
        assertEq(
            uint8(queue.requestStatus(rid2)),
            uint8(RequestStatus.Pending),
            "A34: short-paying redeem did not close at degraded rate"
        );

        // 3) Exclusion recovery short-pay: draining an excluded venue that pays short does NOT mark asset gone
        //    if value remains held or fails proportion check.
        mech.setMode(mech.SHORT_PAY(), 5_000);
        timelockExecute(
            address(fund),
            abi.encodeCall(IRobotMoneyFund.setAdapterCodeHashAllowed, (address(mech).codehash, false))
        );
        uint256 exclId = fund.openExclusionOf(IDX_AAVE);
        assertGt(exclId, 0, "A34: exclusion opened");
        vm.prank(address(timelock));
        vm.expectRevert(IFundEvents.InvalidParam.selector);
        fund.setAdapterCodeHashAllowed(address(mech).codehash, true);
        assertEq(
            fund.openExclusionOf(IDX_AAVE),
            exclId,
            "A34: short-paying exclusion restore refused and stays open"
        );
        // An honest venue drains and the record closes.
        mech.setMode(mech.HONEST(), 0);
        timelockExecute(
            address(fund),
            abi.encodeCall(IRobotMoneyFund.setAdapterCodeHashAllowed, (address(mech).codehash, true))
        );
        assertEq(fund.openExclusionOf(IDX_AAVE), 0, "A34: honest venue restores and the record closes");
        // No per-share check: the recovery moved the venue's balance into the exclusion ledger, for the holders.
        _end("A34: short-paying adapter rejected across venue test, redeem, and recovery", false);
    }

    /// @notice A35: pool fee at or above `legBandBps` less margin, or mutable fee — refused at admission and funding.
    function test_A35_poolFeeAtOrAboveLegBand_refusedAtAdmissionAndFunding() public fixtureCovered {
        _world();
        _begin();
        _startAttacker();
        MechSwapAdapter mech = _etchSwapMech();

        // Funding (plan open) rejects non-fixed fee and fee + margin >= legBandBps.
        mech.setFixedFeePool(false);
        (address[] memory ids, uint256[] memory w) = assetArrays(bucketVec(6_500, 3_500));
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.PoolNotFixedFee.selector, WETH_POOL));
        governance.setTarget(ids, w, PlanParams(1 days, 500));

        mech.setFixedFeePool(true);
        uint256 legBand = queue.flowParams().legBandBps;
        uint256 margin = fund.feeMarginBps();
        mech.setPoolFeeBps(uint24(legBand - margin));
        vm.prank(address(timelock));
        vm.expectRevert(
            abi.encodeWithSelector(
                IRobotMoneyFund.PoolFeeMarginTooSmall.selector, legBand - margin, margin, legBand
            )
        );
        governance.setTarget(ids, w, PlanParams(1 days, 500));

        // Admission (`addAsset`) also refuses mutable or overly costly pool fee.
        AssetConfig memory wethCfg = fund.assetConfig(IDX_WETH);
        mech.setPoolFeeBps(5);
        setTargetViaTimelock(bucketVec(0, 10_000), PlanParams(1 days, 500));
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.closePlan, ()));
        timelockExecute(address(fund), abi.encodeWithSignature("emergencyUnwind(uint256)", IDX_WETH));
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.deactivateAsset, (IDX_WETH)));
        refreshFeeds();

        mech.setFixedFeePool(false);
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.PoolNotFixedFee.selector, WETH_POOL));
        fund.addAsset(wethCfg);

        mech.setFixedFeePool(true);
        mech.setPoolFeeBps(uint24(legBand));
        vm.prank(address(timelock));
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.PoolFeeMarginTooSmall.selector, legBand, margin, legBand)
        );
        fund.addAsset(wethCfg);
        mech.setPoolFeeBps(5);
        AttackPnl memory r = _end("A35: unsafe pool fee refused at admission and funding", false);
        _assertG8("A35: unsafe pool fee refused at admission and funding", r);
    }

    /// @notice A36: round cut in two — pause, sequencer outage, and 5% market move between two `settle` calls of
    ///         one round. No second match may be booked at the old price.
    function test_A36_roundCutInTwo_pauseOutageMove5Pct_noMatchAtOldPrice() public fixtureCovered {
        _world();
        uint256 dShares = _seedHolder(dave, 60_000e6);
        _begin();
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();

        // Same epoch: 2 deposits + 2 redemptions, call 1 settles match + 1 request so round stays open (`rs.done == false`).
        uint256 dep1 = _victimDeposit(victim, 30_000e6);
        _victimDeposit(victim2, 30_000e6);
        openRedeemRequest(alice, fund.balanceOf(alice) / 4);
        openRedeemRequest(dave, dShares / 2);

        warpToSettleable(dep1);
        refreshFeeds();
        vm.prank(keeper);
        uint256 sid1 = queue.settle(1, type(uint256).max);
        assertEq(queue.settlementCount(), sid1, "A36: call 1 booked the round match");
        uint256 mShares1 = queue.getSettlement(sid1).matchedShares;
        assertGt(mShares1, 0, "A36: whole match occurred in call 1");

        // Between call 1 and call 2: pause + unpause, sequencer outage + recover, and +5% WETH move.
        vm.prank(emergency);
        queue.pauseQueue();
        timelockExecute(address(queue), abi.encodeCall(queue.unpauseQueue, ()));
        MockAggregator(FEED_SEQUENCER).setRound(0, 1, block.timestamp, block.timestamp);
        vm.warp(block.timestamp + 2 hours);
        sequencerUpSince = block.timestamp - queue.flowParams().sequencerGrace - 1;
        refreshFeeds();
        (, uint256 wBought) = _pushBps(attacker, WETH_POOL, WETH, USDC, 500);
        setFeedPrice(IDX_WETH, poolPrice8(WETH_POOL, WETH));
        refreshFeeds();

        // While TWAP lags the 5% move, Check 3/4 blocks continuation rather than settling at stale price.
        vm.prank(keeper);
        (SettleCheck chk,) = queue.checkSettle();
        assertTrue(
            chk == SettleCheck.TwapQuorum || chk == SettleCheck.TwapVsFeed,
            "A36: 5% move blocks call 2 while TWAP lags"
        );
        vm.prank(keeper);
        vm.expectPartialRevert(IFlowEvents.SettleBlocked.selector);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);

        // Restore market / let TWAP catch up and finish call 2: NO match may be booked on call 2.
        _sellExact(attacker, WETH_POOL, WETH, USDC, wBought);
        alignFeedsToPools();
        vm.warp(block.timestamp + queue.flowParams().settleWindow);
        refreshFeeds();
        uint256 sBefore = queue.settlementCount();
        vm.prank(keeper);
        uint256 sid2 = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        if (sid2 > sBefore) {
            assertEq(queue.getSettlement(sid2).matchedShares, 0, "A36: zero match booked on call 2");
        }
        deliverAfterHold(victim);
        deliverAfterHold(victim2);
        _claimRedeemUsdc(alice);
        _claimRedeemUsdc(dave);
        _end("A36: round cut in two books no second match at old price", true);
    }

    /// @notice A37: the looks — notice on an old redemption inside an open settle window, and cancel of a deposit
    ///         before/after scheduled `unpauseDeposits`. Neither avoids a price already forming.
    function test_A37_looks_lateRedemptionNoticeAndDepositCancelBeforeUnpause_cannotAvoidPrice()
        public
        fixtureCovered
    {
        _world();
        _begin();
        fundUsdc(attacker, 50_000e6);
        _startAttacker();

        // Part 1: Aged redemption gives notice while its current round's settle window is already open.
        uint256 half = fund.balanceOf(alice) / 2;
        uint256 rid = openRedeemRequest(alice, half);
        FlowParams memory p = queue.flowParams();
        // Advance past expiryEpoch so notice is eligible, landing inside the settle window of round `cur - 1`.
        vm.warp(block.timestamp + uint256(p.maxRoll + 1) * p.epochLength + p.settleWindow);
        refreshFeeds();
        vm.prank(alice);
        uint64 targetRound = queue.giveRedemptionNotice(rid);
        assertEq(targetRound, queue.currentEpoch() - 1, "A37: notice binds to currently active round");
        // Calling claimNoticeReturn while that round is still open MUST revert `NoticeNotReady`.
        vm.prank(alice);
        vm.expectPartialRevert(IFlowEvents.NoticeNotReady.selector);
        queue.claimNoticeReturn(rid);
        // Keeper settles that round -> the noticed redemption STILL takes the round price instead of dodging!
        vm.prank(keeper);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertGt(sid, 0, "A37: active round settled");
        assertEq(
            uint8(queue.requestStatus(rid)),
            uint8(RequestStatus.Closed),
            "A37: aged redemption still filled in the active round"
        );
        _claimRedeemUsdc(alice);

        // Part 2: Locked deposit during scheduled `unpauseDeposits` cannot dodge an active round price.
        uint256 did = _victimDeposit(victim, 25_000e6);
        vm.prank(emergency);
        fund.pauseDeposits();
        // Close epoch of `did` while pause holds, then schedule + execute `unpauseDeposits` inside next epoch `cur`.
        uint256 curStart = (uint256(queue.getRequest(did).epoch) + 1) * p.epochLength;
        vm.warp(curStart + 10);
        refreshFeeds();
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.unpauseDeposits, ()));
        // Once epoch `cur` ends and enters its settle window (`cur + 1`), cancel is CLOSED while `cur` prices!
        vm.warp(curStart + p.epochLength + p.settleWindow);
        refreshFeeds();
        vm.prank(victim);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.RequestLocked.selector, did));
        queue.cancel(did);
        settleAll();
        deliverAfterHold(victim);
        _end("A37: notice and unpause cancel cannot dodge forming price", true);
    }

    /// @notice A38: wind-down notice — between `pauseDeposits` + scheduling `shutdown` and `shutdown` execution,
    ///         redeemers cannot match against locked depositors (`depositsPaused` -> cause 1 -> zero match).
    function test_A38_windDownNotice_redeemersCannotMatchAgainstLockedDepositsBeforeShutdown()
        public
        fixtureCovered
    {
        _world();
        _begin();
        _startAttacker();

        uint256 did = _victimDeposit(victim, 40_000e6);
        // Step E55: pauseDeposits then schedule shutdown in timelock.
        vm.prank(emergency);
        fund.pauseDeposits();
        bytes32 salt = keccak256("a38-shutdown");
        bytes memory data = abi.encodeCall(IRobotMoneyFund.shutdown, ());
        timelock.schedule(address(fund), 0, data, bytes32(0), salt, TIMELOCK_DELAY);

        // Attacker queues a matching redemption between schedule and execution, and keeper settles.
        uint256 half = fund.balanceOf(alice) / 2;
        uint256 rid = openRedeemRequest(alice, half);
        warpToSettleable(did);
        refreshFeeds();
        vm.recordLogs();
        vm.prank(keeper);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertTrue(
            _sawDepositStopped(queue.getRequest(did).epoch, 1), "A38: deposit stop prevented match"
        );
        assertEq(queue.getSettlement(sid).matchedShares, 0, "A38: zero match while shutdown scheduled");
        assertEq(queue.getRequest(did).remaining, 40_000e6, "A38: locked deposit untouched");

        // Now execute shutdown after timelock delay -> wind-down releases deposit to credit & redeems cleanly.
        if (block.timestamp < TIMELOCK_DELAY + 10) vm.warp(TIMELOCK_DELAY + 10);
        refreshFeeds();
        timelock.execute(address(fund), 0, data, bytes32(0), salt);
        vm.prank(victim);
        queue.withdrawCredit();
        assertEq(IERC20(USDC).balanceOf(victim), 40_000e6, "A38: depositor recovered 100% escrow");
        rid;
        _claimRedeemUsdc(alice);
        _end("A38: wind-down notice stops match before shutdown", true);
    }

    /// @notice A39: more locked than epoch flow cap (2x cap deposits vs 1x cap redemptions, and reverse) —
    ///         RB-36 exact share & USDC conservation and no fill above cap.
    function test_A39_moreLockedThanCap_conservationAndCapBounds() public fixtureCovered {
        _world();
        // Give alice + dave > 600k worth of shares so 2 * cap (500k) can be redeemed cleanly.
        uint256 sDave = _seedHolder(dave, 450_000e6);
        _begin();
        _startAttacker();

        FlowParams memory p = queue.flowParams();
        uint256 cap = Math.max(_navRef().mulDiv(p.maxEpochFlowBps, BPS), p.epochFlowFloorUsdc);
        uint256 d1 = _victimDeposit(victim, cap);
        uint256 d2 = _victimDeposit(victim2, cap); // 2 * cap total deposits
        openRedeemRequest(dave, sDave * 3 / 5); // ~cap shares redeemed

        warpToSettleable(d1);
        refreshFeeds();
        uint256 feeBefore = IERC20(USDC).balanceOf(feeRecipient);
        vm.prank(keeper);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        Settlement memory st = queue.getSettlement(sid);
        assertLe(st.matchedUsdc, cap, "A39: matchedUsdc <= cap");
        assertLe(st.usdcIn, cap - st.matchedUsdc + 1, "A39: total deposit fills <= cap");
        assertLe(st.usdcOut, cap - st.matchedUsdc + 1, "A39: total redeem fills <= cap");

        // RB-36: queue books match token/USDC balances to the unit.
        FlowBooks memory b = queue.books();
        uint256 qUsdc = IERC20(USDC).balanceOf(address(queue));
        uint256 qShares = IERC20(address(fund)).balanceOf(address(queue));
        assertGe(
            qUsdc,
            b.pendingUsdc + b.owedUsdc + b.creditUsdc + b.dustUsdc,
            "A39: USDC covers all queue liabilities"
        );
        assertEq(
            qUsdc,
            b.pendingUsdc + b.owedUsdc + b.creditUsdc + b.dustUsdc,
            "A39: exact USDC conservation"
        );
        assertEq(
            qShares,
            b.escrowShares + b.heldShares + b.creditShares + b.dustShares,
            "A39: exact share conservation"
        );

        // Next period: reverse (1x cap deposits vs 2x cap redemptions).
        vm.warp(block.timestamp + queue.flowParams().epochLength);
        refreshFeeds();
        uint256 d3 = _victimDeposit(victim, cap);
        openRedeemRequest(alice, fund.balanceOf(alice));
        openRedeemRequest(dave, fund.balanceOf(dave));
        warpToSettleable(d3);
        refreshFeeds();
        vm.prank(keeper);
        uint256 sid2 = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        Settlement memory st2 = queue.getSettlement(sid2);
        assertLe(st2.matchedUsdc, cap, "A39-rev: matchedUsdc <= cap");
        assertGt(IERC20(USDC).balanceOf(feeRecipient), feeBefore, "A39: fees collected");
        FlowBooks memory b2 = queue.books();
        assertEq(
            IERC20(USDC).balanceOf(address(queue)),
            b2.pendingUsdc + b2.owedUsdc + b2.creditUsdc + b2.dustUsdc,
            "A39-rev: exact USDC conservation"
        );
        assertEq(
            IERC20(address(fund)).balanceOf(address(queue)),
            b2.escrowShares + b2.heldShares + b2.creditShares + b2.dustShares,
            "A39-rev: exact share conservation"
        );
        d2;
        _end("A39: over-cap match booking conservation", true);
    }

    /// @notice A40 (RB-22): exclusion after a match — neither matched user touches the queue, an adapter is revoked,
    ///         both claim: recovery goes to the depositor. Repeat with a second match before either checkpoints.
    function test_A40_exclusionAfterMatch_bothClaimWithoutTouching_recoveryToDepositor_andRepeat()
        public
        fixtureCovered
    {
        _world();
        _begin();
        _startAttacker();

        FundExclusionLedger ledger = FundExclusionLedger(fund.exclusionLedger());
        uint256 aliceInit = fund.balanceOf(alice);

        // Cycle 1: victim deposits vs alice redeems -> whole match -> NEITHER touches queue -> revoke Moonwell.
        uint256 r1Shares = aliceInit / 4;
        uint256 did1 = _victimDeposit(victim, 30_000e6);
        openRedeemRequest(alice, r1Shares);
        warpToSettleable(did1);
        refreshFeeds();
        vm.prank(keeper);
        uint256 sid1 = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertGt(queue.getSettlement(sid1).matchedShares, 0, "A40-c1: matched");

        timelockExecute(
            address(fund),
            abi.encodeCall(
                IRobotMoneyFund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, false)
            )
        );
        uint256 ex1 = fund.openExclusionOf(IDX_MOONWELL);
        assertGt(ex1, 0, "A40-c1: exclusion opened");
        vm.warp(block.timestamp + queue.flowParams().minHold);
        refreshFeeds();
        deliverAfterHold(victim);
        _claimRedeemUsdc(alice);

        // End exclusion and drain recovery, then check attribution and run Cycle 2 BEFORE explicit claim.
        timelockExecute(
            address(fund),
            abi.encodeCall(
                IRobotMoneyFund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, true)
            )
        );
        assertGt(ledger.claimable(ex1, victim), 0, "A40-c1: recovery attributed to depositor");
        assertEq(
            ledger.balanceAt(alice, ex1),
            aliceInit - r1Shares,
            "A40-c1: matched redeemer lost exclusion claim on matched shares"
        );
        vm.warp(block.timestamp + queue.flowParams().epochLength);
        refreshFeeds();
        settleAll();

        // Cycle 1's recovery took everything out of Moonwell. A stable-only plan puts money back, so the second
        // exclusion has a balance to recover.
        setTargetViaTimelock(bucketVec(10_000, 0), PlanParams(1 days, 500));
        stepUntilDone(64);
        vm.warp(block.timestamp + 1 days + 1);
        refreshFeeds();
        assertGt(moonwellAdapter.totalAssets(), 1_000e6, "A40-c2: Moonwell funded again");

        uint256 aliceAfter1 = fund.balanceOf(alice);
        uint256 r2Shares = aliceAfter1 / 4;
        uint256 did2 = _victimDeposit(victim, 20_000e6);
        openRedeemRequest(alice, r2Shares);
        warpToSettleable(did2);
        refreshFeeds();
        vm.prank(keeper);
        uint256 sid2 = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertGt(queue.getSettlement(sid2).matchedShares, 0, "A40-c2: second match booked");

        timelockExecute(
            address(fund),
            abi.encodeCall(
                IRobotMoneyFund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, false)
            )
        );
        uint256 ex2 = fund.openExclusionOf(IDX_MOONWELL);
        assertGt(ex2, ex1, "A40-c2: second exclusion opened");
        vm.warp(block.timestamp + queue.flowParams().minHold);
        refreshFeeds();
        deliverAfterHold(victim);
        _claimRedeemUsdc(alice);
        timelockExecute(
            address(fund),
            abi.encodeCall(
                IRobotMoneyFund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, true)
            )
        );
        assertGt(ledger.claimable(ex2, victim), 0, "A40-c2: second recovery went to depositor");
        assertEq(
            ledger.balanceAt(alice, ex2),
            aliceAfter1 - r2Shares,
            "A40-c2: matched redeemer lost second exclusion claim on matched shares"
        );
        // Neither the per-share check nor G8 applies: each recovery moves a venue's balance out of the fund into the
        // exclusion ledger, where it is the holders' claim. The assertions above are this test's checks (RB-22).
        _end("A40: RB-22 exclusion after match attributes to depositor across cycles", false);
    }

    /// @notice A41: scheduled adapter revoke — redeemers try leaving at face value between schedule and execution
    ///         (with and without `pauseDeposits`); `pauseDeposits` is immediately renewable without cooldown.
    function test_A41_scheduledAdapterRevoke_redeemersCannotExitAtFaceValue_pauseDepositsRenewable()
        public
        fixtureCovered
    {
        _world();
        _begin();
        _startAttacker();

        // Schedule adapter revocation.
        bytes32 salt = keccak256("a41-revoke");
        bytes memory data = abi.encodeCall(
            IRobotMoneyFund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, false)
        );
        timelock.schedule(address(fund), 0, data, bytes32(0), salt, TIMELOCK_DELAY);

        // Case 1 (no pauseDeposits): redeemer CANNOT call redeemInKind (InKindClosed), and queue redeem pays
        // exit fee (no free face-value exit).
        uint256 rShares = fund.balanceOf(alice) / 4;
        vm.prank(alice);
        vm.expectRevert(IRobotMoneyFund.InKindClosed.selector);
        fund.redeemInKind(rShares, alice, alice);

        uint256 feeBefore = IERC20(USDC).balanceOf(feeRecipient);
        uint256 rid1 = openRedeemRequest(alice, rShares);
        warpToSettleable(rid1);
        refreshFeeds();
        vm.prank(keeper);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        _claimRedeemUsdc(alice);
        assertGt(IERC20(USDC).balanceOf(feeRecipient), feeBefore, "A41: redeem paid exit fee");

        // Case 2 (with pauseDeposits): emergency renews `pauseDeposits` back-to-back with ZERO cooldown (E39/A41)!
        vm.startPrank(emergency);
        fund.pauseDeposits();
        vm.warp(block.timestamp + 1 hours);
        fund.pauseDeposits(); // MUST succeed without cooldown!
        vm.stopPrank();
        assertTrue(fund.depositsPaused(), "A41: deposit pause active and renewed");

        // Execute revoke when delay finishes; deposits remained blocked and redeemer cannot dodge exclusion.
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        refreshFeeds();
        timelock.execute(address(fund), 0, data, bytes32(0), salt);
        assertGt(fund.openExclusionOf(IDX_MOONWELL), 0, "A41: exclusion opened on execute");
        AttackPnl memory r = _end("A41: scheduled revoke and renewable pauseDeposits", false);
        _assertG8("A41: scheduled revoke and renewable pauseDeposits", r);
    }

    /// @notice A42: delisting sale with redemptions and sale steps interleaved — no double claim, USDC split by
    ///         tokens, and NAV never counts claimed tokens.
    function test_A42_delistingSale_interleavedWithRedemptions_noDoubleClaim_navExcludesClaimed()
        public
        fixtureCovered
    {
        _world();
        uint256 sDave = _seedHolder(dave, 100_000e6);
        _begin();
        _startAttacker();

        // Delist WETH -> marks asset in sale, stops deposits.
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.delistAsset, (IDX_WETH)));
        assertTrue(fund.isAssetInSale(IDX_WETH), "A42: WETH in sale");

        // Interleave: redeem 1 -> sale step 1 -> redeem 2 -> remaining sale steps.
        uint256 rid1 = openRedeemRequest(alice, fund.balanceOf(alice) / 2);
        warpToSettleable(rid1);
        refreshFeeds();
        vm.prank(keeper);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        _claimRedeemUsdc(alice);

        (, uint256[] memory held1) = fund.heldBalances();
        uint256 contractWeth1 = IERC20(WETH).balanceOf(address(fund));
        assertLt(held1[IDX_WETH], contractWeth1, "A42: claimed WETH excluded from heldBalances");
        assertLt(
            fund.assetValue(IDX_WETH),
            fund.assetUsdcValue(IDX_WETH, contractWeth1),
            "A42: NAV never counts claimed WETH"
        );

        // Execute half the WETH sale via rebalancer `stepDelisted`.
        vm.prank(keeper);
        rebalancer.stepDelisted(IDX_WETH);

        // Interleave redemption 2 AFTER step 1.
        vm.warp(block.timestamp + queue.flowParams().epochLength);
        refreshFeeds();
        uint256 rid2 = openRedeemRequest(dave, sDave / 2);
        warpToSettleable(rid2);
        refreshFeeds();
        vm.prank(keeper);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        _claimRedeemUsdc(dave);

        // Drain rest of delist sale.
        for (uint256 k; k < 20 && fund.isAssetInSale(IDX_WETH); ++k) {
            vm.warp(block.timestamp + rebalancer.stepParams().stepInterval + 1);
            refreshFeeds();
            vm.prank(keeper);
            rebalancer.stepDelisted(IDX_WETH);
        }
        assertFalse(fund.isAssetInSale(IDX_WETH), "A42: delist sale finished");
        assertFalse(fund.assetConfig(IDX_WETH).active, "A42: WETH deactivated cleanly");

        // Stranger settles claims for alice and dave: USDC split cleanly, second call reverts NoClaimToSettle.
        uint256 aBefore = IERC20(USDC).balanceOf(alice);
        uint256 dBefore = IERC20(USDC).balanceOf(dave);
        vm.prank(attacker);
        uint256 aGot = fund.settleClaim(IDX_WETH, alice);
        vm.prank(attacker);
        uint256 dGot = fund.settleClaim(IDX_WETH, dave);
        assertGt(aGot, 0, "A42: alice claim paid");
        assertGt(dGot, 0, "A42: dave claim paid");
        assertEq(IERC20(USDC).balanceOf(alice) - aBefore, aGot);
        assertEq(IERC20(USDC).balanceOf(dave) - dBefore, dGot);
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.NoClaimToSettle.selector, IDX_WETH, alice));
        fund.settleClaim(IDX_WETH, alice);
        AttackPnl memory r = _end("A42: interleaved delisting sale & claim settlement", false);
        _assertG8("A42: interleaved delisting sale & claim settlement", r);
    }

    /// @notice A43: a basket rebalance step inside the window before a round's first call makes `settle` revert
    ///         `StepInWindow` (RB-30); while the queue is paused, steps still execute.
    function test_A43_stepInsideWindowBlocksFirstSettle_pausedQueueAllowsSteps() public fixtureCovered {
        _world();
        _begin();
        _startAttacker();
        setTargetViaTimelock(bucketVec(5_500, 4_500), PlanParams(1 days, 500));
        vm.warp(block.timestamp + 1 days + 1);
        refreshFeeds();

        uint256 vid = _victimDeposit(victim, 20_000e6);
        uint256 windowAt = queue.settleableAt(queue.getRequest(vid).epoch);
        vm.warp(windowAt - 10 minutes);
        refreshFeeds();

        // Execute a basket step INSIDE the upcoming settle window (`windowAt - 10 min`).
        vm.prank(keeper);
        (bool did,) = rebalancer.step();
        assertTrue(did, "A43: basket step ran");
        uint64 lastBasket = rebalancer.lastBasketStepAt();
        assertGt(lastBasket, 0, "A43: basket step recorded timestamp");

        // At window open (< lastBasket + settleWindow), first call of round reverts `StepInWindow`.
        vm.warp(windowAt);
        refreshFeeds();
        uint32 settleWin = queue.flowParams().settleWindow;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.StepInWindow.selector, lastBasket, settleWin));
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);

        // Once settleWindow elapses after lastBasket, round settles.
        vm.warp(uint256(lastBasket) + queue.flowParams().settleWindow);
        refreshFeeds();
        vm.prank(keeper);
        assertGt(queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max), 0, "A43: settled after window wait");
        deliverAfterHold(victim);

        // Pausing queue does NOT block rebalance steps.
        vm.warp(block.timestamp + rebalancer.stepParams().stepInterval + 1);
        refreshFeeds();
        vm.prank(emergency);
        queue.pauseQueue();
        assertTrue(queue.queuePaused(), "A43: queue paused");
        if (fund.planStatus() == PlanStatus.Open) {
            vm.prank(keeper);
            (bool didWhilePaused,) = rebalancer.step();
            assertTrue(didWhilePaused, "A43: step ran while queue paused");
        }
        AttackPnl memory r = _end("A43: StepInWindow guard & step under paused queue", false);
        _assertG8("A43: StepInWindow guard & step under paused queue", r);
    }

    /// @notice A44 (report-only per eng plan §8.3): compares an honest 10k request vs a 100k (10x) request competing
    ///         for a scarce 20k match, reporting extra matched fill gained and locked surplus cost.
    function test_A44_askTenTimesMoreThanWanted_reportMatchShareVsLockedSurplusCost()
        public
        fixtureCovered
    {
        _world();
        _begin();
        fundUsdc(attacker, 100_000e6);
        _startAttacker();

        // Scarce match counterparty: 20k worth of redemption shares vs honest 10k deposit + attacker 100k (10x).
        uint256 rShares = fund.balanceOf(alice) / 5; // ~20k USDC
        uint256 dHonest = _victimDeposit(victim, 10_000e6);
        uint256 dTenX = _reqDeposit(attacker, 100_000e6, 0);
        openRedeemRequest(alice, rShares);

        uint64 ep = queue.getRequest(dHonest).epoch;
        // Stop deposits right after match? Measure after normal full settlement vs capped epoch where surplus waits.
        warpToSettleable(dHonest);
        refreshFeeds();
        vm.prank(keeper);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        uint256 matchedTotal = queue.getSettlement(sid).matchedUsdc;

        deliverAfterHold(victim);
        deliverAfterHold(attacker);
        _claimRedeemUsdc(alice);
        // Estimate match allocation (10k vs 100k => 10/11 of matchedTotal went to attacker vs 1/2 honest fair).
        uint256 honestShareOfMatch = matchedTotal / 2;
        uint256 tenXMatchFill = matchedTotal.mulDiv(100_000e6, 110_000e6);
        emit log_named_uint("A44 REPORT: total scarce match (USDC)", matchedTotal);
        emit log_named_uint("A44 REPORT: fair 1x match share (USDC)", honestShareOfMatch);
        emit log_named_uint("A44 REPORT: 10x request match share (USDC)", tenXMatchFill);
        emit log_named_uint("A44 REPORT: locked surplus exposed to net costs (USDC)", 100_000e6 - tenXMatchFill);
        pending = honestShareOfMatch > (matchedTotal - tenXMatchFill)
            ? honestShareOfMatch - (matchedTotal - tenXMatchFill)
            : 0;
        ep;
        dTenX;
        // Report-only (`g8 = false`): explicitly does not pass/fail G8 per proposal §10 step 3f.
        _end("A44 REPORT ONLY: 10x oversizing in scarce match", false);
    }

    /// @notice A45 (RB-35): a lending claim protects its venue's outstanding claim units from rebalance withdrawal,
    ///         and a stranger can permissionlessly call `settleClaim`.
    function test_A45_lendingClaimAndStep_stepSkipsClaimVenue_strangerSettlesClaim()
        public
        fixtureCovered
    {
        _world();
        _begin();
        _startAttacker();

        // Create an Aave position claim for Alice via wind-down `redeemInKind` with inKindAllowance = 0, then restore.
        timelockExecute(
            address(fund),
            abi.encodeCall(IRobotMoneyFund.setInKindAllowance, (0, 0, queue.flowParams().epochLength))
        );
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.shutdown, ()));
        uint256 half = fund.balanceOf(alice) / 2;
        vm.prank(alice);
        fund.redeemInKind(half, alice, alice);
        (uint256 aaveUnits0, uint256 claimUsdc0) = fund.positionClaimOf(IDX_AAVE, alice);
        assertGt(aaveUnits0, 0, "A45: Aave claim created");

        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.restore, (TVL_CAP)));
        // Open plan trying to move ALL funds OUT of Aave (`target[IDX_AAVE] = 0`).
        uint16[5] memory tVec = cometListed
            ? assetVec(0, 3_500, 1_750, 1_750, 3_000)
            : assetVec(0, 6_000, 2_000, 2_000, 0);
        setTargetViaTimelock(tVec, PlanParams(1 days, 500));
        vm.warp(block.timestamp + 1 days + 1);
        refreshFeeds();

        // Rebalance steps run, but NEVER consume Alice's claim units (`positionClaimOf` intact).
        for (uint256 k; k < 4; ++k) {
            vm.prank(keeper);
            rebalancer.step();
            vm.warp(block.timestamp + rebalancer.stepParams().stepInterval + 1);
            refreshFeeds();
        }
        (uint256 aaveUnitsAfterSteps, uint256 claimUsdcAfterSteps) = fund.positionClaimOf(IDX_AAVE, alice);
        assertEq(aaveUnitsAfterSteps, aaveUnits0, "A45: rebalance step never consumed claim units");
        assertGe(claimUsdcAfterSteps, claimUsdc0, "A45: claim value preserved across steps");

        // Stranger (`attacker`) settles Alice's claim -> USDC goes directly to Alice.
        uint256 aliceUsdcBefore = IERC20(USDC).balanceOf(alice);
        vm.prank(attacker);
        uint256 netPaid = fund.settleClaim(IDX_AAVE, alice);
        assertGt(netPaid, 0, "A45: stranger settled Aave claim");
        assertEq(IERC20(USDC).balanceOf(alice) - aliceUsdcBefore, netPaid, "A45: USDC sent to Alice");
        (uint256 unitsEnd,) = fund.positionClaimOf(IDX_AAVE, alice);
        assertEq(unitsEnd, 0, "A45: claim cleared after settleClaim");
        AttackPnl memory r = _end("A45: lending claim protects venue from step & stranger settles", false);
        _assertG8("A45: lending claim protects venue from step & stranger settles", r);
    }

    /// @dev While check 6 (share price) blocks the keeper, move one epoch at a time (at most `maxRoll − 1`, so no
    ///      request expires). Returns the epochs it held.
    function _waitOutSharePriceBreaker() internal returns (uint256 epochs) {
        FlowParams memory p = queue.flowParams();
        for (; epochs < p.maxRoll - 1; ++epochs) {
            refreshFeeds();
            vm.prank(keeper);
            (SettleCheck check,) = queue.checkSettle();
            if (check != SettleCheck.SharePrice) return epochs;
            vm.warp(block.timestamp + p.epochLength);
        }
        refreshFeeds();
    }

    /// @dev Whether the recorded logs hold a `SideFailed` of `kind` from the queue.
    function _sawSideFailed(RequestKind kind) internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter != address(queue)
                    || logs[i].topics[0] != IFlowEvents.SideFailed.selector
            ) continue;
            (RequestKind k,) = abi.decode(logs[i].data, (RequestKind, bytes));
            if (k == kind) return true;
        }
        return false;
    }

    /// @dev Whether the recorded logs hold `DepositStoppedForRound(roundEpoch, cause)` from the queue.
    function _sawDepositStopped(uint64 roundEpoch, uint8 cause) internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter != address(queue)
                    || logs[i].topics[0] != IFlowEvents.DepositStoppedForRound.selector
            ) continue;
            if (uint64(uint256(logs[i].topics[1])) != roundEpoch) continue;
            uint8 loggedCause = abi.decode(logs[i].data, (uint8));
            if (loggedCause == cause) return true;
        }
        return false;
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Levers for D-AT-1 (A7), D-AT-2 (A10) and the blocking floor (A8 way 3), step 3 finish plan §3.2.
    //  Added by `levers` 2026-11-12. Measurement only: no default changes. Each test plays one attack under one
    //  lever setting from the same world as the attack's own test, logs one `LEVER` CSV line per run and one
    //  `LEVER-BEST` line per setting, and asserts what must hold under any lever (RB-14 for the victim, check 10
    //  from outside, holders' loss at most 1 bps of NAV). The attacker's net is reported, not scored: G8 is scored
    //  at the defaults by the attack tests above.
    //
    //  Settings (`_lever`): L0 no lever (all zero, refBandBps 50: §5.9 as first written); L1, L2 `legBandBps` 50, 25; L3, L4 per-swap limits from the TWAP only,
    //  from the feed only; L5, L6, L7 a per-call cap on each basket leg of 5, 10, 20 bps of the pool's time-weighted
    //  depth (one trading settlement per block); L8 `legBandBps` 50 with the 10 bps cap; L9 `legBandBps` 25 from the
    //  feed only; L10, L11 `refBandBps` 90, 100 (the sim's G9 proposal, notes/sim.md §5, which must be priced
    //  against G8 first); L12, L13, L14 `legBandBps` 30, 35, 40; L15 `legBandBps` 35 with the 10 bps cap; L16, L17
    //  `legBandBps` 30 with the 10 and the 5 bps cap; L18, L19 `refBandBps` 90, 100 with the 5 bps cap; L20
    //  `refBandBps` 90 with the 5 bps cap and `legBandBps` 50. L18 is the owner's decided default of 2026-11-12 (the
    //  queue's `initialize` and the harness), so the other rows each switch it off or change it explicitly.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    struct LeverSetting {
        string name;
        uint16 legBand;
        uint16 refBand;
        uint8 mode;
        uint16 callBps;
    }

    /// @dev One run of an attack under a lever: the attacker's net (flash fee 0 and Aave's 5 bps), the victim's fill,
    ///      the holders' loss at the reference prices, the calls made, the deposit sides that failed, and whether a
    ///      call reverted (a check blocked it).
    struct LeverRun {
        int256 lvl;
        int256 net;
        int256 netAave;
        uint256 victimUsdc;
        uint256 victimShares;
        uint256 victimLoss;
        uint256 holdersLoss;
        uint256 navRef;
        uint256 calls;
        uint256 failedSides;
        bool reverted;
    }

    /// @dev The most settlements one run makes (one per block) before it stops: a capped flow fills in parts.
    uint256 internal constant LEVER_MAX_CALLS = 16;
    uint256 internal constant LEVER_SETTINGS = 21;

    function _lever(uint256 id) internal pure returns (LeverSetting memory l) {
        require(id < LEVER_SETTINGS, "lever: unknown setting");
        l.legBand = 100;
        l.refBand = 50;
        if (id == 0) {
            l.name = "L0 no lever (design as first written)";
        } else if (id == 1) {
            (l.name, l.legBand) = ("L1 legBand 50", 50);
        } else if (id == 2) {
            (l.name, l.legBand) = ("L2 legBand 26", 26);
        } else if (id == 3) {
            (l.name, l.mode) = ("L3 limits from TWAP only", 1);
        } else if (id == 4) {
            (l.name, l.mode) = ("L4 limits from feed only", 2);
        } else if (id == 5) {
            (l.name, l.callBps) = ("L5 cap 5 bps of depth per call", 5);
        } else if (id == 6) {
            (l.name, l.callBps) = ("L6 cap 10 bps of depth per call", 10);
        } else if (id == 7) {
            (l.name, l.callBps) = ("L7 cap 20 bps of depth per call", 20);
        } else if (id == 8) {
            (l.name, l.legBand, l.callBps) = ("L8 legBand 50 + cap 10 bps", 50, 10);
        } else if (id == 9) {
            (l.name, l.legBand, l.mode) = ("L9 legBand 26 + feed only", 26, 2);
        } else if (id == 10) {
            (l.name, l.refBand) = ("L10 refBand 90", 90);
        } else if (id == 11) {
            (l.name, l.refBand) = ("L11 refBand 100", 100);
        } else if (id == 12) {
            (l.name, l.legBand) = ("L12 legBand 30", 30);
        } else if (id == 13) {
            (l.name, l.legBand) = ("L13 legBand 35", 35);
        } else if (id == 14) {
            (l.name, l.legBand) = ("L14 legBand 40", 40);
        } else if (id == 15) {
            (l.name, l.legBand, l.callBps) = ("L15 legBand 35 + cap 10 bps", 35, 10);
        } else if (id == 16) {
            (l.name, l.legBand, l.callBps) = ("L16 legBand 30 + cap 10 bps", 30, 10);
        } else if (id == 17) {
            (l.name, l.legBand, l.callBps) = ("L17 legBand 30 + cap 5 bps", 30, 5);
        } else if (id == 18) {
            (l.name, l.refBand, l.callBps) = ("L18 refBand 90 + cap 5 bps (the defaults)", 90, 5);
        } else if (id == 19) {
            (l.name, l.refBand, l.callBps) = ("L19 refBand 100 + cap 5 bps", 100, 5);
        } else {
            (l.name, l.refBand, l.callBps, l.legBand) =
            ("L20 refBand 90 + cap 5 bps + legBand 50", 90, 5, 50);
        }
    }

    /// @dev Put lever `l` in force as ADMIN (the timelock holds ADMIN_ROLE; pranked so no time passes). Every row
    ///      sets its own bands and levers exactly, whatever the queue's defaults are: since 2026-11-12 `initialize`
    ///      turns the 5 bps cap on and the harness band is 90, so the all-zero row L0 must switch them off itself.
    function _applyLever(LeverSetting memory l) internal {
        FlowParams memory p = queue.flowParams();
        if (p.legBandBps != l.legBand || p.refBandBps != l.refBand) {
            p.legBandBps = l.legBand;
            p.refBandBps = l.refBand;
            vm.prank(address(timelock));
            queue.setFlowParams(p);
        }
        vm.prank(address(timelock));
        queue.setFlowLevers(FlowLevers({basketCallBps: l.callBps, legPriceMode: l.mode}));
        FlowLevers memory now_ = queue.flowLevers();
        assertEq(now_.basketCallBps, l.callBps, "lever: cap in force");
        assertEq(now_.legPriceMode, l.mode, "lever: price mode in force");
        assertEq(queue.flowParams().legBandBps, l.legBand, "lever: legBand in force");
        assertEq(queue.flowParams().refBandBps, l.refBand, "lever: refBand in force");
    }

    // ─── A7 under each lever ────────────────────────────────────────────────────────────────────────────

    function test_lever_A7_caller_L00() public fixtureCovered {
        _leverA7(0, true);
    }

    function test_lever_A7_caller_L01() public fixtureCovered {
        _leverA7(1, true);
    }

    function test_lever_A7_caller_L02() public fixtureCovered {
        _leverA7(2, true);
    }

    function test_lever_A7_caller_L03() public fixtureCovered {
        _leverA7(3, true);
    }

    function test_lever_A7_caller_L04() public fixtureCovered {
        _leverA7(4, true);
    }

    function test_lever_A7_caller_L05() public fixtureCovered {
        _leverA7(5, true);
    }

    function test_lever_A7_caller_L06() public fixtureCovered {
        _leverA7(6, true);
    }

    function test_lever_A7_caller_L07() public fixtureCovered {
        _leverA7(7, true);
    }

    function test_lever_A7_caller_L08() public fixtureCovered {
        _leverA7(8, true);
    }

    function test_lever_A7_caller_L09() public fixtureCovered {
        _leverA7(9, true);
    }

    function test_lever_A7_caller_L10() public fixtureCovered {
        _leverA7(10, true);
    }

    function test_lever_A7_caller_L11() public fixtureCovered {
        _leverA7(11, true);
    }

    function test_lever_A7_caller_L12() public fixtureCovered {
        _leverA7(12, true);
    }

    function test_lever_A7_caller_L13() public fixtureCovered {
        _leverA7(13, true);
    }

    function test_lever_A7_caller_L14() public fixtureCovered {
        _leverA7(14, true);
    }

    function test_lever_A7_caller_L15() public fixtureCovered {
        _leverA7(15, true);
    }

    function test_lever_A7_caller_L16() public fixtureCovered {
        _leverA7(16, true);
    }

    function test_lever_A7_caller_L17() public fixtureCovered {
        _leverA7(17, true);
    }

    function test_lever_A7_caller_L18() public fixtureCovered {
        _leverA7(18, true);
    }

    function test_lever_A7_caller_L19() public fixtureCovered {
        _leverA7(19, true);
    }

    function test_lever_A7_caller_L20() public fixtureCovered {
        _leverA7(20, true);
    }

    function test_lever_A7_thirdParty_L00() public fixtureCovered {
        _leverA7(0, false);
    }

    function test_lever_A7_thirdParty_L01() public fixtureCovered {
        _leverA7(1, false);
    }

    function test_lever_A7_thirdParty_L02() public fixtureCovered {
        _leverA7(2, false);
    }

    function test_lever_A7_thirdParty_L03() public fixtureCovered {
        _leverA7(3, false);
    }

    function test_lever_A7_thirdParty_L04() public fixtureCovered {
        _leverA7(4, false);
    }

    function test_lever_A7_thirdParty_L05() public fixtureCovered {
        _leverA7(5, false);
    }

    function test_lever_A7_thirdParty_L06() public fixtureCovered {
        _leverA7(6, false);
    }

    function test_lever_A7_thirdParty_L07() public fixtureCovered {
        _leverA7(7, false);
    }

    function test_lever_A7_thirdParty_L08() public fixtureCovered {
        _leverA7(8, false);
    }

    function test_lever_A7_thirdParty_L09() public fixtureCovered {
        _leverA7(9, false);
    }

    function test_lever_A7_thirdParty_L10() public fixtureCovered {
        _leverA7(10, false);
    }

    function test_lever_A7_thirdParty_L11() public fixtureCovered {
        _leverA7(11, false);
    }

    function test_lever_A7_thirdParty_L12() public fixtureCovered {
        _leverA7(12, false);
    }

    function test_lever_A7_thirdParty_L13() public fixtureCovered {
        _leverA7(13, false);
    }

    function test_lever_A7_thirdParty_L14() public fixtureCovered {
        _leverA7(14, false);
    }

    function test_lever_A7_thirdParty_L15() public fixtureCovered {
        _leverA7(15, false);
    }

    function test_lever_A7_thirdParty_L16() public fixtureCovered {
        _leverA7(16, false);
    }

    function test_lever_A7_thirdParty_L17() public fixtureCovered {
        _leverA7(17, false);
    }

    function test_lever_A7_thirdParty_L18() public fixtureCovered {
        _leverA7(18, false);
    }

    function test_lever_A7_thirdParty_L19() public fixtureCovered {
        _leverA7(19, false);
    }

    function test_lever_A7_thirdParty_L20() public fixtureCovered {
        _leverA7(20, false);
    }

    /// @dev A7 under lever `id`: the same world, victim (250,000 USDC, limit from the quote under the lever plus
    ///      the 50 bps margin) and caller as `_a7`. Each run settles once per block until the victim's request
    ///      closes (a capped flow fills in parts); with a push, the attacker sandwiches EVERY one of those calls in
    ///      its block (push both pools, settle, sell back). Pushes 5 to 90 bps; the honest run first.
    ///      The victim's extra cost is its USDC per share against the honest run's, times its shares.
    function _leverA7(uint256 id, bool attackerSettles) internal {
        LeverSetting memory l = _lever(id);
        _world();
        _applyLever(l);
        uint256 vid = _victimDeposit(victim, 250_000e6);
        warpToSettleable(vid);
        if (attackerSettles) vm.warp(block.timestamp + queue.flowParams().keeperGrace);
        refreshFeeds();
        _begin();
        address caller = attackerSettles ? attacker : keeper;
        string memory tag =
            string.concat(attackerSettles ? "A7-caller" : "A7-thirdParty", ",", l.name);

        uint256 snap = vm.snapshotState();
        LeverRun memory h = _leverA7Run(caller, vid, 0);
        _leverLog(tag, h);
        vm.revertToState(snap);

        int256[10] memory pushes = [
            int256(5),
            int256(10),
            int256(15),
            int256(20),
            int256(30),
            int256(40),
            int256(50),
            int256(65),
            int256(80),
            int256(90)
        ];
        LeverRun memory best;
        best.net = type(int256).min;
        for (uint256 k; k < pushes.length; ++k) {
            snap = vm.snapshotState();
            LeverRun memory r = _leverA7Run(caller, vid, pushes[k]);
            r.victimLoss = _victimLoss(r, h);
            _leverLog(tag, r);
            if (r.net > best.net) best = r;
            vm.revertToState(snap);
            coverageCheckpoint();
        }
        _leverBest(tag, h, best);
    }

    function _leverA7Run(address caller, uint256 vid, int256 push)
        internal
        returns (LeverRun memory r)
    {
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        borrowed = 0;
        r.lvl = push;
        for (uint256 k; k < LEVER_MAX_CALLS; ++k) {
            if (k != 0) _nextBlock();
            uint256 bw;
            uint256 bc;
            if (push != 0) {
                (uint256 sw, uint256 gw) = _pushBps(attacker, WETH_POOL, WETH, USDC, push);
                (uint256 sc, uint256 gc) = _pushBps(attacker, CBBTC_POOL, CBBTC, USDC, push);
                borrowed += sw + sc;
                (bw, bc) = (gw, gc);
            }
            (bool stop) = _leverCall(caller, r);
            if (push != 0) {
                _sellExact(attacker, WETH_POOL, WETH, USDC, bw);
                _sellExact(attacker, CBBTC_POOL, CBBTC, USDC, bc);
            }
            if (stop || queue.getRequest(vid).closed) break;
        }
        _leverClose(vid, r);
    }

    // ─── A10 under each lever ───────────────────────────────────────────────────────────────────────────

    function test_lever_A10_ramp_L00() public fixtureCovered {
        _leverA10(0);
    }

    function test_lever_A10_ramp_L01() public fixtureCovered {
        _leverA10(1);
    }

    function test_lever_A10_ramp_L02() public fixtureCovered {
        _leverA10(2);
    }

    function test_lever_A10_ramp_L03() public fixtureCovered {
        _leverA10(3);
    }

    function test_lever_A10_ramp_L04() public fixtureCovered {
        _leverA10(4);
    }

    function test_lever_A10_ramp_L05() public fixtureCovered {
        _leverA10(5);
    }

    function test_lever_A10_ramp_L06() public fixtureCovered {
        _leverA10(6);
    }

    function test_lever_A10_ramp_L07() public fixtureCovered {
        _leverA10(7);
    }

    function test_lever_A10_ramp_L08() public fixtureCovered {
        _leverA10(8);
    }

    function test_lever_A10_ramp_L09() public fixtureCovered {
        _leverA10(9);
    }

    function test_lever_A10_ramp_L10() public fixtureCovered {
        _leverA10(10);
    }

    function test_lever_A10_ramp_L11() public fixtureCovered {
        _leverA10(11);
    }

    function test_lever_A10_ramp_L12() public fixtureCovered {
        _leverA10(12);
    }

    function test_lever_A10_ramp_L13() public fixtureCovered {
        _leverA10(13);
    }

    function test_lever_A10_ramp_L14() public fixtureCovered {
        _leverA10(14);
    }

    function test_lever_A10_ramp_L15() public fixtureCovered {
        _leverA10(15);
    }

    function test_lever_A10_ramp_L16() public fixtureCovered {
        _leverA10(16);
    }

    function test_lever_A10_ramp_L17() public fixtureCovered {
        _leverA10(17);
    }

    function test_lever_A10_ramp_L18() public fixtureCovered {
        _leverA10(18);
    }

    function test_lever_A10_ramp_L19() public fixtureCovered {
        _leverA10(19);
    }

    function test_lever_A10_ramp_L20() public fixtureCovered {
        _leverA10(20);
    }

    /// @dev A10 under lever `id` (no arbitrage, as `test_A10_slowRampInsideBand_noArbitrage`): the attacker ramps
    ///      wETH by `rate` every 5 minutes over the last hour of the victim's window (12 pushes), holds the ramp
    ///      while the keeper settles once per block until the victim's request closes, then sells back. Rates 1 to 14
    ///      bps (spot +12 to +168 bps at the window end: 10 to 14 reach the refBandBps 90 and 100 rows); the honest
    ///      run (no ramp) first.
    function _leverA10(uint256 id) internal {
        LeverSetting memory l = _lever(id);
        _world();
        _applyLever(l);
        uint256 vid = _victimDeposit(victim, 250_000e6);
        uint256 windowEnd = queue.settleableAt(queue.getRequest(vid).epoch);
        vm.warp(windowEnd - 1 hours);
        refreshFeeds();
        _begin();
        string memory tag = string.concat("A10-ramp,", l.name);

        uint256 snap = vm.snapshotState();
        LeverRun memory h = _leverA10Run(vid, windowEnd, 0);
        _leverLog(tag, h);
        vm.revertToState(snap);

        // 10 to 14 reach the wider band of 90 to 100 (median about +60 to +84; spot +120 to +168, past legBandBps).
        int256[10] memory rates = [
            int256(1),
            int256(2),
            int256(3),
            int256(4),
            int256(5),
            int256(6),
            int256(8),
            int256(10),
            int256(12),
            int256(14)
        ];
        LeverRun memory best;
        best.net = type(int256).min;
        for (uint256 k; k < rates.length; ++k) {
            snap = vm.snapshotState();
            LeverRun memory r = _leverA10Run(vid, windowEnd, rates[k]);
            r.victimLoss = _victimLoss(r, h);
            _leverLog(tag, r);
            if (r.net > best.net) best = r;
            vm.revertToState(snap);
            coverageCheckpoint();
        }
        _leverBest(tag, h, best);
    }

    function _leverA10Run(uint256 vid, uint256 windowEnd, int256 rate)
        internal
        returns (LeverRun memory r)
    {
        fundUsdc(attacker, FLASH_USDC);
        _startAttacker();
        borrowed = 0;
        r.lvl = rate;
        uint256 bought;
        if (rate != 0) bought = _ramp(rate, 12);
        vm.warp(windowEnd > block.timestamp ? windowEnd : block.timestamp);
        refreshFeeds();
        for (uint256 k; k < LEVER_MAX_CALLS; ++k) {
            if (k != 0) _nextBlock();
            if (_leverCall(keeper, r) || queue.getRequest(vid).closed) break;
        }
        if (bought != 0) _sellExact(attacker, WETH_POOL, WETH, USDC, bought);
        _leverClose(vid, r);
    }

    // ─── A8 way 3 under each lever: the cheapest push that blocks the deposit side ───────────────────────

    function test_lever_A8way3_L00() public fixtureCovered {
        _leverA8way3(0);
    }

    function test_lever_A8way3_L01() public fixtureCovered {
        _leverA8way3(1);
    }

    function test_lever_A8way3_L02() public fixtureCovered {
        _leverA8way3(2);
    }

    function test_lever_A8way3_L03() public fixtureCovered {
        _leverA8way3(3);
    }

    function test_lever_A8way3_L04() public fixtureCovered {
        _leverA8way3(4);
    }

    function test_lever_A8way3_L05() public fixtureCovered {
        _leverA8way3(5);
    }

    function test_lever_A8way3_L06() public fixtureCovered {
        _leverA8way3(6);
    }

    function test_lever_A8way3_L07() public fixtureCovered {
        _leverA8way3(7);
    }

    function test_lever_A8way3_L08() public fixtureCovered {
        _leverA8way3(8);
    }

    function test_lever_A8way3_L09() public fixtureCovered {
        _leverA8way3(9);
    }

    function test_lever_A8way3_L10() public fixtureCovered {
        _leverA8way3(10);
    }

    function test_lever_A8way3_L11() public fixtureCovered {
        _leverA8way3(11);
    }

    function test_lever_A8way3_L12() public fixtureCovered {
        _leverA8way3(12);
    }

    function test_lever_A8way3_L13() public fixtureCovered {
        _leverA8way3(13);
    }

    function test_lever_A8way3_L14() public fixtureCovered {
        _leverA8way3(14);
    }

    function test_lever_A8way3_L15() public fixtureCovered {
        _leverA8way3(15);
    }

    function test_lever_A8way3_L16() public fixtureCovered {
        _leverA8way3(16);
    }

    function test_lever_A8way3_L17() public fixtureCovered {
        _leverA8way3(17);
    }

    function test_lever_A8way3_L18() public fixtureCovered {
        _leverA8way3(18);
    }

    function test_lever_A8way3_L19() public fixtureCovered {
        _leverA8way3(19);
    }

    function test_lever_A8way3_L20() public fixtureCovered {
        _leverA8way3(20);
    }

    /// @dev A8 way 3 (`test_A8_block_perSwapLimit_aroundEachKeeperCall`) under lever `id`: a 50,000 USDC deposit and
    ///      a redemption of a quarter of alice's shares wait; the attacker pushes wETH up right before the keeper's
    ///      call and sells back right after it. Pushes 0 (no attack: does the lever itself block the deposit?), then
    ///      10 to 110 bps. The cheapest push after which the deposit is still whole is the blocking
    ///      push; its round-trip cost × 24 keeper attempts a day is the way's cost per day (the scaffold's
    ///      convention for way 3).
    function _leverA8way3(uint256 id) internal {
        LeverSetting memory l = _lever(id);
        _world();
        _applyLever(l);
        _begin();
        uint256 vid = _victimDeposit(victim, 50_000e6);
        openRedeemRequest(alice, fund.balanceOf(alice) / 4, 0);
        warpToSettleable(vid);
        refreshFeeds();
        string memory tag = string.concat("A8way3,", l.name);
        int256[12] memory pushes = [
            int256(0),
            int256(10),
            int256(15),
            int256(20),
            int256(25),
            int256(30),
            int256(40),
            int256(50),
            int256(65),
            int256(80),
            int256(95),
            int256(110)
        ];
        int256 cheapest = -1;
        uint256 perDay;
        for (uint256 k; k < pushes.length; ++k) {
            uint256 snap = vm.snapshotState();
            fundUsdc(attacker, FLASH_USDC);
            _startAttacker();
            borrowed = 0;
            LeverRun memory r;
            r.lvl = pushes[k];
            uint256 bought;
            if (pushes[k] != 0) {
                (borrowed, bought) = _pushBps(attacker, WETH_POOL, WETH, USDC, pushes[k]);
            }
            _leverCall(keeper, r);
            if (bought != 0) _sellExact(attacker, WETH_POOL, WETH, USDC, bought);
            _leverClose(vid, r);
            _leverLog(tag, r);
            bool blocked = queue.getRequest(vid).remaining == 50_000e6;
            if (blocked && cheapest < 0) {
                cheapest = pushes[k];
                perDay = r.net < 0 ? uint256(-r.net) * 24 : 0;
            }
            vm.revertToState(snap);
            coverageCheckpoint();
        }
        emit log_named_string(
            "LEVER-A8",
            string.concat(
                tag,
                ",cheapestBlockingPushBps=",
                vm.toString(cheapest),
                ",costPerDayUsdcUnits=",
                vm.toString(perDay),
                cheapest == 0 ? ",the lever itself blocks the honest deposit" : ""
            )
        );
    }

    // ─── Lever helpers ──────────────────────────────────────────────────────────────────────────────────

    /// @dev One block later (2 s, Base): a capped flow's next part, or the next keeper attempt.
    function _nextBlock() internal {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 2);
        refreshFeeds();
    }

    /// @dev One settlement as `caller`, recorded in `r`. Returns true when the run should stop: the call reverted
    ///      (a check blocked it), or it recorded no settlement.
    function _leverCall(address caller, LeverRun memory r) internal returns (bool stop) {
        vm.recordLogs();
        vm.prank(caller);
        try queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max) returns (uint256 sid) {
            ++r.calls;
            if (_sawSideFailed(RequestKind.Deposit)) ++r.failedSides;
            stop = sid == 0;
        } catch {
            vm.getRecordedLogs();
            r.reverted = true;
            stop = true;
        }
    }

    /// @dev Close a run: the victim's fills of request `vid`, the attacker's net, the
    ///      holders' loss (asserted under 1 bps of NAV), check 10 from outside.
    function _leverClose(uint256 vid, LeverRun memory r) internal {
        uint256 n = queue.claimCount();
        for (uint256 c = 1; c <= n; ++c) {
            Claim memory cl = queue.getClaim(c);
            if (cl.requestId != vid) continue;
            r.victimUsdc += cl.usdc;
            r.victimShares += cl.shares;
        }
        r.net = _diff(_valueOf(attacker), v0);
        r.netAave = r.net - int256(borrowed.mulDiv(AAVE_FLASH_FEE_BPS, BPS));
        r.holdersLoss = _holdersLoss();
        r.navRef = s0.navRef;
        assertLe(
            r.holdersLoss,
            s0.navRef.mulDiv(G8_HOLDER_LOSS_BPS, BPS),
            "lever: holders lose at most 1 bps of NAV"
        );
        _assertPerShareNotLower("lever");
    }

    /// @dev The victim's extra cost in run `r` against the honest run `h`: its USDC less what its shares would have
    ///      cost at the honest run's price per share (0 when either filled nothing).
    function _victimLoss(LeverRun memory r, LeverRun memory h) internal pure returns (uint256) {
        if (r.victimShares == 0 || h.victimShares == 0) return 0;
        uint256 fair = r.victimShares.mulDiv(h.victimUsdc, h.victimShares);
        return r.victimUsdc > fair ? r.victimUsdc - fair : 0;
    }

    /// @dev `LEVER,<attack>,<setting>,lvl,net,netAave,victimUsdc,victimShares,victimLoss,holdersLoss,calls,failedSides,reverted`
    function _leverLog(string memory tag, LeverRun memory r) internal {
        string memory head = string.concat(
            tag,
            ",",
            vm.toString(r.lvl),
            ",",
            vm.toString(r.net),
            ",",
            vm.toString(r.netAave),
            ",",
            vm.toString(r.victimUsdc)
        );
        string memory tail = string.concat(
            vm.toString(r.victimShares),
            ",",
            vm.toString(r.victimLoss),
            ",",
            vm.toString(r.holdersLoss),
            ",",
            vm.toString(r.calls)
        );
        emit log_named_string(
            "LEVER",
            string.concat(
                head,
                ",",
                tail,
                ",",
                vm.toString(r.failedSides),
                ",",
                r.reverted ? "reverted" : "ok"
            )
        );
    }

    /// @dev `LEVER-BEST,<attack>,<setting>,honestCalls,honestVictimUsdc,honestFailedSides,honestReverted,bestLvl,
    ///      bestNet,bestNetAave,bestVictimLoss,bestHoldersLoss,navRef`
    function _leverBest(string memory tag, LeverRun memory h, LeverRun memory b) internal {
        string memory honest = string.concat(
            vm.toString(h.calls),
            ",",
            vm.toString(h.victimUsdc),
            ",",
            vm.toString(h.failedSides),
            ",",
            h.reverted ? "reverted" : "ok"
        );
        string memory best = string.concat(
            vm.toString(b.lvl),
            ",",
            vm.toString(b.net),
            ",",
            vm.toString(b.netAave),
            ",",
            vm.toString(b.victimLoss)
        );
        emit log_named_string(
            "LEVER-BEST",
            string.concat(
                tag,
                ",",
                honest,
                ",",
                best,
                ",",
                vm.toString(b.holdersLoss),
                ",",
                vm.toString(b.navRef)
            )
        );
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: the world, valuation, requests
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev The fund every attack starts from: the seed invested by a 1-day plan to (65, 35), then alice's deposit
    ///      through the queue, then the outside market catches up with the fund's own trades (`alignFeedsToPools`),
    ///      so feed and pool agree when the attack starts.
    function _world() internal {
        investFund(bucketVec(6_500, 3_500));
        deposit(alice, ALICE_USDC);
        _takeCredit(alice);
        alignFeedsToPools();
        refreshFeeds();
        coverageCheckpoint();
    }

    /// @dev Fix the reference prices at the pools' spot now and snapshot the fund (`s0`). Resets the attack's
    ///      bookkeeping (`borrowed`, `pending`).
    function _begin() internal {
        _setRef();
        s0 = _snap();
        borrowed = 0;
        pending = 0;
        extraNet = 0;
    }

    /// @dev The attacker's value at the start, after its flash loan or capital is in place.
    function _startAttacker() internal {
        v0 = _valueOf(attacker);
    }

    /// @dev Close the attack: the attacker's net against `v0`, the holders' loss against `s0`, the pending users'
    ///      loss and the flash borrowing from storage. Logs it; when `g8`, asserts check 10 from outside (no held
    ///      amount per share fell) and G8.
    function _end(string memory id, bool g8) internal returns (AttackPnl memory r) {
        r.attackerNet = _diff(_valueOf(attacker), v0) + extraNet;
        r.flashBorrowed = borrowed;
        r.holdersLoss = _holdersLoss();
        r.pendingLoss = pending;
        r.navRef = s0.navRef;
        _reportPnl(id, r);
        if (!g8) return r;
        _assertPerShareNotLower(id);
        _assertG8(id, r);
    }

    /// @dev Fix the reference prices at the pools' spot now.
    function _setRef() internal {
        refWeth = _spotPx(WETH_POOL, WETH, USDC);
        refCbbtc = _spotPx(CBBTC_POOL, CBBTC, USDC);
    }

    function _snap() internal view returns (Snap memory s) {
        (s.idle, s.held) = fund.heldBalances();
        s.supply = fund.totalSupply();
        s.navRef = _navRef();
    }

    /// @dev NAV at the reference prices: idle, each lending venue's holders' part, each basket token at its reference.
    function _navRef() internal view returns (uint256 nav) {
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        nav = idle;
        for (uint256 i; i < held.length; ++i) {
            if (i == IDX_WETH) nav += held[i].mulDiv(refWeth, 1e18);
            else if (i == IDX_CBBTC) nav += held[i].mulDiv(refCbbtc, 1e8);
            else nav += held[i];
        }
    }

    /// @dev Value of `shares` at the reference NAV per share.
    function _shareValue(uint256 shares) internal view returns (uint256) {
        uint256 supply = fund.totalSupply();
        return supply == 0 ? 0 : shares.mulDiv(_navRef(), supply);
    }

    /// @dev Everything `who` owns, at the reference prices: USDC, wETH, cbBTC, wallet shares, every share the queue
    ///      keeps for it (escrow, held deposit shares, share credit: `queuedSharesOf`), its USDC credit, its pending
    ///      deposit escrow, its settled redemption USDC not yet taken, its lending position claims and its deferred
    ///      basket legs.
    function _valueOf(address who) internal view returns (uint256 v) {
        v = IERC20(USDC).balanceOf(who) + IERC20(WETH).balanceOf(who).mulDiv(refWeth, 1e18)
            + IERC20(CBBTC).balanceOf(who).mulDiv(refCbbtc, 1e8);
        v += _shareValue(fund.balanceOf(who) + queue.queuedSharesOf(who));
        (uint256 creditUsdc,) = queue.creditOf(who);
        v += creditUsdc;
        uint256 n = queue.requestCount();
        for (uint256 id = 1; id <= n; ++id) {
            Request memory r = queue.getRequest(id);
            if (r.owner == who && !r.closed && r.kind == RequestKind.Deposit) {
                v += queue.requestStatus(id) == RequestStatus.Pending
                    ? queue.pendingDepositRequest(id, who)
                    : r.remaining;
            }
        }
        n = queue.claimCount();
        for (uint256 c = 1; c <= n; ++c) {
            Claim memory cl = queue.getClaim(c);
            if (cl.owner == who && cl.kind == RequestKind.Redeem) v += cl.usdc - cl.claimed;
        }
        for (uint256 i; i < listedAssets(); ++i) {
            if (isBasketIndex(i)) {
                uint256 owed = fund.deferredOf(i, who);
                v += owed.mulDiv(i == IDX_WETH ? refWeth : refCbbtc, i == IDX_WETH ? 1e18 : 1e8);
            } else {
                (, uint256 claimUsdc) = fund.positionClaimOf(i, who);
                v += claimUsdc;
            }
        }
    }

    /// @dev NAV the share supply lost against the NAV per share of `s0`, at the reference prices (0 if it rose).
    function _holdersLoss() internal view returns (uint256) {
        uint256 supply = fund.totalSupply();
        uint256 fair = s0.navRef.mulDiv(supply, s0.supply);
        uint256 nav = _navRef();
        return fair > nav ? fair - nav : 0;
    }

    /// @dev Check 10 from outside (RB-13): no held amount per share fell since `s0`.
    function _assertPerShareNotLower(string memory label) internal view {
        (uint256 idle1, uint256[] memory held1) = fund.heldBalances();
        uint256 supply1 = fund.totalSupply();
        assertGe(idle1 * s0.supply, s0.idle * supply1, string.concat(label, ": idle per share"));
        for (uint256 i; i < s0.held.length; ++i) {
            assertGe(
                held1[i] * s0.supply,
                s0.held[i] * supply1,
                string.concat(label, ": asset per share")
            );
        }
    }

    /// @dev `who` asks to deposit `usdc` it already holds (no funding), with limit `limit`.
    function _reqDeposit(address who, uint256 usdc, uint256 /* limit */) internal returns (uint256 id) {
        vm.startPrank(who);
        IERC20(USDC).approve(address(queue), usdc);
        id = queue.requestDeposit(usdc, who);
        vm.stopPrank();
    }

    /// @dev A pending user's deposit request (limits retired in Step 3f).
    function _victimDeposit(address who, uint256 usdc) internal returns (uint256 id) {
        refreshFeeds();
        queue.quoteDeposit(usdc);
        id = openDepositRequest(who, usdc);
    }

    /// @dev `who` takes every settled redemption USDC it has (computed before the prank: a call inside the
    ///      arguments would take the prank).
    function _claimRedeemUsdc(address who) internal returns (uint256 usdc) {
        uint256 shares = queue.maxRedeem(who);
        if (shares == 0) return 0;
        vm.prank(who);
        usdc = queue.redeem(shares, who, who);
    }

    /// @dev Pull `who`'s queue credits, if any.
    function _takeCredit(address who) internal {
        (uint256 u, uint256 s) = queue.creditOf(who);
        if (u == 0 && s == 0) return;
        vm.prank(who);
        queue.withdrawCredit();
    }

    /// @dev An outside trader (not the attacker) moves `token` at `pool` by `bps`: a real market move.
    function _moveMarket(address pool, address token, int256 bps) internal {
        address mkt = makeAddr("market");
        if (bps > 0) fundUsdc(mkt, FLASH_USDC);
        else deal(token, mkt, IERC20(token).balanceOf(mkt) + 10_000e18);
        _pushBps(mkt, pool, token, USDC, bps);
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  A1, A3, A4, A5 and A6 against the frozen synchronous fund (step 3c baseline)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/// @title AttacksBaselineTest
/// @notice Eng plan §4.1 and §5 work package 2: the attacks that apply to the frozen step 3c fund, played on the
///         baseline harness (six assets with deSPXA at 0 weight, deficit-first deposits minted on the realized TWAP
///         NAV delta, synchronous pro-rata redemption). Same valuation and the same no-arbitrage market as
///         `AttacksTimedTest`. The baseline is the "before" of proposal §5.9.1: "`redeem` is safe ... `deposit` is
///         the exposure ... a TWAP that lags or is pushed gives the depositor too many shares." Each test asserts the
///         sign the design doc predicts for the baseline, so a measured result that contradicts the doc turns red.
contract AttacksBaselineTest is BaselineHarness, AttackBook {
    using Math for uint256;

    address internal attacker = makeAddr("attacker");
    address internal alice = makeAddr("alice");

    uint256 internal constant ALICE_USDC = 1_000_000e6;
    uint256 internal constant FLASH_USDC = 30_000_000e6;

    uint256 internal refWeth;
    uint256 internal refCbbtc;
    uint256 internal navRef0;
    uint256 internal supply0;
    uint256 internal v0;
    uint256 internal borrowed;

    function setUp() public override {
        super.setUp();
        vm.label(attacker, "attacker");
        vm.label(alice, "alice");
    }

    // ─── A1: Makina replay, one transaction ───────────────────────────────────────────────────────────

    /// @dev One transaction: borrow, push wETH 150 bps (inside the 200 bps ORA-4 band), deposit 100,000 USDC (at
    ///      target the deposit buys every asset pro rata; a larger one fails the step-3c swap floor of TWAP − 200 bps
    ///      on its own wETH leg), redeem every share, sell back. The deposit mints on the TWAP, which one block does
    ///      not move. Expected on the baseline: no gain (proposal §5.9.1).
    function test_A1_baseline_makinaReplay_oneTransaction() public fixtureCovered {
        _worldB();
        _beginB();
        fundUsdc(attacker, FLASH_USDC);
        v0 = _valueOfB(attacker);
        uint256 bought;
        (borrowed, bought) = _pushBps(attacker, WETH_POOL, WETH, USDC, 150);
        (bool ok,) = fund.marketCheck(IDX_WETH);
        assertTrue(ok, "the push stays inside ORA-4, so the deposit runs");
        uint256 shares = _depositB(attacker, 100_000e6);
        vm.prank(attacker);
        fund.redeem(shares, attacker, attacker);
        _sellExact(attacker, WETH_POOL, WETH, USDC, bought);
        AttackPnl memory r =
            _endB("A1 baseline, push +150 bps, deposit and redeem in one transaction");
        _assertG8("A1 baseline", r);

        // A push past ORA-4 makes the deposit itself revert.
        _pushBps(attacker, WETH_POOL, WETH, USDC, 300);
        fundUsdc(attacker, 1_000e6);
        vm.startPrank(attacker);
        IERC20(USDC).approve(address(fund), 1_000e6);
        vm.expectPartialRevert(IBaselineFund.NavMarketDeviationExceeded.selector);
        fund.deposit(1_000e6, attacker);
        vm.stopPrank();
    }

    // ─── A3: deflate, deposit, exit ───────────────────────────────────────────────────────────────────

    /// @dev The fund's plan has left wETH over its path target, so deficit-first routing sends a deposit to the
    ///      lending venues (`_worldDeficitToLending`). The attacker deflates wETH 500 bps and holds it one TWAP window
    ///      (no arbitrage: free), deposits the per-deposit cap at the deflated TWAP NAV, buys the wETH back, waits one
    ///      window for the TWAP to recover and redeems. Expected on the baseline: the depositor gets too many shares
    ///      (§5.9.1), a positive net without arbitrage, paid by the holders.
    function test_A3_baseline_deflateDepositExit_profitsWithoutArbitrage() public fixtureCovered {
        _worldDeficitToLending();
        _beginB();
        fundUsdc(attacker, PER_DEPOSIT_CAP);
        deal(WETH, attacker, uint256(3_000_000e6).mulDiv(1e18, refWeth));
        v0 = _valueOfB(attacker);
        (uint256 sold, uint256 usdcGot) = _pushBps(attacker, WETH_POOL, WETH, USDC, -500);
        borrowed = sold.mulDiv(refWeth, 1e18);
        vm.warp(block.timestamp + TWAP_WINDOW + 60);
        (bool ok,) = fund.marketCheck(IDX_WETH);
        assertTrue(ok, "after one window the TWAP agrees with the deflated spot: ORA-4 passes");
        uint256 wethBefore = IERC20(WETH).balanceOf(address(fund));
        uint256 shares = _depositB(attacker, PER_DEPOSIT_CAP);
        assertEq(
            IERC20(WETH).balanceOf(address(fund)),
            wethBefore,
            "deficit-first: the deposit bought no wETH"
        );
        _sellExact(attacker, WETH_POOL, USDC, WETH, usdcGot);
        vm.warp(block.timestamp + TWAP_WINDOW + 60);
        vm.prank(attacker);
        fund.redeem(shares, attacker, attacker);
        AttackPnl memory r = _endB("A3 baseline, deflate -500 bps held one window, deposit, exit");
        assertGt(
            r.attackerNet, 0, "A3 baseline: the TWAP-priced mint pays the deflation (no arbitrage)"
        );
        assertGt(r.holdersLoss, 0, "A3 baseline: the holders pay it");
    }

    // ─── A4: a gift to a lending adapter ──────────────────────────────────────────────────────────────

    /// @dev A holder gifts USDC to the Aave adapter (supply on its behalf) and redeems: the gift is shared by every
    ///      holder, so the gifter gets back only its own share of it. Expected: a loss for the gifter.
    function test_A4_baseline_giftToLendingAdapter_isAGiftToHolders() public fixtureCovered {
        _worldB();
        _beginB();
        uint256 gift = 50_000e6;
        fundUsdc(attacker, 100_000e6 + gift);
        v0 = _valueOfB(attacker);
        uint256 shares = _depositB(attacker, 100_000e6);
        vm.startPrank(attacker);
        IERC20(USDC).approve(AAVE_POOL, gift);
        IAtkAavePool(AAVE_POOL).supply(USDC, gift, address(aaveAdapter), 0);
        fund.redeem(shares, attacker, attacker);
        vm.stopPrank();
        AttackPnl memory r = _endB("A4 baseline, a 50,000 USDC gift to the Aave adapter");
        _assertG8("A4 baseline", r);
        assertLt(
            r.attackerNet, -int256(gift / 2), "the gifter keeps only its pro-rata share of the gift"
        );
    }

    // ─── A5: round trip ───────────────────────────────────────────────────────────────────────────────

    /// @dev Deposit and redeem in one block, then in consecutive blocks. Nothing moves the TWAP between them, so
    ///      the round trip pays the routing cost and the exit fee. Expected: a loss.
    function test_A5_baseline_roundTrip_oneBlockAndConsecutiveBlocks() public fixtureCovered {
        _worldB();
        _beginB();
        fundUsdc(attacker, 2 * PER_DEPOSIT_CAP);
        v0 = _valueOfB(attacker);
        uint256 shares = _depositB(attacker, PER_DEPOSIT_CAP);
        vm.prank(attacker);
        fund.redeem(shares, attacker, attacker);
        shares = _depositB(attacker, PER_DEPOSIT_CAP);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 2);
        vm.prank(attacker);
        fund.redeem(shares, attacker, attacker);
        AttackPnl memory r = _endB("A5 baseline, two round trips (same block, next block)");
        _assertG8("A5 baseline", r);
    }

    // ─── A6: TWAP lag after a real move (deterministic part) ─────────────────────────────────────────

    /// @dev The fund's plan has left wETH over its path target, so deficit-first routing sends deposits to the
    ///      lending venues. A real move (an outside trader) lifts wETH 190 bps; the attacker deposits 200,000 USDC at
    ///      once, at the lagging TWAP NAV, waits one TWAP window and redeems. The hedge (a short of the shares' wETH
    ///      exposure) has no P&L because the price does not move again. Expected on the baseline: profitable
    ///      (§5.9.1, "a TWAP lags every real move").
    function test_A6_baseline_twapLagAfterRealMove_profits() public fixtureCovered {
        _worldDeficitToLending();
        address mkt = makeAddr("market");
        fundUsdc(mkt, FLASH_USDC);
        _pushBps(mkt, WETH_POOL, WETH, USDC, 190);
        _beginB();
        (bool ok,) = fund.marketCheck(IDX_WETH);
        assertTrue(ok, "a 190 bps move stays inside ORA-4: the deposit runs");
        fundUsdc(attacker, 200_000e6);
        v0 = _valueOfB(attacker);
        uint256 shares = _depositB(attacker, 200_000e6);
        vm.warp(block.timestamp + TWAP_WINDOW + 60);
        vm.prank(attacker);
        fund.redeem(shares, attacker, attacker);
        AttackPnl memory r =
            _endB("A6 baseline, deposit into a 190 bps real move, redeem after one window");
        assertGt(r.attackerNet, 0, "A6 baseline: the lagging TWAP mints too many shares");
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────────────────────────────

    /// @dev Alice deposits 1M (idle: no plan yet), then a 1-day plan to (65, 35, 0) invests it.
    function _worldB() internal {
        deposit(alice, ALICE_USDC);
        setTargetViaTimelock(
            bucketVec(6_500, 3_500, 0), BaselinePlanParams(1 days, COST_BUDGET_BPS)
        );
        stepUntilDoneB(120);
        assertGt(IERC20(WETH).balanceOf(address(fund)), 0, "the fund holds wETH");
        coverageCheckpointB();
    }

    /// @dev `_worldB`, then a 1-day plan to all-stable, at its end time with no step taken: wETH and cbBTC sit over
    ///      their path target and the lending venues under it, so deficit-first routing sends a deposit to lending.
    function _worldDeficitToLending() internal {
        _worldB();
        setTargetViaTimelock(bucketVec(10_000, 0, 0), BaselinePlanParams(1 days, COST_BUDGET_BPS));
        vm.warp(fund.plan().endTime);
        coverageCheckpointB();
    }

    function _beginB() internal {
        refWeth = _spotPx(WETH_POOL, WETH, USDC);
        refCbbtc = _spotPx(CBBTC_POOL, CBBTC, USDC);
        navRef0 = _navRefB();
        supply0 = fund.totalSupply();
        borrowed = 0;
        assertEq(IERC20(DESPXA).balanceOf(address(fund)), 0, "deSPXA is not held (target 0)");
    }

    function _endB(string memory id) internal returns (AttackPnl memory r) {
        r.attackerNet = _diff(_valueOfB(attacker), v0);
        r.flashBorrowed = borrowed;
        uint256 fair = navRef0.mulDiv(fund.totalSupply(), supply0);
        uint256 nav = _navRefB();
        r.holdersLoss = fair > nav ? fair - nav : 0;
        r.navRef = navRef0;
        _reportPnl(id, r);
    }

    /// @dev The baseline's NAV at the reference prices: idle, every counted lending venue, wETH and cbBTC net of
    ///      deferred claims.
    function _navRefB() internal view returns (uint256 nav) {
        nav = fund.idleUsdc();
        for (uint256 i = IDX_AAVE; i <= IDX_MOONWELL; ++i) {
            nav += fund.assetValue(i);
        }
        nav += (IERC20(WETH).balanceOf(address(fund)) - fund.deferredTotal(IDX_WETH))
        .mulDiv(refWeth, 1e18);
        nav += (IERC20(CBBTC).balanceOf(address(fund)) - fund.deferredTotal(IDX_CBBTC))
        .mulDiv(refCbbtc, 1e8);
    }

    function _valueOfB(address who) internal view returns (uint256 v) {
        v = IERC20(USDC).balanceOf(who) + IERC20(WETH).balanceOf(who).mulDiv(refWeth, 1e18)
            + IERC20(CBBTC).balanceOf(who).mulDiv(refCbbtc, 1e8);
        uint256 supply = fund.totalSupply();
        if (supply != 0) v += fund.balanceOf(who).mulDiv(_navRefB(), supply);
    }

    /// @dev `who` deposits `usdc` it already holds into the baseline fund. Returns the shares minted.
    function _depositB(address who, uint256 usdc) internal returns (uint256 shares) {
        vm.startPrank(who);
        IERC20(USDC).approve(address(fund), usdc);
        shares = fund.deposit(usdc, who);
        vm.stopPrank();
    }

    /// @dev The baseline harness's keeper loop with a fixture checkpoint every 16 calls (unmetered), so the state
    ///      diff of a whole plan never has to be decoded at once.
    function stepUntilDoneB(uint256 maxSteps) internal {
        for (uint256 k; k < maxSteps; k += 16) {
            (,, PlanStatusB status) = _stepChunk(16);
            coverageCheckpointB();
            if (status != PlanStatusB.Open) return;
        }
    }

    function _stepChunk(uint256 n)
        internal
        returns (uint256 executed, uint256 calls, PlanStatusB status)
    {
        (executed, calls, status) = stepUntilDone(n);
    }

    function coverageCheckpointB() internal {
        if (!fixtureCheck) return;
        vm.pauseGasMetering();
        _fixtureCheckpoint();
        vm.resumeGasMetering();
    }
}
