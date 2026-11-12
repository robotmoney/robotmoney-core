// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.4 (redemptions), §5.3 (step), §5.5 (plan lifecycle),
//            §4.1 (per-asset target vector), §5.9 (timed flows: §5.9.2 epoch, §5.9.3 settlement, §5.9.4 exits and
//            emergency powers), §7 (RB-1 to RB-18, RB-20 to RB-22); docs/technical/one-vault-timed-flows-eng-plan.md
//            §4.3 ("Invariants.t.sol: add handler actions for request, cancel, settle, claim, expiry, freeze and exit
//            in kind. Add RB-10 to RB-18 and RB-20 to RB-22. Add a conservation check"), §6 (three accounting
//            systems); scaffold plan §7.6 (`attack-tests`). Development plan Step 2.5 (gate G3), phase 3b.
// Experiment prototype only (contracts/test/prototype/). Not a production test.
// Step 3d: `attack-tests` moved the flows to the FlowQueue (the fund's own deposit and redeem are closed, E2) and
// added the step 3d invariants. The step 3c version lives on in baseline/Invariants.t.sol.
pragma solidity ^0.8.24;

import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PrototypeHarness} from "./PrototypeHarness.sol";
import {
    AssetConfig,
    AssetKind,
    Plan,
    PlanParams,
    PlanStatus,
    SkipReason,
    IFundEvents,
    IDLE_INDEX,
    BPS,
    PRICE_SCALE
} from "./src/FundTypes.sol";
import {
    Claim,
    FlowBooks,
    FlowParams,
    IFlowEvents,
    Quote,
    Request,
    RequestKind,
    RequestStatus,
    Settlement,
    SettleCheck,
    Fill,
    SettleContext
} from "./src/FlowTypes.sol";
import {IRebalanceGovernance} from "./src/interfaces/IRebalanceGovernance.sol";
import {IRobotMoneyFund} from "./src/interfaces/IRobotMoneyFund.sol";
import {ILendingRateAdapter} from "./src/interfaces/IFlowAdapters.sol";
import {FundValuationLib} from "./src/lib/FundValuationLib.sol";
import {IStrategyAdapter} from "../../interfaces/IStrategyAdapter.sol";

/// @title Invariants
/// @notice One stateful invariant suite for the one-vault prototype (plan Step 2.5; step 3d eng plan §4.3). The test
///         contract is its own handler, so every action runs through the same harness the other prototype tests use
///         (the timelock path, the keeper, the queue, real Base venues, mock feeds at the real feed addresses).
///
///         Actions. Flows (step 3d): a deposit request (any price, a limit from the quote, or a limit below every
///         bound), a redemption request, `settle` by the keeper or a stranger with bounded inputs, delivery of
///         unlocked shares by anyone, the owner's redemption claim, cancel, the in-kind exit of a pending
///         redemption, withdrawal of expired escrow and of credits, a freeze, ADMIN's release or return, a
///         depositor's `takeReturn`, pause and unpause, and an in-kind exit of wallet shares. Rebalancing (step 3c):
///         apply a random valid receipt through the timelock, a keeper step, an unauthorized plan-open (and flow)
///         attempt. Market: time passes (feeds re-stamped), an outside trader moves a basket pool, the outside market
///         catches up with the pools. Each action records what it saw in ghost variables.
///
///         The `invariant_*` functions assert:
///         - RB-1: no caller but the timelock opens a plan; nobody but the queue mints or sells through the fund, and
///           the queue's emergency and admin powers refuse every other caller.
///         - RB-2 to RB-9 and INV-1: as in step 3c (step bounds, path, receipts, target vectors, custody leaks).
///         - RB-10: no USDC or share leaves the queue except to the fund inside a settlement (the purchase), burned
///           (a sale, an in-kind exit), or to the owner in a claim, a delivery, a credit or an expiry withdrawal.
///         - RB-11: every delivered deposit share left after its claim's `unlockAt`, from an unfrozen settlement, to
///           the request's owner only.
///         - RB-12: a cancel returns exactly the unfilled escrow as credit; an expiry withdrawal pays exactly it; a
///           settle that recorded nothing moved no balance.
///         - RB-13: no settlement, in-kind exit or return lowered the fund's held amount per share of idle USDC or
///           any asset.
///         - RB-14: every fill is inside its request's limit.
///         - RB-15: cancel and in-kind exit never revert for a pending request of the caller, also while paused.
///         - RB-16: nothing settled when `checkSettle` named a failed check for that caller in that block; no
///           period's fills exceed its cap; NAV stays under the TVL cap.
///         - RB-17: every active basket asset has a feed and a maximum age; every lending adapter answers its rate.
///         - RB-18: a freeze ends by itself `maxFreeze` after its call, and within the hold plus `maxFreeze`; only the
///           claim's owner takes a return.
///         - RB-20: a settle's bound prices do not depend on its inputs or its caller (a counterfactual keeper call
///           with no limits, from the same state, uses the same bound prices).
///         - RB-21: the holders' part of each lending position and every position claim add up to the venue's
///           holding, and the claim units add up to the fund's count.
///         - RB-22: every actor's ledger balance is its wallet plus its queued shares, the queued shares equal an
///           independent sum of its escrow, held deposit shares and share credit, and the queue counts for nothing.
///         - Conservation (eng plan §4.3, §6): the queue's books equal independent sums over requests, claims and
///           credits; its USDC and share balances equal the flows booked into and out of it since setUp; the fund's
///           supply equals setUp's plus minted, less burned, by settlements and in-kind exits.
///
///         Fixture coverage: `BaseFixture.fixtureCovered` reads the state-diff recording once, but an invariant
///         campaign interleaves many handler calls with many invariant checks. So in replay this suite also checks
///         coverage per action (`_coverage`), with the same rule as `BaseFixture._assertFixtureCovered`.
///         The fuzz seed is fixed so the record run and every replay make the same call sequences, and so
///         touch the same pool ticks and slots. A random seed would wander onto state the fixture never read.
///
///         Hardened by `hardening` (step 3 plan §3.3 item 4, 2026-11-12): 64 runs of depth 64 (was 16 × 32).
///         Every handler counts each revert it catches under its own name (`revertsCaught`), expected or not, and
///         the run summary prints them. A revert of a call that must succeed (a request while not paused, a
///         settle `checkSettle` passed, a settle that reverted with another check than the one `checkSettle` named,
///         a quote that reverted with other than `SettleBlocked`, a claim the queue reported claimable, a cancel or
///         exit of a pending request, a freeze, release or return, an expiry or credit withdrawal, a wallet in-kind
///         exit, a valid receipt, a keeper step, an outside trade) also counts in `mustSucceedReverts`, and
///         `invariant_mustNotRevert` fails the run on the first one. A handler with no try / catch reverting fails
///         the run through `fail-on-revert`. Shrinking is off (`shrink-run-limit = 0`): it does not change what
///         passes or fails, and a failing sequence of 64 calls on this harness would take hours to shrink.
/// forge-config: default.fuzz.seed = "0x6f6e652d7661756c74"
/// forge-config: default.invariant.dictionary-weight = 0
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: default.invariant.shrink-run-limit = 0
contract Invariants is PrototypeHarness {
    using Math for uint256;

    bytes32 private constant TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");
    bytes32 private constant APPROVAL_SIG = keccak256("Approval(address,address,uint256)");
    bytes32 private constant STEP_EXECUTED_SIG = keccak256(
        "StepExecuted(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
    );
    bytes32 private constant DEPOSIT_FILLED_SIG = keccak256("DepositFilled(uint256,uint256,uint256,uint256,uint256,uint64)");
    bytes32 private constant REDEEM_FILLED_SIG = keccak256("RedeemFilled(uint256,uint256,uint256,uint256,uint256)");
    bytes32 private constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// @dev The in-kind allowance setUp gives the fund (ADMIN through the timelock), small so in-kind exits reach
    ///      position claims and RB-21 has something to hold.
    uint128 private constant IN_KIND_FLOOR_USDC = 1_000e6;

    address[3] internal holders;
    address internal stranger = makeAddr("stranger");
    address internal receiptImpl;

    // ─── What kind of action is in flight (RB-10's rule for transfers out of the queue) ──────────────────

    uint8 private constant ACT_OTHER = 0;
    uint8 private constant ACT_SETTLE = 1;
    uint8 private constant ACT_PAY = 2;
    uint8 private constant ACT_EXIT = 3;

    // ─── Ghosts (reset with the post-setUp snapshot at the start of every run) ───────────────────────────

    uint256 public ghostInKindReverts;
    uint256 public ghostRequestRedeemReverts;
    uint256 public ghostClaimReverts;
    uint256 public ghostApplyFailures;
    uint256 public ghostStepReverts;
    uint256 public ghostRb1Violations;
    uint256 public ghostRb4StepCost;
    uint256 public ghostRb4HaltedStepped;
    uint256 public ghostRb4BudgetNotHalted;
    uint256 public ghostRb5Cooldown;
    uint256 public ghostRb5Market;
    uint256 public ghostRb7PastPath;
    uint256 public ghostRb8Calls;
    uint256 public ghostRb9Violations;
    uint256 public ghostInv1Leaks;
    /// @dev A keeper `step()` skipped NothingToTrade / BelowMinStep although, computed here independently,
    ///      some eligible holding sat over its path and another under it by at least `minStepUsdc`.
    uint256 public ghostLivenessSkips;
    address public ghostLeakFrom;
    address public ghostLeakTo;

    uint256 public ghostRb10;
    uint256 public ghostRb11;
    uint256 public ghostRb12;
    uint256 public ghostRb13;
    uint256 public ghostRb14;
    uint256 public ghostRb15;
    uint256 public ghostRb16;
    uint256 public ghostRb18;
    uint256 public ghostRb20;
    string public ghostLastViolation;

    // ─── Reverts each handler caught (`hardening`, step 3 plan §3.3 item 4) ───────────────────────────────
    // Every try / catch in a handler counts what it caught under its handler, expected or not, so a run that
    // silently did nothing shows. A revert of a call that must succeed also counts in `mustSucceedReverts`, and
    // `invariant_mustNotRevert` fails the run on the first one. Handlers with no try / catch (pause, warp, market
    // catch-up) need no count: under `fail-on-revert` any revert of theirs fails the run by itself.

    uint256 private constant H_REQUEST_DEPOSIT = 0;
    uint256 private constant H_REQUEST_REDEEM = 1;
    uint256 private constant H_QUOTE = 2;
    uint256 private constant H_SETTLE = 3;
    uint256 private constant H_SETTLE_COUNTERFACTUAL = 4;
    uint256 private constant H_DELIVER = 5;
    uint256 private constant H_CLAIM = 6;
    uint256 private constant H_CANCEL = 7;
    uint256 private constant H_EXIT_IN_KIND = 8;
    uint256 private constant H_WITHDRAW_EXPIRED = 9;
    uint256 private constant H_WITHDRAW_CREDIT = 10;
    uint256 private constant H_FREEZE = 11;
    uint256 private constant H_RELEASE_OR_RETURN = 12;
    uint256 private constant H_TAKE_RETURN = 13;
    uint256 private constant H_REDEEM_IN_KIND = 14;
    uint256 private constant H_APPLY = 15;
    uint256 private constant H_STEP = 16;
    uint256 private constant H_MOVE_PRICE = 17;
    uint256 private constant H_UNAUTHORIZED = 18;
    uint256 private constant N_HANDLERS = 19;

    /// @dev Every revert a handler caught, expected or not.
    uint256[N_HANDLERS] public revertsCaught;
    /// @dev Reverts of calls that had to succeed. Any one fails the run (`invariant_mustNotRevert`).
    uint256[N_HANDLERS] public mustSucceedReverts;
    /// @dev The latest must-succeed revert: handler, what, revert data.
    string public lastMustSucceedRevert;

    // Flow ledger since setUp (conservation).
    uint256 public ghostUsdcIn;
    uint256 public ghostUsdcOut;
    uint256 public ghostSharesIn;
    uint256 public ghostSharesOut;
    uint256 public ghostQueueSharesBurned;
    uint256 public ghostWalletSharesBurned;
    mapping(uint256 settlementId => uint64 at) public ghostFreezeAt;

    // Activity.
    uint256 public callsDepositRequest;
    uint256 public callsRedeemRequest;
    uint256 public callsSettle;
    uint256 public settlementsMade;
    uint256 public callsDeliver;
    uint256 public callsClaim;
    uint256 public callsCancel;
    uint256 public callsExitInKind;
    uint256 public callsExpired;
    uint256 public callsCredit;
    uint256 public callsFreeze;
    uint256 public callsRelease;
    uint256 public callsTakeReturn;
    uint256 public callsRedeemInKind;
    uint256 public callsApply;
    /// @dev Valid receipts the fund refused under the pool-share rule, each checked by `_poolShareRefusalJustified`.
    uint256 public callsApplyRefusedPoolShare;
    uint256 public callsRb9Refused;
    uint256 public callsStep;
    uint256 public stepsExecuted;
    uint256 public callsWarp;
    uint256 public callsPrice;

    // The state at the end of setUp (conservation baselines).
    uint256 internal startQueueUsdc;
    uint256 internal startQueueShares;
    uint256 internal startSupply;
    uint256 internal startSettlements;

    /// @dev Every (token, spender) the fund ever emitted an Approval for.
    address[] internal approvedToken;
    address[] internal approvedSpender;
    mapping(bytes32 => bool) internal approvalSeen;

    /// @dev Allowed recipients of a system transfer for the action in flight (see `_scanLogs`).
    mapping(address => bool) internal venueOk;
    mapping(address => bool) internal isSystem;
    address internal actionHolder;
    bool internal actionIsMarket;
    uint8 internal actionKind;

    /// @dev The fund's held amounts per share before a flow action (RB-13).
    struct PerShare {
        uint256 supply;
        uint256 idle;
        uint256[] held;
    }

    PerShare internal pre;

    // ─── Fixture coverage (replay only; same rule as BaseFixture._assertFixtureCovered) ─────────────────

    mapping(address => bool) private _cvAccount;
    mapping(address => mapping(bytes32 => bool)) private _cvSlot;
    mapping(address => mapping(bytes32 => bool)) private _cvSeen;
    mapping(address => bool) private _cvCreated;
    address public coverageMissAccount;
    bytes32 public coverageMissSlot;
    bool public coverageMiss;

    function setUp() public override {
        super.setUp();
        holders[0] = makeAddr("alice");
        holders[1] = makeAddr("bob");
        holders[2] = makeAddr("carol");
        receiptImpl = address(uint160(uint256(vm.load(address(receipts), IMPL_SLOT))));

        address[9] memory sys = [
            address(fund),
            address(swapAdapter),
            address(aaveAdapter),
            address(cometAdapter),
            address(moonwellAdapter),
            address(rebalancer),
            address(governance),
            address(receipts),
            address(queue)
        ];
        for (uint256 i; i < sys.length; ++i) {
            isSystem[sys[i]] = true;
        }
        address[10] memory venues = [
            address(fund),
            address(swapAdapter),
            address(aaveAdapter),
            address(cometAdapter),
            address(moonwellAdapter),
            WETH_POOL,
            CBBTC_POOL,
            AAVE_A_USDC,
            COMET,
            MOONWELL
        ];
        for (uint256 i; i < venues.length; ++i) {
            venueOk[venues[i]] = true;
        }

        // Three holders deposit through the queue in one epoch, then a plan opens so the first steps trade.
        uint256 last;
        for (uint256 k; k < holders.length; ++k) {
            last = openDepositRequest(holders[k], 20_000e6, type(uint256).max);
        }
        settleUntilFilled(last);
        for (uint256 k; k < holders.length; ++k) {
            deliverAfterHold(holders[k]);
            (uint256 u,) = queue.creditOf(holders[k]);
            if (u != 0) {
                vm.prank(holders[k]);
                queue.withdrawCredit();
            }
        }
        timelockExecute(
            address(fund),
            abi.encodeCall(IRobotMoneyFund.setInKindAllowance, (uint16(500), IN_KIND_FLOOR_USDC, uint32(6 hours)))
        );
        recordAndApply(bucketVec(6_500, 3_500));
        // A day into the 7-day plan, so the very first steps of a run have real deviations to trade.
        vm.warp(block.timestamp + 1 days);
        refreshFeeds();

        startQueueUsdc = IERC20(USDC).balanceOf(address(queue));
        startQueueShares = fund.balanceOf(address(queue));
        startSupply = fund.totalSupply();
        startSettlements = queue.settlementCount();

        if (fixtureCheck) {
            _loadCoverageIndex();
            _coverage(vm.stopAndReturnStateDiff());
        }
        vm.startStateDiffRecording();

        bytes4[24] memory sel = [
            this.act_requestDeposit.selector,
            this.act_requestDeposit.selector,
            this.act_requestRedeem.selector,
            this.act_settle.selector,
            this.act_settle.selector,
            this.act_settle.selector,
            this.act_deliver.selector,
            this.act_claim.selector,
            this.act_cancel.selector,
            this.act_exitInKind.selector,
            this.act_withdrawExpired.selector,
            this.act_withdrawCredit.selector,
            this.act_freeze.selector,
            this.act_releaseOrReturn.selector,
            this.act_takeReturn.selector,
            this.act_pause.selector,
            this.act_redeemInKind.selector,
            this.act_apply.selector,
            this.act_step.selector,
            this.act_warp.selector,
            this.act_warp.selector,
            this.act_movePrice.selector,
            this.act_marketCatchesUp.selector,
            this.act_unauthorized.selector
        ];
        bytes4[] memory selectors = new bytes4[](sel.length);
        for (uint256 i; i < sel.length; ++i) {
            selectors[i] = sel[i];
        }
        targetContract(address(this));
        targetSelector(FuzzSelector({addr: address(this), selectors: selectors}));
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Handler actions: flows (step 3d)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Opens the per-action recordings (logs for INV-1 / RB-4..7 / RB-10 / RB-14, state diff for RB-8 and
    ///      coverage). `holder` is the one address a payout may reach; `kind` is RB-10's rule for the queue.
    modifier action(address holder, bool market, uint8 kind) {
        vm.startStateDiffRecording();
        vm.recordLogs();
        actionHolder = holder;
        actionIsMarket = market;
        actionKind = kind;
        _;
        _scanLogs(vm.getRecordedLogs());
        _scanAccesses(vm.stopAndReturnStateDiff());
        actionHolder = address(0);
        actionIsMarket = false;
        actionKind = ACT_OTHER;
    }

    /// @notice A holder asks to deposit 100 to 20,000 USDC. `mode` picks its limit: any price, the quote plus
    ///         50 bps (E21), or a limit below every bound (it never fills: RB-14 skips it).
    function act_requestDeposit(uint256 who, uint256 amt, uint8 mode) public {
        address h = holders[who % holders.length];
        amt = bound(amt, 100e6, 20_000e6);
        uint256 limit = type(uint256).max;
        mode = mode % 3;
        if (mode == 1) {
            try queue.quoteDeposit(amt) returns (Quote memory q) {
                limit = q.boundPrice.mulDiv(BPS + 50, BPS);
            } catch (bytes memory err) {
                _quoteReverted(err);
            }
        } else if (mode == 2) {
            limit = 1;
        }
        _requestDeposit(h, amt, limit);
    }

    function _requestDeposit(address h, uint256 amt, uint256 limit) private action(address(0), false, ACT_OTHER) {
        fundUsdc(h, amt);
        vm.prank(h);
        IERC20(USDC).approve(address(queue), amt);
        vm.prank(h);
        try queue.requestDeposit(amt, limit, h) {
            ++callsDepositRequest;
            ghostUsdcIn += amt;
        } catch (bytes memory err) {
            // The only refusal for these inputs (100 to 20,000 USDC, at or above the minimum, under the per-deposit
            // cap, a non-zero owner and limit) is a paused queue.
            ++revertsCaught[H_REQUEST_DEPOSIT];
            if (!queue.paused()) {
                _violation("deposit request refused while not paused", 0);
                _mustSucceed(H_REQUEST_DEPOSIT, "a deposit request while not paused", err);
            }
        }
        vm.prank(h);
        IERC20(USDC).approve(address(queue), 0);
    }

    /// @notice A holder asks to redeem a slice of its wallet shares, at any price or at the quote less 50 bps.
    function act_requestRedeem(uint256 who, uint256 frac, bool quoted) public {
        address h = holders[who % holders.length];
        uint256 bal = fund.balanceOf(h);
        if (bal == 0) return;
        uint256 shares = bound(frac, 1, bal);
        uint256 limit;
        if (quoted) {
            try queue.quoteRedeem(shares) returns (Quote memory q) {
                limit = q.boundPrice.mulDiv(BPS - 50, BPS);
            } catch (bytes memory err) {
                _quoteReverted(err);
            }
        }
        _requestRedeem(h, shares, limit);
    }

    function _requestRedeem(address h, uint256 shares, uint256 limit) private action(address(0), false, ACT_OTHER) {
        vm.prank(h);
        fund.approve(address(queue), shares);
        vm.prank(h);
        try queue.requestRedeem(shares, limit, h) {
            ++callsRedeemRequest;
            ghostSharesIn += shares;
        } catch (bytes memory err) {
            // Legitimate refusals: paused, or below the minimum and not the whole balance (E11).
            ++revertsCaught[H_REQUEST_REDEEM];
            if (!queue.paused() && bytes4(err) != IFlowEventsSel.BELOW_MIN) {
                ++ghostRequestRedeemReverts;
                _mustSucceed(H_REQUEST_REDEEM, "a redemption request at or above the minimum while not paused", err);
            }
        }
        vm.prank(h);
        fund.approve(address(queue), 0);
    }

    /// @notice `settle` by the keeper or a stranger, with bounded inputs (RB-20: they may only limit the work).
    ///         With `wait`, time first passes to the end of the oldest open request's window (and the keeper grace
    ///         for a stranger), as a keeper that waits for the window would.
    function act_settle(uint256 callerSeed, uint256 maxReq, uint256 maxUsdc, bool wait) public {
        address c = callerSeed % 3 == 0 ? stranger : keeper;
        if (wait) _waitForOldestWindow(c == stranger);
        refreshFeeds();
        maxReq = bound(maxReq, 1, 64);
        maxUsdc = maxUsdc % 4 == 0 ? type(uint256).max : bound(maxUsdc, 1_000e6, 300_000e6);
        _settle(c, maxReq, maxUsdc);
    }

    struct SettlePre {
        SettleCheck check;
        uint256 qUsdc;
        uint256 qShares;
        uint256 claims;
        uint256 navFeed;
        uint256 cfDeposit;
        uint256 cfRedeem;
    }

    SettlePre internal sp;

    function _settle(address c, uint256 maxReq, uint256 maxUsdc) private action(address(0), false, ACT_SETTLE) {
        (uint256 cfDep, uint256 cfRed) = _counterfactualBounds();
        sp.cfDeposit = cfDep;
        sp.cfRedeem = cfRed;
        vm.prank(c);
        (sp.check,) = queue.checkSettle();
        sp.qUsdc = IERC20(USDC).balanceOf(address(queue));
        sp.qShares = fund.balanceOf(address(queue));
        sp.claims = queue.claimCount();
        sp.navFeed = _navAtFeeds();
        _snapPerShare();
        vm.prank(c);
        try queue.settle(maxReq, maxUsdc) returns (uint256 sid) {
            ++callsSettle;
            // RB-16: `settle` runs the same pre-trade checks as `checkSettle` for the same caller in the same block,
            // so a call that `checkSettle` named blocked must revert, whether or not it would record anything.
            if (sp.check != SettleCheck.Ok) _violation("RB-16: settle went through although checkSettle named a failed check", 16);
            if (sid == 0) {
                // RB-12 / RB-15: nothing recorded, nothing moved (a failed side changes no state).
                if (
                    IERC20(USDC).balanceOf(address(queue)) != sp.qUsdc || fund.balanceOf(address(queue)) != sp.qShares
                        || queue.claimCount() != sp.claims
                ) _violation("RB-12: a settle that recorded nothing moved a balance", 12);
                return;
            }
            ++settlementsMade;
            _checkSettlement(sid);
        } catch (bytes memory err) {
            // A settle may revert only because a pre-trade check failed, and then with exactly the check
            // `checkSettle` named. With the gas a handler has, `SettleSideOutOfGas` cannot be legitimate either.
            ++revertsCaught[H_SETTLE];
            if (sp.check == SettleCheck.Ok) {
                _mustSucceed(H_SETTLE, "settle reverted although checkSettle said Ok", err);
            } else if (!_isSettleBlocked(err, sp.check)) {
                _mustSucceed(H_SETTLE, "settle reverted with other than the check checkSettle named", err);
            }
        }
    }

    /// @dev Whether `err` is `SettleBlocked(check, ·, ·)`.
    function _isSettleBlocked(bytes memory err, SettleCheck check) private pure returns (bool) {
        if (err.length != 100 || bytes4(err) != IFlowEvents.SettleBlocked.selector) return false;
        uint256 got;
        assembly {
            got := mload(add(err, 36))
        }
        return got == uint256(check);
    }

    /// @dev A quote may revert only with `SettleBlocked` (checks 2 to 5 failed now, or this size cannot be bounded).
    function _quoteReverted(bytes memory err) private {
        ++revertsCaught[H_QUOTE];
        if (err.length != 100 || bytes4(err) != IFlowEvents.SettleBlocked.selector) {
            _mustSucceed(H_QUOTE, "a quote reverted with other than SettleBlocked", err);
        }
    }

    /// @dev Count a revert of a call that had to succeed (the caller counted it in `revertsCaught` already) and keep
    ///      its description for the failing invariant's message.
    function _mustSucceed(uint256 h, string memory what, bytes memory err) private {
        ++mustSucceedReverts[h];
        lastMustSucceedRevert = string.concat(_handlerName(h), ": ", what, ", revert data ", vm.toString(err));
    }

    /// @dev The handler names, for the run summary and the failure messages.
    function _handlerName(uint256 h) private pure returns (string memory) {
        string[N_HANDLERS] memory names = [
            "requestDeposit",
            "requestRedeem",
            "quote",
            "settle",
            "settle (keeper counterfactual)",
            "deliver",
            "claim",
            "cancel",
            "exitInKind",
            "withdrawExpired",
            "withdrawCredit",
            "freeze",
            "releaseOrReturn",
            "takeReturn",
            "redeemInKind",
            "apply",
            "step",
            "movePrice",
            "unauthorized"
        ];
        return names[h];
    }

    /// @dev RB-20: what the keeper with no limits would settle from this exact state, then undone. Memory and the
    ///      stack survive `revertToState`; this contract's storage does not.
    function _counterfactualBounds() private returns (uint256 dep, uint256 red) {
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        (SettleCheck kc,) = queue.checkSettle();
        vm.prank(keeper);
        try queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max) returns (uint256 sid) {
            if (sid != 0) {
                Settlement memory s = queue.getSettlement(sid);
                (dep, red) = (s.depositBoundPrice, s.redeemBoundPrice);
            }
        } catch (bytes memory err) {
            // The same rule as the real call, for the keeper with no limits.
            ++revertsCaught[H_SETTLE_COUNTERFACTUAL];
            if (kc == SettleCheck.Ok) {
                _mustSucceed(H_SETTLE_COUNTERFACTUAL, "the keeper's settle reverted although checkSettle said Ok", err);
            } else if (!_isSettleBlocked(err, kc)) {
                _mustSucceed(H_SETTLE_COUNTERFACTUAL, "the keeper's settle reverted with another reason", err);
            }
        }
        // The counts above live in storage, which the revert below undoes: carry them over in memory.
        uint256 caught = revertsCaught[H_SETTLE_COUNTERFACTUAL];
        uint256 failed = mustSucceedReverts[H_SETTLE_COUNTERFACTUAL];
        string memory why = lastMustSucceedRevert;
        vm.revertToState(snap);
        revertsCaught[H_SETTLE_COUNTERFACTUAL] = caught;
        mustSucceedReverts[H_SETTLE_COUNTERFACTUAL] = failed;
        lastMustSucceedRevert = why;
        // Drop the counterfactual's logs; keep recording for the real call.
        vm.getRecordedLogs();
        vm.recordLogs();
    }

    /// @dev After a settlement that traded: RB-13, RB-14, RB-16 caps, RB-20, RB-11 unlock times.
    function _checkSettlement(uint256 sid) private {
        Settlement memory s = queue.getSettlement(sid);
        _checkPerShare("settle");
        if (s.depositBoundPrice != 0 && sp.cfDeposit != 0 && s.depositBoundPrice != sp.cfDeposit) {
            _violation("RB-20: the deposit bound depended on the settle's inputs", 20);
        }
        if (s.redeemBoundPrice != 0 && sp.cfRedeem != 0 && s.redeemBoundPrice != sp.cfRedeem) {
            _violation("RB-20: the redemption bound depended on the settle's inputs", 20);
        }
        FlowParams memory p = queue.flowParams();
        (uint256 depUsed, uint256 redUsed) = queue.periodFlow(block.timestamp / p.epochLength);
        uint256 cap = Math.max(sp.navFeed.mulDiv(p.maxEpochFlowBps, BPS), p.epochFlowFloorUsdc);
        // NAV at the feeds here is recomputed outside the queue; 1 % slack covers its rounding, not a cap breach.
        if (depUsed > cap + cap / 100 || redUsed > cap + cap / 100) _violation("RB-16: a period's fills passed its cap", 16);
        (uint256 tvlCap,,,) = fund.config();
        if (_navAtFeeds() > tvlCap) _violation("RB-16: NAV passed the TVL cap", 16);
        // RB-14 and RB-11 from the fill events of the real call.
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        vm.recordLogs();
        _scanLogs(logs);
        for (uint256 k; k < logs.length; ++k) {
            if (logs[k].emitter != address(queue)) continue;
            bytes32 t0 = logs[k].topics[0];
            if (t0 == DEPOSIT_FILLED_SIG) {
                uint256 rid = uint256(logs[k].topics[1]);
                (uint256 usdc, uint256 shares, uint64 unlockAt) = abi.decode(logs[k].data, (uint256, uint256, uint64));
                if (usdc.mulDiv(PRICE_SCALE, shares, Math.Rounding.Ceil) > queue.getRequest(rid).limit) {
                    _violation("RB-14: a deposit filled above its limit", 14);
                }
                if (unlockAt != block.timestamp + p.minHold) _violation("RB-11: a deposit claim unlocks early", 11);
            } else if (t0 == REDEEM_FILLED_SIG) {
                uint256 rid = uint256(logs[k].topics[1]);
                (uint256 shares, uint256 usdc) = abi.decode(logs[k].data, (uint256, uint256));
                if (usdc.mulDiv(PRICE_SCALE, shares) < queue.getRequest(rid).limit) {
                    _violation("RB-14: a redemption filled below its limit", 14);
                }
            }
        }
    }

    /// @notice Anyone triggers delivery of a holder's unlocked shares (E8). RB-11: only unlocked claims of unfrozen
    ///         settlements, only to the owner. With `wait`, time first passes to the holder's earliest locked unlock.
    function act_deliver(uint256 who, bool wait) public {
        address h = holders[who % holders.length];
        if (wait) _waitForUnlock(h);
        uint256 n = queue.maxMint(h);
        if (n == 0) return;
        _deliver(h, n);
    }

    function _deliver(address h, uint256 n) private action(h, false, ACT_PAY) {
        uint256 count = queue.claimCount();
        uint256[] memory claimed0 = new uint256[](count + 1);
        for (uint256 c = 1; c <= count; ++c) {
            claimed0[c] = queue.getClaim(c).claimed;
        }
        uint256 bal0 = fund.balanceOf(h);
        vm.prank(stranger);
        try queue.mint(n, h) {
            ++callsDeliver;
            ghostSharesOut += n;
            if (fund.balanceOf(h) - bal0 != n) _violation("RB-11: delivered shares did not reach the owner", 11);
            for (uint256 c = 1; c <= count; ++c) {
                Claim memory cl = queue.getClaim(c);
                if (cl.claimed == claimed0[c]) continue;
                if (cl.owner != h || cl.kind != RequestKind.Deposit) _violation("RB-11: another's claim moved", 11);
                if (block.timestamp < cl.unlockAt) _violation("RB-11: a share left before its unlock", 11);
                if (queue.getSettlement(cl.settlementId).frozenUntil > block.timestamp) {
                    _violation("RB-18: a frozen settlement delivered", 18);
                }
            }
        } catch (bytes memory err) {
            ++ghostClaimReverts;
            ++revertsCaught[H_DELIVER];
            _mustSucceed(H_DELIVER, "delivery of the shares maxMint reported", err);
        }
    }

    /// @notice The owner takes its settled redemption USDC.
    function act_claim(uint256 who) public {
        address h = holders[who % holders.length];
        uint256 n = queue.maxRedeem(h);
        if (n == 0) return;
        _claim(h, n);
    }

    function _claim(address h, uint256 n) private action(h, false, ACT_PAY) {
        uint256 u0 = IERC20(USDC).balanceOf(h);
        vm.prank(h);
        try queue.redeem(n, h, h) returns (uint256 paid) {
            ++callsClaim;
            ghostUsdcOut += paid;
            if (IERC20(USDC).balanceOf(h) - u0 != paid) _violation("claim: the owner did not receive the USDC", 11);
        } catch (bytes memory err) {
            ++ghostClaimReverts;
            ++revertsCaught[H_CLAIM];
            _mustSucceed(H_CLAIM, "the redemption claim maxRedeem reported", err);
        }
    }

    /// @notice The owner cancels one of its pending requests (RB-12: exactly the unfilled part, as credit; RB-15:
    ///         also while paused).
    function act_cancel(uint256 who, uint256 k) public {
        address h = holders[who % holders.length];
        (bool found, uint256 id) = _pickOpen(h, k, false, false);
        if (!found) return;
        _cancel(h, id);
    }

    function _cancel(address h, uint256 id) private action(h, false, ACT_OTHER) {
        Request memory r0 = queue.getRequest(id);
        (uint256 cu0, uint256 cs0) = queue.creditOf(h);
        vm.prank(h);
        try queue.cancel(id) {
            ++callsCancel;
            (uint256 cu1, uint256 cs1) = queue.creditOf(h);
            bool exact = r0.kind == RequestKind.Deposit
                ? (cu1 - cu0 == r0.remaining && cs1 == cs0)
                : (cs1 - cs0 == r0.remaining && cu1 == cu0);
            if (!exact) _violation("RB-12: a cancel did not credit exactly the unfilled escrow", 12);
        } catch (bytes memory err) {
            _violation("RB-15: cancel of a pending request reverted", 15);
            ++revertsCaught[H_CANCEL];
            _mustSucceed(H_CANCEL, "cancel of the owner's pending request", err);
        }
    }

    /// @notice The owner takes a pending redemption out in kind at once (RB-15: also while paused).
    function act_exitInKind(uint256 who, uint256 k) public {
        address h = holders[who % holders.length];
        (bool found, uint256 id) = _pickOpen(h, k, true, false);
        if (!found) return;
        _exitInKind(h, id);
    }

    function _exitInKind(address h, uint256 id) private action(h, false, ACT_EXIT) {
        uint256 rem = queue.getRequest(id).remaining;
        _snapPerShare();
        vm.prank(h);
        try queue.exitInKind(id) {
            ++callsExitInKind;
            ghostQueueSharesBurned += rem;
            _checkPerShare("exitInKind");
        } catch (bytes memory err) {
            _violation("RB-15: in-kind exit of a pending redemption reverted", 15);
            ++revertsCaught[H_EXIT_IN_KIND];
            _mustSucceed(H_EXIT_IN_KIND, "in-kind exit of the owner's pending redemption", err);
        }
    }

    /// @notice The owner withdraws an expired request's escrow (E18, RB-12: exactly the unfilled escrow). With
    ///         `wait`, time first passes until the holder's oldest open request expires.
    function act_withdrawExpired(uint256 who, uint256 k, bool wait) public {
        address h = holders[who % holders.length];
        if (wait) _waitForExpiry(h);
        (bool found, uint256 id) = _pickOpen(h, k, false, true);
        if (!found) return;
        _withdrawExpired(h, id);
    }

    function _withdrawExpired(address h, uint256 id) private action(h, false, ACT_PAY) {
        Request memory r0 = queue.getRequest(id);
        bool isDeposit = r0.kind == RequestKind.Deposit;
        uint256 b0 = isDeposit ? IERC20(USDC).balanceOf(h) : fund.balanceOf(h);
        vm.prank(h);
        try queue.withdrawExpired(id) returns (uint256 amt) {
            ++callsExpired;
            uint256 b1 = isDeposit ? IERC20(USDC).balanceOf(h) : fund.balanceOf(h);
            if (amt != r0.remaining || b1 - b0 != amt) _violation("RB-12: an expiry did not return exactly", 12);
            if (isDeposit) ghostUsdcOut += amt;
            else ghostSharesOut += amt;
        } catch (bytes memory err) {
            _violation("E18: an expired request's escrow could not be withdrawn", 12);
            ++revertsCaught[H_WITHDRAW_EXPIRED];
            _mustSucceed(H_WITHDRAW_EXPIRED, "withdrawal of an expired request's escrow", err);
        }
    }

    /// @notice The owner pulls its credits (E22).
    function act_withdrawCredit(uint256 who) public {
        address h = holders[who % holders.length];
        (uint256 u, uint256 s) = queue.creditOf(h);
        if (u == 0 && s == 0) return;
        _withdrawCredit(h, u, s);
    }

    function _withdrawCredit(address h, uint256 u, uint256 s) private action(h, false, ACT_PAY) {
        vm.prank(h);
        try queue.withdrawCredit() returns (uint256 pu, uint256 ps) {
            ++callsCredit;
            if (pu != u || ps != s) _violation("E22: credit paid differs from credit booked", 12);
            ghostUsdcOut += pu;
            ghostSharesOut += ps;
        } catch (bytes memory err) {
            ++ghostClaimReverts;
            ++revertsCaught[H_WITHDRAW_CREDIT];
            _mustSucceed(H_WITHDRAW_CREDIT, "withdrawal of the owner's credit", err);
        }
    }

    /// @notice The emergency key freezes a settlement whose deposit shares are in their hold (E17).
    function act_freeze(uint256 k) public {
        uint256 n = queue.settlementCount();
        if (n == 0) return;
        uint256 id = 1 + k % n;
        Settlement memory s = queue.getSettlement(id);
        if (s.sharesMinted == 0 || block.timestamp >= s.holdEndsAt || s.frozenUntil > block.timestamp) return;
        _freeze(id);
    }

    function _freeze(uint256 id) private action(address(0), false, ACT_OTHER) {
        vm.prank(emergency);
        try queue.freezeSettlement(id) {
            ++callsFreeze;
            ghostFreezeAt[id] = uint64(block.timestamp);
        } catch (bytes memory err) {
            _violation("E17: a freeze inside the hold reverted", 18);
            ++revertsCaught[H_FREEZE];
            _mustSucceed(H_FREEZE, "a freeze of a settlement inside its hold", err);
        }
    }

    /// @notice ADMIN (the timelock) releases a frozen settlement or lets its depositors take it back in kind.
    function act_releaseOrReturn(uint256 k, bool release) public {
        uint256 n = queue.settlementCount();
        for (uint256 j; j < n; ++j) {
            uint256 id = 1 + (k % n + j) % n;
            if (queue.getSettlement(id).frozenUntil <= block.timestamp) continue;
            _releaseOrReturn(id, release);
            return;
        }
    }

    function _releaseOrReturn(uint256 id, bool release) private action(address(0), false, ACT_OTHER) {
        vm.prank(address(timelock));
        if (release) {
            try queue.releaseSettlement(id) {
                ++callsRelease;
            } catch (bytes memory err) {
                _violation("E17: release of a frozen settlement reverted", 18);
                ++revertsCaught[H_RELEASE_OR_RETURN];
                _mustSucceed(H_RELEASE_OR_RETURN, "release of a frozen settlement", err);
            }
        } else {
            try queue.allowReturn(id) {
                ++callsRelease;
            } catch (bytes memory err) {
                _violation("E17: allowReturn of a frozen settlement reverted", 18);
                ++revertsCaught[H_RELEASE_OR_RETURN];
                _mustSucceed(H_RELEASE_OR_RETURN, "allowReturn of a frozen settlement", err);
            }
        }
    }

    /// @notice A depositor takes its slice of a returned settlement back in kind; a stranger's attempt must fail
    ///         (RB-18).
    function act_takeReturn(uint256 who) public {
        address h = holders[who % holders.length];
        uint256 n = queue.claimCount();
        for (uint256 c = 1; c <= n; ++c) {
            Claim memory cl = queue.getClaim(c);
            if (cl.owner != h || cl.kind != RequestKind.Deposit || cl.claimed >= cl.shares) continue;
            if (!queue.getSettlement(cl.settlementId).returnAllowed) continue;
            _takeReturn(h, c, cl.shares - cl.claimed);
            return;
        }
    }

    function _takeReturn(address h, uint256 claimId, uint256 x) private action(h, false, ACT_EXIT) {
        vm.prank(stranger);
        try queue.takeReturn(claimId) {
            _violation("RB-18: a stranger took a depositor's return", 18);
        } catch {
            ++revertsCaught[H_TAKE_RETURN]; // expected: only the claim's owner takes it
        }
        _snapPerShare();
        vm.prank(h);
        try queue.takeReturn(claimId) {
            ++callsTakeReturn;
            ghostQueueSharesBurned += x;
            _checkPerShare("takeReturn");
        } catch (bytes memory err) {
            _violation("RB-18: the depositor could not take its return", 18);
            ++revertsCaught[H_TAKE_RETURN];
            _mustSucceed(H_TAKE_RETURN, "the depositor's own return", err);
        }
    }

    /// @notice EMERGENCY pauses the queue, or ADMIN unpauses it. Exits stay open (RB-15, checked in their actions).
    function act_pause(bool on) public action(address(0), false, ACT_OTHER) {
        if (on) {
            vm.prank(emergency);
            queue.pause();
        } else {
            vm.prank(address(timelock));
            queue.unpause();
        }
    }

    /// @notice RB-6 / E9: `redeemInKind` of a holder's own wallet shares never reverts, whatever the plan or the
    ///         market, and keeps every held amount per share (RB-13).
    function act_redeemInKind(uint256 who, uint256 frac) public {
        address h = holders[who % holders.length];
        uint256 bal = fund.balanceOf(h);
        if (bal == 0) return;
        _redeemInKind(h, bound(frac, 1, bal));
    }

    function _redeemInKind(address h, uint256 shares) private action(h, false, ACT_OTHER) {
        _snapPerShare();
        vm.prank(h);
        try fund.redeemInKind(shares, h, h) {
            ++callsRedeemInKind;
            ghostWalletSharesBurned += shares;
            _checkPerShare("redeemInKind");
        } catch (bytes memory err) {
            ++ghostInKindReverts;
            ++revertsCaught[H_REDEEM_IN_KIND];
            _mustSucceed(H_REDEEM_IN_KIND, "redeemInKind of the holder's own wallet shares", err);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Handler actions: rebalancing (step 3c) and the market
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Record a random valid receipt. First send each refused variant of its vector (RB-9), then apply the
    ///         valid vector through the timelock (RB-1's only path). A valid receipt never fails to open a plan.
    function act_apply(uint256 a, uint256 b) public action(address(0), false, ACT_OTHER) {
        uint16 stable = uint16(bound(a, 0, BPS));
        b;
        uint16 protocol = uint16(BPS - stable);
        uint16[5] memory v = bucketVec(stable, protocol);
        (bytes32 id, bytes32 digest) = recordReceipt(v);
        for (uint256 kind; kind < 6; ++kind) {
            _refuseBadVector(id, digest, v, kind);
        }
        uint256 prevId = fund.currentPlanId();
        try this.applyExternal(id, digest, v) {
            ++callsApply;
            if (fund.currentPlanId() != prevId + 1 || fund.planStatus() != PlanStatus.Open) {
                ++ghostApplyFailures;
                _mustSucceed(
                    H_APPLY,
                    string.concat(
                        "a valid receipt applied but no plan opened (plan status ", vm.toString(uint256(fund.planStatus())), ")"
                    ),
                    ""
                );
            }
        } catch (bytes memory err) {
            ++revertsCaught[H_APPLY];
            if (_poolShareRefusalJustified(err, v)) {
                ++callsApplyRefusedPoolShare;
            } else {
                ++ghostApplyFailures;
                _mustSucceed(H_APPLY, "a valid receipt applied through the timelock", err);
            }
        }
        refreshFeeds();
    }

    /// @dev E15 / proposal §4.5 rule 3 (step 3d): `setTargetAndOpenPlan` refuses a target whose basket weight times
    ///      the TVL cap is over `poolShareBps` of the pool's time-weighted USDC depth over one settlement window
    ///      (`PoolShareExceeded`). So a well-formed receipt can be refused, and the step 3c rule "a valid receipt
    ///      always opens a plan" no longer holds as written (`hardening`, 2026-11-12: the 64 × 64 campaign drew a
    ///      receipt with wETH at 49.99 % of a 10 M cap against a limit of 4,995,431 USDC). Such a refusal is accepted
    ///      only when an independent reading agrees with it in full: the named asset is a basket asset that `v`
    ///      weights, the target is that weight of the TVL cap rounded up, the limit is the pool's depth read here
    ///      times `poolShareBps`, and the target is over it. Any other revert stays a must-succeed failure.
    function _poolShareRefusalJustified(bytes memory err, uint16[5] memory v) private view returns (bool) {
        if (err.length != 100 || bytes4(err) != IRobotMoneyFund.PoolShareExceeded.selector) return false;
        uint256 i;
        uint256 target;
        uint256 limit;
        assembly {
            i := mload(add(err, 36))
            target := mload(add(err, 68))
            limit := mload(add(err, 100))
        }
        if (i >= fund.assetCount() || !isBasketIndex(i) || v[i] == 0) return false;
        (uint256 tvlCap,,,) = fund.config();
        if (target != tvlCap.mulDiv(v[i], BPS, Math.Rounding.Ceil)) return false;
        (bool ok, uint256 depth) =
            FundValuationLib.poolUsdcDepth(fund.assetConfig(i).pool, USDC, queue.flowParams().settleWindow);
        return ok && limit == depth.mulDiv(fund.poolShareBps(), BPS) && target > limit;
    }

    /// @dev External hop so a failed timelock execution can be caught. Only this contract may call it.
    function applyExternal(bytes32 id, bytes32 digest, uint16[5] memory bps) external {
        require(msg.sender == address(this), "self only");
        applyReceiptViaTimelock(id, digest, bps);
    }

    /// @dev RB-9: send the timelock's `applyReceipt` call for receipt `id` with a refused variant of the valid
    ///      vector `v`, as the timelock (the call the timelock would execute, with no schedule and no warp, so the
    ///      run's time line and pool reads are unchanged). `kind` picks the variant: 0 an active asset left out
    ///      (its weight moved to a basket asset), 1 a duplicate entry, 2 an unknown asset, 3 a sum of 10 001,
    ///      4 a lending target above `capBps`, 5 the valid vector with a wrong payload digest. The call must
    ///      revert with exactly that variant's error, the receipt must stay unreleased, and no plan or applied
    ///      time may change.
    function _refuseBadVector(bytes32 id, bytes32 digest, uint16[5] memory v, uint256 kind) private {
        address[] memory ids;
        uint256[] memory w;
        bytes memory expected;
        bytes32 sent = digest;
        if (kind == 5) {
            (ids, w) = assetArrays(v);
            sent = keccak256("wrong");
            expected = abi.encodeWithSelector(IRebalanceGovernance.PayloadDigestMismatch.selector, id, digest, sent);
        } else {
            (ids, w, expected) = _badVector(v, kind);
        }
        uint256 prevId = fund.currentPlanId();
        uint64 prevApplied = governance.lastAppliedRecordedAt();
        vm.prank(address(timelock));
        try governance.applyReceipt(id, sent, ids, w) {
            ++ghostRb9Violations;
        } catch (bytes memory err) {
            ++revertsCaught[H_APPLY]; // expected: a refused vector (the error is checked here)
            if (keccak256(err) != keccak256(expected)) ++ghostRb9Violations;
        }
        if (receipts.isReleased(id) || fund.currentPlanId() != prevId) ++ghostRb9Violations;
        if (governance.lastAppliedRecordedAt() != prevApplied) ++ghostRb9Violations;
        ++callsRb9Refused;
    }

    /// @dev The refused variant `kind` of `v` (see `_refuseBadVector`) and the exact revert data it must raise.
    function _badVector(uint16[5] memory v, uint256 kind)
        private
        view
        returns (address[] memory ids, uint256[] memory w, bytes memory expected)
    {
        (ids, w) = assetArrays(v);
        if (kind == 0) {
            // Leave out cbBTC. Its weight moves to wETH, so the sum stays 10 000 and no cap is hit.
            address[] memory ids5 = new address[](ids.length - 1);
            uint256[] memory w5 = new uint256[](ids.length - 1);
            uint256 k;
            for (uint256 i; i < ids.length; ++i) {
                if (i == IDX_CBBTC) continue;
                ids5[k] = ids[i];
                w5[k] = w[i];
                ++k;
            }
            w5[IDX_WETH] += w[IDX_CBBTC];
            return (ids5, w5, abi.encodeWithSelector(IFundEvents.TargetAssetMissing.selector, CBBTC));
        }
        if (kind == 1 || kind == 2) {
            // Append a zero-weight entry: aave again (duplicate), or an address that is no fund asset.
            address extra = kind == 1 ? ids[IDX_AAVE] : stranger;
            address[] memory ids7 = new address[](ids.length + 1);
            uint256[] memory w7 = new uint256[](ids.length + 1);
            for (uint256 i; i < ids.length; ++i) {
                ids7[i] = ids[i];
                w7[i] = w[i];
            }
            ids7[ids.length] = extra;
            bytes4 sel = kind == 1 ? IFundEvents.TargetAssetDuplicate.selector : IFundEvents.TargetAssetNotActive.selector;
            return (ids7, w7, abi.encodeWithSelector(sel, extra));
        }
        if (kind == 3) {
            w[IDX_WETH] += 1;
            return (ids, w, abi.encodeWithSelector(IFundEvents.TargetSumInvalid.selector, BPS + 1));
        }
        // Aave is the first entry, so its cap check fires before the sum check.
        w[IDX_AAVE] = LENDING_CAP_BPS + 1;
        expected = abi.encodeWithSelector(
            IFundEvents.TargetExceedsCap.selector, IDX_AAVE, uint256(LENDING_CAP_BPS) + 1, uint256(LENDING_CAP_BPS)
        );
    }

    /// @notice One keeper `step()` (optionally after one effective interval). Checks RB-4, RB-5 and RB-7 against
    ///         the state just before the call.
    function act_step(bool warpFirst) public {
        if (warpFirst) vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        refreshFeeds();
        _step();
    }

    struct Pre {
        PlanStatus status;
        uint256 readyAt;
        uint256 nav;
        uint256 idle;
        uint256[] values;
        bool[] marketOk;
        Plan plan;
    }

    function _step() private action(address(0), false, ACT_OTHER) {
        Pre memory p0;
        p0.status = fund.planStatus();
        p0.readyAt = uint256(fund.lastStepAt()) + rebalancer.effectiveStepInterval();
        (p0.nav, p0.idle, p0.values) = fund.portfolioValues();
        p0.marketOk = new bool[](fund.assetCount());
        for (uint256 i; i < p0.marketOk.length; ++i) {
            (p0.marketOk[i],) = fund.marketCheck(i);
        }
        p0.plan = fund.plan();

        ++callsStep;
        bool ready = _independentlyReady(p0);
        vm.prank(keeper);
        try rebalancer.step() returns (bool executed, SkipReason why) {
            if (executed) _checkExecutedStep(p0);
            else if (ready && (why == SkipReason.NothingToTrade || why == SkipReason.BelowMinStep)) {
                ++ghostLivenessSkips;
            }
        } catch (bytes memory err) {
            ++ghostStepReverts;
            ++revertsCaught[H_STEP];
            _mustSucceed(H_STEP, "a keeper step (it must skip, not revert)", err);
        }
        Plan memory p = fund.plan();
        if (p.costSpent > p.costBudget && p.status != PlanStatus.Halted) ++ghostRb4BudgetNotHalted;
    }

    function _checkExecutedStep(Pre memory p0) private {
        ++stepsExecuted;
        if (p0.status != PlanStatus.Open) ++ghostRb4HaltedStepped;
        if (block.timestamp < p0.readyAt) ++ghostRb5Cooldown;

        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        // Re-arm so the action modifier still sees this step's transfers.
        vm.recordLogs();
        _scanLogs(logs);
        for (uint256 k; k < logs.length; ++k) {
            if (logs[k].emitter != address(fund) || logs[k].topics[0] != STEP_EXECUTED_SIG) continue;
            (uint256 sellI, uint256 buyI, uint256 notional,,,, uint256 navBefore, uint256 navAfter, uint256 cost) =
                abi.decode(logs[k].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));

            // RB-4: TWAP NAV falls at most maxStepCostBps of the notional, measured by the fund and by us.
            uint256 maxCost = notional.mulDiv(MAX_STEP_COST_BPS, BPS);
            if (cost > maxCost || navBefore != p0.nav || navAfter + maxCost < navBefore) ++ghostRb4StepCost;
            if (_twapNav() + maxCost < p0.nav) ++ghostRb4StepCost;

            // RB-5: no traded Basket asset failed ORA-4 just before the step.
            if (sellI != IDLE_INDEX && !p0.marketOk[sellI]) ++ghostRb5Market;
            if (buyI != IDLE_INDEX && !p0.marketOk[buyI]) ++ghostRb5Market;

            // RB-7: the notional fits between each leg's holding and its pathTarget(now) value.
            uint256 v = sellI == IDLE_INDEX ? p0.idle : p0.values[sellI];
            uint256 t = _pathValue(p0.plan, sellI, block.timestamp, p0.nav);
            if (v < t + notional) ++ghostRb7PastPath;
            if (buyI != IDLE_INDEX) {
                v = p0.values[buyI];
                t = _pathValue(p0.plan, buyI, block.timestamp, p0.nav);
                if (t < v + notional) ++ghostRb7PastPath;
            }
        }
    }

    /// @notice Time passes (1 minute to 12 hours): windows end, holds end, requests expire, cooldowns lapse. The
    ///         feeds are re-stamped (an outside market with live feeds); the fund's NAV views need it (E19).
    function act_warp(uint256 dt) public {
        ++callsWarp;
        vm.warp(block.timestamp + bound(dt, 1 minutes, 12 hours));
        refreshFeeds();
    }

    /// @notice An outside trader moves a basket pool. wETH both ways (deal verified); cbBTC buys only.
    function act_movePrice(uint256 which, uint256 usdc, bool buy) public action(address(0), true, ACT_OTHER) {
        which = which % 2;
        address pool = which == 0 ? WETH_POOL : CBBTC_POOL;
        usdc = bound(usdc, 100e6, 200_000e6);
        if (which != 0) buy = true;
        try this.movePriceExternal(pool, usdc, buy) {
            ++callsPrice;
        } catch (bytes memory err) {
            // An outside trade of at most 200,000 USDC on a real pool with no price limit must go through; a run
            // whose market silently does nothing would test less than it claims.
            ++revertsCaught[H_MOVE_PRICE];
            _mustSucceed(H_MOVE_PRICE, "an outside trader's swap", err);
        }
    }

    function movePriceExternal(address pool, uint256 usdc, bool buy) external {
        require(msg.sender == address(this), "self only");
        movePrice(pool, usdc, buy);
    }

    /// @notice The outside market catches up with the pools: each basket feed moves to its pool's price.
    function act_marketCatchesUp() public {
        alignFeedsToPools();
        refreshFeeds();
    }

    /// @notice RB-1 and the flow authority: no account but the timelock can set a target or open a plan; nobody but
    ///         the queue mints or sells through the fund; only EMERGENCY freezes or pauses; only ADMIN releases,
    ///         returns or sets the flow parameters; nobody calls the queue's settle sides.
    function act_unauthorized(uint256 who, uint256 a) public action(address(0), false, ACT_OTHER) {
        address[4] memory callers = [stranger, keeper, submitter, holders[who % holders.length]];
        address c = callers[a % callers.length];
        (address[] memory s, uint256[] memory w) = assetArrays(bucketVec(10_000, 0));
        PlanParams memory pp = PlanParams(PLAN_DURATION, COST_BUDGET_BPS);
        uint256 prevId = fund.currentPlanId();

        vm.prank(c);
        try governance.setTarget(s, w, pp) {
            ++ghostRb1Violations;
        } catch {
            ++revertsCaught[H_UNAUTHORIZED]; // expected: an unauthorized caller
        }
        vm.prank(c);
        try governance.applyReceipt(bytes32(a), bytes32(0), s, w) {
            ++ghostRb1Violations;
        } catch {
            ++revertsCaught[H_UNAUTHORIZED]; // expected: an unauthorized caller
        }
        vm.prank(c);
        try fund.setTargetAndOpenPlan(s, w, pp, bytes32(0)) {
            ++ghostRb1Violations;
        } catch {
            ++revertsCaught[H_UNAUTHORIZED]; // expected: an unauthorized caller
        }
        if (fund.currentPlanId() != prevId) ++ghostRb1Violations;
        _unauthorizedFlows(c);
    }

    function _unauthorizedFlows(address c) private {
        uint256[] memory legs = new uint256[](fund.assetCount());
        vm.prank(c);
        try fund.mintInKind(1e24, 1e6, legs) {
            ++ghostRb1Violations;
        } catch {
            ++revertsCaught[H_UNAUTHORIZED]; // expected: an unauthorized caller
        }
        vm.prank(c);
        try fund.sellForFlow(1, legs) {
            ++ghostRb1Violations;
        } catch {
            ++revertsCaught[H_UNAUTHORIZED]; // expected: an unauthorized caller
        }
        vm.prank(c);
        try fund.ledgerCheckpoint(c) {
            ++ghostRb1Violations;
        } catch {
            ++revertsCaught[H_UNAUTHORIZED]; // expected: an unauthorized caller
        }
        vm.prank(c);
        try queue.freezeSettlement(1) {
            ++ghostRb1Violations;
        } catch {
            ++revertsCaught[H_UNAUTHORIZED]; // expected: an unauthorized caller
        }
        vm.prank(c);
        try queue.releaseSettlement(1) {
            ++ghostRb1Violations;
        } catch {
            ++revertsCaught[H_UNAUTHORIZED]; // expected: an unauthorized caller
        }
        vm.prank(c);
        try queue.setFlowParams(defaultFlowParams()) {
            ++ghostRb1Violations;
        } catch {
            ++revertsCaught[H_UNAUTHORIZED]; // expected: an unauthorized caller
        }
        vm.prank(c);
        try queue.pause() {
            ++ghostRb1Violations;
        } catch {
            ++revertsCaught[H_UNAUTHORIZED]; // expected: an unauthorized caller
        }
        SettleContext memory ctx;
        vm.prank(c);
        try queue.settleDepositSide(1, new Fill[](0), ctx) {
            ++ghostRb1Violations;
        } catch {
            ++revertsCaught[H_UNAUTHORIZED]; // expected: an unauthorized caller
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A scripted run: every handler path once, then every invariant (no check may pass vacuously)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev The free-memory pointer now (see `test_handlers_coverEveryPathThenInvariantsHold`).
    function _memMark() private pure returns (uint256 m) {
        assembly {
            m := mload(0x40)
        }
    }

    /// @dev Put the free-memory pointer back to `m`: memory above it is reused by the next action.
    function _memReset(uint256 m) private pure {
        assembly {
            mstore(0x40, m)
        }
    }

    /// @notice Drives the handlers through every flow path in a fixed order (requests of all three limit kinds,
    ///         settlement by the keeper and by a stranger after the grace, delivery, the redemption claim, cancel,
    ///         an in-kind exit, a freeze and a return, an expiry, credits, an in-kind exit of wallet shares, pause,
    ///         unauthorized calls), checks each path really ran, then runs every invariant on the end state.
    ///         The handlers run as internal calls in this test's own frame, and the free-memory pointer goes back to
    ///         `mark` after each one, so each action's state diff reuses one region of memory (`verify`,
    ///         2026-11-12). On the recorder's fork every call out of the test frame gets at most the pin block's gas
    ///         limit (40M), and decoding a settlement's state diff needs more memory than 40M of gas buys: the
    ///         earlier `this.act_*` calls ran out of gas there (MemoryOOG), though they passed in replay. Each action
    ///         and every check is the same as before. Nothing an action returns is kept in memory across the reset.
    function test_handlers_coverEveryPathThenInvariantsHold() public fixtureCovered {
        uint256 mark = _memMark();
        // The plan invests the idle seed first, so every exit below has lending legs (RB-21 then has claims).
        for (uint256 k; k < 8; ++k) {
            act_step(true);
            _memReset(mark);
        }
        assertGt(stepsExecuted, 0, "the plan stepped");
        (uint256 aaveUnits,) = fund.positionUnits(IDX_AAVE);
        assertGt(aaveUnits, 0, "the fund holds an Aave position");
        coverageCheckpoint();
        act_requestDeposit(0, 10_000e6, 0);
        _memReset(mark);
        act_requestDeposit(1, 10_000e6, 0);
        _memReset(mark);
        act_requestDeposit(2, 5_000e6, 1);
        _memReset(mark);
        act_requestDeposit(0, 2_000e6, 2);
        _memReset(mark);
        act_requestRedeem(0, fund.balanceOf(holders[0]) / 4, false);
        _memReset(mark);
        act_requestRedeem(1, fund.balanceOf(holders[1]) / 4, true);
        _memReset(mark);
        act_settle(1, 64, type(uint256).max, true);
        _memReset(mark);
        assertGt(settlementsMade, 0, "a settlement traded");
        uint256 last = queue.settlementCount() - 1;
        act_claim(0);
        _memReset(mark);
        assertGt(callsClaim, 0, "a redemption claim was taken");
        act_freeze(last);
        _memReset(mark);
        assertGt(callsFreeze, 0, "a settlement was frozen");
        act_releaseOrReturn(last, false);
        _memReset(mark);
        act_takeReturn(0);
        _memReset(mark);
        assertGt(callsTakeReturn, 0, "a return was taken in kind");
        act_releaseOrReturn(last, true);
        _memReset(mark);
        act_deliver(1, true);
        _memReset(mark);
        assertGt(callsDeliver, 0, "unlocked shares were delivered");
        coverageCheckpoint();
        act_requestRedeem(2, fund.balanceOf(holders[2]) / 3, false);
        _memReset(mark);
        act_exitInKind(2, queue.requestCount() - 1);
        _memReset(mark);
        assertGt(callsExitInKind, 0, "a pending redemption left in kind");
        act_requestDeposit(0, 1_000e6, 0);
        _memReset(mark);
        act_cancel(0, queue.requestCount() - 1);
        _memReset(mark);
        assertGt(callsCancel, 0, "a request was cancelled");
        act_withdrawCredit(0);
        _memReset(mark);
        assertGt(callsCredit, 0, "a credit was withdrawn");
        act_withdrawExpired(0, 0, true);
        _memReset(mark);
        assertGt(callsExpired, 0, "an expired request's escrow was withdrawn");
        act_redeemInKind(0, fund.balanceOf(holders[0]) / 5);
        _memReset(mark);
        act_pause(true);
        _memReset(mark);
        act_requestRedeem(1, fund.balanceOf(holders[1]) / 5, false);
        _memReset(mark);
        act_pause(false);
        _memReset(mark);
        act_unauthorized(0, 1);
        _memReset(mark);
        act_requestDeposit(1, 3_000e6, 0);
        _memReset(mark);
        act_settle(0, 64, type(uint256).max, true);
        _memReset(mark);
        assertGt(settlementsMade, 1, "a stranger settled after the grace");

        invariant_mustNotRevert();
        invariant_noLeak();
        invariant_solvencyAndHygiene();
        invariant_RB10_RB11_queueExits();
        invariant_RB12_RB15_blockedAndExits();
        invariant_RB13_RB14_RB16_settlements();
        invariant_RB17_admission();
        invariant_RB18_freezeBounded();
        invariant_RB20_inputsOnlyLimitWork();
        invariant_RB21_positionClaims();
        invariant_RB22_ledgerCountsQueuedShares();
        invariant_conservation();
        (uint256 totalUnits, uint256 claimUnits) = fund.positionUnits(IDX_AAVE);
        assertGt(claimUnits, 0, "in-kind exits past the allowance left position claims (RB-21 is not vacuous)");
        emit log_named_uint("scripted run: Aave position units", totalUnits);
        emit log_named_uint("scripted run: Aave claim units", claimUnits);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Invariants: step 3c (RB-1 to RB-9, INV-1)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice RB-1, RB-6, RB-8 and the per-action ghosts: actions that must never fail did not.
    function invariant_mustNotRevert() public fixtureCovered {
        if (bytes(lastMustSucceedRevert).length != 0) emit log_named_string("must-succeed revert", lastMustSucceedRevert);
        assertEq(ghostInKindReverts, 0, "RB-6: redeemInKind of own shares reverted");
        assertEq(ghostRequestRedeemReverts, 0, "RB-6: a valid redemption request reverted while not paused");
        assertEq(ghostClaimReverts, 0, "a claim the queue reported claimable reverted");
        assertEq(ghostApplyFailures, 0, "valid receipt failed to open a plan through the timelock");
        assertEq(ghostStepReverts, 0, "keeper step() reverted (must skip, not revert)");
        assertEq(ghostRb1Violations, 0, "RB-1: an unauthorized caller opened a plan or moved a flow");
        // `hardening` (step 3 plan §3.3 item 4): no call that had to succeed reverted, in any handler.
        for (uint256 h; h < N_HANDLERS; ++h) {
            assertEq(mustSucceedReverts[h], 0, string.concat("a call that must succeed reverted in ", _handlerName(h)));
        }
        if (coverageMiss) revert FixtureSlotMiss(coverageMissAccount, coverageMissSlot);
    }

    /// @notice RB-4, RB-5, RB-7 on every executed step; RB-4 budget on every plan.
    function invariant_stepBounds() public fixtureCovered {
        assertEq(ghostRb4StepCost, 0, "RB-4: a step cost more than maxStepCostBps of its notional");
        assertEq(ghostRb4HaltedStepped, 0, "RB-4: a non-Open (Halted) plan stepped");
        assertEq(ghostRb4BudgetNotHalted, 0, "RB-4: budget exceeded without a halt");
        assertEq(ghostRb5Cooldown, 0, "RB-5: a step ran before stepInterval");
        assertEq(ghostRb5Market, 0, "RB-5: a step traded an asset failing ORA-4");
        assertEq(ghostRb7PastPath, 0, "RB-7: a step moved past pathTarget(now)");
        assertEq(ghostLivenessSkips, 0, "liveness: a step with a tradeable deviation skipped as nothing to trade");
        Plan memory p = fund.plan();
        assertTrue(p.costSpent <= p.costBudget || p.status == PlanStatus.Halted, "RB-4: costSpent > costBudget");
    }

    /// @notice RB-9: every refused vector reverted with its own error and released nothing. The fund's persistent
    ///         target names every active asset (inactive assets 0) and sums to 10 000 once a plan has opened.
    function invariant_targetVector() public fixtureCovered {
        assertEq(ghostRb9Violations, 0, "RB-9: a refused vector did not revert with its error, or released");
        if (fund.currentPlanId() == 0) return;
        uint16[] memory t = fund.targetBps();
        assertEq(t.length, fund.assetCount(), "RB-9: target is index-aligned to the asset list");
        uint256 sum;
        for (uint256 i; i < t.length; ++i) {
            if (!fund.assetConfig(i).active) assertEq(t[i], 0, "RB-9: inactive asset has a target");
            sum += t[i];
        }
        assertEq(sum, BPS, "RB-9: target does not sum to 10 000");
    }

    /// @notice RB-3 / INV-1: no asset left a system address for a non-holder, non-venue recipient.
    function invariant_noLeak() public fixtureCovered {
        if (ghostInv1Leaks != 0) {
            emit log_named_address("leak from", ghostLeakFrom);
            emit log_named_address("leak to", ghostLeakTo);
        }
        assertEq(ghostInv1Leaks, 0, "INV-1 / RB-3: asset left to a non-holder recipient");
    }

    /// @notice RB-8: the receipt contract never called the fund, rebalancer or governance, and holds nothing.
    function invariant_receiptInert() public fixtureCovered {
        assertEq(ghostRb8Calls, 0, "RB-8: receipt contract called the fund, rebalancer or governance");
        _assertHoldsNothing(address(receipts), "RB-8: receipts");
    }

    /// @notice Shares outstanding are backed; the rebalancer and governance hold nothing; no standing allowance of
    ///         the fund or of the queue. NAV is read with `portfolioValues` (the TWAP sum `totalAssets` returns
    ///         without its feed-health gate, E19), because an invariant may run between a warp and a refresh.
    function invariant_solvencyAndHygiene() public fixtureCovered {
        (uint256 nav,,) = fund.portfolioValues();
        if (fund.totalSupply() > 0) assertGt(nav, 0, "supply > 0 but NAV == 0");
        _assertHoldsNothing(address(rebalancer), "rebalancer");
        _assertHoldsNothing(address(governance), "governance");
        for (uint256 i; i < approvedToken.length; ++i) {
            assertEq(
                IERC20(approvedToken[i]).allowance(address(fund), approvedSpender[i]), 0, "fund left an allowance"
            );
        }
        address[3] memory tokens = [USDC, WETH, CBBTC];
        address[5] memory spenders = [address(swapAdapter), ROUTER, address(aaveAdapter), address(cometAdapter), address(moonwellAdapter)];
        for (uint256 i; i < tokens.length; ++i) {
            for (uint256 j; j < spenders.length; ++j) {
                assertEq(IERC20(tokens[i]).allowance(address(fund), spenders[j]), 0, "fund allowance to venue");
            }
        }
        assertEq(IERC20(USDC).allowance(address(queue), address(fund)), 0, "the queue left an allowance to the fund");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Invariants: step 3d (RB-10 to RB-18, RB-20 to RB-22, conservation)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice RB-10, RB-11: nothing left the queue but what the rules allow (see `_scanLogs`), and every delivery
    ///         was unlocked, unfrozen and the owner's.
    function invariant_RB10_RB11_queueExits() public fixtureCovered {
        _logLastViolation();
        assertEq(ghostRb10, 0, "RB-10: USDC or shares left the queue outside a settlement, claim or exit");
        assertEq(ghostRb11, 0, "RB-11: a deposit share left early, frozen, or to someone else");
    }

    /// @notice RB-12, RB-15: blocked settlements changed nothing; cancels and expiries were exact; cancel and in-kind
    ///         exit never reverted for a pending request, paused or not.
    function invariant_RB12_RB15_blockedAndExits() public fixtureCovered {
        _logLastViolation();
        assertEq(ghostRb12, 0, "RB-12: a blocked settlement moved something, or a return was not exact");
        assertEq(ghostRb15, 0, "RB-15: cancel or in-kind exit reverted for a pending request");
    }

    /// @notice RB-13, RB-14, RB-16 over every settlement and exit of the run.
    function invariant_RB13_RB14_RB16_settlements() public fixtureCovered {
        _logLastViolation();
        assertEq(ghostRb13, 0, "RB-13: a flow lowered an amount per share");
        assertEq(ghostRb14, 0, "RB-14: a fill outside its limit");
        assertEq(ghostRb16, 0, "RB-16: settled past a failed check, or over a cap");
    }

    /// @notice RB-17: every active basket asset has a feed and its maximum age; every lending adapter answers the
    ///         venue's rate. (Pool history and the pool-share rule are checked at admission: FundExtras.t.sol.)
    function invariant_RB17_admission() public view {
        AssetConfig[] memory cfg = fund.assetConfigs();
        for (uint256 i; i < cfg.length; ++i) {
            if (!cfg[i].active) continue;
            if (cfg[i].kind == AssetKind.Basket) {
                assertTrue(cfg[i].feed != address(0) && cfg[i].maxFeedAge != 0, "RB-17: a basket asset without a feed");
            } else {
                assertGt(ILendingRateAdapter(cfg[i].adapter).ratePerUnit(), 0, "RB-17: a lending adapter without a rate");
            }
        }
    }

    /// @notice RB-18: a freeze ends by itself `maxFreeze` after its call and within the hold plus `maxFreeze`; only
    ///         a depositor takes its own return (ghost from `act_takeReturn`).
    function invariant_RB18_freezeBounded() public fixtureCovered {
        _logLastViolation();
        assertEq(ghostRb18, 0, "RB-18: a frozen share moved to someone else, or a freeze misbehaved");
        uint256 maxFreeze = queue.flowParams().maxFreeze;
        uint256 n = queue.settlementCount();
        for (uint256 id = 1; id <= n; ++id) {
            Settlement memory s = queue.getSettlement(id);
            if (s.frozenUntil == 0) continue;
            assertLe(s.frozenUntil, uint256(ghostFreezeAt[id]) + maxFreeze, "RB-18: a freeze outlives maxFreeze");
            assertLe(s.frozenUntil, uint256(s.holdEndsAt) + maxFreeze, "RB-18: a freeze outlives hold + maxFreeze");
        }
    }

    /// @notice RB-20: no settle's bound price depended on its inputs or its caller.
    function invariant_RB20_inputsOnlyLimitWork() public fixtureCovered {
        _logLastViolation();
        assertEq(ghostRb20, 0, "RB-20: a bound price depended on the settle's inputs");
    }

    /// @notice RB-21: for each lending venue, the holders' part plus every position claim is the venue's holding
    ///         less the basket deferrals, to a few units of rounding; the claim units are the fund's count.
    function invariant_RB21_positionClaims() public view {
        (, uint256[] memory held) = fund.heldBalances();
        address[4] memory actors = [holders[0], holders[1], holders[2], feeRecipient];
        for (uint256 i; i < held.length; ++i) {
            AssetConfig memory a = fund.assetConfig(i);
            if (!a.active || a.kind != AssetKind.Lending) continue;
            (, uint256 claimUnits) = fund.positionUnits(i);
            uint256 units;
            uint256 value;
            for (uint256 k; k < actors.length; ++k) {
                (uint256 u, uint256 v) = fund.positionClaimOf(i, actors[k]);
                units += u;
                value += v;
            }
            assertEq(units, claimUnits, "RB-21: claim units are exactly the claimants'");
            uint256 position = IStrategyAdapter(a.adapter).totalAssets();
            assertLe(held[i] + value, position, "RB-21: holders and claims count more than the venue holds");
            assertLe(position, held[i] + value + actors.length + 4, "RB-21: part of the position belongs to nobody");
        }
    }

    /// @notice RB-22: every actor's ledger balance is wallet plus queued shares; the queued shares are an
    ///         independent sum of its escrow, its undelivered deposit shares and its share credit; the queue itself
    ///         counts for nothing.
    function invariant_RB22_ledgerCountsQueuedShares() public view {
        for (uint256 k; k < holders.length; ++k) {
            address h = holders[k];
            uint256 q = queue.queuedSharesOf(h);
            assertEq(fund.ledgerBalanceOf(h), fund.balanceOf(h) + q, "RB-22: ledger = wallet + queued");
            assertEq(q, _independentQueued(h), "RB-22: queued shares = escrow + held + share credit");
        }
        assertEq(fund.ledgerBalanceOf(address(queue)), 0, "RB-22: the queue has no entitlement");
    }

    /// @notice Conservation (eng plan §4.3, §6, the three accounting systems): the queue's books equal independent
    ///         sums over requests, claims and credits; its balances equal setUp's plus every flow booked in, less
    ///         every flow booked out, plus what settlements paid it, less what they took; the fund's supply equals
    ///         setUp's plus minted, less burned by settlements and by in-kind exits.
    function invariant_conservation() public view {
        FlowBooks memory b = queue.books();
        (uint256 pendingUsdc, uint256 escrowShares, uint256 heldShares, uint256 owedUsdc) = _independentBooks();
        assertEq(b.pendingUsdc, pendingUsdc, "books: pending USDC = sum of open deposit escrow");
        assertEq(b.escrowShares, escrowShares, "books: escrow = sum of open redemption escrow");
        assertEq(b.heldShares, heldShares, "books: held = sum of undelivered deposit claims");
        assertEq(b.owedUsdc, owedUsdc, "books: owed = sum of untaken redemption claims");
        (uint256 creditUsdc, uint256 creditShares) = _independentCredits();
        assertEq(b.creditUsdc, creditUsdc, "books: USDC credit = sum of owners' credits");
        assertEq(b.creditShares, creditShares, "books: share credit = sum of owners' credits");
        uint256 qUsdc = IERC20(USDC).balanceOf(address(queue));
        uint256 qShares = fund.balanceOf(address(queue));
        assertEq(qUsdc, b.pendingUsdc + b.owedUsdc + b.creditUsdc + b.dustUsdc, "queue USDC = its books");
        assertEq(qShares, b.escrowShares + b.heldShares + b.creditShares + b.dustShares, "queue shares = its books");

        (uint256 usdcIn, uint256 usdcOut, uint256 minted, uint256 burned) = _settledSinceStart();
        assertEq(
            qUsdc + ghostUsdcOut + usdcIn, startQueueUsdc + ghostUsdcIn + usdcOut, "queue USDC = the flows booked"
        );
        assertEq(
            qShares + ghostSharesOut + ghostQueueSharesBurned + burned,
            startQueueShares + ghostSharesIn + minted,
            "queue shares = the flows booked"
        );
        assertEq(
            fund.totalSupply() + burned + ghostQueueSharesBurned + ghostWalletSharesBurned,
            startSupply + minted,
            "fund supply = setUp's + minted - burned"
        );
    }

    /// @notice Per-run activity summary (shown with -vv). Guards against a vacuous run: handlers may not revert
    ///      outside their own try blocks (`fail-on-revert = true`, so no action is silently dropped), and the run
    ///      did something.
    function afterInvariant() public fixtureCovered {
        assertGt(
            callsDepositRequest + callsRedeemRequest + callsSettle + callsRedeemInKind + callsApply + callsStep,
            0,
            "run did nothing"
        );
        string memory flows = string.concat(
            "requests ", vm.toString(callsDepositRequest), "/", vm.toString(callsRedeemRequest), ", settles ",
            vm.toString(settlementsMade), "/", vm.toString(callsSettle)
        );
        flows = string.concat(
            flows, ", deliveries ", vm.toString(callsDeliver), ", claims ", vm.toString(callsClaim), ", cancels ",
            vm.toString(callsCancel)
        );
        flows = string.concat(
            flows, ", exitsInKind ", vm.toString(callsExitInKind), ", expired ", vm.toString(callsExpired), ", credits ",
            vm.toString(callsCredit)
        );
        flows = string.concat(
            flows, ", freezes ", vm.toString(callsFreeze), "/", vm.toString(callsRelease), "/", vm.toString(callsTakeReturn)
        );
        emit log_named_string("run", flows);
        string memory rebal = string.concat(
            "inKind ", vm.toString(callsRedeemInKind), ", applies ", vm.toString(callsApply), ", refused by the pool-share rule ",
            vm.toString(callsApplyRefusedPoolShare), ", rb9Refused ", vm.toString(callsRb9Refused)
        );
        rebal = string.concat(
            rebal, ", steps ", vm.toString(stepsExecuted), "/", vm.toString(callsStep), ", priceMoves ",
            vm.toString(callsPrice), ", warps ", vm.toString(callsWarp)
        );
        emit log_named_string("run (step 3c)", rebal);
        // Reverts each handler caught (expected ones included) and the must-succeed ones among them.
        string memory caught = "";
        for (uint256 h; h < N_HANDLERS; ++h) {
            if (revertsCaught[h] == 0 && mustSucceedReverts[h] == 0) continue;
            caught = string.concat(
                caught, _handlerName(h), " ", vm.toString(revertsCaught[h]), "/", vm.toString(mustSucceedReverts[h]), "; "
            );
        }
        emit log_named_string("reverts caught / must-succeed reverts", caught);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Internals
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Warp to the end of the oldest open request's settle window (plus the keeper grace for a stranger).
    function _waitForOldestWindow(bool grace) private {
        uint256 n = queue.requestCount();
        for (uint256 id = 1; id <= n; ++id) {
            Request memory r = queue.getRequest(id);
            if (r.closed) continue;
            uint256 t = queue.settleableAt(r.epoch);
            if (grace) t += queue.flowParams().keeperGrace;
            warpForward(t);
            return;
        }
    }

    /// @dev Warp to the earliest unlock of `h`'s still locked deposit claims.
    function _waitForUnlock(address h) private {
        uint256 n = queue.claimCount();
        uint256 t = type(uint256).max;
        for (uint256 c = 1; c <= n; ++c) {
            Claim memory cl = queue.getClaim(c);
            if (cl.owner != h || cl.kind != RequestKind.Deposit || cl.claimed >= cl.shares) continue;
            if (cl.unlockAt > block.timestamp && cl.unlockAt < t) t = cl.unlockAt;
        }
        if (t != type(uint256).max) warpForward(t);
    }

    /// @dev Warp until `h`'s oldest open request has expired (`currentEpoch > epoch + maxRoll`).
    function _waitForExpiry(address h) private {
        uint256 n = queue.requestCount();
        FlowParams memory p = queue.flowParams();
        for (uint256 id = 1; id <= n; ++id) {
            Request memory r = queue.getRequest(id);
            if (r.owner != h || r.closed) continue;
            warpForward((uint256(r.epoch) + p.maxRoll + 1) * p.epochLength);
            return;
        }
    }

    /// @dev Count a step 3d violation under its RB number and keep the latest reason for the report.
    function _violation(string memory why, uint256 rb) private {
        ghostLastViolation = why;
        if (rb == 10) ++ghostRb10;
        else if (rb == 11) ++ghostRb11;
        else if (rb == 12) ++ghostRb12;
        else if (rb == 13) ++ghostRb13;
        else if (rb == 14) ++ghostRb14;
        else if (rb == 15) ++ghostRb15;
        else if (rb == 16) ++ghostRb16;
        else if (rb == 18) ++ghostRb18;
        else if (rb == 20) ++ghostRb20;
        else ++ghostRb12;
    }

    function _logLastViolation() private {
        if (bytes(ghostLastViolation).length != 0) emit log_named_string("last violation", ghostLastViolation);
    }

    /// @dev A request of `h` that still holds escrow: the `k`-th in id order (wrapping), of the redemption kind
    ///      only when `redeemOnly`, and expired only when `expiredOnly` (else pending or expired).
    function _pickOpen(address h, uint256 k, bool redeemOnly, bool expiredOnly)
        private
        view
        returns (bool found, uint256 id)
    {
        uint256 n = queue.requestCount();
        if (n == 0) return (false, 0);
        for (uint256 j; j < n; ++j) {
            id = 1 + (k % n + j) % n;
            Request memory r = queue.getRequest(id);
            if (r.owner != h || r.closed || r.remaining == 0) continue;
            if (redeemOnly && r.kind != RequestKind.Redeem) continue;
            RequestStatus st = queue.requestStatus(id);
            if (expiredOnly && st != RequestStatus.Expired) continue;
            return (true, id);
        }
        return (false, 0);
    }

    /// @dev Escrow of open requests and undelivered or untaken claims, summed from the queue's own records.
    function _independentBooks()
        private
        view
        returns (uint256 pendingUsdc, uint256 escrowShares, uint256 heldShares, uint256 owedUsdc)
    {
        uint256 n = queue.requestCount();
        for (uint256 id = 1; id <= n; ++id) {
            Request memory r = queue.getRequest(id);
            if (r.closed) continue;
            if (r.kind == RequestKind.Deposit) pendingUsdc += r.remaining;
            else escrowShares += r.remaining;
        }
        n = queue.claimCount();
        for (uint256 c = 1; c <= n; ++c) {
            Claim memory cl = queue.getClaim(c);
            if (cl.kind == RequestKind.Deposit) heldShares += cl.shares - cl.claimed;
            else owedUsdc += cl.usdc - cl.claimed;
        }
    }

    function _independentCredits() private view returns (uint256 usdc, uint256 shares) {
        for (uint256 k; k < holders.length; ++k) {
            (uint256 u, uint256 s) = queue.creditOf(holders[k]);
            usdc += u;
            shares += s;
        }
    }

    /// @dev `h`'s escrowed redemption shares, undelivered deposit shares and share credit.
    function _independentQueued(address h) private view returns (uint256 q) {
        uint256 n = queue.requestCount();
        for (uint256 id = 1; id <= n; ++id) {
            Request memory r = queue.getRequest(id);
            if (r.owner == h && !r.closed && r.kind == RequestKind.Redeem) q += r.remaining;
        }
        n = queue.claimCount();
        for (uint256 c = 1; c <= n; ++c) {
            Claim memory cl = queue.getClaim(c);
            if (cl.owner == h && cl.kind == RequestKind.Deposit) q += cl.shares - cl.claimed;
        }
        (, uint256 s) = queue.creditOf(h);
        q += s;
    }

    /// @dev What the settlements made since setUp moved between the queue and the fund.
    function _settledSinceStart()
        private
        view
        returns (uint256 usdcIn, uint256 usdcOut, uint256 minted, uint256 burned)
    {
        uint256 n = queue.settlementCount();
        for (uint256 id = startSettlements + 1; id <= n; ++id) {
            Settlement memory s = queue.getSettlement(id);
            usdcIn += s.usdcIn;
            usdcOut += s.usdcOut;
            minted += s.sharesMinted;
            burned += s.sharesBurned;
        }
    }

    /// @dev NAV at the feeds as the queue's check 7 computes it (idle, lending held, basket held at the feed price
    ///      converted with the USDC feed), for the cap bound of RB-16.
    function _navAtFeeds() private view returns (uint256 nav) {
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        nav = idle;
        uint256 usdc8 = uint256(feedPrice8[FEED_USDC]);
        for (uint256 i; i < held.length; ++i) {
            if (i == IDX_WETH) nav += held[i].mulDiv(uint256(feedPrice8[FEED_ETH]) * 1e6, usdc8 * 1e18);
            else if (i == IDX_CBBTC) nav += held[i].mulDiv(uint256(feedPrice8[FEED_CBBTC]) * 1e6, usdc8 * 1e8);
            else nav += held[i];
        }
    }

    /// @dev The TWAP NAV (`portfolioValues`, the sum `totalAssets` returns without its feed gate, E19).
    function _twapNav() private view returns (uint256 nav) {
        (nav,,) = fund.portfolioValues();
    }

    function _snapPerShare() private {
        (pre.idle, pre.held) = fund.heldBalances();
        pre.supply = fund.totalSupply();
    }

    /// @dev Check 10 from outside (RB-13): no held amount per share fell since `_snapPerShare`.
    function _checkPerShare(string memory where) private {
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        uint256 supply = fund.totalSupply();
        if (idle * pre.supply < pre.idle * supply) _violation(string.concat("RB-13: idle per share fell in ", where), 13);
        for (uint256 i; i < held.length; ++i) {
            if (held[i] * pre.supply < pre.held[i] * supply) {
                _violation(string.concat("RB-13: an asset per share fell in ", where), 13);
            }
        }
    }

    function _assertHoldsNothing(address who, string memory label) private view {
        address[5] memory tokens = [USDC, WETH, CBBTC, AAVE_A_USDC, address(fund)];
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(IERC20(tokens[i]).balanceOf(who), 0, label);
        }
    }

    /// @dev Independent of `PlanMath.pickLegs`: the plan is Open and before its end (no conclusion pending), the
    ///      cooldown has passed, and among idle and the eligible assets (active, `maxStepUsdc > 0`, not backed
    ///      off, ORA-4 ok) one sits over its path value and one under it, each by at least `minStepUsdc`. Every
    ///      non-zero `maxStepUsdc` is at least `minStepUsdc` (a `setAssetStepParams` bound), so such a step's
    ///      notional is at least `minStepUsdc` and it must not skip NothingToTrade or BelowMinStep.
    function _independentlyReady(Pre memory p0) private view returns (bool) {
        if (p0.status != PlanStatus.Open || block.timestamp < p0.readyAt) return false;
        if (block.timestamp >= p0.plan.endTime) return false;
        uint256 minStep = rebalancer.stepParams().minStepUsdc;
        uint256 t = _pathValue(p0.plan, IDLE_INDEX, block.timestamp, p0.nav);
        uint256 maxOver = p0.idle > t ? p0.idle - t : 0;
        uint256 maxUnder = t > p0.idle ? t - p0.idle : 0;
        for (uint256 i; i < p0.marketOk.length; ++i) {
            if (!p0.marketOk[i] || rebalancer.assetStepParams(i).maxStepUsdc == 0) continue;
            if (rebalancer.assetBackoffUntil(i) >= block.timestamp || !fund.assetConfig(i).active) continue;
            t = _pathValue(p0.plan, i, block.timestamp, p0.nav);
            uint256 v = p0.values[i];
            if (v > t && v - t > maxOver) maxOver = v - t;
            if (t > v && t - v > maxUnder) maxUnder = t - v;
        }
        return maxOver >= minStep && maxUnder >= minStep;
    }

    /// @dev Independent port of the §5.2 path value: `nav × (start×d + (end−start)×e) / (d × 10 000)`, the
    ///      shrinking side rounded up (toward start). Idle's path ends at 0.
    function _pathValue(Plan memory p, uint256 index, uint256 t, uint256 nav) private pure returns (uint256) {
        uint256 e;
        uint256 d;
        if (p.endTime <= p.startTime) {
            (e, d) = (1, 1);
        } else {
            d = p.endTime - p.startTime;
            e = t <= p.startTime ? 0 : Math.min(t - p.startTime, d);
        }
        uint256 s0 = index == IDLE_INDEX ? p.startIdleBps : p.startBps[index];
        uint256 s1 = index == IDLE_INDEX ? 0 : p.endBps[index];
        if (s1 >= s0) return nav.mulDiv(s0 * d + (s1 - s0) * e, d * BPS);
        return nav.mulDiv(s0 * d - (s0 - s1) * e, d * BPS, Math.Rounding.Ceil);
    }

    /// @dev INV-1 / RB-3 and RB-10 over one action's logs. A Transfer out of a system address must land on a venue
    ///      (or the fund), on the action's holder, the fee recipient, or address(0) (a venue receipt-token burn).
    ///      The fund may pay the queue (a sale's proceeds, a purchase's refund). Out of the queue (RB-10): in a
    ///      settlement only to the fund (the purchase) or burned (the sale); in a payout only to the owner; in an
    ///      in-kind exit only burned; in any other action nothing. During a fund action, a pool pays only the fund.
    ///      Approvals by the fund are remembered for the allowance check.
    function _scanLogs(VmSafe.Log[] memory logs) private {
        for (uint256 k; k < logs.length; ++k) {
            VmSafe.Log memory l = logs[k];
            if (l.topics.length != 3) continue;
            address from = address(uint160(uint256(l.topics[1])));
            address to = address(uint160(uint256(l.topics[2])));
            if (l.topics[0] == APPROVAL_SIG) {
                if (from != address(fund)) continue;
                bytes32 key = keccak256(abi.encode(l.emitter, to));
                if (!approvalSeen[key]) {
                    approvalSeen[key] = true;
                    approvedToken.push(l.emitter);
                    approvedSpender.push(to);
                }
                continue;
            }
            if (l.topics[0] != TRANSFER_SIG) continue;
            if (from == address(queue)) {
                _checkQueueTransfer(to);
            } else if (isSystem[from]) {
                bool ok = venueOk[to] || to == feeRecipient || (to == actionHolder && actionHolder != address(0))
                    || (to == address(0) && from != address(fund)) || (from == address(fund) && to == address(queue));
                if (!ok) _leak(from, to);
            } else if (!actionIsMarket && (from == WETH_POOL || from == CBBTC_POOL)) {
                if (to != address(fund)) _leak(from, to);
            }
        }
    }

    /// @dev RB-10: the one rule for a transfer out of the queue in the action in flight.
    function _checkQueueTransfer(address to) private {
        bool ok;
        if (actionKind == ACT_SETTLE) ok = to == address(fund) || to == address(0);
        else if (actionKind == ACT_PAY) ok = to == actionHolder && actionHolder != address(0);
        else if (actionKind == ACT_EXIT) ok = to == address(0);
        if (!ok) {
            _violation("RB-10: a transfer left the queue outside a settlement, payout or exit", 10);
            _leak(address(queue), to);
        }
    }

    function _leak(address from, address to) private {
        ++ghostInv1Leaks;
        ghostLeakFrom = from;
        ghostLeakTo = to;
    }

    /// @dev RB-8 over one action's state diff (the receipt proxy or its implementation never touches the fund,
    ///      rebalancer or governance), then the fixture coverage check in replay.
    function _scanAccesses(VmSafe.AccountAccess[] memory acc) private {
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.AccountAccess memory x = acc[i];
            if (x.accessor != address(receipts) && x.accessor != receiptImpl) continue;
            if (x.account == address(fund) || x.account == address(rebalancer) || x.account == address(governance)) {
                ++ghostRb8Calls;
            }
        }
        if (fixtureCheck) _coverage(acc);
    }

    function _loadCoverageIndex() private {
        // Parsed once, unmetered: a parse per account copies the whole meta file per account (BaseFixture).
        vm.pauseGasMetering();
        string memory meta = vm.readFile(META_PATH);
        address[] memory accounts = vm.parseJsonAddressArray(meta, ".accounts");
        bytes32[][] memory slots = abi.decode(vm.parseJson(meta, ".slots"), (bytes32[][]));
        require(slots.length == accounts.length, "fixture meta: one slot list per account");
        for (uint256 i; i < accounts.length; ++i) {
            _cvAccount[accounts[i]] = true;
            for (uint256 j; j < slots[i].length; ++j) {
                _cvSlot[accounts[i]][slots[i][j]] = true;
            }
        }
        vm.resumeGasMetering();
    }

    /// @dev Same rule as `BaseFixture._assertFixtureCovered`, but records the first miss for the invariant to
    ///      report (a revert inside a handler would be swallowed by `fail-on-revert = false`).
    function _coverage(VmSafe.AccountAccess[] memory acc) private {
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].kind == VmSafe.AccountAccessKind.Create) {
                _cvCreated[acc[i].account] = true;
                _created[acc[i].account] = true; // BaseFixture's own check never sees this part of the diff
            }
        }
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.AccountAccess memory x = acc[i];
            bool isCall = x.kind == VmSafe.AccountAccessKind.Call || x.kind == VmSafe.AccountAccessKind.StaticCall
                || x.kind == VmSafe.AccountAccessKind.DelegateCall;
            if (
                isCall && x.data.length != 0 && !_cvAccount[x.account] && !_cvCreated[x.account]
                    && uint160(x.account) > 0xffff && x.account.code.length == 0
            ) _miss(x.account, bytes32(0));
            for (uint256 j; j < x.storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory s = x.storageAccesses[j];
                if (!_cvAccount[s.account] || _cvCreated[s.account] || _cvSeen[s.account][s.slot]) continue;
                _cvSeen[s.account][s.slot] = true;
                if (!s.isWrite && !_cvSlot[s.account][s.slot]) _miss(s.account, s.slot);
            }
        }
    }

    function _miss(address account, bytes32 slot) private {
        if (coverageMiss) return;
        coverageMiss = true;
        coverageMissAccount = account;
        coverageMissSlot = slot;
    }
}

/// @dev The queue's `BelowMinRequest` selector, named for the refusal filter of `_requestRedeem`.
library IFlowEventsSel {
    bytes4 internal constant BELOW_MIN = bytes4(keccak256("BelowMinRequest(uint256,uint256)"));
}
