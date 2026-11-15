// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.2 (an epoch: request, quote, window, settle, hold,
//            claim), §5.9.3 (one settlement, checks 1 to 12), §5.9.6 (the vault interface), §4.4 (redeemInKind,
//            RedeemOnly), §5.1 (receipt to plan), §5.3 (one step), §5.5 (plan states), §7 RB-1, RB-4, RB-6, RB-7,
//            RB-10 to RB-14, RB-22; docs/technical/one-vault-timed-flows-eng-plan.md E1 to E4, E8, E12, E14, E21, E22;
//            scaffold plan §1 item 3, §7.5 item 4
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    IConsensusRecommendationReceipt
} from "../../interfaces/IConsensusRecommendationReceipt.sol";
import {PrototypeHarness} from "./PrototypeHarness.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {
    AssetConfig,
    AssetKind,
    Plan,
    PlanParams,
    PlanStatus,
    SkipReason,
    StepOrder,
    IFundEvents,
    BPS,
    IDLE_INDEX,
    PRICE_SCALE
} from "./src/FundTypes.sol";
import {
    Claim,
    FlowBooks,
    IFlowEvents,
    QueueLiveness,
    Quote,
    Request,
    RequestKind,
    RequestStatus,
    Settlement,
    SettleCheck
} from "./src/FlowTypes.sol";
import {PlanMath} from "./src/PlanMath.sol";
import {IRobotMoneyFund} from "./src/interfaces/IRobotMoneyFund.sol";
import {IRebalanceGovernance} from "./src/interfaces/IRebalanceGovernance.sol";

/// @notice One-vault experiment, step 3d: the whole life of the fund on the timed flows, on real Base venues.
///
///         `test_happyPath_*` is scaffold plan §1 item 3: seed, deposit request, settle, hold, delivery, redemption
///         request, settle, claim. It checks each step against the design (the escrow, the bound price and RB-14,
///         the hold, delivery by anyone to the owner only, the ledger's queued shares, the claim, the queue's books).
///
///         `test_endToEnd_planLifecycle` keeps the step 3c lifecycle on the new flows: deposits through the queue,
///         receipts (refused ones, the good one, stale and replayed ones), keeper steps until Converged with the
///         RB-4 and RB-7 checks after every step, then redemptions through the queue and in kind after convergence
///         and while a plan is Paused (RB-6). Step 3c's deficit-first deposit stage is gone (D11: a pro-rata deposit
///         does not change weights); it lives on in `baseline/EndToEnd.t.sol`.
///
///         No market price, amount out or block number is hard-coded: every check is a relationship.
contract EndToEndTest is PrototypeHarness {
    using Math for uint256;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    /// @dev Raw share amount used to read NAV per share (shares carry a 10^18 virtual offset).
    uint256 internal constant PPS_UNIT = 1e30;
    /// @dev Upper bound on keeper calls: a 7-day path at one call per interval, plus a day of overrun.
    uint256 internal constant MAX_CALLS = 400;
    /// @dev The user's margin over the quote when setting a limit (E21: a client sets the limit from the quote).
    uint256 internal constant LIMIT_MARGIN_BPS = 50;

    uint256 private _e2eSalt;

    // The stale receipt of stage 2 (storage keeps stage 2 under the stack limit).
    bytes32 private _idOld;
    bytes32 private _dOld;
    uint16[5] private _older;

    // Step-loop tallies (storage keeps the loop body under the stack limit).
    uint256 private _executed;
    uint256 private _calls;
    uint256 private _totalCost;
    mapping(SkipReason => uint256) private _skips;

    // Happy-path state carried between its stages (storage keeps each stage under the stack limit).
    uint256 private _hpDepositId;
    uint256 private _hpDepositLimit;
    uint256 private _hpShares;
    uint256 private _hpCredit;

    /// @dev State captured right before one `step()` (same block as the step).
    struct Snap {
        uint256 nav;
        uint256 idle;
        uint256[] values;
        uint256 pps;
        uint256 costSpent;
        uint32 stepCount;
        /// @dev Idle plus the step's two legs at the feeds (step 3e's cost basis), set around a step.
        uint256 feedLegs;
    }

    function setUp() public override {
        super.setUp();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  The happy path (scaffold plan §1 item 3)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_happyPath_seedDepositSettleHoldDeliverRedeemSettleClaim() public fixtureCovered {
        _hpSeedAndInvest();
        coverageCheckpoint();
        // 20,000 USDC: one settlement under the per-call basket cap (5 bps of each pool's depth, the owner's default
        // of 2026-11-12) at this fund's size; FlowQueue.t.sol's RB-13 tests split larger flows over blocks.
        _hpDepositRequest(20_000e6);
        _hpDepositSettle();
        coverageCheckpoint();
        _hpHoldAndDelivery();
        _hpRedeemAndClaim(20_000e6);
        coverageCheckpoint();
    }

    /// @dev E14: the setUp seed is the fund's own, at the share scale. Then a 1-day plan spreads it over every
    ///      listed asset, so the flows below buy and sell every asset.
    function _hpSeedAndInvest() private {
        assertEq(fund.flowQueue(), address(queue), "queue bound (E1)");
        assertEq(fund.totalSupply(), SEED_USDC * 1e18, "seed minted at the share scale");
        assertEq(fund.balanceOf(address(fund)), SEED_USDC * 1e18, "seed shares belong to the fund");
        assertEq(fund.totalAssets(), SEED_USDC, "NAV = seed");

        investFund(bucketVec(6_500, 3_500));
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        assertEq(held.length, listedAssets(), "held per listed asset");
        for (uint256 i; i < held.length; ++i) {
            assertGt(held[i], 0, "the seed is spread over every asset");
        }
        assertLt(idle, SEED_USDC / 100, "the seed is invested");
    }

    /// @dev §5.9.2 steps 1 and 2: the quote, then the request with a limit from it. The USDC sits in the queue.
    function _hpDepositRequest(uint256 usdc) private {
        Quote memory q = queue.quoteDeposit(usdc);
        assertEq(q.feeBps, 0, "quote: no deposit fee class");
        assertLt(q.cancelCutoff, q.earliestSettle, "quote: cancel cutoff before earliest settle");
        assertEq(
            q.holdEnds,
            q.earliestSettle + 1 hours,
            "quote: hold ends minHold after the earliest settle"
        );
        assertGt(q.refBandBps, 0, "quote: ref band");
        assertGt(q.legBandBps, 0, "quote: leg band");
        _hpDepositLimit = type(uint256).max;

        uint256 queueUsdc = IERC20(USDC).balanceOf(address(queue));
        _hpDepositId = openDepositRequest(alice, usdc);
        assertEq(IERC20(USDC).balanceOf(address(queue)), queueUsdc + usdc, "escrow in the queue");
        assertEq(IERC20(USDC).balanceOf(alice), 0, "pulled from the caller");
        assertEq(queue.pendingDepositRequest(_hpDepositId, alice), usdc, "pending");
        assertEq(
            uint8(queue.requestStatus(_hpDepositId)), uint8(RequestStatus.Pending), "status pending"
        );
        assertEq(queue.books().pendingUsdc, usdc, "books: pending USDC");

        // Check 1: nothing settles before the window of the request's epoch ends.
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Window), "window not ended");
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                IFlowEvents.SettleBlocked.selector, SettleCheck.Window, IDLE_INDEX, 0
            )
        );
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        Request memory r = queue.getRequest(_hpDepositId);
        assertEq(
            uint256(queue.settleableAt(r.epoch)),
            q.earliestSettle,
            "the quote named the earliest settle"
        );
    }

    /// @dev §5.9.2 step 4 and §5.9.3: only the keeper settles in Step 3f (E34). One claim for alice with its
    ///      unlock time; unused USDC becomes alice's credit (E22). Check 10 from outside: no held amount per share fell.
    function _hpDepositSettle() private {
        uint256 usdc = queue.getRequest(_hpDepositId).amount;
        warpToSettleable(_hpDepositId);
        refreshFeeds();
        // Step 3f (E34): only the keeper settles; `checkSettle()` previews readiness, while `settle()` enforces Caller.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IFlowEvents.SettleBlocked.selector, SettleCheck.Caller, IDLE_INDEX, 0
            )
        );
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        vm.prank(keeper);
        (SettleCheck check, uint256 index) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Ok), "every pre-trade check passes");
        assertEq(index, IDLE_INDEX, "no asset named");

        (uint256 idle0, uint256[] memory held0) = fund.heldBalances();
        uint256 supply0 = fund.totalSupply();
        vm.prank(keeper);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertEq(sid, 1, "first settlement");

        Settlement memory st = queue.getSettlement(sid);
        assertEq(st.settler, keeper, "settler");
        assertEq(st.time, block.timestamp, "settled now");
        assertGt(st.sharesMinted, 0, "shares minted to the queue");
        assertLe(st.usdcIn, usdc, "spent at most the request");
        assertEq(st.holdEndsAt, block.timestamp + 1 hours, "hold ends minHold later");
        assertEq(fund.totalSupply(), supply0 + st.sharesMinted, "the fund minted exactly sharesOut");
        assertEq(
            fund.balanceOf(address(queue)),
            st.sharesMinted,
            "the queue holds the shares in their hold"
        );
        _assertPerShareNotLower(idle0, held0, supply0, "deposit");

        assertEq(queue.claimCount(), 1, "one claim");
        Claim memory c = queue.getClaim(1);
        assertEq(c.owner, alice, "claim owner");
        assertEq(uint8(c.kind), uint8(RequestKind.Deposit), "deposit claim");
        assertEq(c.requestId, _hpDepositId, "claim request");
        assertEq(c.unlockAt, st.holdEndsAt, "unlock at the end of the hold");
        assertEq(c.shares, st.sharesMinted, "one fill takes every share");
        assertEq(c.usdc, st.usdcIn, "one fill pays the whole cost");
        assertLe(
            c.usdc.mulDiv(PRICE_SCALE, c.shares, Math.Rounding.Ceil),
            _hpDepositLimit,
            "RB-14: inside the limit"
        );
        assertEq(
            uint8(queue.requestStatus(_hpDepositId)), uint8(RequestStatus.Closed), "request filled"
        );
        assertEq(queue.queuedSharesOf(alice), c.shares, "E13: held shares count for alice");
        assertEq(
            fund.ledgerBalanceOf(alice), c.shares, "RB-22: the ledger sees alice's held shares"
        );

        (uint256 creditUsdc, uint256 creditShares) = queue.creditOf(alice);
        assertEq(creditUsdc, usdc - st.usdcIn, "E22: unused USDC is alice's credit");
        assertEq(creditShares, 0, "no share credit");
        _hpCredit = creditUsdc;
        _hpShares = c.shares;
        emit log_named_uint("deposit: USDC requested", usdc);
        emit log_named_uint("deposit: USDC spent (usdcIn)", st.usdcIn);
        emit log_named_uint("deposit: shares minted", st.sharesMinted);
        emit log_named_uint("deposit: alice's limit", _hpDepositLimit);
        _assertBooks("after the deposit settlement");
    }

    /// @dev §5.9.2 step 6: no delivery during the hold; after it, anyone triggers delivery and the shares go only to
    ///      the owner (E8, RB-11). Alice pulls her credit (E22).
    function _hpHoldAndDelivery() private {
        assertEq(queue.maxMint(alice), 0, "nothing deliverable in the hold");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, 1, 0));
        queue.mint(1, alice);

        Claim memory c = queue.getClaim(1);
        warpForward(c.unlockAt);
        refreshFeeds();
        assertEq(queue.maxMint(alice), _hpShares, "all deliverable after the hold");
        assertEq(queue.maxMint(bob), 0, "bob has nothing to take");

        vm.prank(bob);
        uint256 cost = queue.mint(_hpShares, alice);
        assertEq(cost, c.usdc, "delivery reports the claim's cost");
        assertEq(fund.balanceOf(alice), _hpShares, "shares delivered to the owner");
        assertEq(fund.balanceOf(bob), 0, "the caller receives nothing");
        assertEq(queue.queuedSharesOf(alice), 0, "nothing held for alice");
        assertEq(
            fund.ledgerBalanceOf(alice), _hpShares, "RB-22: same ledger balance, now in the wallet"
        );

        if (_hpCredit != 0) {
            vm.prank(alice);
            (uint256 u, uint256 s) = queue.withdrawCredit();
            assertEq(u, _hpCredit, "credit paid");
            assertEq(s, 0, "no share credit");
            assertEq(IERC20(USDC).balanceOf(alice), _hpCredit, "credit pulled by the owner");
        }
        _assertBooks("after delivery");
    }

    /// @dev §5.9.2 steps 1 to 4 for a redemption, then the claim. The fund sells the pro-rata slice (E4), the exit
    ///      fee goes to the fee recipient, alice's USDC is claimable at once and paid to her. The round trip loses at
    ///      most the swap costs and the fee, and creates nothing.
    function _hpRedeemAndClaim(uint256 deposited) private {
        uint256 shares = _hpShares;
        uint256 minLimit = _hpRedeemSettle(shares);

        Claim memory c = queue.getClaim(queue.claimCount());
        assertEq(c.owner, alice, "claim owner");
        assertEq(uint8(c.kind), uint8(RequestKind.Redeem), "redemption claim");
        assertEq(c.shares, shares, "claim shares");
        assertEq(c.unlockAt, block.timestamp, "USDC claimable at once");
        assertGe(c.usdc.mulDiv(PRICE_SCALE, shares), minLimit, "RB-14: inside the limit");
        assertEq(queue.queuedSharesOf(alice), 0, "nothing queued for alice");
        assertEq(queue.maxRedeem(alice), shares, "claimable");

        // Only the owner claims (RB-11), to the receiver it names.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotRequestOwner.selector, 0, bob));
        queue.redeem(shares, bob, alice);
        uint256 usdcBefore = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        uint256 paid = queue.redeem(shares, alice, alice);
        assertEq(paid, c.usdc, "paid the claim");
        assertEq(IERC20(USDC).balanceOf(alice), usdcBefore + paid, "alice received the USDC");
        assertEq(queue.maxRedeem(alice), 0, "claim taken");
        assertEq(fund.totalSupply(), SEED_USDC * 1e18, "only the seed is left");

        // The round trip: two pro-rata trades on 35 % basket legs, two lending legs, and a 10 bps exit fee.
        uint256 back = IERC20(USDC).balanceOf(alice);
        emit log_named_uint("round trip: USDC back to alice", back);
        assertLe(back, deposited + deposited / 1_000, "no value from nothing (interest only)");
        assertGe(back, deposited.mulDiv(BPS - 100, BPS), "round-trip cost under 1 %");
        _assertBooks("after the redemption claim");
    }

    /// @dev The redemption request from the quote, then its settlement. Returns alice's limit.
    function _hpRedeemSettle(uint256 shares) private returns (uint256 minLimit) {
        Quote memory q = queue.quoteRedeem(shares);
        assertEq(q.feeBps, EXIT_FEE_BPS, "quote: the exit fee");
        assertLt(q.cancelCutoff, q.earliestSettle, "quote: cancel cutoff before earliest settle");
        assertGt(q.legBandBps, 0, "quote: leg band");
        minLimit = 0;

        uint256 id = openRedeemRequest(alice, shares);
        assertEq(fund.balanceOf(alice), 0, "shares pulled from the caller");
        assertEq(fund.balanceOf(address(queue)), shares, "escrow in the queue");
        assertEq(queue.queuedSharesOf(alice), shares, "E13: escrowed shares count for alice");
        assertEq(
            fund.ledgerBalanceOf(alice), shares, "RB-22: ledger balance unchanged by the request"
        );
        assertEq(queue.pendingRedeemRequest(id, alice), shares, "pending");

        warpToSettleable(id);
        refreshFeeds();
        uint256 supply0 = fund.totalSupply();
        (uint256 idle0, uint256[] memory held0) = fund.heldBalances();
        uint256 feeBefore = IERC20(USDC).balanceOf(feeRecipient);
        vm.prank(keeper);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertEq(sid, 2, "second settlement");
        Settlement memory st = queue.getSettlement(sid);
        assertEq(st.sharesBurned, shares, "burned alice's shares");
        assertEq(fund.totalSupply(), supply0 - shares, "supply fell by the shares");
        assertGt(IERC20(USDC).balanceOf(feeRecipient), feeBefore, "exit fee charged");
        _assertPerShareNotLower(idle0, held0, supply0, "redemption");
        emit log_named_uint("redeem: shares burned", st.sharesBurned);
        emit log_named_uint("redeem: USDC out, net of fee", st.usdcOut);
        emit log_named_uint("redeem: alice's limit", minLimit);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  The queue's price-free exits through the fund (the seam integrate wires: E9, E13, E17, E22, RB-22)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Cancel (escrow to a share credit, still counted for the ledger until withdrawn), the in-kind exit of
    ///      escrowed shares (`redeemInKind(shares, owner, queue)`: the queue burns its own shares, the owner receives
    ///      every leg, nothing is keyed to the queue), and a freeze during the hold followed by the Safe's return in
    ///      kind (only the depositor can take it). The queue's books match its balances after each.
    function test_seam_queueExitsGoThroughTheFund() public fixtureCovered {
        investFund(bucketVec(6_500, 3_500));
        uint256 shares = deposit(alice, 100_000e6);
        (uint256 credit,) = queue.creditOf(alice);
        if (credit != 0) {
            vm.prank(alice);
            queue.withdrawCredit();
        }
        coverageCheckpoint();
        _seamCancel(shares);
        _seamFreezeAndReturn();
        coverageCheckpoint();
        _seamExitInKind(shares / 4);
    }

    function _seamCancel(uint256 shares) private {
        uint256 half = shares / 2;
        uint256 id = openRedeemRequest(alice, half, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotRequestOwner.selector, id, bob));
        queue.cancel(id);
        vm.prank(alice);
        queue.cancel(id);
        assertEq(uint8(queue.requestStatus(id)), uint8(RequestStatus.Closed), "cancelled");
        (, uint256 creditShares) = queue.creditOf(alice);
        assertEq(creditShares, half, "escrow became a share credit");
        assertEq(
            queue.queuedSharesOf(alice), half, "E13: a share credit stays counted until withdrawn"
        );
        assertEq(fund.ledgerBalanceOf(alice), shares, "RB-22: ledger balance unchanged");
        _assertBooks("after cancel");
        vm.prank(alice);
        (, uint256 got) = queue.withdrawCredit();
        assertEq(got, half, "credit withdrawn");
        assertEq(fund.balanceOf(alice), shares, "alice has every share back");
        assertEq(queue.queuedSharesOf(alice), 0, "nothing queued");
        _assertBooks("after withdrawCredit");
    }

    function _seamExitInKind(uint256 q) private {
        uint256 id = openRedeemRequest(alice, q, 0);
        uint256 supply0 = fund.totalSupply();
        uint256[3] memory before = [
            IERC20(USDC).balanceOf(alice),
            IERC20(WETH).balanceOf(alice),
            IERC20(CBBTC).balanceOf(alice)
        ];
        // Step 3f (E29): direct in-kind exit is closed while live.
        vm.prank(alice);
        vm.expectRevert(IRobotMoneyFund.InKindClosed.selector);
        fund.redeemInKind(q, alice, alice);

        // Wind-down (E29, E38, E52): shutdown -> releaseWindDown -> withdrawCredit -> redeemInKind -> restore.
        timelockExecute(address(fund), abi.encodeCall(fund.shutdown, ()));
        (, uint256 sharesReleased) = queue.releaseWindDown(alice);
        assertEq(sharesReleased, q, "E38/E52: wind-down released escrowed shares to credit");
        vm.prank(alice);
        queue.withdrawCredit();
        assertEq(queue.queuedSharesOf(alice), 0, "nothing queued after credit withdrawal");

        vm.prank(alice);
        fund.redeemInKind(q, alice, alice);
        assertEq(fund.totalSupply(), supply0 - q, "alice's shares burned in wind-down");
        assertGt(IERC20(USDC).balanceOf(alice), before[0], "USDC leg to the owner");
        assertGt(IERC20(WETH).balanceOf(alice), before[1], "wETH leg to the owner");
        assertGt(IERC20(CBBTC).balanceOf(alice), before[2], "cbBTC leg to the owner");
        assertEq(uint8(queue.requestStatus(id)), uint8(RequestStatus.Closed), "wind-down closed request");
        for (uint256 i; i < listedAssets(); ++i) {
            (uint256 units,) = fund.positionClaimOf(i, address(queue));
            assertEq(units, 0, "E23: no position claim keyed to the queue");
            assertEq(fund.deferredOf(i, address(queue)), 0, "E23: no deferral keyed to the queue");
        }
        _assertBooks("after wind-down redeemInKind");
        timelockExecute(address(fund), abi.encodeCall(fund.restore, (TVL_CAP)));
    }

    function _seamFreezeAndReturn() private {
        uint256 id = openDepositRequest(bob, 50_000e6, type(uint256).max);
        settleUntilFilled(id);
        uint256 sid = queue.settlementCount();
        uint256 claimId = queue.claimCount();
        Claim memory c = queue.getClaim(claimId);
        assertEq(c.owner, bob, "bob's claim");
        assertEq(uint8(c.kind), uint8(RequestKind.Deposit), "deposit claim");

        vm.prank(emergency);
        queue.freezeSettlement(sid);
        warpForward(c.unlockAt);
        refreshFeeds();
        assertEq(queue.maxMint(bob), 0, "frozen: nothing deliverable after the hold");

        // Step 3f (E49): Safe timelock releases frozen settlement so bob can claim his minted shares.
        timelockExecute(address(queue), abi.encodeCall(queue.releaseSettlement, (sid)));
        assertEq(queue.maxMint(bob), c.shares, "released: claim shares deliverable");
        vm.prank(bob);
        uint256 usdcDelivered = queue.mint(c.shares, bob);
        assertEq(usdcDelivered, c.usdc, "mint returns settlement USDC paid");
        assertEq(fund.balanceOf(bob), c.shares, "bob receives full settlement shares");
        _assertBooks("after releaseSettlement and delivery");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  The plan lifecycle on the timed flows (step 3c's stages 2 to 4)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_endToEnd_planLifecycle() public fixtureCovered {
        uint16[5] memory initial = bucketVec(6_500, 3_500);
        uint16[5] memory proposed = bucketVec(3_500, 6_500);

        _stage1SetTargetAndDeposits(initial);
        coverageCheckpoint();
        (uint256 planId, bytes32 receiptId) = _stage2Receipts(proposed);
        coverageCheckpoint();
        _stage3StepUntilConverged(planId, receiptId, proposed);
        coverageCheckpoint();
        _stage4Redemptions(initial);
        coverageCheckpoint();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Stage 1: setTarget, the seed invested, then deposits through the queue (§5.9.3 step 9)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _stage1SetTargetAndDeposits(uint16[5] memory initial) private {
        // RB-1: no direct caller may open a plan; only the timelock path works.
        (address[] memory ids, uint256[] memory w) = assetArrays(initial);
        vm.expectRevert();
        governance.setTarget(ids, w, PlanParams(PLAN_DURATION, COST_BUDGET_BPS));

        uint256 planId = investFund(initial);
        assertEq(planId, 1, "first plan");
        assertEq(fund.plan().receiptId, bytes32(0), "setTarget plan has no receipt");

        // The fund's own entry points name the queue (E2).
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.UseFlowQueue.selector, address(queue))
        );
        fund.deposit(1e6, alice);
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.UseFlowQueue.selector, address(queue))
        );
        fund.previewRedeem(1e30);

        // A pro-rata deposit keeps every weight (§5.9.7 "deposits no longer fill deficits").
        (uint256[] memory w0, uint256 idle0) = assetWeightsBps();
        uint256 shares = deposit(alice, 200_000e6);
        assertGt(shares, 0, "alice shares");
        (uint256[] memory w1, uint256 idle1) = assetWeightsBps();
        for (uint256 i; i < w0.length; ++i) {
            assertApproxEqAbs(w1[i], w0[i], 5, "pro-rata deposit keeps each weight");
        }
        assertApproxEqAbs(idle1, idle0, 5, "pro-rata deposit keeps the idle weight");
        deposit(bob, 50_000e6);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Stage 2: receipts (§5.1, RB-1, RB-8)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _stage2Receipts(uint16[5] memory proposed)
        private
        returns (uint256 planId, bytes32 good)
    {
        // Three receipts, oldest first: a valid older one, one whose vector sums to 9 500, the good one.
        _older = bucketVec(5_000, 5_000);
        uint16[5] memory short = bucketVec(5_000, 5_000);
        short[IDX_CBBTC] -= 500;
        (_idOld, _dOld) = recordReceipt(_older);
        (bytes32 idShort, bytes32 dShort) = recordReceipt(short);
        bytes32 dGood;
        (good, dGood) = recordReceipt(proposed);

        // RB-9: a vector that does not sum to 10 000 is refused, nothing released.
        _applyExpectRevert(
            idShort,
            dShort,
            short,
            abi.encodeWithSelector(IFundEvents.TargetSumInvalid.selector, 9_500)
        );
        assertFalse(receipts.isReleased(idShort), "refused receipt not released");

        // RB-1: the target setter is the timelock alone.
        (address[] memory ids, uint256[] memory w) = assetArrays(proposed);
        vm.expectRevert();
        governance.applyReceipt(good, dGood, ids, w);

        planId = _applyGood(good, dGood, proposed);
        _refuseStaleAndReplay(good, dGood, proposed);
        assertEq(fund.currentPlanId(), planId, "refusals opened no plan");
    }

    /// @dev Apply the good receipt. Plan 1 is concluded by now; the release happens in the same call.
    function _applyGood(bytes32 good, bytes32 dGood, uint16[5] memory proposed)
        private
        returns (uint256 planId)
    {
        (address[] memory ids, uint256[] memory w) = assetArrays(proposed);
        bytes memory data = abi.encodeCall(governance.applyReceipt, (good, dGood, ids, w));
        bytes32 salt = keccak256(abi.encode("e2e", ++_e2eSalt));
        timelock.schedule(address(governance), 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        (uint256 navOpen,, uint256[] memory valuesOpen) = fund.portfolioValues();
        timelock.execute(address(governance), 0, data, bytes32(0), salt);
        planId = fund.currentPlanId();
        assertEq(planId, 2, "second plan");
        IConsensusRecommendationReceipt.Receipt memory r = receipts.getReceiptById(good);
        assertTrue(r.released, "released by applyReceipt");
        assertEq(r.releasedAt, block.timestamp, "released in the apply call");
        assertEq(governance.lastAppliedRecordedAt(), r.recordedAt, "lastAppliedRecordedAt advanced");

        Plan memory p = fund.plan();
        assertEq(uint8(p.status), uint8(PlanStatus.Open), "plan 2 open");
        assertEq(p.receiptId, good, "plan bound to the receipt");
        assertEq(p.startTime, block.timestamp, "starts now");
        assertEq(p.endTime, block.timestamp + PLAN_DURATION, "default duration");
        // §5.1: the start is the ACTUAL weights, never the old plan's target.
        assertEq(p.navAtOpen, navOpen, "nav at open");
        uint16[] memory persistent = fund.targetBps();
        uint256 sumEnd;
        for (uint256 i; i < listedAssets(); ++i) {
            assertEq(
                p.startBps[i], PlanMath.weightBps(valuesOpen[i], navOpen), "start = actual weight"
            );
            assertEq(persistent[i], p.endBps[i], "persistent target = plan end");
            assertEq(p.endBps[i], proposed[i], "end target = the receipt's per-asset vector");
            sumEnd += p.endBps[i];
        }
        assertEq(sumEnd, BPS, "end targets sum to 100%");
        assertGt(
            p.turnoverUsdc, navOpen.mulDiv(2_500, BPS), "materially different vector: big turnover"
        );
        assertEq(
            p.costBudget, p.turnoverUsdc.mulDiv(COST_BUDGET_BPS, BPS), "budget = turnover x bps"
        );
    }

    /// @dev Stale: an older receipt is refused once a newer one applied, even with a valid vector. Replay: the
    ///      applied receipt cannot be applied twice.
    function _refuseStaleAndReplay(bytes32 good, bytes32 dGood, uint16[5] memory proposed) private {
        (bytes32 idOld, bytes32 dOld, uint16[5] memory older) = (_idOld, _dOld, _older);
        uint64 lastApplied = governance.lastAppliedRecordedAt();
        uint64 oldAt = receipts.getReceiptById(idOld).recordedAt;
        assertLt(oldAt, lastApplied, "older receipt really is older");
        _applyExpectRevert(
            idOld,
            dOld,
            older,
            abi.encodeWithSelector(
                IRebalanceGovernance.ReceiptNotNewerThanApplied.selector, idOld, oldAt, lastApplied
            )
        );
        assertFalse(receipts.isReleased(idOld), "stale receipt not released");
        _applyExpectRevert(
            good,
            dGood,
            proposed,
            abi.encodeWithSelector(IRebalanceGovernance.ReceiptAlreadyReleased.selector, good)
        );
    }

    /// @dev Schedule `applyReceipt` on the timelock, wait the delay, and expect the execution to revert with
    ///      `revertData` (the timelock bubbles the target's revert).
    function _applyExpectRevert(
        bytes32 id,
        bytes32 digest,
        uint16[5] memory bps,
        bytes memory revertData
    ) private {
        (address[] memory ids, uint256[] memory w) = assetArrays(bps);
        bytes memory data = abi.encodeCall(governance.applyReceipt, (id, digest, ids, w));
        bytes32 salt = keccak256(abi.encode("e2e", ++_e2eSalt));
        timelock.schedule(address(governance), 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        vm.expectRevert(revertData);
        timelock.execute(address(governance), 0, data, bytes32(0), salt);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Stage 3: keeper steps until Converged (§5.3, §5.5, RB-4, RB-7)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _stage3StepUntilConverged(uint256 planId, bytes32 receiptId, uint16[5] memory proposed)
        private
    {
        // A 7-day path is ~340 real steps on real venues: more than forge's default test gas. Metering is paused
        // for the loop only; nothing under test reads the meter except the Rebalancer's gas-starvation guard,
        // which then never fires.
        vm.pauseGasMetering();
        PlanStatus status = fund.planStatus();
        while (_calls < MAX_CALLS && status == PlanStatus.Open) {
            vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            _oneCheckedStep();
            // Replay only: since step 3e a step reads every feed and every basket TWAP, and this loop also previews
            // and values each step; one decode of 16 steps' state diff ran out of memory (MemoryOOG). Every 4 calls
            // checks the same accesses in smaller pieces.
            if (_calls % 4 == 0) _fixtureCheckpoint();
            status = fund.planStatus();
        }
        vm.resumeGasMetering();
        refreshFeeds();

        Plan memory p = fund.plan();
        emit log_named_uint("keeper calls", _calls);
        emit log_named_uint("steps executed", _executed);
        emit log_named_uint("plan turnover (USDC 6dp)", p.turnoverUsdc);
        emit log_named_uint("plan costSpent", p.costSpent);
        assertEq(p.id, planId, "same plan throughout");
        assertEq(p.receiptId, receiptId, "receipt plan");
        assertEq(uint8(status), uint8(PlanStatus.Converged), "plan converged");
        assertGe(block.timestamp, p.endTime, "converged only after the path end");
        assertGt(_executed, 0, "steps executed");
        assertEq(p.stepCount, _executed, "fund counted every executed step");
        assertEq(p.costSpent, _totalCost, "costSpent = sum of measured step costs");
        assertLe(p.costSpent, p.costBudget, "plan within budget");
        assertEq(_skips[SkipReason.StepFailed], 0, "no step failed in a quiet market");
        assertEq(_skips[SkipReason.MarketDeviation], 0, "no ORA-4 skip in a quiet market");
        assertEq(_skips[SkipReason.Cooldown], 0, "keeper waited every interval");

        // §5.5: every holding within toleranceBps of its end target, idle within the band.
        (uint256[] memory wNow, uint256 idleBps) = assetWeightsBps();
        for (uint256 i; i < listedAssets(); ++i) {
            assertApproxEqAbs(wNow[i], p.endBps[i], TOLERANCE_BPS + 1, "asset within tolerance");
        }
        assertLe(idleBps, TOLERANCE_BPS, "idle within tolerance");
        (uint256[4] memory sw,) = bucketWeightsBps();
        uint256[4] memory pb = bucketsOf(proposed);
        for (uint256 s = 1; s < 3; ++s) {
            assertApproxEqAbs(
                sw[s], pb[s], 3 * TOLERANCE_BPS + 3, "bucket at the receipt's audit weight"
            );
        }

        // A concluded plan does not trade.
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "converged plan does not trade");
        assertEq(uint8(why), uint8(SkipReason.PlanNotOpen), "PlanNotOpen after convergence");
    }

    /// @dev One keeper `step()` with the per-step assertions: previewStep agrees with step, NAV moves by the
    ///      measured cost only, cost <= cap (RB-4), costSpent <= budget, legs stay on their side of
    ///      `pathTarget(now)` (RB-7). A skip changes nothing.
    function _oneCheckedStep() private {
        refreshFeeds();
        // Step 3e (proposal §5.10): a step checks, prices and books at the feeds. This is a quiet market: replay has
        // no arbitrage, so the outside market follows the pools the fund's own steps move, and the feeds move to the
        // pools before each step (the same model stage 4 uses).
        alignFeedsToPools();
        Plan memory p = fund.plan();
        (SkipReason predicted, uint256 sell, uint256 buy, uint256 notional) =
            rebalancer.previewStep();
        Snap memory b = _snap();
        b.feedLegs = _legsAtFeedsNow(sell, buy);

        vm.recordLogs();
        (bool did, SkipReason why) = keeperStep();
        ++_calls;
        Snap memory a = _snap();

        if (!did) {
            ++_skips[why];
            if (why != SkipReason.StepFailed) {
                assertEq(uint8(why), uint8(predicted), "previewStep predicts the skip");
            }
            assertEq(a.nav, b.nav, "skip: NAV unchanged");
            assertEq(a.costSpent, b.costSpent, "skip: no cost");
            assertEq(a.stepCount, b.stepCount, "skip: no step counted");
            return;
        }
        ++_executed;
        assertEq(uint8(predicted), uint8(SkipReason.None), "previewStep predicts the trade");
        assertGe(notional, MIN_STEP_USDC, "step at or above the dust floor");

        a.feedLegs = _legsAtFeedsNow(sell, buy);
        uint256 maxCost = _assertStepCost(b, a, notional);

        // NAV/share: supply is unchanged, so it moves only by the bounded step cost.
        assertGe(
            a.pps + 1,
            b.pps.mulDiv(b.nav - maxCost, b.nav),
            "NAV/share loss bounded by the cost cap"
        );
        assertLe(a.pps, b.pps.mulDiv(b.nav + maxCost, b.nav) + 1, "NAV/share gain bounded");

        // RB-7: at the step's own valuation (navBefore, now), the sell leg is still at or over its path target
        // and the buy leg at or under it. 2 wei absorbs the TWAP round trip of a basket leg.
        uint256 sellPath = PlanMath.pathTargetValue(p, sell, block.timestamp, b.nav);
        uint256 buyPath = PlanMath.pathTargetValue(p, buy, block.timestamp, b.nav);
        assertGe(_valueOf(a, sell) + 2, sellPath, "RB-7: sell leg not pushed under its path");
        assertLe(_valueOf(a, buy), buyPath + 2, "RB-7: buy leg not pushed over its path");
        assertLe(
            _valueOf(b, sell) - _valueOf(a, sell),
            notional + 2,
            "sell leg moved at most the notional"
        );
    }

    /// @dev RB-4 (step 3e, proposal §5.10): NAV falls by at most maxStepCostBps of notional at the TWAP and at the
    ///      feeds, and the plan books exactly the cost at the feeds: the fall of idle plus the two legs at the feed
    ///      prices (every other asset is unchanged, RB-19), recomputed here from the held amounts (`feedLegs`).
    ///      Returns the cap.
    function _assertStepCost(Snap memory b, Snap memory a, uint256 notional)
        private
        returns (uint256 maxCost)
    {
        maxCost = notional.mulDiv(MAX_STEP_COST_BPS, BPS);
        uint256 cost = b.nav > a.nav ? b.nav - a.nav : 0;
        uint256 feedCost = b.feedLegs > a.feedLegs ? b.feedLegs - a.feedLegs : 0;
        (uint256 bookedFeedCost, uint256 bookedTwapCost) = _lastCostBooked();
        assertEq(bookedTwapCost, cost, "the fund's TWAP cost = the measured TWAP NAV fall");
        assertEq(
            bookedFeedCost, feedCost, "the booked cost = the fall at the feeds (idle + both legs)"
        );
        assertLe(cost, maxCost, "RB-4: step cost at the TWAP <= cap");
        assertLe(feedCost, maxCost, "RB-4: step cost at the feeds <= cap");
        assertLe(a.nav, b.nav + maxCost, "NAV does not jump on a step");
        assertEq(a.costSpent, b.costSpent + feedCost, "costSpent += the cost at the feeds");
        assertEq(a.stepCount, b.stepCount + 1, "stepCount += 1");
        assertLe(a.costSpent, fund.plan().costBudget, "plan costSpent <= budget");
        _totalCost += feedCost;
    }

    function _snap() private view returns (Snap memory s) {
        (s.nav, s.idle, s.values) = fund.portfolioValues();
        s.pps = fund.convertToAssets(PPS_UNIT);
        Plan memory p = fund.plan();
        s.costSpent = p.costSpent;
        s.stepCount = p.stepCount;
    }

    function _valueOf(Snap memory s, uint256 index) private pure returns (uint256) {
        return index == IDLE_INDEX ? s.idle : s.values[index];
    }

    /// @dev Idle USDC plus the legs `sell` and `buy` (IDLE_INDEX adds nothing) at the feed prices now, computed here
    ///      the way proposal §5.10 defines the step's cost basis: a lending asset counts one to one; a basket asset at
    ///      its Chainlink feed in USDC per whole token (`feed × 1e6 / USDC feed`, rounded down), times its held amount.
    function _legsAtFeedsNow(uint256 sell, uint256 buy) private view returns (uint256 v) {
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        v = idle;
        if (sell != IDLE_INDEX) v += _atFeed(sell, held[sell]);
        if (buy != IDLE_INDEX) v += _atFeed(buy, held[buy]);
    }

    function _atFeed(uint256 i, uint256 amount) private view returns (uint256) {
        AssetConfig memory c = fund.assetConfig(i);
        if (c.kind != AssetKind.Basket) return amount;
        (, int256 a,,,) = MockAggregator(c.feed).latestRoundData();
        (, int256 u,,,) = MockAggregator(FEED_USDC).latestRoundData();
        uint256 px = uint256(a).mulDiv(1e6, uint256(u));
        return amount.mulDiv(px, 10 ** IERC20Metadata(c.token).decimals());
    }

    /// @dev The `feedCost` and `twapCost` of the last `StepCostBooked` the fund emitted in the recorded logs.
    function _lastCostBooked() private returns (uint256 feedCost, uint256 twapCost) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (
                l.emitter != address(fund) || l.topics[0] != IRobotMoneyFund.StepCostBooked.selector
            ) continue;
            (,, feedCost, twapCost) = abi.decode(l.data, (uint256, uint256, uint256, uint256));
            found = true;
            break;
        }
        assertTrue(found, "StepCostBooked emitted");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Stage 4: redemptions through the queue and in kind (§5.9.4, RB-6)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _stage4Redemptions(uint16[5] memory initial) private {
        // §4.4, §5.9.6: withdraw is not offered on either contract; the fund's own redeem names the queue.
        vm.prank(alice);
        vm.expectRevert(IRobotMoneyFund.RedeemOnly.selector);
        fund.withdraw(1e6, alice, alice);
        vm.expectRevert(IRobotMoneyFund.RedeemOnly.selector);
        fund.previewWithdraw(1e6);
        assertEq(fund.maxWithdraw(alice), 0, "maxWithdraw 0");
        vm.expectRevert(IFlowEvents.RedeemOnly.selector);
        queue.withdraw(1e6, alice, alice);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.UseFlowQueue.selector, address(queue))
        );
        fund.redeem(1e6, alice, alice);

        // Seven days of the plan buying wETH moved its pool about 80 bps from the pin's price, which the mock feed
        // still holds, so check 4 (TWAP within refBandBps = 50 of the feed) blocks every settlement: the check
        // working. A real market arbitrages the pool back to the independent price; the test models the market
        // having caught up by moving the feeds to the pools.
        uint256 feedEth = uint256(feedPrice8[FEED_ETH]);
        uint256 poolEth = poolPrice8(WETH_POOL, WETH);
        uint256 diff = poolEth > feedEth ? poolEth - feedEth : feedEth - poolEth;
        emit log_named_uint("wETH pool vs pin feed after the plan, bps", diff * BPS / feedEth);
        alignFeedsToPools();

        // After convergence: direct redeemInKind is closed while live (E29); alice redeems a quarter through the queue.
        uint256 bobQuarter = fund.balanceOf(bob) / 4;
        vm.prank(bob);
        vm.expectRevert(IRobotMoneyFund.InKindClosed.selector);
        fund.redeemInKind(bobQuarter, carol, bob);
        _checkedRedeem(alice, fund.balanceOf(alice) / 4);

        // A new plan back toward the initial vector, paused at once by the emergency key.
        uint256 planId = setTargetViaTimelock(initial, PlanParams(PLAN_DURATION, COST_BUDGET_BPS));
        vm.prank(emergency);
        fund.pauseRebalance();
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Paused), "paused");
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        (bool did, SkipReason why) = keeperStep();
        assertFalse(did, "paused plan does not trade");
        assertEq(uint8(why), uint8(SkipReason.PlanNotOpen), "paused: PlanNotOpen");

        // RB-6: queue exits work while Paused, and leave the plan as it was.
        _checkedRedeem(alice, fund.balanceOf(alice) / 2);
        assertEq(fund.currentPlanId(), planId, "same plan");
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Paused), "still paused after queue exit");

        // Alice exits the rest through the queue while still Paused.
        _checkedRedeem(alice, fund.balanceOf(alice));
        assertEq(fund.balanceOf(alice), 0, "alice fully out through the queue");
        _assertBooks("after alice queue exits");

        // Step 3f (E29): shutdown opens wind-down redeemInKind while preserving Paused plan state.
        timelockExecute(address(fund), abi.encodeCall(fund.shutdown, ()));
        _checkedRedeemInKind(bob, carol, bobQuarter);
        _checkedRedeemInKind(bob, bob, fund.balanceOf(bob));
        assertEq(fund.balanceOf(bob), 0, "bob fully out in kind");
        assertEq(fund.currentPlanId(), planId, "same plan after wind-down exit");
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Paused), "still paused after wind-down exit");
        assertEq(fund.totalSupply(), SEED_USDC * 1e18, "everyone out but the seed");
        _assertBooks("after every exit");
    }

    /// @dev A redemption through the queue pays at least the quote's worst amount, at most the fee-net TWAP value
    ///      of the shares at the request (plus interest over the wait), burns exactly `shares`, charges the exit fee,
    ///      and never lowers the remaining holders' NAV per share.
    function _checkedRedeem(address who, uint256 shares) private {
        refreshFeeds();
        uint256 gross = fund.convertToAssets(shares);
        uint256 feeBefore = IERC20(USDC).balanceOf(feeRecipient);
        uint256 balBefore = fund.balanceOf(who);

        uint256 net = redeem(who, shares);

        uint256 supply = fund.totalSupply();
        assertEq(fund.balanceOf(who), balBefore - shares, "shares burned");
        assertGe(
            net,
            gross.mulDiv(BPS - EXIT_FEE_BPS, BPS).mulDiv(BPS - MAX_SLIPPAGE_BPS, BPS),
            "redeem >= fee-net worst slippage floor"
        );
        assertLe(
            net,
            gross.mulDiv(BPS - EXIT_FEE_BPS, BPS) + gross / 1_000,
            "redeem <= fee-net value (+ interest)"
        );
        assertGt(IERC20(USDC).balanceOf(feeRecipient), feeBefore, "exit fee charged");
        if (supply > SEED_USDC * 1e18) {
            assertGt(fund.convertToAssets(PPS_UNIT), 0, "stayers keep a NAV");
        }
    }

    /// @dev `redeemInKind` pays the pro-rata USDC (idle plus lending) and each basket token, net of the exit fee,
    ///      with no swap: the TWAP value received is the fee-net share of NAV (to rounding), and stayers keep
    ///      their NAV per share. Lending above the period's in-kind allowance becomes a position claim (E9, E20);
    ///      its value counts too.
    function _checkedRedeemInKind(address owner, address receiver, uint256 shares) private {
        refreshFeeds();
        uint256 gross = fund.convertToAssets(shares);
        uint256 supply = fund.totalSupply();
        uint256 pps = supply > shares ? fund.convertToAssets(PPS_UNIT) : 0;
        uint256[2] memory tokBefore =
            [IERC20(WETH).balanceOf(receiver), IERC20(CBBTC).balanceOf(receiver)];
        uint256 usdcBefore = IERC20(USDC).balanceOf(receiver);
        uint256 claimsBefore = _claimValue(receiver);

        vm.prank(owner);
        fund.redeemInKind(shares, receiver, owner);

        uint256 got =
            IERC20(USDC).balanceOf(receiver) - usdcBefore + (_claimValue(receiver) - claimsBefore);
        assertGt(got, 0, "in kind: USDC leg paid or claimed");
        uint256[2] memory idx = [IDX_WETH, IDX_CBBTC];
        uint256[2] memory tokAfter =
            [IERC20(WETH).balanceOf(receiver), IERC20(CBBTC).balanceOf(receiver)];
        // Each leg's fee is floored in token units, so the receiver can get up to one base unit of each token above
        // the exact fee-net amount. The unit goes from the fee recipient to the receiver.
        uint256 unitDust;
        for (uint256 k; k < 2; ++k) {
            uint256 dTok = tokAfter[k] - tokBefore[k];
            assertGt(dTok, 0, "in kind: basket token paid");
            got += fund.assetUsdcValue(idx[k], dTok);
            unitDust += fund.assetUsdcValue(idx[k], 1) + 1;
        }
        uint256 expected = gross.mulDiv(BPS - EXIT_FEE_BPS, BPS);
        assertLe(got, expected + unitDust + 10, "in kind <= fee-net share of NAV");
        assertGe(got + expected.mulDiv(1, BPS) + 10, expected, "in kind ~= fee-net share of NAV");
        if (pps != 0) {
            assertGe(fund.convertToAssets(PPS_UNIT) + 1, pps, "stayers' NAV/share not lowered");
        }
    }

    /// @dev USDC value today of every lending position claim `who` holds (E9).
    function _claimValue(address who) private view returns (uint256 v) {
        for (uint256 i; i < listedAssets(); ++i) {
            if (isBasketIndex(i)) continue;
            (, uint256 usdc) = fund.positionClaimOf(i, who);
            v += usdc;
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Shared checks
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Check 10 restated from outside: every held amount per share is at least what it was.
    function _assertPerShareNotLower(
        uint256 idle0,
        uint256[] memory held0,
        uint256 supply0,
        string memory label
    ) private view {
        (uint256 idle1, uint256[] memory held1) = fund.heldBalances();
        uint256 supply1 = fund.totalSupply();
        assertGe(idle1 * supply0, idle0 * supply1, string.concat(label, ": idle per share"));
        for (uint256 i; i < held0.length; ++i) {
            assertGe(
                held1[i] * supply0, held0[i] * supply1, string.concat(label, ": asset per share")
            );
        }
    }

    /// @dev The queue's books (eng plan §4.3): with no gift, its USDC and share balances equal the sums.
    function _assertBooks(string memory label) private view {
        FlowBooks memory b = queue.books();
        assertEq(
            IERC20(USDC).balanceOf(address(queue)),
            b.pendingUsdc + b.owedUsdc + b.creditUsdc + b.dustUsdc,
            string.concat(label, ": queue USDC = books")
        );
        assertEq(
            fund.balanceOf(address(queue)),
            b.escrowShares + b.heldShares + b.creditShares + b.dustShares,
            string.concat(label, ": queue shares = books")
        );
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Step 3f: Queue-originated delisting & lending claims, permissionless settleClaim, E54 skip
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _settleAndClaimAllRedeemProceeds(uint256 idA, uint256 idB, address uA, address uB)
        private
        returns (uint256 cashA, uint256 cashB)
    {
        settleUntilFilled(idA);
        if (!queue.getRequest(idB).closed) settleUntilFilled(idB);
        cashA = _claimQueuedUsdc(uA);
        cashB = _claimQueuedUsdc(uB);
    }

    function _claimQueuedUsdc(address user) private returns (uint256 got) {
        uint256 maxR = queue.maxRedeem(user);
        if (maxR == 0) return 0;
        uint256 before = IERC20(USDC).balanceOf(user);
        vm.prank(user);
        queue.redeem(maxR, user, user);
        got = IERC20(USDC).balanceOf(user) - before;
    }

    function _assertSettledMultiUserClaims(
        uint256 index,
        uint256 aRedeem,
        uint256 bRedeem,
        bool checkEmptyAfter
    ) private returns (uint256 netA, uint256 netB) {
        uint256 aBefore = IERC20(USDC).balanceOf(alice);
        uint256 bBefore = IERC20(USDC).balanceOf(bob);
        vm.prank(carol);
        netA = fund.settleClaim(index, alice);
        vm.prank(carol);
        netB = fund.settleClaim(index, bob);
        assertGt(netA, 0, "alice claim settled in USDC");
        assertGt(netB, 0, "bob claim settled in USDC");
        assertEq(IERC20(USDC).balanceOf(alice) - aBefore, netA, "alice balance delta = netA");
        assertEq(IERC20(USDC).balanceOf(bob) - bBefore, netB, "bob balance delta = netB");
        assertApproxEqRel(
            netA * bRedeem, netB * aRedeem, 0.01e18, "pro-rata claim payout across users"
        );
        if (checkEmptyAfter) {
            vm.expectRevert(
                abi.encodeWithSelector(IRobotMoneyFund.NoClaimToSettle.selector, index, alice)
            );
            fund.settleClaim(index, alice);
            vm.expectRevert(
                abi.encodeWithSelector(IRobotMoneyFund.NoClaimToSettle.selector, index, bob)
            );
            fund.settleClaim(index, bob);
        }
    }

    /// @notice Step 3f (E53, D19/D30): multi-user queue redemptions through `FlowQueue.settle()` ->
    ///         `sellForFlowBatch` split delist claims pro-rata, keep deposits blocked while inSale, liquidate
    ///         via `rebalancer.stepDelisted()`, and let anyone call `settleClaim` per owner.
    function test_step3f_queueOriginatedDelistClaimsMultiUser() public fixtureCovered {
        _hpSeedAndInvest();
        uint256 aShares = deposit(alice, 40_000e6);
        uint256 bShares = deposit(bob, 20_000e6);
        coverageCheckpoint();

        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.delistAsset, (IDX_WETH)));
        assertTrue(fund.isAssetInSale(IDX_WETH), "E53: WETH in sale");
        assertTrue(fund.hasAssetInSale(), "E53: fund reports asset in sale");
        assertTrue(queue.liveness().depositsStoppedNow, "E53: queue stops deposits during delisting");

        uint256 aRedeem = aShares / 2;
        uint256 bRedeem = bShares / 2;
        {
            (, uint256[] memory heldBefore) = fund.heldBalances();
            uint256 idA = openRedeemRequest(alice, aRedeem);
            uint256 idB = openRedeemRequest(bob, bRedeem);
            uint256 idC = openDepositRequest(carol, 5_000e6);

            (uint256 cashA, uint256 cashB) = _settleAndClaimAllRedeemProceeds(idA, idB, alice, bob);
            assertGt(cashA, 0, "alice received non-WETH proceeds via queue");
            assertGt(cashB, 0, "bob received non-WETH proceeds via queue");
            assertEq(fund.balanceOf(carol), 0, "E53: queued deposit not minted while inSale");
            assertFalse(queue.getRequest(idC).closed, "E53: queued deposit stays pending during delist");

            (, uint256[] memory heldAfter) = fund.heldBalances();
            assertLt(
                heldAfter[IDX_WETH],
                IERC20(WETH).balanceOf(address(fund)),
                "E53: queue batch reserved claimed WETH"
            );
            assertLe(heldAfter[IDX_WETH], heldBefore[IDX_WETH], "held WETH not drained");
        }

        {
            uint256 interval = rebalancer.effectiveStepInterval();
            for (uint256 k; k < 16 && fund.isAssetInSale(IDX_WETH); ++k) {
                vm.warp(block.timestamp + interval + 2);
                refreshFeeds();
                vm.prank(keeper);
                rebalancer.stepDelisted(IDX_WETH);
            }
            assertFalse(fund.isAssetInSale(IDX_WETH), "E53: rebalancer completed delist sale");
            assertFalse(fund.assetConfig(IDX_WETH).active, "E53: delisted asset deactivated");
        }

        uint256 feeBefore = IERC20(USDC).balanceOf(feeRecipient);
        _assertSettledMultiUserClaims(IDX_WETH, aRedeem, bRedeem, true);
        assertGt(IERC20(USDC).balanceOf(feeRecipient) - feeBefore, 0, "E53: linked exit fee paid");
        _assertBooks("step3f queue delist claims");
    }

    /// @notice Step 3f (E37, E54, RB-37): multi-user queue redemptions under Aave shortfall record pro-rata
    ///         lending claims (`positionClaimOf`) without blocking healthy proceeds, block `Rebalancer` and
    ///         `executeStep` from selling Aave (`E54`), and unblock immediately after permissionless `settleClaim`.
    function test_step3f_queueOriginatedLendingClaimsRebalancerSkipAndSettleClaim()
        public
        fixtureCovered
    {
        _hpSeedAndInvest();
        uint256 aShares = deposit(alice, 30_000e6);
        uint256 bShares = deposit(bob, 15_000e6);
        coverageCheckpoint();

        vm.mockCall(
            address(aaveAdapter),
            abi.encodeWithSignature("availableLiquidity()"),
            abi.encode(uint256(0))
        );
        vm.mockCallRevert(
            address(aaveAdapter), abi.encodeWithSignature("withdraw(uint256)"), "paused"
        );

        uint256 aRedeem = aShares / 2;
        uint256 bRedeem;
        {
            uint256 snap = vm.snapshotState();
            uint256 probeId = openRedeemRequest(alice, aRedeem);
            warpToSettleable(probeId);
            uint256 p0 = aaveAdapter.totalAssets();
            uint256 sup0 = fund.totalSupply();
            (uint256 u0,) = fund.positionUnits(0);
            vm.revertToState(snap);

            // Pick a target `exactAfter` whose `targetBurned = u0 * shares / sup0` satisfies
            // `holdersPart(p0) * sup0 >= p0 * exactAfter` (`FundPositionLib._takeForFlow` omits LENDING_ROUNDING_UNITS).
            uint256 k0 = (sup0 - aRedeem - (bShares / 2)).mulDiv(p0, sup0, Math.Rounding.Ceil);
            uint256 exactAfter = k0.mulDiv(sup0, p0, Math.Rounding.Floor);
            for (uint256 j; j < 64; ++j) {
                uint256 cand = (k0 + j).mulDiv(sup0, p0, Math.Rounding.Floor);
                if (cand >= sup0 - aRedeem) continue;
                uint256 burned = u0.mulDiv(sup0 - cand, sup0);
                if (p0.mulDiv(u0 - burned, u0) * sup0 >= p0 * cand) {
                    exactAfter = cand;
                    break;
                }
            }
            bRedeem = (sup0 - exactAfter) - aRedeem;
        }
        {
            uint256 idA = openRedeemRequest(alice, aRedeem);
            uint256 idB = openRedeemRequest(bob, bRedeem);
            (uint256 cashA, uint256 cashB) = _settleAndClaimAllRedeemProceeds(idA, idB, alice, bob);
            assertGt(cashA, 0, "alice received healthy-venue proceeds");
            assertGt(cashB, 0, "bob received healthy-venue proceeds");
        }

        uint256 totalClaims = fund.positionClaimTotal(IDX_AAVE);
        {
            (uint256 unitsA, uint256 valA) = fund.positionClaimOf(IDX_AAVE, alice);
            (uint256 unitsB, uint256 valB) = fund.positionClaimOf(IDX_AAVE, bob);
            assertGt(unitsA, 0, "E37: alice Aave claim units via queue");
            assertGt(unitsB, 0, "E37: bob Aave claim units via queue");
            assertGt(valA, 0, "alice claim valuation");
            assertGt(valB, 0, "bob claim valuation");
            assertGt(totalClaims, unitsA + unitsB, "E37: total claims include linked exit fee");
            assertApproxEqRel(
                unitsA + unitsB,
                totalClaims.mulDiv(9_990, 10_000),
                0.001e18,
                "E37: net user claims plus 10 bps linked exit fee = positionClaimTotal"
            );
            assertApproxEqRel(
                unitsA * bRedeem,
                unitsB * aRedeem,
                0.01e18,
                "E37: pro-rata lending claims across queue batch"
            );
        }

        vm.clearMockedCalls();

        setTargetViaTimelock(assetVec(0, 4_000, 3_000, 3_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        vm.warp(block.timestamp + Math.max(1 days, rebalancer.effectiveStepInterval()) + 2);
        refreshFeeds();

        {
            (SkipReason rBefore, uint256 sellBefore,,) = rebalancer.previewStep();
            if (rBefore == SkipReason.None) {
                assertTrue(sellBefore != IDX_AAVE, "E54: rebalancer skips Aave while claims exist");
            }
            vm.prank(address(rebalancer));
            vm.expectRevert(
                abi.encodeWithSelector(IRobotMoneyFund.LendingHasClaims.selector, IDX_AAVE, totalClaims)
            );
            fund.executeStep(StepOrder(IDX_AAVE, IDX_MOONWELL, 1_000e6, 0, 0, 10e6));
        }

        _assertSettledMultiUserClaims(IDX_AAVE, aRedeem, bRedeem, false);
        assertEq(fund.positionClaimTotal(IDX_AAVE), 0, "E54: Aave claim total cleared");

        (SkipReason rAfter, uint256 sellAfter,, uint256 notAfter) = rebalancer.previewStep();
        assertEq(uint8(rAfter), uint8(SkipReason.None), "rebalancer unblocked once claims cleared");
        assertEq(sellAfter, IDX_AAVE, "E54: rebalancer now selects Aave");
        assertGt(notAfter, 0, "positive rebalance notional");
        vm.prank(keeper);
        (bool stepped,) = rebalancer.step();
        assertTrue(stepped, "E54: rebalancer executes Aave sell step");
        _assertBooks("step3f queue lending claims");
    }
}
