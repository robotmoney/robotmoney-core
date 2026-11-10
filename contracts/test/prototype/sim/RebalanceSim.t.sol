// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.2 (glide path), §5.3 / §5.3.1 (step and its cost),
//            §5.4 (keeper), §5.5 (plan states), §5.6 (parameters), §10 step 3, §13 G4 / G5, §14 (evidence log)
// Experiment prototype only (contracts/test/prototype/). Plan Step 3 (gates G4 and G5).
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {TickMath} from "../../../lib/TickMath.sol";
import {PrototypeHarness, IHarnessSwapRouter02} from "../PrototypeHarness.sol";
import {
    Plan,
    PlanParams,
    PlanStatus,
    SkipReason,
    StepOrder,
    StepResult,
    StepParams,
    AssetStepParams,
    IFundEvents,
    BPS,
    IDLE_INDEX,
    AssetKind
} from "../src/FundTypes.sol";
import {PlanMath} from "../src/PlanMath.sol";
import {SimLib} from "./SimLib.sol";

interface ISimPool {
    function token0() external view returns (address);
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
}

/// @notice One-vault experiment, plan Step 3: the rebalance simulation behind gates G4 (cost) and G5 (convergence).
///
///         Each test is one (scenario, fund size, seed). It opens receipt plans through the real receipt and
///         timelock path and runs the keeper every `stepInterval` until the plan concludes, on the recorded Base
///         fixture (no RPC in replay). Between keeper calls a seeded market runs: pool noise sized from the pool's
///         own depth, a zero-drift reference walk with the pool's own 30-minute TWAP volatility, an arbitrageur
///         that pulls each pool toward the reference, and small deposits and redeems.
///
///         Determinism: every draw is keccak256(seed, slot, stream, asset) with seed = keccak256("rm-sim-v1",
///         scenario, fundUsdc, k). No vm.randomUint, no fuzz input, nothing reads gasleft. A record run and a
///         replay run make identical calls. No market price is hard-coded: P0, sigma and pool depth come from
///         the pools at the pin.
///
///         The tests assert only what always holds (terminal plan state, the RB-4 step cap, costSpent equals the
///         measured costs, skips change nothing, steps mint and burn nothing). G4 and G5 are scored from the JSON
///         each test writes to out/prototype/<run>/sim-<scenario>-<fund>M-s<k>.json (contracts/test/prototype/
///         sim/score-sim.ts <run dir>). A gate miss is a measured result, not a red test.
///
///         The suite is opt-in (PROTO_SIM=1): each test runs minutes and writes a file, so the unit suite skips
///         it. Record and replay the fixture with PROTO_SIM=1 set, or the sim's state is not in the fixture.
///
///         Parameter sets. PROTO_SIM_RUN=default (or unset) runs the harness constants unchanged (the §5.6
///         suggested starts): this is the scored run. PROTO_SIM_RUN=tuned first sets the tuned values through the
///         timelock (the Safe's only path), then runs the same scenarios and seeds into out/prototype/tuned/.
///         Each tuned value is an env var PROTO_SIM_TUNED_<NAME> that falls back to the harness default, so the
///         tuned set is declared on the command line and written into every JSON (see `_applyTuned`).
contract RebalanceSimTest is PrototypeHarness {
    using Math for uint256;

    // ─── Scenarios ─────────────────────────────────────────────────────────────────────────────────────

    uint256 internal constant SCN_SEQ = 0;
    uint256 internal constant SCN_EXT = 1;
    uint256 internal constant SCN_EXT_PROBE = 2;
    uint256 internal constant SCN_JUMP_DOWN = 3;
    uint256 internal constant SCN_JUMP_UP = 4;

    // ─── Model ─────────────────────────────────────────────────────────────────────────────────────────

    /// @dev Path slots per plan (7 d / 30 min) and the loop bound: path + overrun + slack, so Expired is reached.
    uint256 internal constant LOOP_SLACK_SLOTS = 4;
    /// @dev JUMP scenarios: the deSPXA reference jumps at this plan slot (84 h in: f = 0.5 of a 7-day path).
    uint256 internal constant JUMP_SLOT = 168;
    /// @dev ±1000 bps of the USD price in milli-ticks: ln(0.9)/ln(1.0001) and ln(1.1)/ln(1.0001).
    int256 internal constant JUMP_DOWN_USD_MILLITICKS = -1_053_658;
    int256 internal constant JUMP_UP_USD_MILLITICKS = 953_149;
    /// @dev Sigma fallback when the observation ring holds fewer than 4 intervals: 2 × the 5 bps pool fee.
    uint256 internal constant FALLBACK_SIGMA_MILLITICKS = 10_000;
    /// @dev The arbitrageur's generous input. The router stops at the price limit, so the pool sizes the arb.
    uint256 internal constant ARB_BUDGET_USDC = 100_000_000e6;
    /// @dev Flows: one every ~6 h (1 in 12 slots), size 10..50 hundredths of a percent of NAV.
    uint256 internal constant FLOW_ONE_IN = 12;
    uint256 internal constant FLOW_MIN_BPS = 10;
    uint256 internal constant FLOW_SPAN_BPS = 41;
    uint256 internal constant CHECKPOINT_EVERY = 1;
    uint256 internal constant N_BASKET = 3;
    /// @dev Failed steps per plan replayed to name their revert (diagnostic, deterministic).
    uint256 internal constant MAX_FAIL_PROBES = 3;
    /// @dev sqrt(3/2) x 1e4. The stdev of differences of consecutive 30-minute MEAN ticks is sqrt(2/3) of the
    ///      30-minute log-return stdev of a random walk, so the measured value is scaled back up (review R4).
    uint256 internal constant SIGMA_DIFF_SCALE_E4 = 12_247;
    /// @dev deSPXA (review R1). Its fair price is the S&P 500, which trades Mon-Fri 14:30-21:00 UTC (EST; the pin
    ///      is 2026-11-10, after the DST change; holidays ignored). In those hours the arbitrageur mints and
    ///      redeems with the issuer, so its inventory is unlimited. Outside them the reference is frozen at the
    ///      close and the arbitrageur holds no deSPXA except what it bought back from the pool since the close:
    ///      it can always buy deSPXA that sits under the reference, but it can sell into a pool pushed over the
    ///      reference only from that inventory. The fund's own off-hours buying therefore stays in the price.
    ///      The walk's per-slot sigma is the measured one scaled to open-hours slots (the lookback's vol happened
    ///      in its open intervals). wETH and cbBTC keep the 24/7 unlimited arbitrageur (CEX arbitrage).
    uint256 internal constant US_OPEN_SEC = 52_200;
    uint256 internal constant US_CLOSE_SEC = 75_600;
    /// @dev A pool counts as out of its pin LP range when its active liquidity is under 1/100 of the pin's.
    uint256 internal constant OUT_OF_RANGE_L_DIV = 100;

    /// @dev Pre/post snapshot of the fund, all in one block.
    struct Snap {
        uint256 nav;
        uint256 idle;
        uint256 supply;
        uint256[3] lend;
        uint256[3] q;
        uint256[3] val;
    }

    /// @dev Per-plan accumulators (storage: the slot loop runs in self-calls that free their memory).
    struct Acc {
        uint256 planId;
        uint256 slots;
        uint256 calls;
        uint256 executed;
        uint256[8] byReason;
        uint256 traded;
        uint256 fundCost;
        int256 signedCost;
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
        uint256 flowsBlocked;
        uint256 flowLoss;
        int256 dilution;
        uint256 concludedAt;
        uint256 jumpAt;
        uint256 lastFailSelector;
        uint256 failProbes;
        string failReasons;
        string flowFailReason;
        uint256[4] startSleeve;
        uint256 startNav;
        /// @dev Execution cost against the reference walk (the model's fair price), not the pre-step spot.
        int256 execCostRef;
        /// @dev Flow dilution with holdings valued at the reference, not at TWAP (review flowloss-tautological).
        uint256 flowLossRef;
        /// @dev NothingToTrade / BelowMinStep calls while a masked asset (ORA-4 or backoff) sat off path.
        uint256 maskedCalls;
        /// @dev Keeper calls with each basket pool's active liquidity < 1% of the pin's (left the pin LP range).
        uint256[3] outOfRangeCalls;
        /// @dev Slots whose deSPXA arbitrage was skipped (outside US hours).
        uint256 despxaArbClosedSlots;
        /// @dev Peak fund deSPXA holdings, bps of the pool's deSPXA reserve and of deSPXA totalSupply.
        uint256 maxDespxaPoolShareBps;
        uint256 maxDespxaSupplyShareBps;
    }

    // ─── Run state ─────────────────────────────────────────────────────────────────────────────────────

    uint256 internal seed;
    uint256 internal scenario;
    uint256 internal fundSize;
    uint256 internal seedK;
    string internal scnName;
    uint256 internal slotIndex;
    uint256 internal pinBlock;
    uint256 internal pinTimestamp;
    uint256 internal depNonce;
    uint256 internal planIndex;
    string internal planLabel;
    /// @dev "default" or "tuned" (PROTO_SIM_RUN); names the output directory.
    string internal runName;
    /// @dev path + overrun slots + slack: the loop bound, so Expired is always reached.
    uint256 internal maxPlanSlots;

    address[3] internal pools;
    address[3] internal tokens;
    bool[3] internal usdc0;
    int256[3] internal refMilli;
    int256[3] internal p0Tick;
    uint256[3] internal p0Usdc;
    uint256[3] internal sigmaMilli;
    uint256[3] internal sigmaIntervals;
    uint256[3] internal depthAtPin;
    uint256[3] internal pinL;
    /// @dev deSPXA the arbitrageur bought from the pool since the last US close (its only off-hours inventory).
    uint256 internal arbDespxaInv;
    /// @dev Asset weights (bps) and idle at the moment the plan concluded (the end state G5 scores).
    uint256[] internal finalW;
    uint256 internal finalIdle;
    address[] internal genesisDepositors;

    Acc internal acc;
    Snap internal lastPost;
    string[] internal planJson;

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Tests: one per (scenario, fund, seed), so each stays under the memory limit and runs in parallel.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_sim_SEQ_1M_s0() public fixtureCovered {
        _run(SCN_SEQ, 1, 0);
    }

    function test_sim_SEQ_1M_s1() public fixtureCovered {
        _run(SCN_SEQ, 1, 1);
    }

    function test_sim_SEQ_1M_s2() public fixtureCovered {
        _run(SCN_SEQ, 1, 2);
    }

    function test_sim_SEQ_5M_s0() public fixtureCovered {
        _run(SCN_SEQ, 5, 0);
    }

    function test_sim_SEQ_5M_s1() public fixtureCovered {
        _run(SCN_SEQ, 5, 1);
    }

    function test_sim_SEQ_5M_s2() public fixtureCovered {
        _run(SCN_SEQ, 5, 2);
    }

    function test_sim_EXT_1M_s0() public fixtureCovered {
        _run(SCN_EXT, 1, 0);
    }

    function test_sim_EXT_1M_s1() public fixtureCovered {
        _run(SCN_EXT, 1, 1);
    }

    function test_sim_EXT_1M_s2() public fixtureCovered {
        _run(SCN_EXT, 1, 2);
    }

    function test_sim_EXT_PROBE_5M_s0() public fixtureCovered {
        _run(SCN_EXT_PROBE, 5, 0);
    }

    function test_sim_JUMP_DOWN_1M_s0() public fixtureCovered {
        _run(SCN_JUMP_DOWN, 1, 0);
    }

    function test_sim_JUMP_DOWN_1M_s1() public fixtureCovered {
        _run(SCN_JUMP_DOWN, 1, 1);
    }

    function test_sim_JUMP_DOWN_1M_s2() public fixtureCovered {
        _run(SCN_JUMP_DOWN, 1, 2);
    }

    function test_sim_JUMP_UP_1M_s0() public fixtureCovered {
        _run(SCN_JUMP_UP, 1, 0);
    }

    function test_sim_JUMP_UP_1M_s1() public fixtureCovered {
        _run(SCN_JUMP_UP, 1, 1);
    }

    function test_sim_JUMP_UP_1M_s2() public fixtureCovered {
        _run(SCN_JUMP_UP, 1, 2);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Driver
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _run(uint256 scn, uint256 fundM, uint256 k) internal {
        if (!vm.envOr("PROTO_SIM", false)) {
            vm.skip(true);
            return;
        }
        // Thousands of real swaps exceed forge's per-test gas. Nothing under test reads the meter except the
        // Rebalancer's gas-starvation guard, which then never fires (as in EndToEnd).
        vm.pauseGasMetering();
        _selectParams();
        _initSim(scn, fundM * 1_000_000e6, k);
        _genesis();
        _fixtureCheckpoint();

        (uint16[4][] memory vecs, string[] memory labels) = _sequence(scn);
        for (uint256 i; i < vecs.length; ++i) {
            _runPlan(vecs[i], labels[i]);
            _fixtureCheckpoint();
            // One idle slot (noise, arb, flows; no keeper) before the next receipt.
            if (i + 1 < vecs.length) this.simSlot(false);
        }
        _writeJson(fundM);
        vm.resumeGasMetering();
    }

    function _sequence(uint256 scn) internal pure returns (uint16[4][] memory v, string[] memory l) {
        if (scn == SCN_SEQ) {
            v = new uint16[4][](4);
            l = new string[](4);
            // R1' = deploy-2 receipt 0xdcf4.. with its 575 agent bps folded into stable (ADR-0017).
            (v[0], l[0]) = (_vec(9_125, 525, 350), "R1p");
            (v[1], l[1]) = (_vec(9_500, 500, 0), "d05");
            (v[2], l[2]) = (_vec(8_000, 1_000, 1_000), "d07");
            (v[3], l[3]) = (_vec(7_000, 1_500, 1_500), "d08");
        } else if (scn == SCN_EXT || scn == SCN_EXT_PROBE) {
            v = new uint16[4][](2);
            l = new string[](2);
            (v[0], l[0]) = (_vec(0, 5_000, 5_000), "X");
            (v[1], l[1]) = (_vec(10_000, 0, 0), "G");
        } else {
            v = new uint16[4][](1);
            l = new string[](1);
            (v[0], l[0]) = (_vec(8_000, 1_000, 1_000), "d07");
        }
    }

    function _vec(uint16 stable, uint16 protocol, uint16 rwa) internal pure returns (uint16[4] memory) {
        return sleeveVec(stable, protocol, rwa);
    }

    function _scnName(uint256 scn) internal pure returns (string memory) {
        if (scn == SCN_SEQ) return "SEQ";
        if (scn == SCN_EXT) return "EXT";
        if (scn == SCN_EXT_PROBE) return "EXT-PROBE";
        if (scn == SCN_JUMP_DOWN) return "JUMP-DOWN";
        return "JUMP-UP";
    }

    // ─── Parameter set (default or tuned) ──────────────────────────────────────────────────────────────

    /// @dev PROTO_SIM_RUN picks the parameter set. "default" changes nothing. "tuned" applies `_applyTuned`.
    function _selectParams() internal {
        runName = vm.envOr("PROTO_SIM_RUN", string("default"));
        bytes32 r = keccak256(bytes(runName));
        require(r == keccak256("default") || r == keccak256("tuned"), "PROTO_SIM_RUN must be default or tuned");
        if (r == keccak256("tuned")) _applyTuned();
        PlanParams memory pp = governance.defaultPlanParams();
        uint256 interval = rebalancer.effectiveStepInterval();
        maxPlanSlots = (uint256(pp.duration) + rebalancer.stepParams().maxOverrun) / interval + LOOP_SLACK_SLOTS;
    }

    /// @dev The ONE tuned set (§13: tuned once, chosen from the default run's data before the tuned run):
    ///        planDuration 7 d -> 21 d. In the default run the G4 cost above the arrival cost is the fund's own
    ///          deSPXA buying left in the pool while the S&P is closed (reference cost minus arrival cost). That
    ///          premium scales with the buying rate, so with 1/duration. Scaling each scored plan's premium by 7/D
    ///          projects, over the plans that stay in the pin LP range: D = 14 d median 10.0 / max 32.4 bps,
    ///          D = 21 d median 8.4 / max 23.5 bps. 21 d is the shortest whole-week duration under 30 with margin.
    ///        minStepUsdc 100 -> 33 USDC. 1M d05 moves ~$37k one-sided: $110 of path per slot at 7 d (14% of
    ///          calls skipped BelowMinStep) and $37 at 21 d, so a 100 floor would skip most calls. 100 x 7/21 keeps
    ///          the default's step cadence. It is a gas filter, so it changes no safety bound.
    ///      Everything else stays at its §5.6 start (no default-run number argues for a change: costSpent peaks at
    ///      29% of the budget, StepCostExceeded fires only past the deSPXA LP range edge, the 2k deSPXA cap never
    ///      binds at 21 d outside the unscored EXT-PROBE). Every value can still be overridden by its env var
    ///      PROTO_SIM_TUNED_<NAME>. The Rebalancer and governance enforce their own §5.6 bounds, so a tuned value
    ///      cannot weaken a safety floor. Set through the timelock (the Safe's only path, as in production).
    uint64 internal constant TUNED_PLAN_DURATION = 21 days;
    uint128 internal constant TUNED_MIN_STEP_USDC = 33e6;

    function _applyTuned() internal {
        StepParams memory sp = rebalancer.stepParams();
        sp.maxOverrun = uint32(vm.envOr("PROTO_SIM_TUNED_MAX_OVERRUN", uint256(sp.maxOverrun)));
        sp.maxStepCostBps = uint16(vm.envOr("PROTO_SIM_TUNED_MAX_STEP_COST_BPS", uint256(sp.maxStepCostBps)));
        sp.toleranceBps = uint16(vm.envOr("PROTO_SIM_TUNED_TOLERANCE_BPS", uint256(sp.toleranceBps)));
        sp.minStepUsdc = uint128(vm.envOr("PROTO_SIM_TUNED_MIN_STEP_USDC", uint256(TUNED_MIN_STEP_USDC)));
        timelockExecute(address(rebalancer), abi.encodeCall(rebalancer.setStepParams, (sp)));

        string[3] memory names = ["WETH", "CBBTC", "DESPXA"];
        for (uint256 b; b < N_BASKET; ++b) {
            uint256 i = IDX_WETH + b;
            AssetStepParams memory ap = rebalancer.assetStepParams(i);
            ap.maxStepUsdc =
                uint128(vm.envOr(string.concat("PROTO_SIM_TUNED_", names[b], "_MAX_STEP_USDC"), uint256(ap.maxStepUsdc)));
            ap.maxStepSlippageBps = uint16(
                vm.envOr(string.concat("PROTO_SIM_TUNED_", names[b], "_SLIPPAGE_BPS"), uint256(ap.maxStepSlippageBps))
            );
            timelockExecute(address(rebalancer), abi.encodeCall(rebalancer.setAssetStepParams, (i, ap)));
        }

        PlanParams memory pp = governance.defaultPlanParams();
        pp.duration = uint64(vm.envOr("PROTO_SIM_TUNED_PLAN_DURATION", uint256(TUNED_PLAN_DURATION)));
        pp.costBudgetBps = uint16(vm.envOr("PROTO_SIM_TUNED_COST_BUDGET_BPS", uint256(pp.costBudgetBps)));
        timelockExecute(address(governance), abi.encodeCall(governance.setDefaultPlanParams, (pp)));
    }

    // ─── Setup at the pin ──────────────────────────────────────────────────────────────────────────────

    function _initSim(uint256 scn, uint256 size, uint256 k) internal {
        scenario = scn;
        fundSize = size;
        pinBlock = vm.getBlockNumber();
        pinTimestamp = vm.getBlockTimestamp();
        seedK = k;
        seed = SimLib.seedOf(scn, size, k);
        scnName = _scnName(scn);
        pools = [WETH_POOL, CBBTC_POOL, DESPXA_POOL];
        tokens = [WETH, CBBTC, DESPXA];
        for (uint256 b; b < N_BASKET; ++b) {
            ISimPool p = ISimPool(pools[b]);
            usdc0[b] = p.token0() == USDC;
            (sigmaMilli[b], sigmaIntervals[b]) = _sigma(p, b == 2);
            int256 mean = _meanTick(p, TWAP_WINDOW);
            p0Tick[b] = mean;
            refMilli[b] = mean * 1000;
            p0Usdc[b] = fund.assetUsdcValue(IDX_WETH + b, 10 ** IERC20Metadata(tokens[b]).decimals());
            (uint160 sp,,,,,,) = p.slot0();
            pinL[b] = p.liquidity();
            depthAtPin[b] = SimLib.depth10Bps(p.liquidity(), sp, usdc0[b]);
        }
    }

    /// @dev Stdev of 30-minute mean-tick changes (one tick = 1 bp of price, so this is the log-return stdev in
    ///      bps) over the longest lookback the observation ring holds: a deterministic ladder 48, 24, 12, 8, 4.
    function _sigma(ISimPool p, bool equityHours) internal view returns (uint256 sigma, uint256 intervals) {
        uint256[5] memory ladder = [uint256(48), 24, 12, 8, 4];
        for (uint256 r; r < ladder.length; ++r) {
            uint256 n = ladder[r];
            uint32[] memory ago = new uint32[](n + 1);
            for (uint256 j; j <= n; ++j) {
                ago[j] = uint32((n - j) * TWAP_WINDOW);
            }
            try p.observe(ago) returns (int56[] memory c, uint160[] memory) {
                int256[] memory m = new int256[](n);
                for (uint256 j; j < n; ++j) {
                    m[j] = (int256(c[j + 1]) - int256(c[j])) * 1000 / int256(uint256(TWAP_WINDOW));
                }
                sigma = SimLib.stdevOfDiffs(m) * SIGMA_DIFF_SCALE_E4 / 10_000;
                if (equityHours) {
                    uint256 open;
                    for (uint256 j; j < n; ++j) {
                        if (_usMarketOpen(vm.getBlockTimestamp() - (n - j) * TWAP_WINDOW)) ++open;
                    }
                    if (open > 0) sigma = sigma * Math.sqrt(n * 1e8 / open) / 1e4;
                }
                return (sigma, n);
            } catch {}
        }
        return (FALLBACK_SIGMA_MILLITICKS, 0);
    }

    function _meanTick(ISimPool p, uint32 window) internal view returns (int256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory c,) = p.observe(ago);
        int256 d = int256(c[1]) - int256(c[0]);
        int256 t = d / int256(uint256(window));
        if (d < 0 && d % int256(uint256(window)) != 0) --t;
        return t;
    }

    /// @dev Genesis: a receipt-less 100%-stable (or d05) target at NAV 0, then the fund's money in 1M (5M: five
    ///      deposits at the per-deposit cap; 1M: four 250k deposits). Deposits route straight to target.
    function _genesis() internal {
        uint16[4] memory g = (scenario == SCN_JUMP_DOWN || scenario == SCN_JUMP_UP)
            ? _vec(9_500, 500, 0)
            : _vec(10_000, 0, 0);
        setTargetViaTimelock(g, governance.defaultPlanParams());
        uint256 n = fundSize > 1_000_000e6 ? fundSize / PER_DEPOSIT_CAP : 4;
        for (uint256 i; i < n; ++i) {
            address d = makeAddr(string.concat("sim-genesis-", vm.toString(i)));
            deposit(d, fundSize / n);
            genesisDepositors.push(d);
        }
    }

    // ─── One plan ──────────────────────────────────────────────────────────────────────────────────────

    function _runPlan(uint16[4] memory vec, string memory label) internal {
        this.simOpen(vec, label);
        _at(vm.getBlockTimestamp() + rebalancer.effectiveStepInterval());
        for (uint256 s; s < maxPlanSlots && fund.planStatus() == PlanStatus.Open; ++s) {
            this.simSlot(true);
            if (s % CHECKPOINT_EVERY == CHECKPOINT_EVERY - 1) _fixtureCheckpoint();
        }
        this.simClose();
    }

    /// @notice Self-call: open the plan through the receipt and timelock path and reset the accumulators.
    function simOpen(uint16[4] calldata vec, string calldata label) external {
        require(msg.sender == address(this), "self only");
        (uint256[4] memory sw,) = sleeveWeightsBps();
        uint256 navBefore = fund.totalAssets();
        uint256 id = recordAndApply(vec);
        delete acc;
        acc.planId = id;
        acc.startSleeve = sw;
        acc.startNav = navBefore;
        planLabel = label;
        ++planIndex;
        lastPost = _snap();
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Open), "plan opened");
    }

    /// @notice Self-call: one slot of `stepInterval`. Keeper at t, noise at t+600, arb at t+1200, flows at t+1500.
    function simSlot(bool withKeeper) external {
        require(msg.sender == address(this), "self only");
        uint256 t0 = vm.getBlockTimestamp();
        if (withKeeper) _keeper();
        _at(t0 + 600);
        _noise();
        _at(t0 + 1200);
        _arb();
        _at(t0 + 1500);
        _flow();
        _at(t0 + rebalancer.effectiveStepInterval());
        ++slotIndex;
        ++acc.slots;
    }

    function _at(uint256 t) internal {
        uint256 dt = t - vm.getBlockTimestamp();
        vm.warp(t);
        vm.roll(vm.getBlockNumber() + dt / 2);
    }

    // ─── Keeper ────────────────────────────────────────────────────────────────────────────────────────

    function _keeper() internal {
        (SkipReason predicted,,, uint256 notional) = rebalancer.previewStep();
        Snap memory pre = _snap();
        _attribute(pre);
        uint160[3] memory spot = _spots();
        uint256 spentBefore = fund.plan().costSpent;
        // The first few failures per plan are replayed against the fund to name the revert (diagnostic only).
        bool probe = predicted == SkipReason.None && acc.failProbes < MAX_FAIL_PROBES;
        uint256 snap = probe ? vm.snapshotState() : 0;
        bool maskedOff = _observeMarket();

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
            if (maskedOff && (why == SkipReason.NothingToTrade || why == SkipReason.BelowMinStep)) ++acc.maskedCalls;
            assertEq(post.nav, pre.nav, "skip: NAV unchanged");
            assertEq(fund.plan().costSpent, spentBefore, "skip: no cost");
            if (why == SkipReason.StepFailed) {
                acc.lastFailSelector = _failSelector(logs);
                if (probe) _probeFailure(snap);
            } else {
                assertEq(uint8(why), uint8(predicted), "previewStep predicts the skip");
            }
            if (probe) vm.deleteStateSnapshot(snap);
            return;
        }
        if (probe) vm.deleteStateSnapshot(snap);
        assertEq(uint8(predicted), uint8(SkipReason.None), "previewStep predicts the trade");
        _booked(pre, post, spot, notional, spentBefore);
        if (fund.planStatus() != PlanStatus.Open) _concluded();
    }

    /// @dev Per keeper call, before the step: LP-range and deSPXA-share logs, and whether an asset the
    ///      Rebalancer masks out (ORA-4 or backoff) still sits at least minStepUsdc off its path. Such an asset is
    ///      blocked even when step() reports NothingToTrade or BelowMinStep for the remaining legs.
    function _observeMarket() internal returns (bool maskedOff) {
        for (uint256 b; b < N_BASKET; ++b) {
            if (uint256(ISimPool(pools[b]).liquidity()) * OUT_OF_RANGE_L_DIV < pinL[b]) ++acc.outOfRangeCalls[b];
        }
        uint256 q = IERC20(DESPXA).balanceOf(address(fund));
        uint256 poolBal = IERC20(DESPXA).balanceOf(DESPXA_POOL);
        uint256 supply = IERC20(DESPXA).totalSupply();
        if (poolBal > 0 && q * BPS / poolBal > acc.maxDespxaPoolShareBps) acc.maxDespxaPoolShareBps = q * BPS / poolBal;
        if (supply > 0 && q * BPS / supply > acc.maxDespxaSupplyShareBps) acc.maxDespxaSupplyShareBps = q * BPS / supply;

        Plan memory p = fund.plan();
        (uint256 nav,, uint256[] memory values) = fund.portfolioValues();
        uint256 minStep = rebalancer.stepParams().minStepUsdc;
        for (uint256 b; b < N_BASKET; ++b) {
            uint256 i = IDX_WETH + b;
            bool masked = rebalancer.assetBackoffUntil(i) >= vm.getBlockTimestamp();
            if (!masked) {
                (bool ok,) = fund.marketCheck(i);
                masked = !ok;
            }
            if (!masked) continue;
            uint256 tgt = PlanMath.pathTargetValue(p, i, vm.getBlockTimestamp(), nav);
            uint256 gap = values[i] > tgt ? values[i] - tgt : tgt - values[i];
            if (gap >= minStep) return true;
        }
    }

    function _concluded() internal {
        acc.concludedAt = vm.getBlockTimestamp();
        (finalW, finalIdle) = assetWeightsBps();
    }

    /// @dev Book one executed step: (a) signed TWAP cost, (b) the fund's floored cost, (c) arrival-price
    ///      execution cost at the pre-step pool spot, (d) basis = a − c.
    function _booked(Snap memory pre, Snap memory post, uint160[3] memory spot, uint256 notional, uint256 spentBefore)
        internal
    {
        int256 signed = SimLib.sub(pre.nav, post.nav);
        uint256 fc = SimLib.pos(signed);
        assertLe(fc, notional.mulDiv(rebalancer.stepParams().maxStepCostBps, BPS), "RB-4: step cost <= cap");
        assertEq(fund.plan().costSpent, spentBefore + fc, "costSpent += measured cost");

        int256 dv = SimLib.sub(post.idle, pre.idle);
        for (uint256 j; j < 3; ++j) {
            dv += SimLib.sub(post.lend[j], pre.lend[j]);
        }
        for (uint256 b; b < N_BASKET; ++b) {
            dv += SimLib.spotUsdcSigned(SimLib.sub(post.q[b], pre.q[b]), spot[b], usdc0[b]);
        }
        int256 exec = -dv;
        acc.execCostRef += -_refValueDelta(pre, post);

        ++acc.executed;
        acc.traded += notional;
        acc.fundCost += fc;
        acc.signedCost += signed;
        acc.execCost += exec;
        acc.basisCost += signed - exec;
        uint256 fb = fc * BPS * 100 / notional;
        if (fb > acc.maxStepFundBps) acc.maxStepFundBps = fb;
        int256 eb = exec * int256(BPS * 100) / int256(notional);
        if (eb > acc.maxStepExecBps) acc.maxStepExecBps = eb;
    }

    /// @dev Δ(idle + lending + Σ q × reference price): the value change at the model's fair price.
    function _refValueDelta(Snap memory a, Snap memory b) internal view returns (int256 dv) {
        dv = SimLib.sub(b.idle, a.idle);
        for (uint256 j; j < 3; ++j) {
            dv += SimLib.sub(b.lend[j], a.lend[j]);
        }
        for (uint256 k; k < N_BASKET; ++k) {
            dv += SimLib.spotUsdcSigned(SimLib.sub(b.q[k], a.q[k]), _refSqrt(k), usdc0[k]);
        }
    }

    /// @dev NAV at the reference: idle + lending + Σ q × reference price.
    function _navRef(Snap memory s) internal view returns (uint256 v) {
        v = s.idle;
        for (uint256 j; j < 3; ++j) {
            v += s.lend[j];
        }
        for (uint256 k; k < N_BASKET; ++k) {
            v += SimLib.spotUsdc(s.q[k], _refSqrt(k), usdc0[k]);
        }
    }

    function _refSqrt(uint256 b) internal view returns (uint160) {
        return TickMath.getSqrtRatioAtTick(int24(refMilli[b] / 1000));
    }

    /// @dev US equity hours (Mon-Fri, US_OPEN_SEC..US_CLOSE_SEC UTC). Day 0 of the epoch was a Thursday.
    function _usMarketOpen(uint256 t) internal pure returns (bool) {
        uint256 dow = (t / 1 days + 4) % 7; // 0 = Sunday
        uint256 sod = t % 1 days;
        return dow >= 1 && dow <= 5 && sod >= US_OPEN_SEC && sod < US_CLOSE_SEC;
    }

    /// @dev Diagnostic: go back to the state before the failed step, rebuild the Rebalancer's order the way
    ///      `Rebalancer._buildOrder` does, call `fund.executeStep` as the Rebalancer, keep the revert data, then
    ///      return to the post-failure state. The run continues from exactly the state the real call left.
    function _probeFailure(uint256 before) internal {
        uint256 afterFail = vm.snapshotState();
        vm.revertToState(before);
        (, uint256 sell, uint256 buy, uint256 notional) = rebalancer.previewStep();
        StepOrder memory o = _order(sell, buy, notional);
        string memory why;
        vm.prank(address(rebalancer));
        try fund.executeStep(o) returns (StepResult memory) {
            why = "no-revert-on-probe";
        } catch (bytes memory err) {
            why = vm.toString(err);
        }
        string memory row = string.concat(
            vm.toString(sell), ">", vm.toString(buy), ":", vm.toString(notional), ":", _legDev(sell), _legDev(buy), why
        );
        // Storage writes come after the revert, or the revert would undo them.
        vm.revertToStateAndDelete(afterFail);
        vm.deleteStateSnapshot(before);
        ++acc.failProbes;
        acc.failReasons = string.concat(acc.failReasons, bytes(acc.failReasons).length == 0 ? "" : "|", row);
    }

    /// @dev "dev<bps>/tick<spot>/ref<ref>;" of a basket leg at the probe (spot-vs-TWAP deviation and the walk).
    function _legDev(uint256 i) internal view returns (string memory) {
        if (i == IDLE_INDEX || i < IDX_WETH) return "";
        (, uint256 dev) = fund.marketCheck(i);
        (, int24 tick,,,,,) = ISimPool(pools[i - IDX_WETH]).slot0();
        return string.concat(
            "dev", vm.toString(dev), "/tick", vm.toString(int256(tick)), "/ref", vm.toString(refMilli[i - IDX_WETH] / 1000),
            "/L", vm.toString(uint256(ISimPool(pools[i - IDX_WETH]).liquidity())), "/t", vm.toString(vm.getBlockTimestamp()), ";"
        );
    }

    function _order(uint256 sell, uint256 buy, uint256 notional) internal view returns (StepOrder memory o) {
        (o.sellIndex, o.buyIndex, o.notionalUsdc) = (sell, buy, notional);
        uint256 ceiling = fund.maxSlippageBps();
        if (sell != IDLE_INDEX) {
            uint256 keep = BPS - Math.min(rebalancer.assetStepParams(sell).maxStepSlippageBps, ceiling);
            if (fund.assetConfig(sell).kind == AssetKind.Basket) {
                uint256 quote = fund.assetUsdcValue(sell, fund.assetTokenValue(sell, notional));
                o.minSellUsdcOut = quote.mulDiv(keep, BPS);
            } else {
                o.minSellUsdcOut = notional.mulDiv(keep, BPS);
            }
        }
        if (buy != IDLE_INDEX && fund.assetConfig(buy).kind == AssetKind.Basket) {
            uint256 keep = BPS - Math.min(rebalancer.assetStepParams(buy).maxStepSlippageBps, ceiling);
            o.minBuyOut = fund.assetTokenValue(buy, notional).mulDiv(keep, BPS);
        }
        o.maxCostUsdc = notional.mulDiv(rebalancer.stepParams().maxStepCostBps, BPS);
    }

    function _failSelector(VmSafe.Log[] memory logs) internal view returns (uint256) {
        bytes32 sig = IFundEvents.RebalanceStepSkipped.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(rebalancer) && logs[i].topics[0] == sig) {
                (, , , uint256 detail) = abi.decode(logs[i].data, (SkipReason, uint256, uint256, uint256));
                return detail;
            }
        }
        return 0;
    }

    /// @dev Between two events holdings change only by price and lending interest. priceMove = Σ q·ΔTWAP,
    ///      interest = Δ lending, residual = ΔNAV − priceMove − interest (should be 0).
    function _attribute(Snap memory b) internal {
        Snap storage a = lastPost;
        int256 pm;
        for (uint256 i; i < N_BASKET; ++i) {
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

    // ─── Market ────────────────────────────────────────────────────────────────────────────────────────

    /// @dev 1 or 2 seeded swaps per pool, each a buy or sell that moves the pool's price by u × 10 bps. In range
    ///      that is a swap of u × D, D = the USDC notional that moves the spot 10 bps (from the pool's liquidity,
    ///      `SimLib.depth10Bps`, recorded at the pin). It is run as a price-limited swap, so a pool walked to the
    ///      edge of its liquidity is never pushed to an extreme price by noise (static LP ranges, no re-centering).
    function _noise() internal {
        for (uint256 b; b < N_BASKET; ++b) {
            uint256 n = 1 + SimLib.draw(seed, slotIndex, SimLib.TAG_NOISE_N, b) % 2;
            for (uint256 j; j < n; ++j) {
                uint256 a = b * 2 + j;
                bool buy = SimLib.draw(seed, slotIndex, SimLib.TAG_NOISE_DIR, a) % 2 == 0;
                uint256 u = SimLib.unit(seed, slotIndex, SimLib.TAG_NOISE_SIZE, a);
                if (u < SimLib.ONE / 100) continue;
                (uint160 sp,,,,,,) = ISimPool(pools[b]).slot0();
                // Buying the token with USDC lowers token1/token0 when USDC is token0.
                bool up = usdc0[b] ? !buy : buy;
                uint256 move = u * 5 / 10_000; // sqrt price moves half the price bps
                uint256 f = up ? SimLib.ONE + move : SimLib.ONE - move;
                _swapToLimit(b, up, uint160(uint256(sp).mulDiv(f, SimLib.ONE)));
            }
        }
    }

    /// @dev Advance each reference one walk step (ref *= exp(sigma·z), in ticks), then close a seeded fraction
    ///      a ∈ [0.5, 1) of each pool's gap to it (1.0 on the jump slot) with a price-limited swap.
    function _arb() internal {
        bool open = _usMarketOpen(vm.getBlockTimestamp());
        if (open) arbDespxaInv = 0; // the issuer redeems it; in hours the inventory is unlimited
        for (uint256 b; b < N_BASKET; ++b) {
            int256 z = SimLib.normal(seed, slotIndex, SimLib.TAG_WALK, b);
            bool jump = b == 2 && acc.slots == JUMP_SLOT && acc.jumpAt == 0 && _isJump();
            bool closed = b == 2 && !open && !jump;
            // deSPXA's reference is frozen while the S&P is closed.
            if (!closed) refMilli[b] += int256(sigmaMilli[b]) * z / int256(SimLib.ONE);
            uint256 a = SimLib.ONE / 2 + SimLib.unit(seed, slotIndex, SimLib.TAG_ARB, b) / 2;
            if (jump) {
                // The scripted jump is a gap move: the pool reprices to it whatever the hour.
                int256 usdJump = scenario == SCN_JUMP_DOWN ? JUMP_DOWN_USD_MILLITICKS : JUMP_UP_USD_MILLITICKS;
                refMilli[b] += usdc0[b] ? -usdJump : usdJump;
                a = SimLib.ONE;
                acc.jumpAt = vm.getBlockTimestamp();
            }
            if (closed) ++acc.despxaArbClosedSlots;
            (, int24 tick,,,,,) = ISimPool(pools[b]).slot0();
            int256 cur = int256(tick) * 1000;
            int256 tgt = cur + (refMilli[b] - cur) * int256(a) / int256(SimLib.ONE);
            int24 tt = int24(tgt / 1000);
            if (tt == tick) continue;
            bool up = tt > tick;
            if (!closed) {
                _swapToLimit(b, up, TickMath.getSqrtRatioAtTick(tt));
                continue;
            }
            // Off hours: buying deSPXA with USDC is unlimited and adds to the inventory; selling deSPXA is capped
            // by the inventory.
            bool usdcIn = up ? !usdc0[b] : usdc0[b];
            if (usdcIn) {
                (, uint256 got) = _swapToLimitCapped(b, up, TickMath.getSqrtRatioAtTick(tt), 0);
                arbDespxaInv += got;
            } else if (arbDespxaInv > 0) {
                (uint256 spent,) = _swapToLimitCapped(b, up, TickMath.getSqrtRatioAtTick(tt), arbDespxaInv);
                arbDespxaInv -= spent;
            }
        }
    }

    function _isJump() internal view returns (bool) {
        return scenario == SCN_JUMP_DOWN || scenario == SCN_JUMP_UP;
    }

    /// @dev `up`: pool price (token1 per token0) rises, so token1 goes in.
    function _swapToLimit(uint256 b, bool up, uint160 limit) internal {
        _swapToLimitCapped(b, up, limit, 0);
    }

    /// @dev `capIn` > 0 caps the input (a finite inventory); 0 means the generous budget. Returns the input spent
    ///      and the output received.
    function _swapToLimitCapped(uint256 b, bool up, uint160 limit, uint256 capIn)
        internal
        returns (uint256 spent, uint256 got)
    {
        bool usdcIn = up ? !usdc0[b] : usdc0[b];
        address tokenIn = usdcIn ? USDC : tokens[b];
        address tokenOut = usdcIn ? tokens[b] : USDC;
        uint256 amt = usdcIn ? ARB_BUDGET_USDC : spotTokenForUsdc(pools[b], ARB_BUDGET_USDC);
        if (capIn > 0 && capIn < amt) amt = capIn;
        uint256 bal = IERC20(tokenIn).balanceOf(address(this));
        if (bal < amt) {
            if (usdcIn) fundUsdc(address(this), amt - bal);
            else deal(tokenIn, address(this), amt);
        }
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).approve(ROUTER, amt);
        IHarnessSwapRouter02(ROUTER).exactInputSingle(
            IHarnessSwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, POOL_FEE, address(this), amt, 0, limit)
        );
        spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        got = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
    }

    // ─── Flows ─────────────────────────────────────────────────────────────────────────────────────────

    /// @dev With p = 1/12 a deposit or redeem (p = 0.5 each) of 0.10%..0.50% of NAV, measured in its own block.
    function _flow() internal {
        uint256 sl = slotIndex;
        if (SimLib.draw(seed, sl, SimLib.TAG_FLOW, 0) % FLOW_ONE_IN != 0) return;
        bool isDeposit = SimLib.draw(seed, sl, SimLib.TAG_FLOW_DIR, 0) % 2 == 0;
        uint256 bps = FLOW_MIN_BPS + SimLib.draw(seed, sl, SimLib.TAG_FLOW_SIZE, 0) % FLOW_SPAN_BPS;

        Snap memory pre = _snap();
        _attribute(pre);
        uint256 amt = pre.nav.mulDiv(bps, BPS);
        bool ok = isDeposit ? _flowDeposit(amt) : _flowRedeem(amt, sl);
        Snap memory post = _snap();
        lastPost = post;
        if (!ok) {
            ++acc.flowsBlocked;
            return;
        }
        if (isDeposit) ++acc.deposits;
        else ++acc.redeems;
        // dilution = ΔNAV − Δsupply × NAV_pre / supply_pre. Negative = a loss on the holders who stay.
        int256 dSupply = SimLib.sub(post.supply, pre.supply);
        int256 fair = dSupply >= 0
            ? int256(uint256(dSupply).mulDiv(pre.nav, pre.supply))
            : -int256(uint256(-dSupply).mulDiv(pre.nav, pre.supply));
        int256 dil = SimLib.sub(post.nav, pre.nav) - fair;
        acc.dilution += dil;
        if (dil < 0) acc.flowLoss += uint256(-dil);
        // The same at the reference price: a deficit-first deposit buys at spot but is credited at TWAP.
        uint256 refPre = _navRef(pre);
        int256 fairRef = dSupply >= 0
            ? int256(uint256(dSupply).mulDiv(refPre, pre.supply))
            : -int256(uint256(-dSupply).mulDiv(refPre, pre.supply));
        int256 dilRef = SimLib.sub(_navRef(post), refPre) - fairRef;
        if (dilRef < 0) acc.flowLossRef += uint256(-dilRef);
    }

    function _flowDeposit(uint256 amt) internal returns (bool) {
        address d = address(uint160(uint256(keccak256(abi.encode("rm-sim-depositor", seed, ++depNonce)))));
        fundUsdc(d, amt);
        vm.prank(d);
        IERC20(USDC).approve(address(fund), amt);
        vm.prank(d);
        try fund.deposit(amt, d) returns (uint256) {
            return true;
        } catch (bytes memory err) {
            _flowFail("deposit", err);
            return false;
        }
    }

    function _flowRedeem(uint256 amt, uint256 sl) internal returns (bool) {
        address h = genesisDepositors[SimLib.draw(seed, sl, SimLib.TAG_FLOW_WHO, 0) % genesisDepositors.length];
        uint256 shares = fund.convertToShares(amt);
        uint256 bal = fund.balanceOf(h);
        if (shares > bal) shares = bal / 2;
        if (shares == 0) return false;
        vm.prank(h);
        try fund.redeem(shares, h, h) returns (uint256) {
            return true;
        } catch (bytes memory err) {
            _flowFail("redeem", err);
            return false;
        }
    }

    function _flowFail(string memory kind, bytes memory err) internal {
        if (bytes(acc.flowFailReason).length == 0) acc.flowFailReason = string.concat(kind, ":", vm.toString(err));
    }

    // ─── Snapshots ─────────────────────────────────────────────────────────────────────────────────────

    function _snap() internal view returns (Snap memory s) {
        uint256[] memory values;
        (s.nav, s.idle, values) = fund.portfolioValues();
        for (uint256 j; j < 3; ++j) {
            s.lend[j] = values[IDX_AAVE + j];
        }
        for (uint256 b; b < N_BASKET; ++b) {
            s.val[b] = values[IDX_WETH + b];
            s.q[b] = IERC20(tokens[b]).balanceOf(address(fund));
        }
        s.supply = fund.totalSupply();
    }

    function _spots() internal view returns (uint160[3] memory sp) {
        for (uint256 b; b < N_BASKET; ++b) {
            (sp[b],,,,,,) = ISimPool(pools[b]).slot0();
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Conclusion and JSON
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Self-call: check the always-true end state, then serialize the plan row.
    function simClose() external {
        require(msg.sender == address(this), "self only");
        Plan memory p = fund.plan();
        PlanStatus st = p.status;
        assertTrue(
            st == PlanStatus.Converged || st == PlanStatus.Expired || st == PlanStatus.Halted,
            "plan reached a terminal state"
        );
        assertEq(p.id, acc.planId, "same plan throughout");
        assertEq(p.costSpent, acc.fundCost, "costSpent = sum of measured step costs");
        assertEq(p.stepCount, acc.executed, "fund counted every executed step");
        if (st != PlanStatus.Halted) assertLe(p.costSpent, p.costBudget, "unhalted plan within budget");

        string memory o = string.concat("plan", vm.toString(planIndex));
        _jsonIdentity(o, p);
        _jsonCost(o, p);
        _jsonSteps(o);
        _jsonModel(o);
        string memory row = _jsonEnd(o, p);
        planJson.push(row);
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
        uint256[4] memory es;
        for (uint256 s; s < 4; ++s) {
            es[s] = p.sleeveBps[s];
        }
        vm.serializeUint(o, "endSleeveBps", _arr4(es));
        vm.serializeUint(o, "startBps", _arr16(p.startBps));
        vm.serializeUint(o, "endBps", _arr16(p.endBps));
        vm.serializeUint(o, "permissionlessAtOpen", uint256(p.startTime) + rebalancer.stepParams().keeperGrace);
    }

    function _jsonCost(string memory o, Plan memory p) internal {
        vm.serializeUint(o, "turnoverUsdc", p.turnoverUsdc);
        vm.serializeUint(o, "tradedNotional", acc.traded);
        vm.serializeInt(o, "flowAssist", SimLib.sub(p.turnoverUsdc, acc.traded));
        vm.serializeUint(o, "costBudget", p.costBudget);
        vm.serializeUint(o, "costSpent", p.costSpent);
        vm.serializeInt(o, "signedTwapCost", acc.signedCost);
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
        vm.serializeUint(o, "flowsBlocked", acc.flowsBlocked);
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
        vm.serializeString(o, "lastStepFailedSelector", vm.toString(bytes4(uint32(acc.lastFailSelector))));
        vm.serializeString(o, "stepFailProbes", acc.failReasons);
        vm.serializeString(o, "firstFlowFailure", acc.flowFailReason);
        vm.serializeUint(o, "jumpAt", acc.jumpAt);
    }

    function _jsonModel(string memory o) internal {
        vm.serializeInt(o, "execCostRef", acc.execCostRef);
        vm.serializeUint(o, "flowLossRef", acc.flowLossRef);
        vm.serializeUint(o, "maskedCalls", acc.maskedCalls);
        uint256[] memory oor = new uint256[](3);
        for (uint256 b; b < N_BASKET; ++b) {
            oor[b] = acc.outOfRangeCalls[b];
        }
        vm.serializeUint(o, "outOfRangeCalls", oor);
        vm.serializeUint(o, "despxaArbClosedSlots", acc.despxaArbClosedSlots);
        vm.serializeUint(o, "maxDespxaPoolShareBps", acc.maxDespxaPoolShareBps);
        vm.serializeUint(o, "maxDespxaSupplyShareBps", acc.maxDespxaSupplyShareBps);
    }

    function _jsonEnd(string memory o, Plan memory p) internal returns (string memory) {
        string memory outcome = _statusName(p.status);
        uint256 at = acc.concludedAt;
        vm.serializeString(o, "outcome", outcome);
        vm.serializeUint(o, "concludedAt", at);
        vm.serializeUint(o, "timeToConvergeSec", at - p.startTime);
        vm.serializeUint(o, "overrunSec", at > p.endTime ? at - p.endTime : 0);
        vm.serializeBool(
            o,
            "convergedInWindow",
            p.status == PlanStatus.Converged && at <= uint256(p.endTime) + rebalancer.stepParams().maxOverrun
        );
        assertGt(at, 0, "conclusion was observed");
        (uint256[] memory w, uint256 idleBps) = (finalW, finalIdle);
        vm.serializeUint(o, "finalBps", w);
        vm.serializeUint(o, "finalIdleBps", idleBps);
        (uint256[] memory offIdx, uint256[] memory offGap, bool liquidOff) =
            _offTolerance(w, p.endBps, rebalancer.stepParams().toleranceBps);
        if (p.status == PlanStatus.Converged) assertEq(offIdx.length, 0, "converged: every asset within tolerance");
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
            // +1: weights are floored bps; the fund checks tolerance on the unrounded values (PlanMath).
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

    function _writeJson(uint256 fundM) internal {
        string memory m = "meta";
        vm.serializeString(m, "scenario", scnName);
        vm.serializeUint(m, "fundUsdc", fundSize);
        vm.serializeUint(m, "seedK", seedK);
        vm.serializeString(m, "seed", vm.toString(bytes32(seed)));
        vm.serializeBool(m, "recording", recording);
        vm.serializeUint(m, "pinBlock", pinBlock);
        vm.serializeUint(m, "pinTimestamp", pinTimestamp);
        vm.serializeUint(m, "blockAtEnd", vm.getBlockNumber());
        int256[] memory ticks = new int256[](3);
        for (uint256 b; b < N_BASKET; ++b) {
            ticks[b] = p0Tick[b];
        }
        vm.serializeInt(m, "p0TwapTick", ticks);
        vm.serializeUint(m, "sigmaMilliTicks", _arr3(sigmaMilli));
        vm.serializeUint(m, "sigmaIntervals", _arr3(sigmaIntervals));
        vm.serializeUint(m, "p0UsdcPerToken", _arr3(p0Usdc));
        vm.serializeUint(m, "depth10BpsUsdcAtPin", _arr3(depthAtPin));
        vm.serializeUint(m, "slotsRun", slotIndex);
        vm.serializeString(
            m,
            "model",
            "keeper t+0; noise t+600 (1-2 swaps/pool, u*D10bps); arb t+1200 (close a in [0.5,1) of gap to a zero-drift tick walk, sigma = pool 30-min mean-tick diff stdev x sqrt(3/2) (deSPXA: x sqrt(lookback/open intervals)); a=1 on jump; deSPXA: ref frozen and arb inventory = deSPXA bought back since the close outside Mon-Fri 14:30-21:00 UTC; wETH/cbBTC 24/7 unlimited); flows t+1500 (p=1/12, 0.10-0.50% NAV)"
        );
        vm.serializeString(m, "run", runName);
        string memory meta = vm.serializeString(m, "params", _paramsJson());
        string memory plans = "";
        for (uint256 i; i < planJson.length; ++i) {
            plans = string.concat(plans, i == 0 ? "" : ",", planJson[i]);
        }
        string memory full = string.concat('{"meta":', meta, ',"plans":[', plans, "]}");
        string memory dir = string.concat("out/prototype/", runName);
        vm.createDir(dir, true);
        string memory path =
            string.concat(dir, "/sim-", scnName, "-", vm.toString(fundM), "M-s", vm.toString(seedK), ".json");
        vm.writeFile(path, full);
    }

    /// @dev The parameters the run actually used, read back from the contracts (not from the constants).
    function _paramsJson() internal returns (string memory) {
        string memory k = "params";
        StepParams memory sp = rebalancer.stepParams();
        PlanParams memory pp = governance.defaultPlanParams();
        vm.serializeString(k, "set", runName);
        vm.serializeUint(k, "stepInterval", rebalancer.effectiveStepInterval());
        vm.serializeUint(k, "keeperGrace", sp.keeperGrace);
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
        return vm.serializeUint(k, "maxStepSlippageBps", slip);
    }

    function _arr3(uint256[3] storage a) internal view returns (uint256[] memory r) {
        r = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            r[i] = a[i];
        }
    }
}
