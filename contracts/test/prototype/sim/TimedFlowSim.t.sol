// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md §4.4 (sim: timed flows, PROTO_SIM_FLOWS=timed);
//            docs/technical/one-vault-rebalancer-proposal.md §10 step 3d ("rerun the step 3 sim with timed flows"),
//            §10 step 3e (the rules of the rerun), §5.9.5 (values set from the sim's normal range), §13 G4 / G5 / G9;
//            one-vault-step3-finish-plan.md §3.4
// Experiment prototype only (contracts/test/prototype/). Plan step 3d / 3e (gates G4, G5, G9).
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {SimLib} from "./SimLib.sol";
import {TimedSimBase} from "./TimedSimBase.sol";
import {
    AssetStepParams,
    BPS,
    IDLE_INDEX,
    IFundEvents,
    Plan,
    PlanParams,
    PlanStatus,
    SkipReason,
    StepParams
} from "../../../FundTypes.sol";
import {FlowParams, RequestKind, RequestStatus} from "../../../FlowTypes.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {PlanMath} from "../../../PlanMath.sol";

/// @notice One-vault experiment, steps 3d and 3e: the rebalance simulation with timed, quantity-based flows
///         (eng plan §4.4, `PROTO_SIM_FLOWS=timed`). Each test is one (scenario, fund size, seed) of the step 3 sim,
///         run on the live fund: the §4.5 list (Aave, Moonwell, wETH, cbBTC, Compound), the FlowQueue, the feeds.
///
///         What is the same as step 3 (`RebalanceSim.t.sol`, the synchronous arm on the frozen fund): scenarios,
///         seeds (`SimLib.seedOf`, same scenario ids), the pin, the market model for wETH and cbBTC (`SimMarket`:
///         the same draws), the keeper's step every `stepInterval`, the flow draws (one flow in 12 slots, 0.10 % to
///         0.50 % of NAV, at t + 1500), the plan rows of the JSON and the scorer's cost definition.
///
///         What the rules of step 3e change (proposal §10 step 3e, fixed before any result):
///         - the asset list is §4.5: no deSPXA;
///         - each replayed receipt's deSPXA weight is spread over its other assets in proportion to their weights in
///           the same receipt (`_rule3e`; largest remainder to whole bps, ties to the lower step 3 index);
///         - EXT moves between all lending and all basket, the basket being wETH and cbBTC at their receipt
///           proportions (the general rule gives X = 50 / 50 wETH / cbBTC);
///         - JUMP moves the wETH price by the size and at the slot step 3 moved deSPXA (`SimMarket._mkWalkAndArb`).
///
///         What step 3d changes:
///         - flows are requests with limits: a deposit or redemption request at t + 1500, its limit set from the
///           queue's quote with `USER_LIMIT_SLACK_BPS` of room (a client's default, §5.9.2 step 2);
///         - the keeper settles every epoch at the end of its window and retries a failed call every slot
///           (`TimedSimBase`); the feeds follow the reference walk with their deviation threshold and heartbeat;
///         - genesis: the seed (100,000 USDC, E14) is invested to the genesis target by a 1-day plan, then the
///           genesis holders deposit `fund size − seed` through the queue in chunks of 245,000 USDC, one per cap
///           period, and their shares are delivered after the hold. The market stands still during genesis (the
///           walk starts with the first scenario plan), so NAV at the first plan is the step 3 fund size.
///
///         Outputs, beside step 3's in `out/prototype/<run>-timed/sim-<scenario>-<M>M-s<k>.json`, scored by
///         `score-sim.ts`: the plan rows (G4, G5, as step 3), and a `timed` block with every keeper attempt (its
///         outcome by check and the market quantities each §5.9.5 value bounds), every settlement (both sides' cost
///         against the feed and the reference, for netting) and every request (wait, fills, cost against the feed
///         before the exit fee) for G9.
///
///         Opt-in: PROTO_SIM=1 and PROTO_SIM_FLOWS=timed. PROTO_SIM_RUN=default|tuned as in step 3 (the tuned step
///         and plan values of `RebalanceSim._applyTuned`). PROTO_SIM_FLOW_<FIELD> overrides a FlowParams value and
///         PROTO_SIM_USER_SLACK_BPS the clients' slack; either needs PROTO_SIM_TAG, which names the output
///         directory (`<run>-timed-<tag>`), so an override never writes over the scored run.
contract TimedFlowSimTest is TimedSimBase {
    using Math for uint256;

    // ─── Scenarios (the ids of RebalanceSim, so the seeds match) ────────────────────────────────────────

    uint256 internal constant SCN_SEQ = 0;
    uint256 internal constant SCN_EXT = 1;
    uint256 internal constant SCN_EXT_PROBE = 2;
    uint256 internal constant SCN_JUMP_DOWN = 3;
    uint256 internal constant SCN_JUMP_UP = 4;

    uint256 internal constant LOOP_SLACK_SLOTS = 4;
    uint256 internal constant JUMP_SLOT = 168;
    int256 internal constant JUMP_DOWN_USD_MILLITICKS = -1_053_658;
    int256 internal constant JUMP_UP_USD_MILLITICKS = 953_149;
    uint256 internal constant FLOW_ONE_IN = 12;
    uint256 internal constant FLOW_MIN_BPS = 10;
    uint256 internal constant FLOW_SPAN_BPS = 41;
    uint256 internal constant OUT_OF_RANGE_L_DIV = 100;
    uint256 internal constant N_SKIP = 16;

    /// @dev Genesis deposit chunk: under the 250,000 USDC cap floor, so each fills whole in its own period.
    uint256 internal constant GENESIS_CHUNK_USDC = 245_000e6;
    /// @dev A client's room over the quote when it sets a request's limit (an assumption, written into the JSON).
    uint256 internal constant USER_LIMIT_SLACK_BPS = 100;

    uint64 internal constant TUNED_PLAN_DURATION = 21 days;
    uint128 internal constant TUNED_MIN_STEP_USDC = 33e6;

    /// @dev Lending asset indices of the live fund: Aave, Moonwell, Compound.
    uint256[3] internal LEND = [uint256(0), 1, 4];

    struct Snap {
        uint256 nav;
        uint256 idle;
        uint256 supply;
        uint256[3] lend;
        uint256[2] q;
        uint256[2] val;
    }

    /// @dev Per-plan accumulators. The fields of RebalanceSim's `Acc` the scorer reads keep their meaning.
    struct Acc {
        uint256 planId;
        uint256 slots;
        uint256 calls;
        uint256 executed;
        uint256[16] byReason;
        uint256 traded;
        uint256 fundCost;
        int256 signedCost;
        int256 feedCost;
        int256 execCost;
        int256 basisCost;
        uint256 maxStepFundBps;
        int256 maxStepExecBps;
        int256 priceMove;
        int256 interest;
        uint256 unexplainedDrop;
        uint256 residualAbs;
        uint256 deposits;
        uint256 redeems;
        uint256 depositRequests;
        uint256 redeemRequests;
        uint256 flowsBlocked;
        uint256 flowLoss;
        int256 dilution;
        uint256 concludedAt;
        uint256 jumpAt;
        uint256 lastFailSelector;
        string flowFailReason;
        uint256[4] startSleeve;
        uint256[4] endSleeve;
        uint256 startNav;
        int256 execCostRef;
        uint256 flowLossRef;
        uint256 maskedCalls;
        uint256[2] outOfRangeCalls;
        uint256 bookedAtTwap;
        uint256 bookedAtFeed;
        uint256 bookedOther;
        uint256 bookedZero;
        uint256 settleAttempts;
        uint256 settleBlocked;
    }

    // ─── Run state ──────────────────────────────────────────────────────────────────────────────────────

    uint256 internal scenario;
    uint256 internal fundSize;
    uint256 internal seedK;
    string internal scnName;
    uint256 internal pinBlock;
    uint256 internal pinTimestamp;
    uint256 internal depNonce;
    /// @dev Keeper slots on which the step was held back by the ordering rule (`_holdSteps`).
    uint256 internal stepsHeld;
    uint256 internal planIndex;
    string internal planLabel;
    string internal runName;
    string internal runTag;
    uint256 internal userSlackBps;
    uint256 internal maxPlanSlots;
    uint256 internal marketStartAt;
    uint256[2] internal p0Usdc;
    uint256[] internal finalW;
    uint256 internal finalIdle;
    address[] internal genesisDepositors;
    uint256 internal kNav;
    uint256[] internal kValues;

    Acc internal acc;
    Snap internal lastPost;
    Snap internal settlePre;
    string[] internal planJson;

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Tests: the step 3 set, one per (scenario, fund, seed)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_timed_SEQ_1M_s0() public fixtureCovered {
        _run(SCN_SEQ, 1, 0);
    }

    function test_timed_SEQ_1M_s1() public fixtureCovered {
        _run(SCN_SEQ, 1, 1);
    }

    function test_timed_SEQ_1M_s2() public fixtureCovered {
        _run(SCN_SEQ, 1, 2);
    }

    function test_timed_SEQ_5M_s0() public fixtureCovered {
        _run(SCN_SEQ, 5, 0);
    }

    function test_timed_SEQ_5M_s1() public fixtureCovered {
        _run(SCN_SEQ, 5, 1);
    }

    function test_timed_SEQ_5M_s2() public fixtureCovered {
        _run(SCN_SEQ, 5, 2);
    }

    function test_timed_EXT_1M_s0() public fixtureCovered {
        _run(SCN_EXT, 1, 0);
    }

    function test_timed_EXT_1M_s1() public fixtureCovered {
        _run(SCN_EXT, 1, 1);
    }

    function test_timed_EXT_1M_s2() public fixtureCovered {
        _run(SCN_EXT, 1, 2);
    }

    function test_timed_EXT_PROBE_5M_s0() public fixtureCovered {
        _run(SCN_EXT_PROBE, 5, 0);
    }

    function test_timed_JUMP_DOWN_1M_s0() public fixtureCovered {
        _run(SCN_JUMP_DOWN, 1, 0);
    }

    function test_timed_JUMP_DOWN_1M_s1() public fixtureCovered {
        _run(SCN_JUMP_DOWN, 1, 1);
    }

    function test_timed_JUMP_DOWN_1M_s2() public fixtureCovered {
        _run(SCN_JUMP_DOWN, 1, 2);
    }

    function test_timed_JUMP_UP_1M_s0() public fixtureCovered {
        _run(SCN_JUMP_UP, 1, 0);
    }

    function test_timed_JUMP_UP_1M_s1() public fixtureCovered {
        _run(SCN_JUMP_UP, 1, 1);
    }

    function test_timed_JUMP_UP_1M_s2() public fixtureCovered {
        _run(SCN_JUMP_UP, 1, 2);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Driver
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _run(uint256 scn, uint256 fundM, uint256 k) internal virtual {
        if (!vm.envOr("PROTO_SIM", false)) {
            _skipCovered("");
            return;
        }
        if (keccak256(bytes(vm.envOr("PROTO_SIM_FLOWS", string("sync")))) != keccak256("timed")) {
            _skipCovered("");
            return;
        }
        _selectParams();
        _initSim(scn, fundM * 1_000_000e6, k);
        this.simGenesis();
        coverageCheckpoint();
        _schedInit();
        marketStartAt = vm.getBlockTimestamp();
        lastPost = _snap();

        (uint16[5][] memory vecs, string[] memory labels) = _sequence(scn);
        for (uint256 i; i < vecs.length; ++i) {
            _runPlan(vecs[i], labels[i]);
            coverageCheckpoint();
            vm.resetGasMetering();
            if (i + 1 < vecs.length) this.simSlot(false);
        }
        _writeJson(fundM);
    }

    // ─── Scenario vectors under the rules of step 3e ────────────────────────────────────────────────────

    /// @dev The step 3 vectors of `RebalanceSim._sequence` in its order [aave, comet, moonwell, wETH, cbBTC,
    ///      deSPXA], each turned into a live vector [aave, moonwell, wETH, cbBTC, comet] by `_rule3e`.
    function _sequence(uint256 scn)
        internal
        pure
        returns (uint16[5][] memory v, string[] memory l)
    {
        if (scn == SCN_SEQ) {
            v = new uint16[5][](4);
            l = new string[](4);
            (v[0], l[0]) = (_rule3e([uint16(3_650), 2_737, 2_738, 262, 263, 350]), "R1p");
            (v[1], l[1]) = (_rule3e([uint16(3_800), 2_850, 2_850, 250, 250, 0]), "d05");
            (v[2], l[2]) = (_rule3e([uint16(3_200), 2_400, 2_400, 500, 500, 1_000]), "d07");
            (v[3], l[3]) = (_rule3e([uint16(2_800), 2_100, 2_100, 750, 750, 1_500]), "d08");
        } else if (scn == SCN_EXT || scn == SCN_EXT_PROBE) {
            v = new uint16[5][](2);
            l = new string[](2);
            (v[0], l[0]) = (_rule3e([uint16(0), 0, 0, 2_500, 2_500, 5_000]), "X");
            (v[1], l[1]) = (_rule3e([uint16(4_000), 3_000, 3_000, 0, 0, 0]), "G");
        } else {
            v = new uint16[5][](1);
            l = new string[](1);
            (v[0], l[0]) = (_rule3e([uint16(3_200), 2_400, 2_400, 500, 500, 1_000]), "d07");
        }
    }

    /// @notice Proposal §10 step 3e: spread the deSPXA weight (`v6[5]`) over the other five in proportion to their
    ///         weights in the same receipt: `w_i × 10 000 / (10 000 − deSPXA)`, floored, the remaining whole bps to
    ///         the largest remainders (ties to the lower step 3 index). Returns the live order.
    function _rule3e(uint16[6] memory v6) internal pure returns (uint16[5] memory live) {
        uint256 s;
        for (uint256 i; i < 5; ++i) {
            s += v6[i];
        }
        require(
            s + v6[5] == BPS && s != 0,
            "rule 3e: a receipt sums to 10 000 and holds a non-deSPXA asset"
        );
        uint256[5] memory w;
        uint256[5] memory rem;
        uint256 sum;
        for (uint256 i; i < 5; ++i) {
            w[i] = uint256(v6[i]) * BPS / s;
            rem[i] = uint256(v6[i]) * BPS % s;
            sum += w[i];
        }
        for (uint256 r = BPS - sum; r > 0; --r) {
            uint256 best = 5;
            for (uint256 i; i < 5; ++i) {
                if (v6[i] != 0 && (best == 5 || rem[i] > rem[best])) best = i;
            }
            ++w[best];
            rem[best] = 0;
        }
        // Step 3 order [aave, comet, moonwell, wETH, cbBTC] -> live [aave, moonwell, wETH, cbBTC, comet].
        live = [uint16(w[0]), uint16(w[2]), uint16(w[3]), uint16(w[4]), uint16(w[1])];
    }

    function _scnName(uint256 scn) internal pure returns (string memory) {
        if (scn == SCN_SEQ) return "SEQ";
        if (scn == SCN_EXT) return "EXT";
        if (scn == SCN_EXT_PROBE) return "EXT-PROBE";
        if (scn == SCN_JUMP_DOWN) return "JUMP-DOWN";
        return "JUMP-UP";
    }

    function _isJump() internal view returns (bool) {
        return scenario == SCN_JUMP_DOWN || scenario == SCN_JUMP_UP;
    }

    // ─── Parameter set ──────────────────────────────────────────────────────────────────────────────────

    function _selectParams() internal {
        runName = vm.envOr("PROTO_SIM_RUN", string("default"));
        bytes32 r = keccak256(bytes(runName));
        require(
            r == keccak256("default") || r == keccak256("tuned"),
            "timed: PROTO_SIM_RUN must be default or tuned"
        );
        require(
            keccak256(bytes(vm.envOr("PROTO_SIM_LP", string("static")))) == keccak256("static"),
            "timed: only the static LP model is built (PROTO_SIM_LP=recenter is a step 3c sensitivity)"
        );
        runTag = vm.envOr("PROTO_SIM_TAG", string(""));
        if (r == keccak256("tuned")) _applyTuned();
        bool overridden = _applyFlowOverrides();
        userSlackBps = vm.envOr("PROTO_SIM_USER_SLACK_BPS", USER_LIMIT_SLACK_BPS);
        if (userSlackBps != USER_LIMIT_SLACK_BPS) overridden = true;
        require(
            !overridden || bytes(runTag).length != 0,
            "timed: an override needs PROTO_SIM_TAG (output dir)"
        );
        PlanParams memory pp = governance.defaultPlanParams();
        uint256 interval = rebalancer.effectiveStepInterval();
        maxPlanSlots = (uint256(pp.duration) + rebalancer.stepParams().maxOverrun) / interval
            + LOOP_SLACK_SLOTS;
    }

    /// @dev `RebalanceSim._applyTuned` on the live list (wETH and cbBTC only).
    function _applyTuned() internal {
        StepParams memory sp = rebalancer.stepParams();
        sp.maxOverrun = uint32(vm.envOr("PROTO_SIM_TUNED_MAX_OVERRUN", uint256(sp.maxOverrun)));
        sp.maxStepCostBps =
            uint16(vm.envOr("PROTO_SIM_TUNED_MAX_STEP_COST_BPS", uint256(sp.maxStepCostBps)));
        sp.toleranceBps =
            uint16(vm.envOr("PROTO_SIM_TUNED_TOLERANCE_BPS", uint256(sp.toleranceBps)));
        sp.minStepUsdc =
            uint128(vm.envOr("PROTO_SIM_TUNED_MIN_STEP_USDC", uint256(TUNED_MIN_STEP_USDC)));
        timelockExecute(address(rebalancer), abi.encodeCall(rebalancer.setStepParams, (sp)));
        string[2] memory names = ["WETH", "CBBTC"];
        for (uint256 b; b < MK_N; ++b) {
            uint256 i = IDX_WETH + b;
            AssetStepParams memory ap = rebalancer.assetStepParams(i);
            ap.maxStepUsdc = uint128(
                vm.envOr(
                    string.concat("PROTO_SIM_TUNED_", names[b], "_MAX_STEP_USDC"),
                    uint256(ap.maxStepUsdc)
                )
            );
            ap.maxStepSlippageBps = uint16(
                vm.envOr(
                    string.concat("PROTO_SIM_TUNED_", names[b], "_SLIPPAGE_BPS"),
                    uint256(ap.maxStepSlippageBps)
                )
            );
            timelockExecute(
                address(rebalancer), abi.encodeCall(rebalancer.setAssetStepParams, (i, ap))
            );
        }
        PlanParams memory pp = governance.defaultPlanParams();
        pp.duration =
            uint64(vm.envOr("PROTO_SIM_TUNED_PLAN_DURATION", uint256(TUNED_PLAN_DURATION)));
        pp.costBudgetBps =
            uint16(vm.envOr("PROTO_SIM_TUNED_COST_BUDGET_BPS", uint256(pp.costBudgetBps)));
        timelockExecute(address(governance), abi.encodeCall(governance.setDefaultPlanParams, (pp)));
    }

    // ─── Setup ──────────────────────────────────────────────────────────────────────────────────────────

    function _initSim(uint256 scn, uint256 size, uint256 k) internal {
        scenario = scn;
        fundSize = size;
        seedK = k;
        scnName = _scnName(scn);
        pinBlock = vm.getBlockNumber();
        pinTimestamp = vm.getBlockTimestamp();
        _mkInit(SimLib.seedOf(scn, size, k));
        for (uint256 b; b < MK_N; ++b) {
            p0Usdc[b] =
                fund.assetUsdcValue(IDX_WETH + b, 10 ** IERC20Metadata(mkTokens[b]).decimals());
        }
    }

    /// @notice Self-call: genesis (see the contract note). The market stands still; the feeds sit on the reference.
    function simGenesis() external {
        require(msg.sender == address(this), "self only");
        _feedInit();
        uint16[5] memory g = _isJump()
            ? _rule3e([uint16(3_800), 2_850, 2_850, 250, 250, 0])
            : _rule3e([uint16(4_000), 3_000, 3_000, 0, 0, 0]);
        _investQuiet(g);
        uint256 n = fundSize > 1_000_000e6 ? fundSize / PER_DEPOSIT_CAP : 4;
        address[] memory hs = new address[](n);
        for (uint256 i; i < n; ++i) {
            hs[i] = makeAddr(string.concat("sim-genesis-", vm.toString(i)));
            genesisDepositors.push(hs[i]);
        }
        _depositQuiet(hs, fundSize - SEED_USDC, GENESIS_CHUNK_USDC);
    }

    // ─── One plan ───────────────────────────────────────────────────────────────────────────────────────

    function _runPlan(uint16[5] memory vec, string memory label) internal {
        this.simOpen(vec, label);
        _until(vm.getBlockTimestamp() + rebalancer.effectiveStepInterval());
        for (uint256 s; s < maxPlanSlots && fund.planStatus() == PlanStatus.Open; ++s) {
            vm.resetGasMetering();
            this.simSlot(true);
            // Unmetered (the harness's coverageCheckpoint): one slot's state diff per decode (verify notes §4).
            coverageCheckpoint();
        }
        this.simClose();
    }

    /// @notice Self-call: open the plan through the receipt and timelock path and reset the accumulators.
    function simOpen(uint16[5] calldata vec, string calldata label) external {
        require(msg.sender == address(this), "self only");
        (uint256[4] memory sw,) = bucketWeightsBps();
        (uint256 navBefore,,) = fund.portfolioValues();
        uint256 id = recordAndApply(vec);
        delete acc;
        acc.planId = id;
        acc.startSleeve = sw;
        acc.endSleeve = bucketsOf(vec);
        acc.startNav = navBefore;
        planLabel = label;
        ++planIndex;
        lastPost = _snap();
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Open), "plan opened");
    }

    /// @notice Self-call: one slot. Keeper (retry a failed settle, then step) at t, noise at t+600, walk, arb and
    ///         feed deviation rounds at t+1200, a flow request at t+1500; the keeper's scheduled settles land at
    ///         each window end on the way (`_until`).
    function simSlot(bool withKeeper) external {
        require(msg.sender == address(this), "self only");
        uint256 t0 = vm.getBlockTimestamp();
        _retrySettle();
        if (withKeeper) _keeper();
        _until(t0 + 600);
        _mkNoise();
        _until(t0 + 1200);
        bool jump = _isJump() && acc.slots == JUMP_SLOT && acc.jumpAt == 0;
        _mkWalkAndArb(
            jump, scenario == SCN_JUMP_DOWN ? JUMP_DOWN_USD_MILLITICKS : JUMP_UP_USD_MILLITICKS
        );
        if (jump) acc.jumpAt = mkJumpAt;
        _feedDeviation();
        _until(t0 + 1500);
        _flow();
        _until(t0 + rebalancer.effectiveStepInterval());
        ++mkSlot;
        ++acc.slots;
    }

    /// @dev The one ordering rule (E42, RB-30): the round's first `settle` call reverts `StepInWindow` if a step that
    ///      traded a basket pool is younger than `settleWindow`. So the keeper sends no step from an epoch's close to
    ///      its round's end, and none while that first call is still being retried, if a request of a closed epoch is
    ///      still open (a round has work). Before the close a step is harmless: the round's call comes `settleWindow` after it.
    ///      The first scored 3f run had no such rule in the sim keeper and failed 6,455 of 6,752 calls on it.
    function _holdSteps() internal view returns (bool) {
        FlowParams memory p = queue.flowParams();
        uint256 now_ = vm.getBlockTimestamp();
        uint256 close = (lastSchedK + 1) * p.epochLength;
        bool zone = (now_ > close && now_ < close + p.settleWindow) || retryDue;
        return zone && _pendingClosedEpoch();
    }

    // ─── Keeper step (as RebalanceSim `_keeper`, booking against the TWAP and the feed) ───────────────

    function _keeper() internal {
        if (_holdSteps()) {
            ++stepsHeld;
            return;
        }
        Snap memory pre = _snapKeeper();
        _attribute(pre);
        uint160[2] memory spot = [_mkSpotSqrt(0), _mkSpotSqrt(1)];
        uint256 spentBefore = fund.plan().costSpent;
        bool maskedOff = _observeMarket();
        (uint256 feedPre,,) = _navFeedRef();

        vm.recordLogs();
        (bool did, SkipReason why) = keeperStep();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        Snap memory post = _snap();
        assertEq(post.supply, pre.supply, "a step mints and burns nothing");
        lastPost = post;

        if (why == SkipReason.Concluded) {
            assertEq(post.nav, pre.nav, "conclusion moves nothing");
            _concluded();
            return;
        }
        ++acc.calls;
        ++acc.byReason[uint8(why)];
        if (!did) {
            if (maskedOff && (why == SkipReason.NothingToTrade || why == SkipReason.BelowMinStep)) {
                ++acc.maskedCalls;
            }
            assertEq(post.nav, pre.nav, "skip: NAV unchanged");
            assertEq(fund.plan().costSpent, spentBefore, "skip: no cost");
            if (why == SkipReason.StepFailed) acc.lastFailSelector = _failDetail(logs);
            return;
        }
        (uint256 feedPost,,) = _navFeedRef();
        _booked(pre, post, spot, _stepNotional(logs), spentBefore, SimLib.sub(feedPre, feedPost));
        if (fund.planStatus() != PlanStatus.Open) _concluded();
    }

    /// @dev Per keeper call: LP-range counts, and whether a basket asset the Rebalancer masks out (ORA-4 or backoff)
    ///      still sits at least `minStepUsdc` off its path (RebalanceSim `_observeMarket`, no deSPXA).
    function _observeMarket() internal returns (bool maskedOff) {
        for (uint256 b; b < MK_N; ++b) {
            if (uint256(ISimPoolL(mkPools[b]).liquidity()) * OUT_OF_RANGE_L_DIV < mkPinL[b]) {
                ++acc.outOfRangeCalls[b];
            }
        }
        Plan memory p = fund.plan();
        uint256 minStep = rebalancer.stepParams().minStepUsdc;
        for (uint256 b; b < MK_N; ++b) {
            uint256 i = IDX_WETH + b;
            bool masked = rebalancer.assetBackoffUntil(i) >= vm.getBlockTimestamp();
            if (!masked) {
                (bool ok,) = fund.marketCheck(i);
                masked = !ok;
            }
            if (!masked) continue;
            uint256 tgt = PlanMath.pathTargetValue(p, i, vm.getBlockTimestamp(), kNav);
            uint256 gap = kValues[i] > tgt ? kValues[i] - tgt : tgt - kValues[i];
            if (gap >= minStep) return true;
        }
    }

    function _concluded() internal {
        acc.concludedAt = vm.getBlockTimestamp();
        (finalW, finalIdle) = assetWeightsBps();
    }

    /// @dev Book one executed step. `signed` is the TWAP NAV drop (step 3's fund cost), `feedSigned` the NAV drop at
    ///      the feeds; the cost the fund booked (`costSpent`) must stay under the RB-4 cap, and which of the two it
    ///      equals is counted (step 3e books against the feed, §5.10). Arrival cost at the pre-step spot and
    ///      reference cost at the walk, as step 3.
    function _booked(
        Snap memory pre,
        Snap memory post,
        uint160[2] memory spot,
        uint256 notional,
        uint256 spentBefore,
        int256 feedSigned
    ) internal {
        int256 signed = SimLib.sub(pre.nav, post.nav);
        uint256 booked = fund.plan().costSpent - spentBefore;
        assertLe(
            booked,
            notional.mulDiv(rebalancer.stepParams().maxStepCostBps, BPS),
            "RB-4: booked step cost <= cap"
        );
        if (booked == 0) ++acc.bookedZero;
        else if (booked == SimLib.pos(signed)) ++acc.bookedAtTwap;
        else if (booked == SimLib.pos(feedSigned)) ++acc.bookedAtFeed;
        else ++acc.bookedOther;

        int256 dv = SimLib.sub(post.idle, pre.idle);
        for (uint256 j; j < 3; ++j) {
            dv += SimLib.sub(post.lend[j], pre.lend[j]);
        }
        for (uint256 b; b < MK_N; ++b) {
            dv += SimLib.spotUsdcSigned(SimLib.sub(post.q[b], pre.q[b]), spot[b], mkUsdc0[b]);
        }
        int256 exec = -dv;
        acc.execCostRef += -_refValueDelta(pre, post);
        ++acc.executed;
        acc.traded += notional;
        acc.fundCost += booked;
        acc.signedCost += signed;
        acc.feedCost += feedSigned;
        acc.execCost += exec;
        acc.basisCost += signed - exec;
        uint256 fb = booked * BPS * 100 / notional;
        if (fb > acc.maxStepFundBps) acc.maxStepFundBps = fb;
        int256 eb = exec * int256(BPS * 100) / int256(notional);
        if (eb > acc.maxStepExecBps) acc.maxStepExecBps = eb;
    }

    function _refValueDelta(Snap memory a, Snap memory b) internal view returns (int256 dv) {
        dv = SimLib.sub(b.idle, a.idle);
        for (uint256 j; j < 3; ++j) {
            dv += SimLib.sub(b.lend[j], a.lend[j]);
        }
        for (uint256 k; k < MK_N; ++k) {
            dv += SimLib.spotUsdcSigned(SimLib.sub(b.q[k], a.q[k]), _mkRefSqrt(k), mkUsdc0[k]);
        }
    }

    function _navRef(Snap memory s) internal view returns (uint256 v) {
        v = s.idle;
        for (uint256 j; j < 3; ++j) {
            v += s.lend[j];
        }
        for (uint256 k; k < MK_N; ++k) {
            v += SimLib.spotUsdc(s.q[k], _mkRefSqrt(k), mkUsdc0[k]);
        }
    }

    function _stepNotional(VmSafe.Log[] memory logs) internal view returns (uint256) {
        bytes32 sig = IFundEvents.RebalanceStep.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(rebalancer) && logs[i].topics[0] == sig) {
                (,, uint256 notional) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                return notional;
            }
        }
        revert("executed step without RebalanceStep");
    }

    /// @dev The skip's `detail` (the revert selector for StepFailed). Decoded as words, so a skip reason appended by
    ///      step 3e never fails the decode.
    function _failDetail(VmSafe.Log[] memory logs) internal view returns (uint256) {
        bytes32 sig = IFundEvents.RebalanceStepSkipped.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(rebalancer) && logs[i].topics[0] == sig) {
                (,,, uint256 detail) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                return detail;
            }
        }
        return 0;
    }

    /// @dev Between two events holdings change only by price and lending interest (RebalanceSim `_attribute`).
    function _attribute(Snap memory b) internal {
        Snap storage a = lastPost;
        int256 pm;
        for (uint256 i; i < MK_N; ++i) {
            pm += SimLib.sub(fund.assetUsdcValue(IDX_WETH + i, a.q[i]), a.val[i]);
        }
        int256 interest;
        for (uint256 j; j < 3; ++j) {
            interest += SimLib.sub(b.lend[j], a.lend[j]);
        }
        int256 resid = SimLib.sub(b.nav, a.nav) - pm - interest;
        acc.priceMove += pm;
        acc.interest += interest;
        if (resid < 0) acc.unexplainedDrop += uint256(-resid);
        acc.residualAbs += resid < 0 ? uint256(-resid) : uint256(resid);
    }

    // ─── Flows: requests with limits ────────────────────────────────────────────────────────────────────

    /// @dev RebalanceSim `_flow`'s draws, made into a request at t + 1500. The fill comes at a later settlement.
    function _flow() internal {
        uint256 sl = mkSlot;
        if (SimLib.draw(mkSeed, sl, SimLib.TAG_FLOW, 0) % FLOW_ONE_IN != 0) return;
        bool isDeposit = SimLib.draw(mkSeed, sl, SimLib.TAG_FLOW_DIR, 0) % 2 == 0;
        uint256 bps =
            FLOW_MIN_BPS + SimLib.draw(mkSeed, sl, SimLib.TAG_FLOW_SIZE, 0) % FLOW_SPAN_BPS;
        (uint256 nav,,) = fund.portfolioValues();
        uint256 amt = nav.mulDiv(bps, BPS);
        bool ok = isDeposit ? _flowDeposit(amt) : _flowRedeem(amt, sl);
        if (!ok) ++acc.flowsBlocked;
        else if (isDeposit) ++acc.depositRequests;
        else ++acc.redeemRequests;
    }

    function _flowDeposit(uint256 amt) internal returns (bool ok) {
        address d = address(
            uint160(uint256(keccak256(abi.encode("rm-sim-depositor", mkSeed, ++depNonce))))
        );
        bytes memory err;
        (ok,, err) = _reqDeposit(d, amt, userSlackBps);
        if (!ok) _flowFail("deposit", err);
    }

    function _flowRedeem(uint256 amt, uint256 sl) internal returns (bool ok) {
        address h = genesisDepositors[
            SimLib.draw(mkSeed, sl, SimLib.TAG_FLOW_WHO, 0) % genesisDepositors.length
        ];
        (uint256 nav,,) = fund.portfolioValues();
        uint256 shares = amt.mulDiv(fund.totalSupply(), nav);
        uint256 bal = fund.balanceOf(h);
        if (shares > bal) shares = bal / 2;
        if (shares == 0) return false;
        bytes memory err;
        (ok,, err) = _reqRedeem(h, shares, userSlackBps);
        if (!ok) _flowFail("redeem", err);
    }

    function _flowFail(string memory kind, bytes memory err) internal {
        if (bytes(acc.flowFailReason).length == 0) {
            acc.flowFailReason = string.concat(kind, ":", vm.toString(err));
        }
    }

    /// @dev Around each keeper settle: the attribution before it, then the holders' dilution at the TWAP and at the
    ///      reference (RebalanceSim's flow accounting, now per settlement).
    function _onSettlePre() internal virtual override {
        Snap memory pre = _snap();
        _attribute(pre);
        settlePre = pre;
    }

    function _onSettlePost(uint16 outcome) internal virtual override {
        Snap memory pre = settlePre;
        Snap memory post = _snap();
        lastPost = post;
        ++acc.settleAttempts;
        if (!_settled(outcome)) ++acc.settleBlocked;
        acc.deposits += lastAttemptDepFills;
        acc.redeems += lastAttemptRedFills;
        if (post.supply == pre.supply || pre.supply == 0) return;
        int256 dSupply = SimLib.sub(post.supply, pre.supply);
        int256 fair = dSupply >= 0
            ? int256(uint256(dSupply).mulDiv(pre.nav, pre.supply))
            : -int256(uint256(-dSupply).mulDiv(pre.nav, pre.supply));
        int256 dil = SimLib.sub(post.nav, pre.nav) - fair;
        acc.dilution += dil;
        if (dil < 0) acc.flowLoss += uint256(-dil);
        uint256 refPre = _navRef(pre);
        int256 fairRef = dSupply >= 0
            ? int256(uint256(dSupply).mulDiv(refPre, pre.supply))
            : -int256(uint256(-dSupply).mulDiv(refPre, pre.supply));
        int256 dilRef = SimLib.sub(_navRef(post), refPre) - fairRef;
        if (dilRef < 0) acc.flowLossRef += uint256(-dilRef);
    }

    // ─── Snapshots ──────────────────────────────────────────────────────────────────────────────────────

    function _snapKeeper() internal returns (Snap memory s) {
        uint256[] memory values;
        (s.nav, s.idle, values) = fund.portfolioValues();
        kNav = s.nav;
        kValues = values;
        _fill(s, values);
    }

    function _snap() internal view returns (Snap memory s) {
        uint256[] memory values;
        (s.nav, s.idle, values) = fund.portfolioValues();
        _fill(s, values);
    }

    function _fill(Snap memory s, uint256[] memory values) internal view {
        for (uint256 j; j < 3; ++j) {
            s.lend[j] = values[LEND[j]];
        }
        for (uint256 b; b < MK_N; ++b) {
            s.val[b] = values[IDX_WETH + b];
            s.q[b] = IERC20(mkTokens[b]).balanceOf(address(fund));
        }
        s.supply = fund.totalSupply();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Conclusion and JSON
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Self-call: the always-true end state, then the plan row (RebalanceSim's fields, plus the timed ones).
    function simClose() external {
        require(msg.sender == address(this), "self only");
        Plan memory p = fund.plan();
        PlanStatus st = p.status;
        assertTrue(
            st == PlanStatus.Converged || st == PlanStatus.Expired || st == PlanStatus.Halted,
            "plan reached a terminal state"
        );
        assertEq(p.id, acc.planId, "same plan throughout");
        assertEq(p.costSpent, acc.fundCost, "costSpent = sum of booked step costs");
        assertEq(p.stepCount, acc.executed, "fund counted every executed step");
        if (st != PlanStatus.Halted) {
            assertLe(p.costSpent, p.costBudget, "unhalted plan within budget");
        }

        string memory o = string.concat("plan", vm.toString(planIndex));
        _jsonIdentity(o, p);
        _jsonCost(o, p);
        _jsonSteps(o);
        _jsonModel(o);
        planJson.push(_jsonEnd(o, p));
    }

    function _jsonIdentity(string memory o, Plan memory p) internal {
        vm.serializeString(o, "scenario", scnName);
        vm.serializeUint(o, "fundUsdc", fundSize);
        vm.serializeUint(o, "seedK", seedK);
        vm.serializeString(o, "receipt", planLabel);
        vm.serializeUint(o, "planIndex", planIndex);
        vm.serializeUint(o, "planId", p.id);
        vm.serializeUint(o, "navAtOpen", p.navAtOpen);
        vm.serializeUint(o, "startTime", p.startTime);
        vm.serializeUint(o, "endTime", p.endTime);
        vm.serializeUint(o, "startSleeveBps", _arr4(acc.startSleeve));
        vm.serializeUint(o, "endSleeveBps", _arr4(acc.endSleeve));
        vm.serializeUint(o, "startBps", _arr16(p.startBps));
        vm.serializeUint(o, "endBps", _arr16(p.endBps));
    }

    function _jsonCost(string memory o, Plan memory p) internal {
        vm.serializeUint(o, "turnoverUsdc", p.turnoverUsdc);
        vm.serializeUint(o, "tradedNotional", acc.traded);
        vm.serializeInt(o, "flowAssist", SimLib.sub(p.turnoverUsdc, acc.traded));
        vm.serializeUint(o, "costBudget", p.costBudget);
        vm.serializeUint(o, "costSpent", p.costSpent);
        vm.serializeInt(o, "signedTwapCost", acc.signedCost);
        vm.serializeInt(o, "signedFeedCost", acc.feedCost);
        vm.serializeInt(o, "execCost", acc.execCost);
        vm.serializeInt(o, "basisCost", acc.basisCost);
        vm.serializeUint(o, "maxStepFundCostCentiBps", acc.maxStepFundBps);
        vm.serializeInt(o, "maxStepExecCostCentiBps", acc.maxStepExecBps);
        vm.serializeInt(o, "priceMove", acc.priceMove);
        vm.serializeInt(o, "interest", acc.interest);
        vm.serializeUint(o, "unexplainedDrop", acc.unexplainedDrop);
        vm.serializeUint(o, "residualAbs", acc.residualAbs);
        vm.serializeUint(o, "flowLoss", acc.flowLoss);
        vm.serializeInt(o, "flowDilution", acc.dilution);
        vm.serializeUint(o, "deposits", acc.deposits);
        vm.serializeUint(o, "redeems", acc.redeems);
        vm.serializeUint(o, "depositRequests", acc.depositRequests);
        vm.serializeUint(o, "redeemRequests", acc.redeemRequests);
        vm.serializeUint(o, "flowsBlocked", acc.flowsBlocked);
        vm.serializeUint(o, "settleAttempts", acc.settleAttempts);
        vm.serializeUint(o, "settleBlockedAttempts", acc.settleBlocked);
        vm.serializeUint(o, "bookedAtTwap", acc.bookedAtTwap);
        vm.serializeUint(o, "bookedAtFeed", acc.bookedAtFeed);
        vm.serializeUint(o, "bookedOther", acc.bookedOther);
        vm.serializeUint(o, "bookedZero", acc.bookedZero);
    }

    function _jsonSteps(string memory o) internal {
        vm.serializeUint(o, "slots", acc.slots);
        vm.serializeUint(o, "calls", acc.calls);
        vm.serializeUint(o, "executed", acc.executed);
        vm.serializeUint(o, "skipCooldown", acc.byReason[uint8(SkipReason.Cooldown)]);
        vm.serializeUint(o, "skipMarketDeviation", acc.byReason[uint8(SkipReason.MarketDeviation)]);
        vm.serializeUint(o, "skipNothingToTrade", acc.byReason[uint8(SkipReason.NothingToTrade)]);
        vm.serializeUint(o, "skipBelowMinStep", acc.byReason[uint8(SkipReason.BelowMinStep)]);
        vm.serializeUint(o, "skipStepFailed", acc.byReason[uint8(SkipReason.StepFailed)]);
        vm.serializeUint(o, "skipPlanNotOpen", acc.byReason[uint8(SkipReason.PlanNotOpen)]);
        uint256 other;
        uint256[] memory all = new uint256[](N_SKIP);
        for (uint256 r; r < N_SKIP; ++r) {
            all[r] = acc.byReason[r];
            if (r > uint8(SkipReason.Concluded)) other += acc.byReason[r];
        }
        vm.serializeUint(o, "skipOther", other);
        vm.serializeUint(o, "skipByReason", all);
        vm.serializeString(
            o, "lastStepFailedSelector", vm.toString(bytes4(uint32(acc.lastFailSelector)))
        );
        vm.serializeString(o, "stepFailProbes", "");
        vm.serializeString(o, "firstFlowFailure", acc.flowFailReason);
        vm.serializeUint(o, "jumpAt", acc.jumpAt);
    }

    function _jsonModel(string memory o) internal {
        vm.serializeInt(o, "execCostRef", acc.execCostRef);
        vm.serializeUint(o, "flowLossRef", acc.flowLossRef);
        vm.serializeUint(o, "maskedCalls", acc.maskedCalls);
        uint256[] memory oor = new uint256[](MK_N);
        for (uint256 b; b < MK_N; ++b) {
            oor[b] = acc.outOfRangeCalls[b];
        }
        vm.serializeUint(o, "outOfRangeCalls", oor);
    }

    function _jsonEnd(string memory o, Plan memory p) internal returns (string memory) {
        uint256 at = acc.concludedAt;
        vm.serializeString(o, "outcome", _statusName(p.status));
        vm.serializeUint(o, "concludedAt", at);
        vm.serializeUint(o, "timeToConvergeSec", at - p.startTime);
        vm.serializeUint(o, "overrunSec", at > p.endTime ? at - p.endTime : 0);
        vm.serializeBool(
            o,
            "convergedInWindow",
            p.status == PlanStatus.Converged
                && at <= uint256(p.endTime) + rebalancer.stepParams().maxOverrun
        );
        assertGt(at, 0, "conclusion was observed");
        (uint256[] memory w, uint256 idleBps) = (finalW, finalIdle);
        vm.serializeUint(o, "finalBps", w);
        vm.serializeUint(o, "finalIdleBps", idleBps);
        (uint256[] memory offIdx, uint256[] memory offGap, bool liquidOff) =
            _offTolerance(w, p.endBps, rebalancer.stepParams().toleranceBps);
        if (p.status == PlanStatus.Converged) {
            assertEq(offIdx.length, 0, "converged: every asset within tolerance");
        }
        vm.serializeUint(o, "offToleranceAssets", offIdx);
        vm.serializeUint(o, "offToleranceGapBps", offGap);
        return vm.serializeBool(o, "liquidAssetOffTolerance", liquidOff);
    }

    function _offTolerance(uint256[] memory w, uint16[] memory endBps, uint256 tol)
        internal
        pure
        returns (uint256[] memory idx, uint256[] memory gap, bool liquid)
    {
        uint256 n;
        uint256[] memory gi = new uint256[](w.length);
        uint256[] memory gg = new uint256[](w.length);
        for (uint256 i; i < w.length; ++i) {
            uint256 g = w[i] > endBps[i] ? w[i] - endBps[i] : endBps[i] - w[i];
            if (g > tol + 1) {
                gi[n] = i;
                gg[n] = g;
                ++n;
                if (i == IDX_WETH || i == IDX_CBBTC) liquid = true;
            }
        }
        idx = new uint256[](n);
        gap = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            idx[i] = gi[i];
            gap[i] = gg[i];
        }
    }

    function _statusName(PlanStatus s) internal pure returns (string memory) {
        if (s == PlanStatus.Converged) return "Converged";
        if (s == PlanStatus.Expired) return "Expired";
        if (s == PlanStatus.Halted) return "Halted";
        if (s == PlanStatus.Superseded) return "Superseded";
        if (s == PlanStatus.Paused) return "Paused";
        if (s == PlanStatus.Open) return "Open";
        return "None";
    }

    function _arr4(uint256[4] memory a) internal pure returns (uint256[] memory r) {
        r = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            r[i] = a[i];
        }
    }

    function _arr16(uint16[] memory a) internal pure returns (uint256[] memory r) {
        r = new uint256[](a.length);
        for (uint256 i; i < a.length; ++i) {
            r[i] = a[i];
        }
    }

    function _arr2(uint256[2] memory a) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a[0], a[1]);
    }

    function _writeJson(uint256 fundM) internal {
        string memory meta = _jsonMeta();
        string memory plans = "";
        for (uint256 i; i < planJson.length; ++i) {
            plans = string.concat(plans, i == 0 ? "" : ",", planJson[i]);
        }
        string memory full = string.concat(
            '{"meta":',
            meta,
            ',"plans":[',
            plans,
            '],"timed":{"attempts":',
            _jsonAttempts(),
            ',"settlements":',
            _jsonSettles(),
            ',"requests":',
            _jsonReqs(),
            ',"depositStops":',
            vm.toString(depositStops),
            "}}"
        );
        string memory dir = string.concat(
            "out/prototype/",
            runName,
            "-timed",
            bytes(runTag).length == 0 ? "" : string.concat("-", runTag)
        );
        vm.createDir(dir, true);
        vm.writeFile(
            string.concat(
                dir, "/sim-", scnName, "-", vm.toString(fundM), "M-s", vm.toString(seedK), ".json"
            ),
            full
        );
    }

    function _jsonMeta() internal returns (string memory) {
        string memory m = "meta";
        vm.serializeString(m, "scenario", scnName);
        vm.serializeUint(m, "fundUsdc", fundSize);
        vm.serializeUint(m, "seedK", seedK);
        vm.serializeString(m, "seed", vm.toString(bytes32(mkSeed)));
        vm.serializeBool(m, "recording", recording);
        vm.serializeUint(m, "pinBlock", pinBlock);
        vm.serializeUint(m, "pinTimestamp", pinTimestamp);
        vm.serializeUint(m, "blockAtEnd", vm.getBlockNumber());
        vm.serializeUint(m, "marketStartAt", marketStartAt);
        vm.serializeUint(m, "endAt", vm.getBlockTimestamp());
        int256[] memory ticks = new int256[](MK_N);
        uint256[] memory sig = new uint256[](MK_N);
        uint256[] memory sigN = new uint256[](MK_N);
        uint256[] memory dep = new uint256[](MK_N);
        for (uint256 b; b < MK_N; ++b) {
            (ticks[b], sig[b], sigN[b], dep[b]) =
            (mkP0Tick[b], mkSigma[b], mkSigmaN[b], mkDepth10Bps[b]);
        }
        vm.serializeInt(m, "p0TwapTick", ticks);
        vm.serializeUint(m, "sigmaMilliTicks", sig);
        vm.serializeUint(m, "sigmaIntervals", sigN);
        vm.serializeUint(m, "p0UsdcPerToken", _arr2(p0Usdc));
        vm.serializeUint(m, "depth10BpsUsdcAtPin", dep);
        vm.serializeUint(m, "slotsRun", mkSlot);
        vm.serializeUint(m, "feedRoundsDeviation", _arr2(feedRoundsDeviation));
        vm.serializeUint(m, "feedRoundsHeartbeat", _arr2(feedRoundsHeartbeat));
        vm.serializeString(m, "flows", "timed");
        vm.serializeUint(m, "stepsHeldForRound", stepsHeld);
        vm.serializeBool(m, "step3f", true);
        vm.serializeString(m, "assets", "aave,moonwell,weth,cbbtc,comet");
        vm.serializeString(
            m,
            "rules",
            "proposal 10 step 3e: 4.5 list (no deSPXA); deSPXA weight spread pro rata over the receipt's other assets (largest remainder); EXT = all lending <-> all basket (wETH, cbBTC at receipt proportions); JUMP moves wETH at slot 168 by the step 3 deSPXA size"
        );
        vm.serializeString(
            m,
            "model",
            "keeper settles at each window end (k*epochLength+settleWindow) when checkSettle != Window, retries a reverted or one-sided call every slot, then steps; noise t+600, walk+arb t+1200 (wETH/cbBTC as step 3, 24/7 unlimited arb), feed rounds on deviation (ETH 15 bps, cbBTC 30 bps) right after the walk and on a 1200 s heartbeat, USDC feed 1.0 (24 h), sequencer up; flow request t+1500 (p=1/12, 0.10-0.50% NAV), no limit (step 3f: forward-priced, netted); a matched fill is read through the queue's views after each settle and costed at the match price; genesis: seed invested by a 1-day plan, then fund-seed deposited through the queue in 245k chunks, one per cap period, market still"
        );
        vm.serializeUint(m, "userLimitSlackBps", userSlackBps);
        vm.serializeString(m, "tag", runTag);
        vm.serializeString(m, "run", runName);
        return vm.serializeString(m, "params", _paramsJson());
    }

    function _paramsJson() internal returns (string memory) {
        string memory k = "params";
        StepParams memory sp = rebalancer.stepParams();
        PlanParams memory pp = governance.defaultPlanParams();
        vm.serializeString(k, "set", runName);
        vm.serializeUint(k, "stepInterval", rebalancer.effectiveStepInterval());
        vm.serializeUint(k, "maxOverrun", sp.maxOverrun);
        vm.serializeUint(k, "maxStepCostBps", sp.maxStepCostBps);
        vm.serializeUint(k, "toleranceBps", sp.toleranceBps);
        vm.serializeUint(k, "minStepUsdc", sp.minStepUsdc);
        vm.serializeUint(k, "planDuration", pp.duration);
        vm.serializeUint(k, "costBudgetBps", pp.costBudgetBps);
        uint256[] memory cap = new uint256[](N_ASSETS);
        uint256[] memory slip = new uint256[](N_ASSETS);
        for (uint256 i; i < N_ASSETS; ++i) {
            AssetStepParams memory ap = rebalancer.assetStepParams(i);
            (cap[i], slip[i]) = (ap.maxStepUsdc, ap.maxStepSlippageBps);
        }
        vm.serializeUint(k, "maxStepUsdc", cap);
        vm.serializeUint(k, "maxStepSlippageBps", slip);
        vm.serializeUint(k, "minPoolDepthUsdc", fund.minPoolDepthUsdc());
        vm.serializeUint(k, "feeMarginBps", fund.feeMarginBps());
        vm.serializeUint(k, "delistBandBps", fund.delistBandBps());
        vm.serializeUint(k, "delistBudgetBps", fund.delistBudgetBps());
        return vm.serializeString(k, "flowParams", _flowParamsJson());
    }

    function _flowParamsJson() internal returns (string memory) {
        string memory k = "flowParams";
        FlowParams memory p = queue.flowParams();
        vm.serializeUint(k, "epochLength", p.epochLength);
        vm.serializeUint(k, "settleWindow", p.settleWindow);
        vm.serializeUint(k, "minHold", p.minHold);
        vm.serializeUint(k, "keeperGrace", p.keeperGrace);
        vm.serializeUint(k, "maxEpochFlowBps", p.maxEpochFlowBps);
        vm.serializeUint(k, "epochFlowFloorUsdc", p.epochFlowFloorUsdc);
        vm.serializeUint(k, "maxSharePriceMoveBps", p.maxSharePriceMoveBps);
        vm.serializeUint(k, "maxRoll", p.maxRoll);
        vm.serializeUint(k, "minRequestUsdc", p.minRequestUsdc);
        vm.serializeUint(k, "maxFreeze", p.maxFreeze);
        vm.serializeUint(k, "slices", p.slices);
        vm.serializeUint(k, "quorum", p.quorum);
        vm.serializeUint(k, "dispersionBps", p.dispersionBps);
        vm.serializeUint(k, "refBandBps", p.refBandBps);
        vm.serializeUint(k, "legBandBps", p.legBandBps);
        vm.serializeUint(k, "sequencerGrace", p.sequencerGrace);
        vm.serializeUint(k, "usdcPegBandBps", p.usdcPegBandBps);
        vm.serializeUint(k, "maxLendRateGrowthBps", p.maxLendRateGrowthBps);
        vm.serializeUint(k, "cancelBuffer", queue.cancelBuffer());
        vm.serializeUint(k, "maxPause", queue.maxPause());
        return vm.serializeUint(k, "matchBandBps", p.matchBandBps);
    }

    /// @dev Every keeper attempt, as columns. Basket columns end in 0 (wETH) and 1 (cbBTC).
    function _jsonAttempts() internal returns (string memory) {
        string memory k = "attempts";
        uint256 n = attempts.length;
        uint256[][6] memory u;
        int256[][6] memory s;
        for (uint256 c; c < 6; ++c) {
            u[c] = new uint256[](n);
            s[c] = new int256[](n);
        }
        uint256[] memory inBand0 = new uint256[](n);
        uint256[] memory inBand1 = new uint256[](n);
        uint256[] memory dev0 = new uint256[](n);
        uint256[] memory dev1 = new uint256[](n);
        uint256[] memory sid = new uint256[](n);
        uint256[] memory fills = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            AttemptRec storage a = attempts[i];
            u[0][i] = a.at;
            u[1][i] = a.kind;
            u[2][i] = a.outcome;
            u[3][i] = a.index;
            u[4][i] = a.detail;
            u[5][i] = a.limitSkips;
            for (uint256 b; b < 2; ++b) {
                s[b][i] = a.twapVsFeedBps[b];
                s[2 + b][i] = a.spotVsFeedBps[b];
                s[4 + b][i] = a.spotMoveBps[b];
            }
            inBand0[i] = a.slicesInBand[0];
            inBand1[i] = a.slicesInBand[1];
            dev0[i] = a.sliceDevBps[0];
            dev1[i] = a.sliceDevBps[1];
            sid[i] = a.settlementId;
            fills[i] = a.fills;
        }
        vm.serializeUint(k, "at", u[0]);
        vm.serializeUint(k, "kind", u[1]);
        vm.serializeUint(k, "outcome", u[2]);
        vm.serializeUint(k, "index", u[3]);
        vm.serializeUint(k, "detail", u[4]);
        vm.serializeUint(k, "limitSkips", u[5]);
        vm.serializeUint(k, "settlementId", sid);
        vm.serializeUint(k, "fills", fills);
        vm.serializeInt(k, "twapVsFeedBps0", s[0]);
        vm.serializeInt(k, "twapVsFeedBps1", s[1]);
        vm.serializeInt(k, "spotVsFeedBps0", s[2]);
        vm.serializeInt(k, "spotVsFeedBps1", s[3]);
        vm.serializeInt(k, "spotMoveBps0", s[4]);
        vm.serializeInt(k, "spotMoveBps1", s[5]);
        vm.serializeUint(k, "slicesInBand0", inBand0);
        vm.serializeUint(k, "slicesInBand1", inBand1);
        vm.serializeUint(k, "sliceDevBps0", dev0);
        vm.serializeUint(k, "sliceDevBps1", dev1);
        return _jsonAttemptsTail(k, n);
    }

    function _jsonAttemptsTail(string memory k, uint256 n) internal returns (string memory) {
        uint256[] memory px = new uint256[](n);
        uint256[] memory lend = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            (px[i], lend[i]) = (attempts[i].sharePriceMoveBps, attempts[i].lendGrowthCentiBpsPerDay);
        }
        vm.serializeUint(k, "sharePriceMoveBpsPerEpoch", px);
        return vm.serializeUint(k, "lendGrowthCentiBpsPerDay", lend);
    }

    /// @dev Every settlement that traded, as columns (USDC units).
    function _jsonSettles() internal returns (string memory) {
        string memory k = "settlements";
        uint256 n = settles.length;
        uint256[][10] memory u;
        for (uint256 c; c < 10; ++c) {
            u[c] = new uint256[](n);
        }
        for (uint256 i; i < n; ++i) {
            SettleRec storage x = settles[i];
            u[0][i] = x.at;
            u[1][i] = x.depUsdc;
            u[2][i] = x.depFairFeed;
            u[3][i] = x.depFairRef;
            u[4][i] = x.redGross;
            u[5][i] = x.redFairFeed;
            u[6][i] = x.redFairRef;
            u[7][i] = x.navFeed;
            u[8][i] = x.matchedUsdc;
            u[9][i] = x.matchedShares;
        }
        vm.serializeUint(k, "matchedUsdc", u[8]);
        vm.serializeUint(k, "matchedShares", u[9]);
        vm.serializeUint(k, "at", u[0]);
        vm.serializeUint(k, "depUsdc", u[1]);
        vm.serializeUint(k, "depFairFeed", u[2]);
        vm.serializeUint(k, "depFairRef", u[3]);
        vm.serializeUint(k, "redGross", u[4]);
        vm.serializeUint(k, "redFairFeed", u[5]);
        vm.serializeUint(k, "redFairRef", u[6]);
        return vm.serializeUint(k, "navFeed", u[7]);
    }

    /// @dev Every request the sim made, as columns. `status`: 1 pending, 2 expired, 3 closed (RequestStatus).
    function _jsonReqs() internal returns (string memory) {
        string memory k = "requests";
        uint256 n = reqs.length;
        uint256[][12] memory u;
        int256[] memory cf = new int256[](n);
        int256[] memory cr = new int256[](n);
        for (uint256 c; c < 12; ++c) {
            u[c] = new uint256[](n);
        }
        for (uint256 i; i < n; ++i) {
            ReqRec storage r = reqs[i];
            u[0][i] = r.isDeposit ? 1 : 0;
            u[1][i] = r.at;
            u[2][i] = r.epoch;
            u[3][i] = r.amount;
            u[4][i] = r.valueUsdc;
            u[5][i] = r.filled + r.matched;
            u[6][i] = r.basis;
            u[7][i] = r.firstFillAt;
            u[8][i] = r.doneAt;
            u[9][i] = r.unlockAt;
            u[10][i] = uint8(queue.requestStatus(r.id));
            u[11][i] = r.limitSkips;
            cf[i] = r.costFeed;
            cr[i] = r.costRef;
        }
        vm.serializeUint(k, "isDeposit", u[0]);
        vm.serializeUint(k, "at", u[1]);
        vm.serializeUint(k, "epoch", u[2]);
        vm.serializeUint(k, "amount", u[3]);
        vm.serializeUint(k, "valueUsdc", u[4]);
        vm.serializeUint(k, "filled", u[5]);
        vm.serializeUint(k, "basis", u[6]);
        vm.serializeUint(k, "firstFillAt", u[7]);
        vm.serializeUint(k, "doneAt", u[8]);
        vm.serializeUint(k, "unlockAt", u[9]);
        vm.serializeUint(k, "status", u[10]);
        vm.serializeUint(k, "limitSkips", u[11]);
        vm.serializeInt(k, "costFeed", cf);
        return vm.serializeInt(k, "costRef", cr);
    }
}

interface ISimPoolL {
    function liquidity() external view returns (uint128);
}

/// @notice Step 3f, work package 11 (eng plan §8.4, E48): the scenarios the timed sim did not measure. Each test is
///         one fault on the live fund at 1M USDC, seed 0, the SEQ market, with the sim's own background flows and the
///         keeper's schedule. No rebalance plan runs: the fault is the thing measured.
///
///         A fault window opens at t0, right after genesis and one quiet slot. At t0 two probe requests are made:
///         a depositor (0.20 % of NAV) and a genesis holder's redemption (0.20 % of supply). The run goes on in
///         30-minute slots until both probes are done and the fault is over, or the horizon (10 days) ends.
///
///         Reported per scenario (stdout and `out/prototype/<run>-timed-e48/e48-<name>-s<k>.json`):
///         - the probes' waits: request to settlement (redemption: USDC claimable then; deposit: shares usable,
///           which is settlement plus the hold, plus a freeze if one applies), in hours;
///         - the longest wait over every request the sim made (done or still open, open ones counted to the end);
///         - what each holder can do, tried at the middle of the fault and at its end: cancel the deposit, withdraw it
///           as expired, give notice on the redemption, exit in kind, deliver the shares, withdraw credit. Each try
///           runs inside a snapshot and is reverted, so it changes nothing.
///
///         Opt-in like the rest of the timed sim: PROTO_SIM=1 and PROTO_SIM_FLOWS=timed. Nothing here sends a
///         transaction to make a check pass. A fault is a feed answer, a keeper that stops, the emergency key's own
///         pause or freeze, or the venue's own answer (mocked, as in A14 and A30).
contract TimedFlowFaultSimTest is TimedFlowSimTest {
    using Math for uint256;

    uint8 internal constant F_NONE = 0;
    uint8 internal constant F_SEQ = 1;
    uint8 internal constant F_DEPEG = 2;
    uint8 internal constant F_DEPEG_STUCK = 3;
    uint8 internal constant F_KEEPER = 4;
    uint8 internal constant F_PAUSE = 5;
    uint8 internal constant F_FREEZE = 6;
    uint8 internal constant F_VENUE = 7;
    uint8 internal constant F_LEND = 8;

    uint256 internal constant SLOT_S = 1800;
    uint256 internal constant HORIZON_S = 10 days;
    uint256 internal constant PROBE_BPS = 20;
    uint256 internal constant N_ACTIONS = 6;
    uint256 internal constant DEPEG_PX8 = 97_000_000;
    uint256 internal constant DEPEG_STUCK_PX8 = 95_000_000;
    uint256 internal constant LEND_SPIKE_BPS = 12_000;

    address internal pDep;
    address internal pRed;
    uint256 internal pDepId;
    uint256 internal pRedId;
    uint256 internal fT0;
    uint256 internal fEnd;
    uint256 internal depClosedAt;
    uint256 internal depUsableAt;
    uint256 internal redClosedAt;
    uint256 internal freezeUntil;
    bool internal freezeDone;
    uint256 internal midActions;
    uint256 internal endActions;
    bool internal midDone;
    bool internal endDone;

    /// @dev The inherited scored-sim tests are not this contract's job.
    function _run(uint256, uint256, uint256) internal override {
        _skipCovered("E48 contract: the scored sim runs in TimedFlowSimTest");
    }

    function test_e48_none_s0() public fixtureCovered {
        _fault(F_NONE, 0);
    }

    function test_e48_sequencerOutage_s0() public fixtureCovered {
        _fault(F_SEQ, 0);
    }

    function test_e48_usdcDepeg_s0() public fixtureCovered {
        _fault(F_DEPEG, 0);
    }

    function test_e48_usdcDepegStuck_s0() public fixtureCovered {
        _fault(F_DEPEG_STUCK, 0);
    }

    function test_e48_keeperStopped_s0() public fixtureCovered {
        _fault(F_KEEPER, 0);
    }

    function test_e48_pause_s0() public fixtureCovered {
        _fault(F_PAUSE, 0);
    }

    function test_e48_freeze_s0() public fixtureCovered {
        _fault(F_FREEZE, 0);
    }

    function test_e48_venueFullyBorrowed_s0() public fixtureCovered {
        _fault(F_VENUE, 0);
    }

    function test_e48_lendRateSpike_s0() public fixtureCovered {
        _fault(F_LEND, 0);
    }

    /// @notice SAFE-09 calibration: 14 days of the SEQ market with the sim's own flows and no fault, under the
    ///         `maxLendRateGrowthBps` the run is given (`PROTO_SIM_FLOW_MAX_LEND_RATE_GROWTH_BPS` and a
    ///         `PROTO_SIM_TAG`). It counts the rounds check 5 stopped for deposits and the match, the fastest venue
    ///         rate growth any call saw, and the longest request waits. Run once per candidate value.
    function test_e48_lendRateCalibration_s0() public fixtureCovered {
        if (!vm.envOr("PROTO_SIM", false)) {
            _skipCovered("");
            return;
        }
        if (keccak256(bytes(vm.envOr("PROTO_SIM_FLOWS", string("sync")))) != keccak256("timed")) {
            _skipCovered("");
            return;
        }
        _selectParams();
        _initSim(SCN_SEQ, 1_000_000e6, 0);
        this.simGenesis();
        coverageCheckpoint();
        _schedInit();
        marketStartAt = vm.getBlockTimestamp();
        lastPost = _snap();
        uint256 t0 = vm.getBlockTimestamp();
        for (uint256 s; s < 14 days / SLOT_S; ++s) {
            vm.resetGasMetering();
            this.simSlot(false);
            coverageCheckpoint();
        }
        FaultStats memory st = _stats();
        uint256 maxGrowth;
        for (uint256 i; i < attempts.length; ++i) {
            if (attempts[i].lendGrowthCentiBpsPerDay > maxGrowth) {
                maxGrowth = attempts[i].lendGrowthCentiBpsPerDay;
            }
        }
        string memory o = "safe09";
        vm.serializeUint(o, "maxLendRateGrowthBps", queue.flowParams().maxLendRateGrowthBps);
        vm.serializeUint(o, "days", (vm.getBlockTimestamp() - t0) / 1 days);
        vm.serializeUint(o, "settlements", settles.length);
        vm.serializeUint(o, "attempts", attempts.length);
        vm.serializeUint(o, "roundsStoppedByLendRate", lendStops);
        vm.serializeUint(o, "roundsStoppedAny", depositStops);
        vm.serializeUint(o, "maxObservedGrowthCentiBpsPerDay", maxGrowth);
        vm.serializeUint(o, "maxRedeemWaitS", st.maxRed);
        vm.serializeUint(o, "maxDepositWaitS", st.maxDep);
        vm.serializeUint(o, "depositsExpired", st.expiredDep);
        string memory json = vm.serializeUint(o, "requests", reqs.length);
        string memory dir = string.concat(
            "out/prototype/",
            runName,
            "-timed-e48",
            bytes(runTag).length == 0 ? "" : string.concat("-", runTag)
        );
        vm.createDir(dir, true);
        vm.writeFile(string.concat(dir, "/e48-lendRateCalibration-s0.json"), json);
        emit log_named_uint("SAFE-09 maxLendRateGrowthBps", queue.flowParams().maxLendRateGrowthBps);
        emit log_named_uint("SAFE-09 rounds stopped by check 5", lendStops);
        emit log_named_uint("SAFE-09 settlements", settles.length);
        emit log_named_uint("SAFE-09 max observed growth (centi-bps/day)", maxGrowth);
    }

    // ─── The run ────────────────────────────────────────────────────────────────────────────────────────

    function _faultName(uint8 f) internal pure returns (string memory) {
        if (f == F_NONE) return "none";
        if (f == F_SEQ) return "sequencerOutage";
        if (f == F_DEPEG) return "usdcDepeg";
        if (f == F_DEPEG_STUCK) return "usdcDepegStuck";
        if (f == F_KEEPER) return "keeperStopped";
        if (f == F_PAUSE) return "pause";
        if (f == F_FREEZE) return "freeze";
        if (f == F_VENUE) return "venueFullyBorrowed";
        return "lendRateSpike";
    }

    /// @dev How long the fault is on (seconds). Pause and freeze end by themselves (`maxPause`, `maxFreeze`).
    function _faultSpan(uint8 f) internal view returns (uint256) {
        if (f == F_NONE) return 0;
        if (f == F_SEQ) return 6 hours;
        if (f == F_DEPEG) return 12 hours;
        if (f == F_DEPEG_STUCK) return 72 hours;
        if (f == F_KEEPER) return 36 hours;
        if (f == F_PAUSE) return queue.flowParams().maxPause;
        if (f == F_FREEZE) return 0;
        if (f == F_VENUE) return 24 hours;
        return 12 hours;
    }

    function _fault(uint8 f, uint256 k) internal {
        if (!vm.envOr("PROTO_SIM", false)) {
            _skipCovered("");
            return;
        }
        if (keccak256(bytes(vm.envOr("PROTO_SIM_FLOWS", string("sync")))) != keccak256("timed")) {
            _skipCovered("");
            return;
        }
        _selectParams();
        _initSim(SCN_SEQ, 1_000_000e6, k);
        this.simGenesis();
        coverageCheckpoint();
        _schedInit();
        marketStartAt = vm.getBlockTimestamp();
        lastPost = _snap();
        vm.resetGasMetering();
        this.simSlot(false);

        this.faultOpen(f);
        uint256 t0 = fT0;
        uint256 horizon = t0 + HORIZON_S;
        for (uint256 s; s < HORIZON_S / SLOT_S; ++s) {
            vm.resetGasMetering();
            this.faultSlot(f);
            coverageCheckpoint();
            if (_faultDone(f)) break;
            if (vm.getBlockTimestamp() >= horizon) break;
        }
        this.faultClose(f);
    }

    /// @notice Self-call: start the fault and place the two probes.
    function faultOpen(uint8 f) external {
        require(msg.sender == address(this), "self only");
        pDep = makeAddr("e48-probe-depositor");
        pRed = genesisDepositors[0];
        (uint256 nav,,) = fund.portfolioValues();
        bool ok;
        (ok, pDepId,) = _reqDeposit(pDep, nav.mulDiv(PROBE_BPS, BPS), userSlackBps);
        require(ok, "e48: probe deposit refused");
        uint256 shares = fund.totalSupply().mulDiv(PROBE_BPS, BPS);
        uint256 bal = fund.balanceOf(pRed);
        if (shares > bal) shares = bal / 2;
        (ok, pRedId,) = _reqRedeem(pRed, shares, userSlackBps);
        require(ok, "e48: probe redemption refused");
        fT0 = vm.getBlockTimestamp();
        uint256 span = _faultSpan(f);
        fEnd = span == 0 ? 0 : fT0 + span;
        _faultSet(f, true);
    }

    function _faultSet(uint8 f, bool on) internal {
        uint256 now_ = vm.getBlockTimestamp();
        if (f == F_SEQ) {
            seqAnswer = on ? int256(1) : int256(0);
            seqStartedAt = now_;
        } else if (f == F_DEPEG || f == F_DEPEG_STUCK) {
            usdcFaultPx8 = on ? (f == F_DEPEG ? DEPEG_PX8 : DEPEG_STUCK_PX8) : 0;
            if (!on) {
                MockAggregator(FEED_USDC).setRound(8, 1e8, now_, now_);
                usdcFeedAt = now_;
            }
        } else if (f == F_KEEPER) {
            keeperStopped = on;
            if (!on) retryDue = true;
        } else if (f == F_PAUSE) {
            if (on) {
                vm.prank(emergency);
                queue.pauseQueue();
            }
        } else if (f == F_VENUE) {
            if (on) {
                vm.mockCallRevert(
                    AAVE_POOL,
                    abi.encodeWithSignature("withdraw(address,uint256,address)"),
                    bytes("32")
                );
                vm.mockCall(
                    address(aaveAdapter),
                    abi.encodeWithSignature("availableLiquidity()"),
                    abi.encode(uint256(0))
                );
            } else {
                vm.clearMockedCalls();
            }
        } else if (f == F_LEND) {
            if (on) {
                uint256 r = aaveAdapter.ratePerUnit();
                vm.mockCall(
                    address(aaveAdapter),
                    abi.encodeWithSignature("ratePerUnit()"),
                    abi.encode(r.mulDiv(LEND_SPIKE_BPS, BPS))
                );
            } else {
                vm.clearMockedCalls();
            }
        }
    }

    /// @notice Self-call: one 30-minute slot (the sim's own, no plan), then the fault's own events and the probes.
    function faultSlot(uint8 f) external {
        require(msg.sender == address(this), "self only");
        this.simSlot(false);
        uint256 now_ = vm.getBlockTimestamp();
        // The fault's end, once.
        if (fEnd != 0 && now_ >= fEnd && !endDone) {
            if (f != F_PAUSE) _faultSet(f, false);
            endActions = _tryActions();
            endDone = true;
        } else if (fEnd != 0 && !midDone && now_ >= fT0 + (fEnd - fT0) / 2) {
            midActions = _tryActions();
            midDone = true;
        }
        _track(f);
    }

    /// @dev Probe bookkeeping after each slot. The freeze fault waits for the probe deposit to settle, goes to the
    ///      last second of its hold (the longest wait, A16) and has the emergency key freeze that settlement.
    function _track(uint8 f) internal {
        uint256 now_ = vm.getBlockTimestamp();
        if (depClosedAt == 0 && queue.requestStatus(pDepId) == RequestStatus.Closed) {
            depClosedAt = now_;
            if (f == F_FREEZE && !freezeDone) {
                // A matched fill is read through the queue's index and has no claim until touched (E52): the
                // settlement is the latest one and the unlock is its time plus the hold.
                uint256 sid = queue.settlementCount();
                uint256 unlockAt = queue.getSettlement(sid).time + queue.flowParams().minHold;
                _until(unlockAt - 1);
                _feedTick();
                vm.prank(emergency);
                queue.freezeSettlement(sid);
                freezeUntil = queue.getSettlement(sid).frozenUntil;
                freezeDone = true;
                fEnd = freezeUntil;
                midActions = _tryActions();
                midDone = true;
            }
        }
        if (redClosedAt == 0 && queue.requestStatus(pRedId) == RequestStatus.Closed) {
            redClosedAt = now_;
        }
        if (depClosedAt != 0 && depUsableAt == 0 && queue.maxMint(pDep) != 0) depUsableAt = now_;
    }

    function _faultDone(uint8 f) internal view returns (bool) {
        if (f != F_NONE && f != F_FREEZE && !endDone) return false;
        if (f == F_FREEZE && (!freezeDone || vm.getBlockTimestamp() < freezeUntil)) return false;
        return redClosedAt != 0 && depUsableAt != 0;
    }

    struct FaultStats {
        uint256 maxRed;
        uint256 maxDep;
        uint256 openRed;
        uint256 openDep;
        uint256 expiredDep;
        uint256 nRed;
        uint256 nDep;
        uint256 ok;
        uint256 noop;
        uint256 blocked;
        uint256 other;
        uint256 firstBlocked;
    }

    /// @notice Self-call: finish and report.
    function faultClose(uint8 f) external {
        require(msg.sender == address(this), "self only");
        if (!endDone) {
            _faultSet(f, false);
            endActions = _tryActions();
        }
        FaultStats memory st = _stats();
        _writeFault(f, st);
        emit log_named_string("E48 fault", _faultName(f));
        emit log_named_uint("E48 attempts blocked", st.blocked);
        emit log_named_uint("E48 first blocked check", st.firstBlocked);
        emit log_named_uint(
            "E48 probe redeem wait (s, 0 = unfilled)", redClosedAt == 0 ? 0 : redClosedAt - fT0
        );
        emit log_named_uint(
            "E48 probe deposit usable wait (s, 0 = not usable)",
            depUsableAt == 0 ? 0 : depUsableAt - fT0
        );
        emit log_named_uint("E48 max redeem wait over all requests (s)", st.maxRed);
        emit log_named_uint("E48 max deposit wait over all requests (s)", st.maxDep);
        emit log_named_uint("E48 deposits expired unfilled", st.expiredDep);
        emit log_named_uint(
            "E48 probe deposit status at end (1 pending, 2 expired, 3 closed)",
            uint8(queue.requestStatus(pDepId))
        );
        emit log_named_uint("E48 actions mid (bits)", midActions);
        emit log_named_uint("E48 actions end (bits)", endActions);
    }

    /// @dev Waits over every request the sim made: done ones to their settlement (a deposit to its unlock), open ones
    ///      to the end of the run (so an open request's wait is a floor). Attempts by outcome.
    function _stats() internal view returns (FaultStats memory st) {
        uint256 now_ = vm.getBlockTimestamp();
        for (uint256 i; i < reqs.length; ++i) {
            ReqRec storage r = reqs[i];
            bool open = r.doneAt == 0;
            bool expired = open && r.isDeposit && queue.requestStatus(r.id) == RequestStatus.Expired;
            if (expired) {
                ++st.expiredDep;
                open = false;
            }
            uint256 end = expired
                ? queue.getRequest(r.id).expiresAt
                : (open ? now_ : (r.isDeposit ? r.unlockAt : r.doneAt));
            uint256 w = end > r.at ? end - r.at : 0;
            if (r.isDeposit) {
                ++st.nDep;
                if (open) ++st.openDep;
                if (w > st.maxDep) st.maxDep = w;
            } else {
                ++st.nRed;
                if (open) ++st.openRed;
                if (w > st.maxRed) st.maxRed = w;
            }
        }
        for (uint256 i; i < attempts.length; ++i) {
            uint16 oc = attempts[i].outcome;
            if (oc == OUT_OK) {
                ++st.ok;
            } else if (oc == OUT_NOOP) {
                ++st.noop;
            } else if (oc >= OUT_BLOCKED_BASE && oc < 200) {
                ++st.blocked;
                if (st.firstBlocked == 0) st.firstBlocked = oc - OUT_BLOCKED_BASE;
            } else {
                ++st.other;
            }
        }
    }

    function _writeFault(uint8 f, FaultStats memory st) internal {
        string memory o = "e48";
        vm.serializeString(o, "fault", _faultName(f));
        vm.serializeUint(o, "seed", seedK);
        vm.serializeUint(o, "faultSeconds", fEnd > fT0 ? fEnd - fT0 : 0);
        vm.serializeUint(o, "endedAtSeconds", vm.getBlockTimestamp() - fT0);
        vm.serializeUint(o, "attemptsOk", st.ok);
        vm.serializeUint(o, "attemptsNoop", st.noop);
        vm.serializeUint(o, "attemptsBlocked", st.blocked);
        vm.serializeUint(o, "attemptsOther", st.other);
        vm.serializeUint(o, "firstBlockedCheck", st.firstBlocked);
        vm.serializeUint(o, "probeRedeemWaitS", redClosedAt == 0 ? 0 : redClosedAt - fT0);
        vm.serializeBool(o, "probeRedeemDone", redClosedAt != 0);
        vm.serializeUint(o, "probeDepositSettledWaitS", depClosedAt == 0 ? 0 : depClosedAt - fT0);
        vm.serializeUint(o, "probeDepositUsableWaitS", depUsableAt == 0 ? 0 : depUsableAt - fT0);
        vm.serializeBool(o, "probeDepositDone", depUsableAt != 0);
        vm.serializeUint(o, "redeemRequests", st.nRed);
        vm.serializeUint(o, "depositRequests", st.nDep);
        vm.serializeUint(o, "maxRedeemWaitS", st.maxRed);
        vm.serializeUint(o, "maxDepositWaitS", st.maxDep);
        vm.serializeUint(o, "redeemsOpenAtEnd", st.openRed);
        vm.serializeUint(o, "depositsOpenAtEnd", st.openDep);
        vm.serializeUint(o, "depositsExpired", st.expiredDep);
        vm.serializeUint(o, "probeDepositStatusAtEnd", uint8(queue.requestStatus(pDepId)));
        vm.serializeUint(o, "actionsMidBits", midActions);
        vm.serializeUint(o, "actionsEndBits", endActions);
        string memory json = vm.serializeString(
            o,
            "actionOrder",
            "cancelDeposit,withdrawExpired,giveNotice,redeemInKind,mintShares,withdrawCredit"
        );
        string memory dir = string.concat(
            "out/prototype/",
            runName,
            "-timed-e48",
            bytes(runTag).length == 0 ? "" : string.concat("-", runTag)
        );
        vm.createDir(dir, true);
        vm.writeFile(
            string.concat(dir, "/e48-", _faultName(f), "-s", vm.toString(seedK), ".json"), json
        );
    }

    // ─── What a holder can do ───────────────────────────────────────────────────────────────────────────

    /// @dev Bit i is set if action i succeeds now. Each try is reverted, so the run is not changed.
    function _tryActions() internal returns (uint256 bits) {
        for (uint256 i; i < N_ACTIONS; ++i) {
            uint256 snap = vm.snapshotState();
            bool ok = _try(i);
            vm.revertToState(snap);
            if (ok) bits |= 1 << i;
        }
    }

    function _try(uint256 i) internal returns (bool ok) {
        if (i == 0) {
            vm.prank(pDep);
            (ok,) = address(queue).call(abi.encodeCall(queue.cancel, (pDepId)));
        } else if (i == 1) {
            vm.prank(pDep);
            (ok,) = address(queue).call(abi.encodeCall(queue.withdrawExpired, (pDepId)));
        } else if (i == 2) {
            vm.prank(pRed);
            (ok,) = address(queue).call(abi.encodeCall(queue.giveRedemptionNotice, (pRedId)));
        } else if (i == 3) {
            uint256 w = fund.balanceOf(genesisDepositors[1]);
            vm.prank(genesisDepositors[1]);
            (ok,) = address(fund)
                .call(
                    abi.encodeWithSignature(
                        "redeemInKind(uint256,address,address)",
                        w / 2,
                        genesisDepositors[1],
                        genesisDepositors[1]
                    )
                );
        } else if (i == 4) {
            uint256 m = queue.maxMint(pDep);
            if (m == 0) return false;
            vm.prank(pDep);
            (ok,) = address(queue).call(abi.encodeCall(queue.mint, (m, pDep)));
        } else {
            vm.prank(pRed);
            (ok,) = address(queue).call(abi.encodeCall(queue.withdrawCredit, ()));
        }
    }
}
