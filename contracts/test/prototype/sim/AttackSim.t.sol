// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md §4.1 (A2, A6, A9 and A10 "need the sim's arbitrage
//            model. They go in sim/AttackSim.t.sol, which reuses SimLib and the fast harness flags"), §4.4 (timed-flow
//            sim), §5 work packages 3 and 6; docs/technical/one-vault-rebalancer-proposal.md §13 G8;
//            one-vault-step3-finish-plan.md §3.4 ("A2, A6, A9 and A10 for both funds, with the attacker in the sim's
//            market loop"), §3.2 (the levers are measured here too)
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BaselineHarness} from "../baseline/BaselineHarness.sol";
import {PlanParams as BaselinePlanParams} from "../baseline/src/FundTypes.sol";
import {Vm} from "forge-std/Vm.sol";
import {AttackBook, AttackPnl} from "../Attacks.t.sol";
import {BPS} from "../src/FundTypes.sol";
import {FlowLevers, FlowParams} from "../src/FlowTypes.sol";
import {FlowQueue} from "../src/FlowQueue.sol";
import {SimLib} from "./SimLib.sol";
import {SimMarket} from "./SimMarket.sol";
import {TimedSimBase} from "./TimedSimBase.sol";
import {TimedFlowSimTest} from "./TimedFlowSim.t.sol";

/// @title LeverEnv
/// @notice The lever settings of step 3 finish plan §3.2 from the environment, for the timed attack world and the
///         timed-flow sim (added by `levers` 2026-11-12): PROTO_LEVER_LEG_BAND_BPS and PROTO_LEVER_REF_BAND_BPS
///         (FlowParams), PROTO_LEVER_BASKET_CALL_BPS and PROTO_LEVER_LEG_PRICE_MODE (FlowLevers). Set as ADMIN (the
///         timelock holds ADMIN_ROLE; pranked, so no time passes, unlike `timelockExecute`). Unset leaves a value as
///         it is. A run with any of them needs PROTO_SIM_TAG, so it writes to its own output directory.
library LeverEnv {
    function applyFromEnv(Vm vm, FlowQueue queue, address admin) internal returns (bool changed) {
        FlowParams memory p = queue.flowParams();
        FlowParams memory q = queue.flowParams();
        q.legBandBps = uint16(vm.envOr("PROTO_LEVER_LEG_BAND_BPS", uint256(q.legBandBps)));
        q.refBandBps = uint16(vm.envOr("PROTO_LEVER_REF_BAND_BPS", uint256(q.refBandBps)));
        if (keccak256(abi.encode(p)) != keccak256(abi.encode(q))) {
            vm.prank(admin);
            queue.setFlowParams(q);
            changed = true;
        }
        FlowLevers memory l = queue.flowLevers();
        FlowLevers memory m = FlowLevers({
            basketCallBps: uint16(vm.envOr("PROTO_LEVER_BASKET_CALL_BPS", uint256(l.basketCallBps))),
            legPriceMode: uint8(vm.envOr("PROTO_LEVER_LEG_PRICE_MODE", uint256(l.legPriceMode)))
        });
        if (m.basketCallBps != l.basketCallBps || m.legPriceMode != l.legPriceMode) {
            vm.prank(admin);
            queue.setFlowLevers(m);
            changed = true;
        }
    }
}

interface IAtkSimRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
    function exactOutputSingle(ExactOutputSingleParams calldata p) external payable returns (uint256);
}

/// @title AttackSimSpec
/// @notice What the four sim attacks measure, for both funds. The market is the step 3 sim's (`SimMarket`): a seeded
///         zero-drift reference walk per basket pool with the pool's own 30-minute volatility, noise sized from the
///         pool's depth, and an arbitrageur that pulls each pool a seeded 50 to 100 % of the way to the reference once
///         per 30-minute slot. The timed arm adds the feeds following the walk and the keeper settling every window end
///         (`TimedSimBase`). The attacker joins that loop: it trades to its target price at its start time and again
///         after every market event (noise, arbitrage) and right before the call it aims at, and pays whatever the
///         arbitrageur takes from it. It unwinds right after that call, into its own push.
///
///         Every attack is measured against its honest twin: the same seed, the same slots and the same flows without
///         the attacker's trades. The walk does not depend on pool state, so both runs end at the same reference
///         prices. `attackerNet` is the attacker's value at the reference walk at the end (USDC, tokens, shares at NAV
///         per share at the reference, queue claims) minus its value in the honest twin. `pendingLoss` is the same
///         difference for the pending user, the other way round. `holdersLoss` is the fall of NAV per share at the
///         reference against the twin, times the holders' shares. Scored by G8 (proposal §13): the worst variant of
///         every attack must net the attacker at most zero, and holders may lose at most 1 bps of NAV.
///
///         - A2, a push held 1 block, 5 minutes, 30 minutes or one settle window, of 25, 50 or 100 bps on each pool,
///           around a settlement (timed) or a flow (baseline). Timed flows: a stranger's deposit (push up: the fund
///           buys from the attacker's pushed pool), the attacker's own redemption (push up), a stranger's redemption
///           (push down) and the attacker's own deposit (push down). Baseline: the attacker's own deposit after a push
///           down, its own redemption into a push up.
///         - A10, a slow ramp of 5, 10 or 20 bps per slot over 2, 4 or 8 slots, same flows, the level at the call
///           being rate × slots.
///         - A6, the TWAP lag with a hedge and no manipulation: whenever the reference sits more than 25 or 50 bps
///           above the fund's TWAP (basket-weighted), the attacker deposits 200,000 USDC, shorts the shares' basket
///           tokens at the reference, and exits as fast as the fund allows (baseline: one TWAP window later; timed:
///           after the hold, through the queue). Net over a whole seeded run (4 days).
///         - A9, a run: ten holders with half of NAV redeem everything over two epochs while the market moves. Timed:
///           a redeemer still waiting 24 hours after its request exits the rest in kind. Who gets USDC first, the
///           waits, the in-kind exits with their lending position claims, and the stayers' loss against the twin.
abstract contract AttackSimSpec {
    uint256 internal constant SCN_A2_PUSH_HELD = 0;
    uint256 internal constant SCN_A6_TWAP_LAG = 1;
    uint256 internal constant SCN_A9_RUN = 2;
    uint256 internal constant SCN_A10_RAMP = 3;

    /// @dev The seeds each scenario runs: SimLib.seedOf(scenario, FUND_USDC, k), k < SEEDS (PROTO_SIM_ATTACK_SEEDS
    ///      may lower it for a quick look; the scored run uses SEEDS).
    uint256 internal constant SEEDS = 4;
    uint256 internal constant FUND_USDC = 5_000_000e6;
    /// @dev The attacker's own holding, the victim's holding and each flow aimed at.
    uint256 internal constant FLOW_USDC = 250_000e6;
    uint256 internal constant N_RUNNERS = 10;
    uint256 internal constant RUNNER_USDC = 250_000e6;
    uint256 internal constant A6_USDC = 200_000e6;
    uint256 internal constant FLASH_USDC = 50_000_000e6;
    uint256 internal constant WORLD_CHUNK_USDC = 245_000e6;
    uint256 internal constant WARMUP_SLOTS = 4;
    uint256 internal constant SLOT = 1_800;
    uint256 internal constant A6_SLOTS = 192;

    /// @dev Flows aimed at (A2, A10).
    uint8 internal constant FLOW_STRANGER_DEPOSIT = 0;
    uint8 internal constant FLOW_OWN_REDEEM = 1;
    uint8 internal constant FLOW_STRANGER_REDEEM = 2;
    uint8 internal constant FLOW_OWN_DEPOSIT = 3;

    function _seedOf(uint256 scenario, uint256 k) internal pure returns (uint256) {
        return SimLib.seedOf(scenario, FUND_USDC, k);
    }
}

/// @title AttackSimCore
/// @notice The attacker in the market loop, for both arms: its push toward a target price, its unwind, and the
///         result table each attack writes and scores. Harness-neutral (`SimMarket`).
abstract contract AttackSimCore is SimMarket, AttackBook, AttackSimSpec {
    using Math for uint256;

    address internal attacker = makeAddr("sim-attacker");
    address internal victim = makeAddr("sim-victim");
    address internal alice = makeAddr("sim-alice");
    address[] internal runners;

    /// @dev One variant of A2 or A10 (`ramp`): the flow aimed at, the pool, the level (bps, or bps per slot for a
    ///      ramp), the hold in seconds (A2) or the ramp's slots (A10), and whether the attacker trades (false: the
    ///      honest twin).
    struct Var {
        uint8 flow;
        uint8 b;
        uint16 lvl;
        uint32 hold;
        bool ramp;
        bool attack;
    }

    /// @dev One run's end state, all at the reference walk: the attacker's and the pending user's value, NAV per
    ///      share (1e18 scale) and the holders' shares, NAV, the outcome of the call aimed at, and what the attacker
    ///      spent on its pushes (the flash loan).
    struct Res {
        int256 atk;
        int256 vic;
        uint256 hps;
        uint256 holderShares;
        uint256 navRef;
        uint256 first;
        uint256 spent;
    }

    /// @dev The attacker's live push. `startAt`: when it starts holding; `aimAt`: the call it aims at.
    struct Atk {
        bool armed;
        bool active;
        bool done;
        bool up;
        bool ramp;
        uint8 b;
        uint16 lvl;
        uint64 startAt;
        uint64 aimAt;
        uint256[2] tok0;
    }

    Atk internal atk;
    uint256 internal atkSpent;

    function _optIn() internal returns (bool) {
        if (!vm.envOr("PROTO_SIM_ATTACKS", false)) {
            vm.skip(true, "opt-in: the sim attacks run minutes; set PROTO_SIM_ATTACKS=1");
            return false;
        }
        return true;
    }

    function _seeds() internal view returns (uint256) {
        return vm.envOr("PROTO_SIM_ATTACK_SEEDS", SEEDS);
    }

    /// @notice Arm the attacker for the run (its starting token balances are what it unwinds back to).
    function _arm(Var memory v, uint256 startAt, uint256 aimAt) internal {
        atk.armed = v.attack;
        atk.up = v.flow == FLOW_STRANGER_DEPOSIT || v.flow == FLOW_OWN_REDEEM;
        atk.ramp = v.ramp;
        atk.b = v.b;
        atk.lvl = v.lvl;
        atk.startAt = uint64(startAt);
        atk.aimAt = uint64(aimAt);
        for (uint256 b; b < MK_N; ++b) {
            atk.tok0[b] = IERC20(mkTokens[b]).balanceOf(attacker);
        }
    }

    /// @notice The level now: fixed (A2), or `lvl` per slot since the ramp started, one step per slot boundary (A10).
    function _level() internal view returns (uint256) {
        if (!atk.ramp) return atk.lvl;
        return uint256(atk.lvl) * ((vm.getBlockTimestamp() - atk.startAt) / SLOT + 1);
    }

    /// @notice The attacker trades pool b toward reference × (1 ± level), only in its own direction.
    function _atkPush() internal {
        if (!atk.active || atk.done) return;
        uint256 b = atk.b;
        uint256 lvl = _level();
        if (!atk.up && lvl >= BPS) lvl = BPS - 1;
        uint256 f = Math.sqrt((atk.up ? BPS + lvl : BPS - lvl) * 1e36 / BPS);
        uint160 ref = _mkRefSqrt(b);
        uint160 target = mkUsdc0[b] ? uint160(uint256(ref).mulDiv(1e18, f)) : uint160(uint256(ref).mulDiv(f, 1e18));
        uint160 sp = _mkSpotSqrt(b);
        // The token's USD price rises with sqrtP when the token is token0, and falls when it is token1.
        bool tokenPriceBelow = mkUsdc0[b] ? sp > target : sp < target;
        if (atk.up != tokenPriceBelow || sp == target) return;
        address tIn = atk.up ? MK_USDC : mkTokens[b];
        address tOut = atk.up ? mkTokens[b] : MK_USDC;
        uint256 bal = IERC20(tIn).balanceOf(attacker);
        uint256 usdc0 = IERC20(MK_USDC).balanceOf(attacker);
        vm.startPrank(attacker);
        IERC20(tIn).approve(MK_ROUTER, bal);
        IAtkSimRouter(MK_ROUTER).exactInputSingle(
            IAtkSimRouter.ExactInputSingleParams(tIn, tOut, MK_POOL_FEE, attacker, bal, 0, target)
        );
        IERC20(tIn).approve(MK_ROUTER, 0);
        vm.stopPrank();
        if (atk.up) atkSpent += usdc0 - IERC20(MK_USDC).balanceOf(attacker);
    }

    /// @notice Back to the starting token balance of the pushed pool, into the pool as it stands.
    function _atkUnwind() internal {
        if (!atk.active || atk.done) return;
        atk.done = true;
        atk.active = false;
        uint256 b = atk.b;
        address token = mkTokens[b];
        uint256 bal = IERC20(token).balanceOf(attacker);
        vm.startPrank(attacker);
        if (bal > atk.tok0[b]) {
            uint256 x = bal - atk.tok0[b];
            IERC20(token).approve(MK_ROUTER, x);
            IAtkSimRouter(MK_ROUTER).exactInputSingle(
                IAtkSimRouter.ExactInputSingleParams(token, MK_USDC, MK_POOL_FEE, attacker, x, 0, 0)
            );
        } else if (bal < atk.tok0[b]) {
            uint256 u = IERC20(MK_USDC).balanceOf(attacker);
            IERC20(MK_USDC).approve(MK_ROUTER, u);
            IAtkSimRouter(MK_ROUTER).exactOutputSingle(
                IAtkSimRouter.ExactOutputSingleParams(MK_USDC, token, MK_POOL_FEE, attacker, atk.tok0[b] - bal, u, 0)
            );
            IERC20(MK_USDC).approve(MK_ROUTER, 0);
        }
        vm.stopPrank();
    }

    /// @notice Value at the reference walk of `who`'s USDC and basket tokens.
    function _walletRef(address who) internal view returns (uint256 v) {
        v = IERC20(MK_USDC).balanceOf(who);
        for (uint256 b; b < MK_N; ++b) {
            uint256 unit = 10 ** IERC20Metadata(mkTokens[b]).decimals();
            v += IERC20(mkTokens[b]).balanceOf(who).mulDiv(_mkUsdcFor(b, unit, _mkRefSqrt(b)), unit);
        }
    }

    // ─── Result tables ──────────────────────────────────────────────────────────────────────────────────

    /// @dev One scored row: the variant, the seed, the attacker's net and the losses against the honest twin.
    struct Row {
        uint256 seedK;
        uint8 flow;
        uint8 b;
        uint16 lvl;
        uint32 hold;
        int256 net;
        int256 pendingLoss;
        int256 holdersLoss;
        uint256 navRef;
        uint256 first;
        uint256 spent;
    }

    function _row(uint256 k, Var memory v, Res memory h, Res memory a) internal pure returns (Row memory r) {
        r.seedK = k;
        (r.flow, r.b, r.lvl, r.hold) = (v.flow, v.b, v.lvl, v.hold);
        r.net = a.atk - h.atk;
        r.pendingLoss = h.vic - a.vic;
        r.holdersLoss = h.hps > a.hps
            ? int256((h.hps - a.hps).mulDiv(a.holderShares, 1e18))
            : -int256((a.hps - h.hps).mulDiv(a.holderShares, 1e18));
        r.navRef = a.navRef;
        r.first = a.first;
        r.spent = a.spent;
    }

    /// @notice A9 has no profit-seeking attacker: `atk` holds the runners' value. The row's net is 0, `pendingLoss` is
    ///         what the runners gave up against staying (negative: they did better), and the holders' loss is the
    ///         stayers'.
    function _rowRun(uint256 k, Res memory h, Res memory a) internal pure returns (Row memory r) {
        r = _row(k, Var(0, 0, 0, 0, false, true), h, a);
        r.pendingLoss = h.atk - a.atk;
        r.net = 0;
    }

    /// @notice Write the rows to out/prototype/attack-sim/<arm>-<id>.json and score the worst one: the attacker's best
    ///         net and the largest holders' loss over every variant and seed. `g8`: assert G8 (the timed fund); else
    ///         report only (the frozen fund, whose exposure the design names, proposal §5.9.1).
    function _score(string memory arm, string memory id, Row[] memory rows, uint256 n, bool g8) internal {
        _writeRows(arm, id, rows, n);
        uint256 worst;
        uint256 worstHolders;
        for (uint256 i = 1; i < n; ++i) {
            if (rows[i].net > rows[worst].net) worst = i;
            if (rows[i].holdersLoss > rows[worstHolders].holdersLoss) worstHolders = i;
        }
        if (n == 0) return;
        _logBestMean(arm, id, rows, n);
        _logBestOnTime(arm, id, rows, n);
        Row memory w = rows[worst];
        emit log_named_string(
            string.concat(arm, " ", id, " worst variant"),
            string.concat(
                "seed ", vm.toString(w.seedK), " flow ", vm.toString(uint256(w.flow)), " pool ", vm.toString(uint256(w.b)),
                " level ", vm.toString(uint256(w.lvl)), " hold ", vm.toString(uint256(w.hold)), " first outcome ",
                vm.toString(w.first)
            )
        );
        int256 hl = rows[worstHolders].holdersLoss;
        AttackPnl memory r = AttackPnl({
            attackerNet: w.net,
            flashBorrowed: w.spent,
            holdersLoss: hl > 0 ? uint256(hl) : 0,
            pendingLoss: w.pendingLoss > 0 ? uint256(w.pendingLoss) : 0,
            navRef: rows[worstHolders].navRef
        });
        string memory tag = string.concat(arm, " ", id, " (sim, ", vm.toString(n), " variant runs)");
        _reportPnl(tag, r);
        if (g8) _g8OrFinding(tag, r);
    }

    /// @notice Beside the strict score (the best single run), the best variant by its mean over the seeds: a variant
    ///         that delays the settlement also carries the market's move over the delay, which is zero-mean luck in
    ///         a single run. Logged only; G8 stays scored on the best single run.
    function _logBestMean(string memory arm, string memory id, Row[] memory rows, uint256 n) internal {
        int256 bestSum = type(int256).min;
        uint256 bestI;
        uint256 bestCount;
        for (uint256 i; i < n; ++i) {
            int256 sum;
            uint256 c;
            for (uint256 j; j < n; ++j) {
                if (_sameVar(rows[i], rows[j])) {
                    sum += rows[j].net;
                    ++c;
                }
            }
            if (sum / int256(c) > bestSum) (bestSum, bestI, bestCount) = (sum / int256(c), i, c);
        }
        Row memory r = rows[bestI];
        emit log_named_string(
            string.concat(arm, " ", id, " best variant by mean over seeds"),
            string.concat(
                "mean net ", vm.toString(bestSum), " over ", vm.toString(bestCount), " seeds; flow ",
                vm.toString(uint256(r.flow)), " pool ", vm.toString(uint256(r.b)), " level ", vm.toString(uint256(r.lvl)),
                " hold ", vm.toString(uint256(r.hold))
            )
        );
    }

    /// @notice The best single run among those whose aimed call settled (outcome 0): no delay, so no timing luck.
    ///         Logged only.
    function _logBestOnTime(string memory arm, string memory id, Row[] memory rows, uint256 n) internal {
        int256 best = type(int256).min;
        uint256 bi;
        for (uint256 i; i < n; ++i) {
            if (rows[i].first == 0 && rows[i].net > best) (best, bi) = (rows[i].net, i);
        }
        if (best == type(int256).min) return;
        Row memory r = rows[bi];
        emit log_named_string(
            string.concat(arm, " ", id, " best run settled at the aimed call"),
            string.concat(
                "net ", vm.toString(best), "; seed ", vm.toString(r.seedK), " flow ", vm.toString(uint256(r.flow)),
                " pool ", vm.toString(uint256(r.b)), " level ", vm.toString(uint256(r.lvl)), " hold ",
                vm.toString(uint256(r.hold))
            )
        );
    }

    function _sameVar(Row memory a, Row memory b) internal pure returns (bool) {
        return a.flow == b.flow && a.b == b.b && a.lvl == b.lvl && a.hold == b.hold;
    }

    function _writeRows(string memory arm, string memory id, Row[] memory rows, uint256 n) internal {
        string memory k = string.concat(arm, id);
        uint256[][8] memory u;
        int256[][3] memory s;
        for (uint256 c; c < 8; ++c) {
            u[c] = new uint256[](n);
        }
        for (uint256 c; c < 3; ++c) {
            s[c] = new int256[](n);
        }
        for (uint256 i; i < n; ++i) {
            u[0][i] = rows[i].seedK;
            u[1][i] = rows[i].flow;
            u[2][i] = rows[i].b;
            u[3][i] = rows[i].lvl;
            u[4][i] = rows[i].hold;
            u[5][i] = rows[i].navRef;
            u[6][i] = rows[i].first;
            u[7][i] = rows[i].spent;
            s[0][i] = rows[i].net;
            s[1][i] = rows[i].pendingLoss;
            s[2][i] = rows[i].holdersLoss;
        }
        vm.serializeUint(k, "seedK", u[0]);
        vm.serializeUint(k, "flow", u[1]);
        vm.serializeUint(k, "pool", u[2]);
        vm.serializeUint(k, "level", u[3]);
        vm.serializeUint(k, "hold", u[4]);
        vm.serializeUint(k, "navRef", u[5]);
        vm.serializeUint(k, "firstOutcome", u[6]);
        vm.serializeUint(k, "spent", u[7]);
        vm.serializeInt(k, "attackerNet", s[0]);
        vm.serializeInt(k, "pendingLoss", s[1]);
        string memory json = vm.serializeInt(k, "holdersLoss", s[2]);
        string memory dir = string.concat("out/prototype/attack-sim", _tagDir());
        vm.createDir(dir, true);
        vm.writeFile(string.concat(dir, "/", arm, "-", id, ".json"), json);
    }

    /// @dev Three levels from `name` (comma-separated), else `dflt`. A lever run that sets it needs PROTO_SIM_TAG.
    function _levels(string memory name, uint16[3] memory dflt) internal view returns (uint16[3] memory l) {
        uint256[] memory d = new uint256[](3);
        (d[0], d[1], d[2]) = (dflt[0], dflt[1], dflt[2]);
        uint256[] memory v = vm.envOr(name, ",", d);
        require(v.length == 3, "attack sim: a level list has three values");
        if (v[0] != d[0] || v[1] != d[1] || v[2] != d[2]) {
            require(bytes(_tagDir()).length != 0, "attack sim: a level list needs PROTO_SIM_TAG");
        }
        (l[0], l[1], l[2]) = (uint16(v[0]), uint16(v[1]), uint16(v[2]));
    }

    /// @dev PROTO_SIM_TAG names a lever run's own directory (attack-sim-<tag>), so it never writes over the default.
    function _tagDir() internal view returns (string memory) {
        string memory t = vm.envOr("PROTO_SIM_TAG", string(""));
        return bytes(t).length == 0 ? "" : string.concat("-", t);
    }

    /// @notice A2's grid: 2 pools × 3 levels × 4 holds × the arm's flows. PROTO_LEVER_A2_LEVELS (three
    ///         comma-separated bps, `levers` 2026-11-12) replaces the levels for a lever run that needs smaller pushes;
    ///         unset, the scored grid is unchanged.
    function _a2Vars(uint8[] memory flows) internal view returns (Var[] memory vs) {
        uint16[3] memory lv = _levels("PROTO_LEVER_A2_LEVELS", [uint16(25), 50, 100]);
        uint32[4] memory hd = [uint32(2), 300, 1_800, 3_600];
        vs = new Var[](2 * 3 * 4 * flows.length);
        uint256 n;
        for (uint256 f; f < flows.length; ++f) {
            for (uint8 b; b < 2; ++b) {
                for (uint256 l; l < 3; ++l) {
                    for (uint256 h; h < 4; ++h) {
                        vs[n++] = Var(flows[f], b, lv[l], hd[h], false, true);
                    }
                }
            }
        }
    }

    /// @notice A10's grid: 2 pools × 3 rates × 3 lengths × the arm's flows. `hold` carries the ramp's slots.
    ///         PROTO_LEVER_A10_RATES (three comma-separated bps per slot) replaces the rates, as for A2.
    function _a10Vars(uint8[] memory flows) internal view returns (Var[] memory vs) {
        uint16[3] memory rt = _levels("PROTO_LEVER_A10_RATES", [uint16(5), 10, 20]);
        uint32[3] memory ns = [uint32(2), 4, 8];
        vs = new Var[](2 * 3 * 3 * flows.length);
        uint256 n;
        for (uint256 f; f < flows.length; ++f) {
            for (uint8 b; b < 2; ++b) {
                for (uint256 r; r < 3; ++r) {
                    for (uint256 s; s < 3; ++s) {
                        vs[n++] = Var(flows[f], b, rt[r], ns[s], true, true);
                    }
                }
            }
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  The timed fund (step 3d / 3e), its queue and feeds
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/// @title AttackSimTimedTest
/// @notice The four sim attacks against the live fund (eng plan §5 work package 6). World: the seed invested to
///         (65, 35) by a 1-day plan, then alice, the attacker, the victim and ten runners deposit 5M USDC through the
///         queue in 245,000 USDC chunks, one per cap period, while the market runs (so the arbitrageur takes back the
///         fund's own impact), and their shares are delivered after the hold. Opt-in: PROTO_SIM_ATTACKS=1.
contract AttackSimTimedTest is TimedSimBase, AttackSimCore {
    using Math for uint256;

    uint256 internal aimFirstOutcome;
    bool internal aimSeen;

    /// @dev `TimedSimBase` and `SimMarket` both reach Test; the harness's fixture default is the sim's (off).
    function _fixtureCheckByDefault() internal pure override returns (bool) {
        return false;
    }

    function test_A2_sim_timed_twapPushHeldAgainstArbitrage() public fixtureCovered {
        if (!_optIn()) return;
        _world();
        uint8[] memory flows = new uint8[](4);
        (flows[0], flows[1], flows[2], flows[3]) =
            (FLOW_STRANGER_DEPOSIT, FLOW_OWN_REDEEM, FLOW_STRANGER_REDEEM, FLOW_OWN_DEPOSIT);
        _grid(SCN_A2_PUSH_HELD, "A2", _a2Vars(flows), flows);
    }

    function test_A10_sim_timed_slowRampAgainstArbitrage() public fixtureCovered {
        if (!_optIn()) return;
        _world();
        uint8[] memory flows = new uint8[](4);
        (flows[0], flows[1], flows[2], flows[3]) =
            (FLOW_STRANGER_DEPOSIT, FLOW_OWN_REDEEM, FLOW_STRANGER_REDEEM, FLOW_OWN_DEPOSIT);
        _grid(SCN_A10_RAMP, "A10", _a10Vars(flows), flows);
    }

    function test_A6_sim_timed_twapLagWithHedge() public fixtureCovered {
        if (!_optIn()) return;
        _world();
        uint256 ws = vm.snapshotState();
        uint256 seeds = _seeds();
        Row[] memory rows = new Row[](seeds * 2);
        uint256 n;
        for (uint256 k; k < seeds; ++k) {
            vm.revertToState(ws);
            this.seedPrep(_seedOf(SCN_A6_TWAP_LAG, k));
            uint256 ss = vm.snapshotState();
            Res memory h = this.a6Run(false, 0);
            for (uint256 t; t < 2; ++t) {
                vm.revertToState(ss);
                Var memory v = Var(0, 0, t == 0 ? 25 : 50, uint32(A6_SLOTS), false, true);
                rows[n++] = _row(k, v, h, this.a6Run(true, v.lvl));
            }
            vm.deleteStateSnapshot(ss);
        }
        _score("timed", "A6", rows, n, true);
    }

    function test_A9_sim_timed_run() public fixtureCovered {
        if (!_optIn()) return;
        _world();
        uint256 ws = vm.snapshotState();
        uint256 seeds = _seeds();
        Row[] memory rows = new Row[](seeds);
        for (uint256 k; k < seeds; ++k) {
            vm.revertToState(ws);
            this.seedPrep(_seedOf(SCN_A9_RUN, k));
            uint256 ss = vm.snapshotState();
            Res memory h = this.a9Run(false);
            vm.revertToState(ss);
            rows[k] = _rowRun(k, h, this.a9Run(true));
            vm.deleteStateSnapshot(ss);
        }
        _score("timed", "A9", rows, seeds, true);
    }

    // ─── World and seeds ────────────────────────────────────────────────────────────────────────────────

    function _world() internal {
        // A lever run (PROTO_SIM_FLOW_<FIELD>) needs PROTO_SIM_TAG, so it writes to attack-sim-<tag>/.
        bool overridden = _applyFlowOverrides();
        require(!overridden || bytes(_tagDir()).length != 0, "attack sim: an override needs PROTO_SIM_TAG");
        _mkInit(_seedOf(SCN_A2_PUSH_HELD, 0));
        _feedInit();
        _investQuiet(bucketVec(6_500, 3_500));
        _schedInit();
        address[] memory hs = new address[](3 + N_RUNNERS);
        uint256[] memory amts = new uint256[](3 + N_RUNNERS);
        (hs[0], amts[0]) = (attacker, FLOW_USDC);
        (hs[1], amts[1]) = (victim, FLOW_USDC);
        uint256 rest = FUND_USDC - SEED_USDC - 2 * FLOW_USDC;
        for (uint256 i; i < N_RUNNERS; ++i) {
            address r = makeAddr(string.concat("sim-runner-", vm.toString(i)));
            runners.push(r);
            (hs[2 + i], amts[2 + i]) = (r, RUNNER_USDC);
            rest -= RUNNER_USDC;
        }
        (hs[2 + N_RUNNERS], amts[2 + N_RUNNERS]) = (alice, rest);
        // The world is built with the per-call basket cap off, so its 245,000 USDC genesis chunks fill in their
        // period whatever the setting; the queue's defaults (5 bps since 2026-11-12) are put back before any attack.
        FlowLevers memory defaults = queue.flowLevers();
        vm.prank(address(timelock));
        queue.setFlowLevers(FlowLevers({basketCallBps: 0, legPriceMode: defaults.legPriceMode}));
        this.worldDeposits(hs, amts);
        vm.prank(address(timelock));
        queue.setFlowLevers(defaults);
        // Levers (step 3 finish plan §3.2, `levers` 2026-11-12) go in AFTER the world is built, so every lever runs
        // the same holders and NAV, and a genesis chunk never meets a per-call cap (it must fill in its period).
        bool levered = LeverEnv.applyFromEnv(vm, queue, address(timelock));
        require(!levered || bytes(_tagDir()).length != 0, "attack sim: a lever needs PROTO_SIM_TAG");
    }

    /// @notice Self-call: each holder's deposit through the queue, 245,000 USDC a period, the market running.
    function worldDeposits(address[] calldata hs, uint256[] calldata amts) external {
        require(msg.sender == address(this), "self only");
        for (uint256 i; i < hs.length; ++i) {
            uint256 left = amts[i];
            while (left != 0) {
                uint256 amt = left < WORLD_CHUNK_USDC ? left : WORLD_CHUNK_USDC;
                left -= amt;
                uint256 id = openDepositRequest(hs[i], amt, type(uint256).max);
                for (uint256 s; s < 32 && !queue.getRequest(id).closed; ++s) {
                    vm.resetGasMetering();
                    _atkSlot();
                }
                require(queue.getRequest(id).closed, "attack world: a deposit chunk did not fill");
            }
        }
        for (uint256 s; s < 50; ++s) {
            vm.resetGasMetering();
            _atkSlot();
        }
        for (uint256 i; i < hs.length; ++i) {
            uint256 m = queue.maxMint(hs[i]);
            if (m != 0) queue.mint(m, hs[i]);
        }
    }

    /// @notice Self-call: switch to seed `s`, run the warm-up slots, then run to the first slot of a new epoch, so
    ///         a request made next settles about 7 hours later (room for the longest hold and ramp).
    function seedPrep(uint256 s) external {
        require(msg.sender == address(this), "self only");
        mkSeed = s;
        uint256 epochLen = queue.flowParams().epochLength;
        for (uint256 i; i < WARMUP_SLOTS || vm.getBlockTimestamp() % epochLen >= SLOT; ++i) {
            vm.resetGasMetering();
            _atkSlot();
            require(i < WARMUP_SLOTS + 2 * epochLen / SLOT, "seedPrep: no epoch start");
        }
    }

    // ─── The slot with the attacker in it ───────────────────────────────────────────────────────────────

    /// @dev `TimedFlowSim.simSlot` without a plan step or random flows: keeper retry, noise (+600), walk, arbitrage
    ///      and feed rounds (+1200). The attacker starts at `startAt` and re-pushes after each market event.
    function _atkSlot() internal {
        uint256 t0 = vm.getBlockTimestamp();
        _retrySettle();
        _atkUntil(t0 + 600);
        _mkNoise();
        _atkPush();
        _atkUntil(t0 + 1_200);
        _mkWalkAndArb(false, 0);
        _feedDeviation();
        _atkPush();
        _atkUntil(t0 + SLOT);
        ++mkSlot;
        // `verify` 2026-11-12: with the coverage check on (replay, PROTO_FIXTURE_CHECK=1), decode one slot's state
        // diff at a time, as TimedFlowSim does; a whole run in one decode would run out of memory. No-op with the
        // check off and on the recorder's fork. Reads no chain state, so no result depends on it.
        _fixtureCheckpoint();
    }

    function _atkUntil(uint256 t) internal {
        if (atk.armed && !atk.active && !atk.done && atk.startAt < atk.aimAt && atk.startAt <= t) {
            if (atk.startAt > vm.getBlockTimestamp()) _until(atk.startAt);
            atk.active = true;
            _atkPush();
        }
        _until(t);
    }

    /// @dev Right before the keeper's call it aims at: the attacker's last push (a 1-block hold starts here).
    function _onSettlePre() internal override {
        if (!atk.armed || atk.done || vm.getBlockTimestamp() < atk.aimAt) return;
        atk.active = true;
        _atkPush();
    }

    /// @dev Right after that call: the outcome is recorded and the attacker unwinds into its own push.
    function _onSettlePost(uint16 outcome) internal override {
        if (!aimSeen && atk.aimAt != 0 && vm.getBlockTimestamp() >= atk.aimAt) {
            aimSeen = true;
            aimFirstOutcome = outcome;
        }
        if (atk.armed && atk.active && vm.getBlockTimestamp() >= atk.aimAt) _atkUnwind();
    }

    // ─── A2 and A10 ─────────────────────────────────────────────────────────────────────────────────────

    /// @dev For each seed: the honest twin of each flow, then every variant from the same state.
    function _grid(uint256 scn, string memory id, Var[] memory vs, uint8[] memory flows) internal {
        uint256 ws = vm.snapshotState();
        uint256 seeds = _seeds();
        Row[] memory rows = new Row[](seeds * vs.length);
        uint256 n;
        for (uint256 k; k < seeds; ++k) {
            vm.revertToState(ws);
            this.seedPrep(_seedOf(scn, k));
            vm.resetGasMetering();
            uint256 ss = vm.snapshotState();
            Res[] memory twin = new Res[](4);
            for (uint256 f; f < flows.length; ++f) {
                vm.revertToState(ss);
                twin[flows[f]] = this.flowRun(Var(flows[f], 0, 0, 0, false, false));
                vm.resetGasMetering();
            }
            for (uint256 i; i < vs.length; ++i) {
                vm.revertToState(ss);
                rows[n++] = _row(k, vs[i], twin[vs[i].flow], this.flowRun(vs[i]));
                // `levers` 2026-11-12: the grid's own frame meters every run, and under a lever whose limits make
                // sides fail (keeper retries every slot) 384 runs passed the 2^30 test gas limit (EvmError: Revert).
                // Metering only; no run's state or result depends on it (proof: notes/levers.md, lv0 rerun).
                vm.resetGasMetering();
            }
            vm.deleteStateSnapshot(ss);
        }
        _score("timed", id, rows, n, true);
    }

    /// @notice Self-call: one A2 / A10 run. The flow's request at the first slot of an epoch, the keeper's call at
    ///         its window end (`aimAt`), the attacker (if armed) from `aimAt − hold` (or the ramp's start) to right
    ///         after that call; the run ends an hour after it.
    function flowRun(Var calldata v) external returns (Res memory r) {
        require(msg.sender == address(this), "self only");
        fundUsdc(attacker, FLASH_USDC);
        for (uint256 b; b < MK_N; ++b) {
            deal(mkTokens[b], attacker, _mkTokenForUsdc(b, FLASH_USDC / 10, _mkRefSqrt(b)));
        }
        uint256 id = _flowRequest(v.flow);
        uint256 aimAt = queue.settleableAt(queue.getRequest(id).epoch);
        uint256 startAt = v.ramp ? aimAt - (uint256(v.hold) - 1) * SLOT : (v.hold <= 2 ? aimAt : aimAt - v.hold);
        require(startAt >= vm.getBlockTimestamp(), "flowRun: the hold starts before the request");
        _arm(v, startAt, aimAt);
        while (vm.getBlockTimestamp() < aimAt + 3_600) {
            vm.resetGasMetering();
            _atkSlot();
        }
        _atkUnwind();
        r = _result(id, v.flow);
    }

    function _flowRequest(uint8 flow) internal returns (uint256 id) {
        bool ok;
        if (flow == FLOW_STRANGER_DEPOSIT) (ok, id,) = _reqDeposit(victim, FLOW_USDC, 100);
        else if (flow == FLOW_OWN_DEPOSIT) (ok, id,) = _reqDeposit(attacker, FLOW_USDC, BPS);
        else if (flow == FLOW_STRANGER_REDEEM) (ok, id,) = _reqRedeem(victim, fund.balanceOf(victim), 100);
        else (ok, id,) = _reqRedeem(attacker, fund.balanceOf(attacker), BPS);
        require(ok, "flowRun: the request reverted");
    }

    /// @dev Claims taken, then everything valued at the reference walk.
    function _result(uint256 id, uint8 flow) internal returns (Res memory r) {
        _claimOwed(attacker);
        _claimOwed(victim);
        (, uint256 navRef, uint256 supply) = _navFeedRef();
        r.atk = int256(_valueRef(attacker, navRef, supply));
        r.vic = int256(_valueRef(victim, navRef, supply));
        bool depositFlow = flow == FLOW_STRANGER_DEPOSIT || flow == FLOW_OWN_DEPOSIT;
        if (depositFlow && !queue.getRequest(id).closed) {
            int256 escrow = int256(queue.getRequest(id).remaining);
            if (flow == FLOW_STRANGER_DEPOSIT) r.vic += escrow;
            else r.atk += escrow;
        }
        r.hps = navRef.mulDiv(1e18, supply);
        r.holderShares = fund.balanceOf(alice) + fund.balanceOf(address(fund));
        for (uint256 i; i < runners.length; ++i) {
            r.holderShares += fund.balanceOf(runners[i]);
        }
        r.navRef = navRef;
        r.first = aimSeen ? aimFirstOutcome : type(uint16).max;
        r.spent = atkSpent;
    }

    function _claimOwed(address who) internal {
        uint256 m = queue.maxRedeem(who);
        if (m != 0) {
            vm.prank(who);
            queue.redeem(m, who, who);
        }
    }

    /// @notice USDC, tokens and every share `who` holds or has queued or credited, at the reference walk.
    function _valueRef(address who, uint256 navRef, uint256 supply) internal view returns (uint256 v) {
        v = _walletRef(who);
        (uint256 cu, uint256 cs) = queue.creditOf(who);
        v += cu + (fund.balanceOf(who) + queue.queuedSharesOf(who) + cs).mulDiv(navRef, supply);
    }

    // ─── A6: the TWAP lag with a hedge ──────────────────────────────────────────────────────────────────

    /// @dev The attacker's open position: 0 idle, 1 deposit requested, 2 shares held (in the hold), 3 redemption
    ///      requested. The hedge is a short of `hedgeQ` basket tokens opened at `hedgePx` (reference).
    uint256 internal a6State;
    uint256 internal a6Req;
    uint256 internal a6Spent;
    int256 internal a6Hedge;
    uint256[2] internal hedgeQ;
    uint256[2] internal hedgePx;

    /// @notice Self-call: 4 days of market; when armed, the attacker trades the lag (threshold `theta` bps).
    function a6Run(bool armed, uint256 theta) external returns (Res memory r) {
        require(msg.sender == address(this), "self only");
        for (uint256 s; s < A6_SLOTS; ++s) {
            vm.resetGasMetering();
            _atkSlot();
            if (armed) _a6Step(theta);
        }
        if (a6State != 0) _a6MarkHedge();
        (, uint256 navRef, uint256 supply) = _navFeedRef();
        _claimOwed(attacker);
        // The deposits' USDC was minted to the attacker at each request (`_reqDeposit`): it is what it paid in.
        r.atk = int256(_valueRef(attacker, navRef, supply)) + a6Hedge - int256(a6Spent);
        if (a6State == 1) r.atk += int256(queue.getRequest(a6Req).remaining);
        r.hps = navRef.mulDiv(1e18, supply);
        r.holderShares = fund.balanceOf(alice) + fund.balanceOf(address(fund));
        r.navRef = navRef;
        r.spent = a6Spent;
    }

    function _a6Step(uint256 theta) internal {
        if (a6State == 0) {
            if (_lagBps() <= int256(theta)) return;
            bool ok;
            (ok, a6Req,) = _reqDeposit(attacker, A6_USDC, BPS);
            if (ok) {
                a6State = 1;
                a6Spent += A6_USDC;
            }
        } else if (a6State == 1) {
            if (!queue.getRequest(a6Req).closed) return;
            uint256 sh = queue.queuedSharesOf(attacker);
            (, uint256[] memory held) = fund.heldBalances();
            uint256 supply = fund.totalSupply();
            for (uint256 b; b < MK_N; ++b) {
                hedgeQ[b] = held[IDX_WETH + b].mulDiv(sh, supply);
                hedgePx[b] = _refPerToken(b);
            }
            a6State = 2;
        } else if (a6State == 2) {
            uint256 m = queue.maxMint(attacker);
            if (m == 0) return;
            uint256 before = fund.balanceOf(attacker);
            queue.mint(m, attacker);
            // Only the hedged deposit's shares leave; the attacker's world holding stays, as in the twin.
            bool ok;
            (ok, a6Req,) = _reqRedeem(attacker, fund.balanceOf(attacker) - before, BPS);
            if (ok) a6State = 3;
        } else if (queue.getRequest(a6Req).closed) {
            _claimOwed(attacker);
            _a6MarkHedge();
            a6State = 0;
        }
    }

    /// @dev Close the short at the reference now: + q × (entry − now) per token.
    function _a6MarkHedge() internal {
        for (uint256 b; b < MK_N; ++b) {
            if (hedgeQ[b] == 0) continue;
            uint256 unit = 10 ** IERC20Metadata(mkTokens[b]).decimals();
            int256 d = int256(hedgePx[b]) - int256(_refPerToken(b));
            a6Hedge += d * int256(hedgeQ[b]) / int256(unit);
            hedgeQ[b] = 0;
        }
    }

    /// @dev Reference over the fund's own 30-minute TWAP, weighted by the basket's value in the fund (bps).
    function _lagBps() internal view returns (int256 lag) {
        (, uint256[] memory held) = fund.heldBalances();
        uint256 wsum;
        for (uint256 b; b < MK_N; ++b) {
            uint256 unit = 10 ** IERC20Metadata(mkTokens[b]).decimals();
            uint256 twap = fund.assetUsdcValue(IDX_WETH + b, unit);
            uint256 w = held[IDX_WETH + b].mulDiv(twap, unit);
            lag += _mkBps(_refPerToken(b), twap) * int256(w);
            wsum += w;
        }
        if (wsum != 0) lag /= int256(wsum);
    }

    // ─── A9: a run ──────────────────────────────────────────────────────────────────────────────────────

    /// @notice Self-call: when `run`, runners 0-4 ask to redeem everything now and runners 5-9 one epoch later, with
    ///         no limit; a runner still waiting 24 hours after its request exits the rest in kind. 4 days. Logs
    ///         each runner's first fill, completion, USDC and in-kind value. The result's `atk` is the runners' total
    ///         value and `vic` 0; the scored loss is the stayers' (holders').
    function a9Run(bool run) external returns (Res memory r) {
        require(msg.sender == address(this), "self only");
        uint256 t0 = vm.getBlockTimestamp();
        uint256[] memory ids = new uint256[](N_RUNNERS);
        uint256[] memory askedAt = new uint256[](N_RUNNERS);
        uint256 epochLen = queue.flowParams().epochLength;
        for (uint256 s; s < 192; ++s) {
            if (run) _a9Requests(ids, askedAt, t0, epochLen);
            vm.resetGasMetering();
            _atkSlot();
            if (run) _a9InKind(ids, askedAt);
        }
        (, uint256 navRef, uint256 supply) = _navFeedRef();
        for (uint256 i; i < N_RUNNERS; ++i) {
            _claimOwed(runners[i]);
            uint256 v = _valueRef(runners[i], navRef, supply) + _positionValue(runners[i]);
            r.atk += int256(v);
            if (run) _a9Log(i, ids[i], askedAt[i], v);
        }
        r.hps = navRef.mulDiv(1e18, supply);
        r.holderShares = fund.balanceOf(alice) + fund.balanceOf(address(fund)) + fund.balanceOf(attacker)
            + fund.balanceOf(victim);
        r.navRef = navRef;
    }

    function _a9Requests(uint256[] memory ids, uint256[] memory askedAt, uint256 t0, uint256 epochLen) internal {
        for (uint256 i; i < N_RUNNERS; ++i) {
            if (ids[i] != 0 || vm.getBlockTimestamp() < t0 + (i < N_RUNNERS / 2 ? 0 : epochLen)) continue;
            (bool ok, uint256 id,) = _reqRedeem(runners[i], fund.balanceOf(runners[i]), BPS);
            require(ok, "A9: a redemption request reverted");
            (ids[i], askedAt[i]) = (id, vm.getBlockTimestamp());
        }
    }

    function _a9InKind(uint256[] memory ids, uint256[] memory askedAt) internal {
        for (uint256 i; i < N_RUNNERS; ++i) {
            if (ids[i] == 0 || queue.getRequest(ids[i]).closed) continue;
            if (vm.getBlockTimestamp() < askedAt[i] + 1 days) continue;
            vm.prank(runners[i]);
            queue.exitInKind(ids[i]);
        }
    }

    /// @dev Lending position claims from in-kind exits, at the venues' own value (`positionClaimOf`).
    function _positionValue(address who) internal view returns (uint256 v) {
        uint256 n = fund.assetCount();
        for (uint256 i; i < n; ++i) {
            if (i == IDX_WETH || i == IDX_CBBTC) continue;
            (, uint256 usdc) = fund.positionClaimOf(i, who);
            v += usdc;
        }
    }

    function _a9Log(uint256 i, uint256 id, uint256 askedAt, uint256 value) internal {
        string memory head = _a9Times(id, askedAt);
        string memory tail = string.concat(
            " status ", vm.toString(uint256(uint8(queue.requestStatus(id)))), " value at ref ", vm.toString(value)
        );
        emit log_named_string(
            string.concat("A9 timed runner ", vm.toString(i)),
            string.concat(head, tail, " position claims ", vm.toString(_positionValue(runners[i])))
        );
    }

    function _a9Times(uint256 id, uint256 askedAt) internal view returns (string memory) {
        uint256 k = reqIndex[id];
        uint256 first = k == 0 ? 0 : reqs[k - 1].firstFillAt;
        uint256 doneAt = k == 0 ? 0 : reqs[k - 1].doneAt;
        return string.concat(
            "asked ", vm.toString(askedAt), " first fill ", vm.toString(first), " done ", vm.toString(doneAt)
        );
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  The frozen synchronous fund (step 3c)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/// @title AttackSimBaselineTest
/// @notice The four sim attacks against the frozen synchronous fund (eng plan §5 work package 3), on the §4.5 basket
///         (deSPXA listed at weight 0). World: a 1-day (65, 35) target at NAV 0, then alice, the attacker, the
///         victim and ten runners deposit 5M USDC in 245,000 USDC deposits, which route to target (deficit-first),
///         one per slot while the market runs. Flows are synchronous: a deposit mints on the TWAP NAV's realized
///         change, a redemption pays the realized proceeds of a pro-rata slice. Opt-in: PROTO_SIM_ATTACKS=1.
contract AttackSimBaselineTest is BaselineHarness, AttackSimCore {
    using Math for uint256;

    uint256 internal constant B_LEND_N = 3;

    function _mkFundUsdc(address to, uint256 amount) internal override {
        fundUsdc(to, amount);
    }

    function _fixtureCheckByDefault() internal pure override returns (bool) {
        return false;
    }

    function test_A2_sim_baseline_twapPushHeldAgainstArbitrage() public fixtureCovered {
        if (!_optIn()) return;
        _worldB();
        uint8[] memory flows = new uint8[](2);
        (flows[0], flows[1]) = (FLOW_OWN_DEPOSIT, FLOW_OWN_REDEEM);
        _gridB(SCN_A2_PUSH_HELD, "A2", _a2Vars(flows), flows);
    }

    function test_A10_sim_baseline_slowRampAgainstArbitrage() public fixtureCovered {
        if (!_optIn()) return;
        _worldB();
        uint8[] memory flows = new uint8[](2);
        (flows[0], flows[1]) = (FLOW_OWN_DEPOSIT, FLOW_OWN_REDEEM);
        _gridB(SCN_A10_RAMP, "A10", _a10Vars(flows), flows);
    }

    function test_A6_sim_baseline_twapLagWithHedge() public fixtureCovered {
        if (!_optIn()) return;
        _worldB();
        uint256 ws = vm.snapshotState();
        uint256 seeds = _seeds();
        Row[] memory rows = new Row[](seeds * 2);
        uint256 n;
        for (uint256 k; k < seeds; ++k) {
            vm.revertToState(ws);
            this.seedPrepB(_seedOf(SCN_A6_TWAP_LAG, k));
            uint256 ss = vm.snapshotState();
            Res memory h = this.a6RunB(false, 0);
            for (uint256 t; t < 2; ++t) {
                vm.revertToState(ss);
                Var memory v = Var(0, 0, t == 0 ? 25 : 50, uint32(A6_SLOTS), false, true);
                rows[n++] = _row(k, v, h, this.a6RunB(true, v.lvl));
            }
            vm.deleteStateSnapshot(ss);
        }
        _score("baseline", "A6", rows, n, false);
    }

    function test_A9_sim_baseline_run() public fixtureCovered {
        if (!_optIn()) return;
        _worldB();
        uint256 ws = vm.snapshotState();
        uint256 seeds = _seeds();
        Row[] memory rows = new Row[](seeds);
        for (uint256 k; k < seeds; ++k) {
            vm.revertToState(ws);
            this.seedPrepB(_seedOf(SCN_A9_RUN, k));
            uint256 ss = vm.snapshotState();
            Res memory h = this.a9RunB(false);
            vm.revertToState(ss);
            rows[k] = _rowRun(k, h, this.a9RunB(true));
            vm.deleteStateSnapshot(ss);
        }
        _score("baseline", "A9", rows, seeds, false);
    }

    // ─── World ──────────────────────────────────────────────────────────────────────────────────────────

    function _worldB() internal {
        _mkInit(_seedOf(SCN_A2_PUSH_HELD, 0));
        setTargetViaTimelock(bucketVec(6_500, 3_500, 0), BaselinePlanParams(1 days, COST_BUDGET_BPS));
        address[] memory hs = new address[](3 + N_RUNNERS);
        uint256[] memory amts = new uint256[](3 + N_RUNNERS);
        (hs[0], amts[0]) = (attacker, FLOW_USDC);
        (hs[1], amts[1]) = (victim, FLOW_USDC);
        uint256 rest = FUND_USDC - 2 * FLOW_USDC;
        for (uint256 i; i < N_RUNNERS; ++i) {
            address r = makeAddr(string.concat("sim-runner-", vm.toString(i)));
            runners.push(r);
            (hs[2 + i], amts[2 + i]) = (r, RUNNER_USDC);
            rest -= RUNNER_USDC;
        }
        (hs[2 + N_RUNNERS], amts[2 + N_RUNNERS]) = (alice, rest);
        this.worldDepositsB(hs, amts);
    }

    function worldDepositsB(address[] calldata hs, uint256[] calldata amts) external {
        require(msg.sender == address(this), "self only");
        for (uint256 i; i < hs.length; ++i) {
            uint256 left = amts[i];
            while (left != 0) {
                uint256 amt = left < WORLD_CHUNK_USDC ? left : WORLD_CHUNK_USDC;
                left -= amt;
                deposit(hs[i], amt);
                vm.resetGasMetering();
                _bSlot();
            }
        }
    }

    function seedPrepB(uint256 s) external {
        require(msg.sender == address(this), "self only");
        mkSeed = s;
        for (uint256 i; i < WARMUP_SLOTS; ++i) {
            vm.resetGasMetering();
            _bSlot();
        }
    }

    /// @dev The market slot with the attacker in it: noise (+600), walk and arbitrage (+1200); the attacker starts at
    ///      `startAt` and re-pushes after each event.
    function _bSlot() internal {
        uint256 t0 = vm.getBlockTimestamp();
        _bUntil(t0 + 600);
        _mkNoise();
        _atkPush();
        _bUntil(t0 + 1_200);
        _mkWalkAndArb(false, 0);
        _atkPush();
        _bUntil(t0 + SLOT);
        ++mkSlot;
        // `verify` 2026-11-12: one slot's state diff per coverage decode (see `_atkSlot`).
        _fixtureCheckpoint();
    }

    function _bUntil(uint256 t) internal {
        if (atk.armed && !atk.active && !atk.done && atk.startAt < atk.aimAt && atk.startAt <= t) {
            if (atk.startAt > vm.getBlockTimestamp()) _mkAt(atk.startAt);
            atk.active = true;
            _atkPush();
        }
        if (t > vm.getBlockTimestamp()) _mkAt(t);
    }

    // ─── A2 and A10 ─────────────────────────────────────────────────────────────────────────────────────

    function _gridB(uint256 scn, string memory id, Var[] memory vs, uint8[] memory flows) internal {
        uint256 ws = vm.snapshotState();
        uint256 seeds = _seeds();
        Row[] memory rows = new Row[](seeds * vs.length);
        uint256 n;
        for (uint256 k; k < seeds; ++k) {
            vm.revertToState(ws);
            this.seedPrepB(_seedOf(scn, k));
            uint256 ss = vm.snapshotState();
            Res[] memory twin = new Res[](4);
            for (uint256 f; f < flows.length; ++f) {
                vm.revertToState(ss);
                twin[flows[f]] = this.flowRunB(Var(flows[f], 0, 0, 0, false, false));
            }
            for (uint256 i; i < vs.length; ++i) {
                vm.revertToState(ss);
                rows[n++] = _row(k, vs[i], twin[vs[i].flow], this.flowRunB(vs[i]));
            }
            vm.deleteStateSnapshot(ss);
        }
        _score("baseline", id, rows, n, false);
    }

    /// @notice Self-call: the attacker's own deposit (after a push down, held) or its own redemption (into a push up,
    ///         held) four slots from now (`aimAt`); the attacker unwinds right after it. After a deposit it redeems
    ///         everything an hour later (two TWAP windows). The run ends an hour after `aimAt`.
    function flowRunB(Var calldata v) external returns (Res memory r) {
        require(msg.sender == address(this), "self only");
        fundUsdc(attacker, FLASH_USDC);
        for (uint256 b; b < MK_N; ++b) {
            deal(mkTokens[b], attacker, _mkTokenForUsdc(b, FLASH_USDC / 10, _mkRefSqrt(b)));
        }
        uint256 aimAt = vm.getBlockTimestamp() + 8 * SLOT;
        uint256 startAt = v.ramp ? aimAt - (uint256(v.hold) - 1) * SLOT : (v.hold <= 2 ? aimAt : aimAt - v.hold);
        _arm(v, startAt, aimAt);
        while (vm.getBlockTimestamp() < aimAt) {
            vm.resetGasMetering();
            _bSlot();
        }
        atk.active = atk.armed;
        _atkPush();
        bool ok = v.flow == FLOW_OWN_DEPOSIT ? _bDeposit(attacker, FLOW_USDC) : _bRedeemAll(attacker);
        _atkUnwind();
        while (vm.getBlockTimestamp() < aimAt + 3_600) {
            vm.resetGasMetering();
            _bSlot();
        }
        if (v.flow == FLOW_OWN_DEPOSIT && ok) require(_bRedeemAll(attacker), "flowRunB: the exit redemption reverted");
        r = _resultB();
        r.first = ok ? 0 : 1;
    }

    /// @dev A synchronous deposit that may revert (ORA-4, a per-swap floor): false and nothing moves then. The USDC
    ///      is minted to `who` either way, so both twins hold the same amount.
    function _bDeposit(address who, uint256 usdc) internal returns (bool ok) {
        fundUsdc(who, usdc);
        vm.startPrank(who);
        IERC20(MK_USDC).approve(address(fund), usdc);
        try fund.deposit(usdc, who) returns (uint256) {
            ok = true;
        } catch {}
        vm.stopPrank();
    }

    function _bRedeemAll(address who) internal returns (bool ok) {
        uint256 sh = fund.balanceOf(who);
        vm.prank(who);
        try fund.redeem(sh, who, who) returns (uint256) {
            ok = true;
        } catch {}
    }

    function _resultB() internal view returns (Res memory r) {
        uint256 navRef = _navRefB();
        uint256 supply = fund.totalSupply();
        r.atk = int256(_walletRef(attacker) + fund.balanceOf(attacker).mulDiv(navRef, supply));
        r.vic = int256(_walletRef(victim) + fund.balanceOf(victim).mulDiv(navRef, supply));
        r.hps = navRef.mulDiv(1e18, supply);
        r.holderShares = fund.balanceOf(alice);
        for (uint256 i; i < runners.length; ++i) {
            r.holderShares += fund.balanceOf(runners[i]);
        }
        r.navRef = navRef;
        r.spent = atkSpent;
    }

    /// @dev NAV at the reference walk: idle, the lending values, wETH and cbBTC balances at the reference, deSPXA at
    ///      the fund's own value (the fund holds none here).
    function _navRefB() internal view returns (uint256 v) {
        uint256[] memory values;
        (, v, values) = fund.portfolioValues();
        for (uint256 i; i < B_LEND_N; ++i) {
            v += values[i];
        }
        v += values[IDX_DESPXA];
        for (uint256 b; b < MK_N; ++b) {
            uint256 unit = 10 ** IERC20Metadata(mkTokens[b]).decimals();
            v += IERC20(mkTokens[b]).balanceOf(address(fund)).mulDiv(_mkUsdcFor(b, unit, _mkRefSqrt(b)), unit);
        }
    }

    // ─── A6 ─────────────────────────────────────────────────────────────────────────────────────────────

    uint256 internal b6Shares;
    uint256 internal b6Since;
    uint256 internal b6Spent;
    int256 internal b6Hedge;
    uint256[2] internal b6Q;
    uint256[2] internal b6Px;

    /// @notice Self-call: 4 days of market; when armed, the attacker deposits on the lag, hedges, and redeems one
    ///         TWAP window later.
    function a6RunB(bool armed, uint256 theta) external returns (Res memory r) {
        require(msg.sender == address(this), "self only");
        for (uint256 s; s < A6_SLOTS; ++s) {
            vm.resetGasMetering();
            _bSlot();
            if (armed) _b6Step(theta);
        }
        if (b6Shares != 0) _b6Exit();
        r = _resultB();
        r.atk += b6Hedge - int256(b6Spent);
        r.spent = b6Spent;
    }

    function _b6Step(uint256 theta) internal {
        if (b6Shares != 0) {
            if (vm.getBlockTimestamp() >= b6Since + TWAP_WINDOW) _b6Exit();
            return;
        }
        if (_lagBpsB() <= int256(theta)) return;
        uint256 supply0 = fund.totalSupply();
        b6Shares = deposit(attacker, A6_USDC);
        b6Spent += A6_USDC;
        b6Since = vm.getBlockTimestamp();
        uint256 supply = supply0 + b6Shares;
        for (uint256 b; b < MK_N; ++b) {
            b6Q[b] = IERC20(mkTokens[b]).balanceOf(address(fund)).mulDiv(b6Shares, supply);
            b6Px[b] = _mkUsdcFor(b, 10 ** IERC20Metadata(mkTokens[b]).decimals(), _mkRefSqrt(b));
        }
    }

    function _b6Exit() internal {
        vm.prank(attacker);
        fund.redeem(b6Shares, attacker, attacker);
        b6Shares = 0;
        for (uint256 b; b < MK_N; ++b) {
            uint256 unit = 10 ** IERC20Metadata(mkTokens[b]).decimals();
            int256 d = int256(b6Px[b]) - int256(_mkUsdcFor(b, unit, _mkRefSqrt(b)));
            b6Hedge += d * int256(b6Q[b]) / int256(unit);
        }
    }

    function _lagBpsB() internal view returns (int256 lag) {
        uint256 wsum;
        for (uint256 b; b < MK_N; ++b) {
            uint256 unit = 10 ** IERC20Metadata(mkTokens[b]).decimals();
            uint256 twap = fund.assetUsdcValue(IDX_WETH + b, unit);
            uint256 w = IERC20(mkTokens[b]).balanceOf(address(fund)).mulDiv(twap, unit);
            lag += _mkBps(_mkUsdcFor(b, unit, _mkRefSqrt(b)), twap) * int256(w);
            wsum += w;
        }
        if (wsum != 0) lag /= int256(wsum);
    }

    // ─── A9 ─────────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Self-call: when `run`, runners 0-4 redeem everything now, one after another, and runners 5-9 six hours
    ///         later. 12 hours of market. Logs each runner's USDC against its shares' value at the reference.
    function a9RunB(bool run) external returns (Res memory r) {
        require(msg.sender == address(this), "self only");
        for (uint256 s; s < 24; ++s) {
            if (run && (s == 0 || s == 12)) _b9Redeem(s == 0 ? 0 : N_RUNNERS / 2);
            vm.resetGasMetering();
            _bSlot();
        }
        r = _resultB();
        r.holderShares = fund.balanceOf(alice) + fund.balanceOf(attacker) + fund.balanceOf(victim);
        r.first = b9Refused;
        r.atk = 0;
        for (uint256 i; i < N_RUNNERS; ++i) {
            r.atk += int256(_walletRef(runners[i]) + fund.balanceOf(runners[i]).mulDiv(r.navRef, fund.totalSupply()));
        }
    }

    uint256 internal b9Refused;

    function _b9Redeem(uint256 from) internal {
        for (uint256 i = from; i < from + N_RUNNERS / 2; ++i) {
            uint256 sh = fund.balanceOf(runners[i]);
            uint256 fair = sh.mulDiv(_navRefB(), fund.totalSupply());
            vm.prank(runners[i]);
            try fund.redeem(sh, runners[i], runners[i]) returns (uint256 got) {
                emit log_named_string(
                    string.concat("A9 baseline runner ", vm.toString(i)),
                    string.concat(
                        "USDC ", vm.toString(got), " for shares worth ", vm.toString(fair), " at the reference (",
                        vm.toString(_mkBps(got, fair)), " bps)"
                    )
                );
            } catch (bytes memory err) {
                // The synchronous fund refuses the sale (a per-swap floor): the runner keeps its shares.
                ++b9Refused;
                emit log_named_string(
                    string.concat("A9 baseline runner ", vm.toString(i)),
                    string.concat("redeem REFUSED, keeps its shares: ", vm.toString(err))
                );
            }
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  The timed-flow sim under a lever (step 3 finish plan §3.2: G9 per lever), added by `levers` 2026-11-12
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/// @title TimedFlowSimLeversTest
/// @notice `TimedFlowSimTest` (all 16 timed tests, unchanged) with a lever from `LeverEnv` in force. It lives here
///         because the sim's own files belong to the sim agent. Opt-in: PROTO_LEVER_TIMED=1, else every test is
///         skipped in setUp, so a plain sim run never runs the timed set twice. Run it with PROTO_SIM=1,
///         PROTO_SIM_FLOWS=timed, PROTO_SIM_TAG=<tag> and the PROTO_LEVER_* values; the output goes to
///         out/prototype/<run>-timed-<tag>/ and `score-sim.ts <run>-timed-<tag>` scores it.
///
///         The levers go in at setUp, before the sim's genesis: `TimedFlowSimTest`'s settle hooks are not virtual,
///         so nothing here can act after genesis. The sim's genesis buys no basket in SEQ and EXT (their genesis
///         vector is all lending) and 2.5 % wETH and cbBTC in JUMP, so a per-call cap reaches genesis only in JUMP.
///         The sim's keeper calls once per window end and retries only a call that failed, so under a per-call cap
///         the rest of a capped flow waits for the next window end (a keeper that continues in the next blocks would
///         fill it sooner): waits measured here are an upper bound for the cap.
contract TimedFlowSimLeversTest is TimedFlowSimTest {
    function setUp() public override {
        if (!vm.envOr("PROTO_LEVER_TIMED", false)) {
            vm.skip(true, "opt-in: PROTO_LEVER_TIMED=1 runs the timed sim under PROTO_LEVER_* (needs PROTO_SIM_TAG)");
            return;
        }
        super.setUp();
        bool levered = LeverEnv.applyFromEnv(vm, queue, address(timelock));
        require(
            !levered || bytes(vm.envOr("PROTO_SIM_TAG", string(""))).length != 0,
            "timed levers: a lever needs PROTO_SIM_TAG (output dir)"
        );
    }
}
