#!/usr/bin/env bun
// One-vault experiment, plan Step 3 (docs/technical/one-vault-rebalancer-proposal.md §13 G4 / G5, §14).
//
// Scores the rebalance simulation. Reads <run dir>/sim-*.json (one file per forge test, written by
// contracts/test/prototype/sim/RebalanceSim.t.sol), merges them into <run dir>/sim.json, prints one row per
// plan, and the G4 and G5 verdicts.
//
//   bun contracts/test/prototype/sim/score-sim.ts [out/prototype/default | out/prototype/tuned | default | tuned]
//   (default: out/prototype/default; --dir <path> also works; --allow-partial scores an incomplete run but
//    labels every verdict PARTIAL, for development only)
//
// Definitions (fixed before the scored run; §14 records them):
//   costArrival    = Σ execCost + flowLoss + unexplainedDrop. execCost is the arrival-price cost of each executed
//                    step at the pre-step pool spot (fee + impact + lending rounding).
//   costRef        = Σ execCostRef + flowLossRef + unexplainedDrop. execCostRef values each step's token deltas at
//                    the model's fair price (the reference walk), so the fund's own impact still sitting in the
//                    pool (the arb closes only part of each gap; deSPXA has no arb outside US hours) is a cost.
//   costBps        = max(costArrival, costRef) × 1e4 / denominator. The denominator is plan.turnoverUsdc for a
//                    Converged plan, and min(turnoverUsdc, tradedNotional) for a plan that did not converge
//                    (Expired, Halted), so a plan that stops early is not costed over work it never did.
//                    G4 is scored on costBps. The arrival-only, reference-only, per-traded and on-chain costSpent
//                    readings are printed beside it.
//   blocked        = MarketDeviation + Cooldown + StepFailed + masked. masked = a NothingToTrade or BelowMinStep
//                    call while an asset the Rebalancer masked out (ORA-4 or backoff) sat >= minStepUsdc off path.
//   blockedSkipRate = blocked / (executed + blocked), pooled over the scored plans. NothingToTrade and
//                    BelowMinStep with no masked asset mean the fund sits on its glide path: a keeper that reads
//                    previewStep sends no transaction then. §5.3 still names "nothing to trade" a skip, so the
//                    literal rate (every non-executing call / every call) is printed next to the verdict, and a
//                    flag fires when only the literal reading is over 10%. The per-plan maximum is printed too.
// Scored set: SEQ (1M, 5M), EXT (1M), JUMP-DOWN, JUMP-UP. EXT-PROBE (5M) is a capacity probe: its G5 reading
// is printed next to the headline, not merged into it.
// Thresholds (§13, fixed): G4 pass iff median costBps <= 15 and max <= 30. G5 pass iff every scored plan
// converged within endTime + maxOverrun and blockedSkipRate < 10%. G5 fail iff a scored plan expired with a
// liquid asset (wETH, cbBTC) off tolerance, or the skip rate exceeds 10%; otherwise a miss is "not pass".
// A Halted plan with a liquid asset off tolerance is listed separately (§13 says "expires").
//
// Timed runs (steps 3d / 3e, eng plan §4.4): a directory written by TimedFlowSim.t.sol (`<run>-timed[-<tag>]`, every
// file's meta.flows = "timed") is scored the same way for G4 and G5, on the same plan rows, with two differences that
// follow from the live fund: the default parameters are the live list's (five assets, no deSPXA, plus the §5.9.5
// FlowParams), and a step skipped for a reason step 3 did not have (step 3e's FeedCheck: the step's own feed checks
// failed) counts as blocked. It adds a `timed` block to sim.json:
//   G9 (§13), in the scenarios without a price jump (SEQ, EXT; EXT-PROBE beside it):
//     firstCallShare  = keeper calls at a window end with new requests that neither reverted nor had a side fail,
//                       over all such calls; pass >= 95%.
//     redeemWaitH     = per redemption request, request to the settlement that filled its last part (USDC claimable
//                       then), hours. A request still unfilled at the end counts as an infinite wait once it is older
//                       than the 14 h threshold; a younger one is censored (excluded, counted). pass: p95 <= 14 h.
//     flowCostBps     = per request, its fills' cost against NAV per share at the feeds before the settlement,
//                       before the exit fee, over the USDC it used (deposit) or the feed value it burned (redemption).
//                       pass: median <= 15 bps and max <= 30 bps.
//   depositWaitH (request to unlocked shares), attempts by outcome and by check, the normal range of the quantity
//   behind each §5.9.5 value next to the value, and the swap cost netting would have saved: per two-sided
//   settlement min(D, R) x (deposit cost rate + redemption cost rate), D the deposit USDC and R the redeemed shares'
//   feed value (linear cost assumed).
// A sync directory is scored exactly as before: the timed code never runs and its sim.json is unchanged.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const allowPartial = args.includes("--allow-partial");
const dirFlag = args.indexOf("--dir");
const dirArg = dirFlag >= 0 ? args[dirFlag + 1] : args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--dir");
const repo = resolve(import.meta.dir, "../../../..");
const dir =
  dirArg === undefined
    ? join(repo, "out/prototype/default")
    : /^[A-Za-z0-9_-]+$/.test(dirArg) && !existsSync(dirArg)
      ? join(repo, "out/prototype", dirArg)
      : resolve(dirArg);
const runLabel = basename(dir);

const G4_MEDIAN = 15;
const G4_MAX = 30;
const G5_SKIP = 0.1;
const SCORED = new Set(["SEQ", "EXT", "JUMP-DOWN", "JUMP-UP"]);

// The expected manifest: file -> plan count. A missing, extra or short file refuses the score, so a test that
// reverted (and wrote no JSON) cannot silently drop its plans from the median, the max or G5.
const MANIFEST: Record<string, number> = {};
for (const k of [0, 1, 2]) {
  MANIFEST[`sim-SEQ-1M-s${k}.json`] = 4;
  MANIFEST[`sim-SEQ-5M-s${k}.json`] = 4;
  MANIFEST[`sim-EXT-1M-s${k}.json`] = 2;
  MANIFEST[`sim-JUMP-DOWN-1M-s${k}.json`] = 1;
  MANIFEST[`sim-JUMP-UP-1M-s${k}.json`] = 1;
}
MANIFEST["sim-EXT-PROBE-5M-s0.json"] = 2;

// The §5.6 starts (PrototypeHarness constants). A "default" run must read exactly these back from the contracts.
const DEFAULT_PARAMS: Record<string, unknown> = {
  stepInterval: 1800,
  keeperGrace: 21600,
  maxOverrun: 604800,
  maxStepCostBps: 50,
  toleranceBps: 50,
  minStepUsdc: 100000000,
  planDuration: 604800,
  costBudgetBps: 30,
  maxStepUsdc: [500000000000, 500000000000, 500000000000, 50000000000, 50000000000, 2000000000],
  maxStepSlippageBps: [0, 0, 0, 50, 50, 200],
};

if (!existsSync(dir)) throw new Error(`no ${dir}: run the sim first (PROTO_SIM=1 forge test ...)`);
const files = readdirSync(dir)
  .filter((f) => /^sim-.*\.json$/.test(f) && f !== "sim.json")
  .sort();
if (files.length === 0) throw new Error(`no sim-*.json in ${dir}`);

const num = (x: unknown) => Number(x);
const KNOWN_ERRORS: Record<string, string> = { "9a007d1b": "StepCostExceeded" };
function decodeRevert(text: string): string {
  text = text.replace(/0x([0-9a-f]{8})((?:[0-9a-f]{64})*)/gi, (m, sel: string, body: string) => {
    const name = KNOWN_ERRORS[sel.toLowerCase()];
    if (!name) return m;
    const words = (body.match(/.{64}/g) ?? []).map((w) => BigInt("0x" + w).toString());
    return `${name}(${words.join(",")})`;
  });
  return text.replace(/0x08c379a0([0-9a-f]+)/gi, (_m, body: string) => {
    const len = parseInt(body.slice(64, 128), 16);
    return `Error("${Buffer.from(body.slice(128, 128 + 2 * len), "hex").toString("utf8")}")`;
  });
}
const runs = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
const timedFiles = runs.filter((r) => r.meta?.flows === "timed").length;
const timed = timedFiles > 0;

// The live list's defaults (PrototypeHarness: §5.6 starts, five assets [aave, moonwell, wETH, cbBTC, comet], and the
// §5.9.5 FlowParams). A timed "default" run with no tag must read exactly these back.
const DEFAULT_PARAMS_TIMED: Record<string, unknown> = {
  stepInterval: 1800,
  keeperGrace: 21600,
  maxOverrun: 604800,
  maxStepCostBps: 50,
  toleranceBps: 50,
  minStepUsdc: 100000000,
  planDuration: 604800,
  costBudgetBps: 30,
  maxStepUsdc: [500000000000, 500000000000, 50000000000, 50000000000, 500000000000],
  maxStepSlippageBps: [0, 0, 50, 50, 0],
  flowParams: {
    epochLength: 21600, settleWindow: 3600, minHold: 86400, keeperGrace: 21600, maxEpochFlowBps: 500,
    epochFlowFloorUsdc: 250000000000, maxSharePriceMoveBps: 1000, maxRoll: 8, minRequestUsdc: 100000000,
    maxFreeze: 604800, slices: 12, quorum: 9, dispersionBps: 100, refBandBps: 50, legBandBps: 100,
    sequencerGrace: 3600, usdcPegBandBps: 50, maxLendRateGrowthBps: 10,
  },
};
const canonDeep = (o: unknown): string =>
  o !== null && typeof o === "object" && !Array.isArray(o)
    ? `{${Object.keys(o as object).sort().map((k) => `${JSON.stringify(k)}:${canonDeep((o as any)[k])}`).join(",")}}`
    : JSON.stringify(o);

// ─── Provenance checks ───────────────────────────────────────────────────────────────────────────────
const problems: string[] = [];
if (timed && timedFiles !== runs.length) problems.push(`mixed timed and sync files (${timedFiles} of ${runs.length} timed)`);
for (const f of Object.keys(MANIFEST)) if (!files.includes(f)) problems.push(`missing ${f}`);
for (const r of runs) {
  if (!(r.file in MANIFEST)) problems.push(`unexpected ${r.file}`);
  else if ((r.plans ?? []).length !== MANIFEST[r.file]) problems.push(`${r.file}: ${r.plans?.length} plans, expected ${MANIFEST[r.file]}`);
}
const canon = (o: unknown) => JSON.stringify(o, Object.keys(o as object).sort());
const pins = new Set(runs.map((r) => r.meta?.pinBlock));
if (pins.size !== 1) problems.push(`mixed pin blocks: ${[...pins].join(",")}`);
const recs = new Set(runs.map((r) => r.meta?.recording));
if (recs.size !== 1) problems.push(`mixed record/replay files: recording=${[...recs].join(",")}`);
const runNames = new Set(runs.map((r) => r.meta?.run));
if (runNames.size !== 1) problems.push(`mixed parameter sets: ${[...runNames].join(",")}`);
const paramSets = new Set(
  runs.map((r) => {
    const { set: _s, ...p } = r.meta?.params ?? {};
    return canon(p);
  }),
);
if (paramSets.size !== 1) problems.push(`files disagree on params (${paramSets.size} distinct sets)`);
const params = (() => {
  const { set: _s, ...p } = runs[0].meta?.params ?? {};
  return p as Record<string, unknown>;
})();
const paramDiff = timed
  ? Object.keys(DEFAULT_PARAMS_TIMED).filter((k) => canonDeep(params[k]) !== canonDeep(DEFAULT_PARAMS_TIMED[k]))
  : Object.keys(DEFAULT_PARAMS).filter((k) => JSON.stringify(params[k]) !== JSON.stringify(DEFAULT_PARAMS[k]));
if ((runLabel === "default" || runLabel === "tuned") && !runNames.has(runLabel)) {
  problems.push(`dir ${runLabel} holds files of run ${[...runNames].join(",")}`);
}
const timedTags = new Set(runs.map((r) => String(r.meta?.tag ?? "")));
const timedTag = [...timedTags][0] ?? "";
if (timed) {
  if (timedTags.size !== 1) problems.push(`mixed tags: ${[...timedTags].join(",")}`);
  const expected = `${[...runNames][0]}-timed${timedTag ? "-" + timedTag : ""}`;
  if (runLabel !== expected) problems.push(`dir ${runLabel} holds timed files of ${expected}`);
}
if (runNames.has("default") && paramDiff.length && !(timed && timedTag !== "")) {
  problems.push(`default run params differ from §5.6 starts: ${paramDiff.join(",")}`);
}
if (problems.length && !allowPartial) {
  console.error(`REFUSING TO SCORE ${dir}:\n  ${problems.join("\n  ")}\n(--allow-partial scores it as PARTIAL)`);
  process.exit(2);
}
const partial = problems.length > 0;

// ─── Rows ────────────────────────────────────────────────────────────────────────────────────────────
type Row = Record<string, any>;
const rows: Row[] = [];
for (const r of runs) {
  for (const p of r.plans as Row[]) {
    const turnover = num(p.turnoverUsdc);
    const traded = num(p.tradedNotional);
    const converged = p.outcome === "Converged";
    const arrival = num(p.execCost) + num(p.flowLoss) + num(p.unexplainedDrop);
    const ref = num(p.execCostRef ?? NaN) + num(p.flowLossRef ?? NaN) + num(p.unexplainedDrop);
    const denom = converged ? turnover : Math.min(turnover, traded);
    const bps = (x: number) => (denom > 0 ? (x * 1e4) / denom : NaN);
    const masked = num(p.maskedCalls ?? 0);
    // Timed: a skip for a reason step 3 did not have (step 3e's FeedCheck) is a blocked attempt too.
    const blockedNew = timed ? num(p.skipOther ?? 0) : 0;
    const blocked = num(p.skipMarketDeviation) + num(p.skipCooldown) + num(p.skipStepFailed) + masked + blockedNew;
    const executed = num(p.executed);
    const calls = num(p.calls);
    const oor: number[] = (p.outOfRangeCalls ?? [0, 0, 0]).map(num);
    const row: Row = {
      file: r.file,
      scenario: p.scenario,
      fundM: num(p.fundUsdc) / 1e12,
      seed: num(p.seedK),
      plan: p.receipt,
      id: `${p.scenario}-${num(p.fundUsdc) / 1e12}M-s${num(p.seedK)}/${p.receipt}`,
      scored: SCORED.has(p.scenario),
      outcome: p.outcome,
      denominator: converged ? "turnover" : "min(turnover,traded)",
      convergedInWindow: p.convergedInWindow === true,
      liquidOff: p.liquidAssetOffTolerance === true,
      offAssets: p.offToleranceAssets,
      offGapBps: p.offToleranceGapBps,
      turnoverUsdc: turnover / 1e6,
      tradedUsdc: traded / 1e6,
      flowAssistUsdc: converged ? (turnover - traded) / 1e6 : NaN,
      arrivalUsdc: arrival / 1e6,
      refUsdc: ref / 1e6,
      arrivalBps: bps(arrival),
      refBps: bps(ref),
      costBps: Math.max(bps(arrival), Number.isFinite(bps(ref)) ? bps(ref) : -Infinity),
      costBpsTraded: traded > 0 ? (Math.max(arrival, Number.isFinite(ref) ? ref : -Infinity) * 1e4) / traded : NaN,
      costSpentBps: bps(num(p.costSpent)),
      basisBps: bps(num(p.basisCost)),
      flowLossUsdc: num(p.flowLoss) / 1e6,
      flowLossRefUsdc: num(p.flowLossRef ?? NaN) / 1e6,
      unexplainedUsdc: num(p.unexplainedDrop) / 1e6,
      budgetUsedPct: num(p.costBudget) > 0 ? (100 * num(p.costSpent)) / num(p.costBudget) : NaN,
      timeToConvergeH: num(p.timeToConvergeSec) / 3600,
      overrunH: num(p.overrunSec) / 3600,
      calls,
      executed,
      blocked,
      masked,
      blockedRate: blocked / Math.max(1, executed + blocked),
      skips: {
        NothingToTrade: num(p.skipNothingToTrade),
        BelowMinStep: num(p.skipBelowMinStep),
        MarketDeviation: num(p.skipMarketDeviation),
        Cooldown: num(p.skipCooldown),
        StepFailed: num(p.skipStepFailed),
      },
      outOfRangeCalls: oor,
      leftPinLpRange: oor.some((x) => x > 0),
      despxaArbClosedSlots: num(p.despxaArbClosedSlots ?? NaN),
      maxDespxaPoolSharePct: num(p.maxDespxaPoolShareBps ?? NaN) / 100,
      maxDespxaSupplySharePct: num(p.maxDespxaSupplyShareBps ?? NaN) / 100,
      lastStepFailedSelector: p.lastStepFailedSelector,
      stepFailProbes: decodeRevert(String(p.stepFailProbes ?? "")),
      firstFlowFailure: decodeRevert(String(p.firstFlowFailure ?? "")),
      flows: { deposits: num(p.deposits), redeems: num(p.redeems), blocked: num(p.flowsBlocked) },
    };
    if (timed) {
      Object.assign(row, {
        skipFeedCheckOrNew: blockedNew,
        skipByReason: p.skipByReason,
        feedCostUsdc: num(p.signedFeedCost) / 1e6,
        twapCostUsdc: num(p.signedTwapCost) / 1e6,
        booked: { atFeed: num(p.bookedAtFeed), atTwap: num(p.bookedAtTwap), zero: num(p.bookedZero), other: num(p.bookedOther) },
        requests: { deposits: num(p.depositRequests), redeems: num(p.redeemRequests) },
        settleAttempts: num(p.settleAttempts),
        settleBlockedAttempts: num(p.settleBlockedAttempts),
      });
    }
    rows.push(row);
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : NaN);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const g4of = (set: Row[], key: string) => {
  const xs = set.map((r) => r[key]).filter(Number.isFinite);
  const med = median(xs);
  const mx = max(xs);
  return { median: med, max: mx, n: xs.length, pass: xs.length > 0 && med <= G4_MEDIAN && mx <= G4_MAX };
};

function gates(set: Row[]) {
  const g4 = g4of(set, "costBps");
  const g4Arrival = g4of(set, "arrivalBps");
  const g4Ref = g4of(set, "refBps");
  const g4Traded = g4of(set, "costBpsTraded");
  const g4Spent = g4of(set, "costSpentBps");
  const worst = [...set].sort((a, b) => b.costBps - a.costBps)[0];

  const executed = set.reduce((a, r) => a + r.executed, 0);
  const blocked = set.reduce((a, r) => a + r.blocked, 0);
  const masked = set.reduce((a, r) => a + r.masked, 0);
  const calls = set.reduce((a, r) => a + r.calls, 0);
  const blockedSkipRate = blocked / Math.max(1, executed + blocked);
  const literalSkipRate = (calls - executed) / Math.max(1, calls);
  const unconverged = set.filter((r) => !r.convergedInWindow);
  const liquidExpiry = set.filter((r) => r.outcome === "Expired" && r.liquidOff);
  const haltedLiquid = set.filter((r) => r.outcome === "Halted" && r.liquidOff);
  const g5Pass = unconverged.length === 0 && blockedSkipRate < G5_SKIP;
  const g5Fail = liquidExpiry.length > 0 || blockedSkipRate > G5_SKIP;
  const overPlans = set.filter((r) => r.blockedRate > G5_SKIP);
  const maxPlan = [...set].sort((a, b) => b.blockedRate - a.blockedRate)[0];
  return {
    plans: set.length,
    g4: { ...g4, worst: worst?.id, halted: set.filter((r) => r.outcome === "Halted").map((r) => r.id) },
    g4Verdict: g4.pass ? "PASS" : "FAIL",
    g4Readings: {
      arrival: { ...g4Arrival, verdict: g4Arrival.pass ? "PASS" : "FAIL" },
      reference: { ...g4Ref, verdict: g4Ref.pass ? "PASS" : "FAIL" },
      perTraded: { ...g4Traded, verdict: g4Traded.pass ? "PASS" : "FAIL" },
      costSpent: { ...g4Spent, verdict: g4Spent.pass ? "PASS" : "FAIL" },
    },
    g5: {
      allConvergedInWindow: unconverged.length === 0,
      unconverged: unconverged.map(
        (r) => `${r.id}:${r.outcome} off=[${r.offAssets}] gap=[${r.offGapBps}] liquidOff=${r.liquidOff}${r.leftPinLpRange ? " LEFT-PIN-LP-RANGE" : ""}`,
      ),
      liquidExpiries: liquidExpiry.map((r) => r.id),
      haltedWithLiquidOff: haltedLiquid.map((r) => r.id),
      attempts: executed + blocked,
      blocked,
      masked,
      blockedSkipRate,
      calls,
      literalSkipRate,
      maxPlanBlockedRate: maxPlan ? maxPlan.blockedRate : NaN,
      maxPlan: maxPlan?.id,
      plansOver10pct: overPlans.map((r) => `${r.id}=${f(100 * r.blockedRate, 1)}%`),
    },
    g5Verdict: g5Pass ? "PASS" : g5Fail ? "FAIL" : "NOT PASS (no fail clause fired)",
  };
}

const scored = rows.filter((r) => r.scored);
const probe = rows.filter((r) => !r.scored);
const scoredInRange = scored.filter((r) => !r.leftPinLpRange);
const byScenario: Record<string, ReturnType<typeof gates>> = {};
for (const s of [...new Set(rows.map((r) => `${r.scenario}-${r.fundM}M`))]) {
  byScenario[s] = gates(rows.filter((r) => `${r.scenario}-${r.fundM}M` === s));
}
const result = {
  generatedFrom: files,
  partial,
  provenance: { problems, pinBlocks: [...pins], recording: [...recs], run: [...runNames], params, diffFromDefaults: paramDiff },
  definitions: {
    costBps: "max(arrival, reference) cost * 1e4 / (turnover if Converged else min(turnover, traded))",
    arrival: "sum execCost (pre-step spot) + flowLoss + unexplainedDrop",
    reference: "sum execCostRef (reference walk price) + flowLossRef + unexplainedDrop",
    blockedSkipRate: "(MarketDeviation + Cooldown + StepFailed + masked) / (executed + those), pooled",
    literalSkipRate: "non-executing calls / calls (concluding call excluded)",
    scoredSet: [...SCORED],
  },
  scored: gates(scored),
  scoredExcludingPlansThatLeftPinLpRange: gates(scoredInRange),
  probe: probe.length ? gates(probe) : null,
  byScenario,
  meta: runs.map((r) => ({ file: r.file, ...r.meta })),
  plans: rows,
};

// ─── Timed runs: G9, waits, blocked settlements by check, normal ranges, netting (see the header) ─────
const G9_FIRST_CALL = 0.95;
const G9_WAIT_H = 14;
const G9_COST_MEDIAN = 15;
const G9_COST_MAX = 30;
const G9_SET = new Set(["SEQ", "EXT"]);
const CHECK_NAMES = [
  "Ok", "Window", "Caller", "Paused", "Sequencer", "Feed", "UsdcPeg", "TwapQuorum", "TwapVsFeed", "LendRate",
  "SharePrice", "RedeemLeg", "DepositLeg", "Proportion", "RealizedPrice",
];
function outcomeName(o: number): string {
  if (o === 0) return "settled";
  if (o === 2) return "nothingTraded";
  if (o === 10) return "depositSideFailed";
  if (o === 11) return "redeemSideFailed";
  if (o === 12) return "bothSidesFailed";
  if (o >= 100 && o < 200) return `blocked:${CHECK_NAMES[o - 100] ?? String(o - 100)}`;
  if (o === 300) return "sideOutOfGas";
  return `revert:${o}`;
}
/** Nearest-rank quantile; Infinity sorts last. */
function quant(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}
const dist = (xs: number[]) => ({
  n: xs.length, min: quant(xs, 0), p01: quant(xs, 0.01), p05: quant(xs, 0.05), p50: quant(xs, 0.5),
  p95: quant(xs, 0.95), p99: quant(xs, 0.99), max: xs.length ? Math.max(...xs) : NaN,
});
const col = (o: any, k: string): number[] => ((o?.[k] ?? []) as unknown[]).map(num);

function timedReport(set: Row[]) {
  const outcomes: Record<string, number> = {};
  const firstOutcomes: Record<string, number> = {};
  let first = 0;
  let firstOk = 0;
  let attemptsN = 0;
  const redeemWaits: number[] = [];
  const depositWaits: number[] = [];
  const cost: number[] = [];
  const costRef: number[] = [];
  const costDep: number[] = [];
  const costRed: number[] = [];
  let censored = 0;
  let unfilledOld = 0;
  let expired = 0;
  let requestsN = 0;
  let partialAtEnd = 0;
  const range: Record<string, number[]> = {
    twapVsFeedAbsBps: [], spotVsFeedAbsBps: [], settleSpotMoveAbsBps: [], slicesInBand: [], sliceDevBps: [],
    sharePriceMoveBpsPerEpoch: [], lendGrowthBpsPerDay: [], depositBpsOfNav: [], redeemBpsOfNav: [], requestUsdc: [],
  };
  let netSaved = 0;
  let netSavedRef = 0;
  let flowVolume = 0;
  let twoSided = 0;
  let settlementsN = 0;
  for (const r of set) {
    const a = r.timed?.attempts ?? {};
    const out = col(a, "outcome");
    const kind = col(a, "kind");
    attemptsN += out.length;
    for (let i = 0; i < out.length; i++) {
      const name = outcomeName(out[i]);
      outcomes[name] = (outcomes[name] ?? 0) + 1;
      if (kind[i] === 1) {
        first++;
        firstOutcomes[name] = (firstOutcomes[name] ?? 0) + 1;
        if (out[i] === 0 || out[i] === 2) firstOk++;
      }
      for (const b of [0, 1]) {
        range.twapVsFeedAbsBps.push(Math.abs(col(a, `twapVsFeedBps${b}`)[i]));
        range.spotVsFeedAbsBps.push(Math.abs(col(a, `spotVsFeedBps${b}`)[i]));
        range.slicesInBand.push(col(a, `slicesInBand${b}`)[i]);
        range.sliceDevBps.push(col(a, `sliceDevBps${b}`)[i]);
        if (out[i] === 0) range.settleSpotMoveAbsBps.push(Math.abs(col(a, `spotMoveBps${b}`)[i]));
      }
      const px = col(a, "sharePriceMoveBpsPerEpoch")[i];
      if (px > 0) range.sharePriceMoveBpsPerEpoch.push(px);
      const lg = col(a, "lendGrowthCentiBpsPerDay")[i];
      if (lg > 0) range.lendGrowthBpsPerDay.push(lg / 100);
    }
    const q = r.timed?.requests ?? {};
    const at = col(q, "at");
    const done = col(q, "doneAt");
    const isDep = col(q, "isDeposit");
    const basis = col(q, "basis");
    const cf = col(q, "costFeed");
    const cr = col(q, "costRef");
    const unlock = col(q, "unlockAt");
    const status = col(q, "status");
    const value = col(q, "valueUsdc");
    const filled = col(q, "filled");
    const endAt = num(r.meta?.endAt);
    requestsN += at.length;
    for (let i = 0; i < at.length; i++) {
      range.requestUsdc.push(value[i] / 1e6);
      if (status[i] === 2) expired++;
      if (done[i] === 0 && filled[i] > 0) partialAtEnd++;
      if (basis[i] > 0) {
        const c = (cf[i] * 1e4) / basis[i];
        cost.push(c);
        costRef.push((cr[i] * 1e4) / basis[i]);
        (isDep[i] === 1 ? costDep : costRed).push(c);
      }
      if (isDep[i] === 1) {
        if (done[i] > 0 && unlock[i] > 0) depositWaits.push((unlock[i] - at[i]) / 3600);
        continue;
      }
      if (done[i] > 0) redeemWaits.push((done[i] - at[i]) / 3600);
      else if ((endAt - at[i]) / 3600 > G9_WAIT_H) {
        redeemWaits.push(Infinity);
        unfilledOld++;
      } else censored++;
    }
    const s = r.timed?.settlements ?? {};
    const dU = col(s, "depUsdc");
    const dF = col(s, "depFairFeed");
    const dR = col(s, "depFairRef");
    const rG = col(s, "redGross");
    const rF = col(s, "redFairFeed");
    const rR = col(s, "redFairRef");
    const nav = col(s, "navFeed");
    settlementsN += dU.length;
    for (let i = 0; i < dU.length; i++) {
      flowVolume += dU[i] + rF[i];
      if (nav[i] > 0) {
        if (dU[i] > 0) range.depositBpsOfNav.push((dU[i] * 1e4) / nav[i]);
        if (rF[i] > 0) range.redeemBpsOfNav.push((rF[i] * 1e4) / nav[i]);
      }
      if (dU[i] > 0 && rF[i] > 0) {
        twoSided++;
        const m = Math.min(dU[i], rF[i]);
        netSaved += m * ((dU[i] - dF[i]) / dU[i] + (rF[i] - rG[i]) / rF[i]);
        netSavedRef += m * ((dU[i] - dR[i]) / dU[i] + (rR[i] - rG[i]) / rR[i]);
      }
    }
  }
  const firstCallShare = first > 0 ? firstOk / first : NaN;
  const waitP95 = quant(redeemWaits, 0.95);
  const costMed = median(cost);
  const costMax = max(cost);
  const g9Pass =
    first > 0 && firstCallShare >= G9_FIRST_CALL && waitP95 <= G9_WAIT_H && costMed <= G9_COST_MEDIAN && costMax <= G9_COST_MAX;
  return {
    files: set.length,
    g9: {
      firstCalls: first,
      firstCallsOk: firstOk,
      firstCallShare,
      firstCallOutcomes: firstOutcomes,
      redeemWaitH: { median: median(redeemWaits), p95: waitP95, n: redeemWaits.length, unfilledOlderThan14h: unfilledOld, censored },
      flowCostBps: { median: costMed, max: costMax, n: cost.length, deposits: dist(costDep), redemptions: dist(costRed) },
      flowCostRefBps: { median: median(costRef), max: max(costRef) },
      verdict: g9Pass ? "PASS" : "FAIL",
    },
    depositWaitH: { median: median(depositWaits), p95: quant(depositWaits, 0.95), max: max(depositWaits), n: depositWaits.length },
    requests: { n: requestsN, expired, partlyFilledAtEnd: partialAtEnd },
    attempts: { n: attemptsN, byOutcome: outcomes, settlements: settlementsN },
    normalRange: Object.fromEntries(Object.entries(range).map(([k, v]) => [k, dist(v)])),
    netting: {
      twoSidedSettlements: twoSided,
      settlements: settlementsN,
      savedUsdcAtFeed: netSaved / 1e6,
      savedUsdcAtRef: netSavedRef / 1e6,
      flowVolumeUsdc: flowVolume / 1e6,
      savedBpsOfFlowAtFeed: flowVolume > 0 ? (netSaved * 1e4) / flowVolume : NaN,
    },
  };
}

if (timed) {
  const g9Set = runs.filter((r) => G9_SET.has(r.meta?.scenario));
  const fp = (params.flowParams ?? {}) as Record<string, number>;
  (result as any).timed = {
    definitions: {
      g9Set: [...G9_SET],
      firstCallShare: "window-end keeper calls with new requests that neither reverted nor had a side fail / all such calls (>= 95%)",
      redeemWaitH: `request to the settlement of its last part; unfilled and older than ${G9_WAIT_H} h = infinite; younger and unfilled = censored (p95 <= ${G9_WAIT_H} h)`,
      flowCostBps: "per request: fill cost against NAV per share at the feeds before the settlement, before the exit fee (median <= 15, max <= 30)",
      blockedStepAttempts: "as step 3, plus skips for a reason step 3 did not have (step 3e FeedCheck)",
      netting: "per two-sided settlement min(D, R) x (deposit cost rate + redemption cost rate); linear cost assumed",
    },
    flowParams: fp,
    noJump: timedReport(g9Set),
    probe: timedReport(runs.filter((r) => r.meta?.scenario === "EXT-PROBE")),
    jump: timedReport(runs.filter((r) => String(r.meta?.scenario).startsWith("JUMP"))),
    all: timedReport(runs),
    values: {
      refBandBps: { value: fp.refBandBps, observed: "normalRange.twapVsFeedAbsBps (no-jump set)" },
      legBandBps: { value: fp.legBandBps, observed: "normalRange.spotVsFeedAbsBps and settleSpotMoveAbsBps" },
      dispersionBps: { value: fp.dispersionBps, observed: "normalRange.sliceDevBps" },
      quorum: { value: fp.quorum, of: fp.slices, observed: "normalRange.slicesInBand (low tail)" },
      maxSharePriceMoveBps: { value: fp.maxSharePriceMoveBps, observed: "normalRange.sharePriceMoveBpsPerEpoch" },
      maxLendRateGrowthBps: { value: fp.maxLendRateGrowthBps, observed: "normalRange.lendGrowthBpsPerDay" },
      maxEpochFlowBps: { value: fp.maxEpochFlowBps, observed: "normalRange.depositBpsOfNav / redeemBpsOfNav per settlement" },
      minRequestUsdc: { value: (fp.minRequestUsdc ?? NaN) / 1e6, observed: "normalRange.requestUsdc (low tail)" },
      maxRoll: { value: fp.maxRoll, observed: "requests.expired" },
      epochLength_settleWindow_minHold: { value: [fp.epochLength, fp.settleWindow, fp.minHold], observed: "g9.redeemWaitH, depositWaitH" },
      notMeasured: "sequencerGrace, usdcPegBandBps, maxFeedAge, keeperGrace, maxFreeze, poolShareBps, minSeedUsdc: the sim models no outage, depeg, absent keeper or freeze",
    },
  };
}
writeFileSync(join(dir, "sim.json"), JSON.stringify(result, null, 1) + "\n");

// ─── Console ─────────────────────────────────────────────────────────────────────────────────────────
const hdr = [
  "scenario", "M", "s", "plan", "turnover", "traded", "arr$", "ref$", "costBps", "arrBps", "refBps", "c/traded",
  "spentBps", "outcome", "ttc_h", "calls", "exec", "N2T", "BMS", "MDev", "Cool", "Fail", "Mask", "blk%",
  "oorCalls", "dSPXA%pool/%sup", "flows d/r/x",
];
const lines = [hdr.join("\t")];
for (const r of rows) {
  lines.push(
    [
      r.scenario + (r.scored ? "" : "*"), r.fundM, r.seed, r.plan, f(r.turnoverUsdc, 0), f(r.tradedUsdc, 0),
      f(r.arrivalUsdc), f(r.refUsdc), f(r.costBps) + (r.outcome === "Converged" ? "" : "†"), f(r.arrivalBps),
      f(r.refBps), f(r.costBpsTraded), f(r.costSpentBps), r.outcome, f(r.timeToConvergeH, 1), r.calls, r.executed,
      r.skips.NothingToTrade, r.skips.BelowMinStep, r.skips.MarketDeviation, r.skips.Cooldown, r.skips.StepFailed,
      r.masked, f(100 * r.blockedRate, 1), r.outOfRangeCalls.join("/"),
      `${f(r.maxDespxaPoolSharePct, 0)}/${f(r.maxDespxaSupplySharePct, 0)}`,
      `${r.flows.deposits}/${r.flows.redeems}/${r.flows.blocked}`,
    ].join("\t"),
  );
}
console.log(lines.join("\n"));
console.log("(* = not scored; † = not converged, costed over min(turnover, traded))\n");
console.log("Step failures (first probes per plan: sell>buy:notional:leg state;revert) and first blocked flow:");
for (const r of rows) {
  if (r.stepFailProbes || r.firstFlowFailure) {
    console.log(`  ${r.id}: steps[${r.stepFailProbes.slice(0, 300)}] flow[${r.firstFlowFailure.slice(0, 160)}]`);
  }
}
console.log("");

function report(name: string, g: ReturnType<typeof gates>) {
  const tag = partial ? "PARTIAL " : "";
  console.log(`${name}`);
  console.log(
    `  G4 ${tag}${g.g4Verdict}: median costBps ${f(g.g4.median)} (pass <= ${G4_MEDIAN}), max ${f(g.g4.max)} (pass <= ${G4_MAX}, worst ${g.g4.worst}) over ${g.g4.n} plans`,
  );
  for (const [k, v] of Object.entries(g.g4Readings)) {
    const vv = v.n === 0 ? "n/a (not in this run's JSON)" : v.verdict;
    console.log(`     ${k.padEnd(9)} reading: median ${f(v.median)}, max ${f(v.max)} -> ${vv}${v.n > 0 && v.verdict !== g.g4Verdict ? "  (DIFFERS from headline)" : ""}`);
  }
  if (g.g4.halted.length) console.log(`     Halted plans: ${g.g4.halted.join(", ")}`);
  const cmp = g.g5.blockedSkipRate > G5_SKIP ? ">" : g.g5.blockedSkipRate < G5_SKIP ? "<" : "=";
  console.log(
    `  G5 ${tag}${g.g5Verdict}: all converged in window ${g.g5.allConvergedInWindow}; blocked skips ${g.g5.blocked}/${g.g5.attempts} = ${f(100 * g.g5.blockedSkipRate)}% (${cmp} 10%; ${g.g5.masked} masked); literal ${f(100 * g.g5.literalSkipRate)}% of ${g.g5.calls} calls`,
  );
  if (g.g5.literalSkipRate > G5_SKIP && g.g5.blockedSkipRate < G5_SKIP) {
    console.log(`     FLAG: the literal §5.3 skip rate is over 10% while the blocked rate is under it`);
  }
  console.log(`     per plan: max blocked ${f(100 * g.g5.maxPlanBlockedRate, 1)}% (${g.g5.maxPlan}); plans over 10%: ${g.g5.plansOver10pct.length ? g.g5.plansOver10pct.join(", ") : "none"}`);
  for (const u of g.g5.unconverged) console.log(`     unconverged: ${u}`);
  if (g.g5.liquidExpiries.length) console.log(`     liquid-asset expiries (fail clause): ${g.g5.liquidExpiries.join(", ")}`);
  if (g.g5.haltedWithLiquidOff.length) console.log(`     Halted with a liquid asset off tolerance (not the "expires" clause): ${g.g5.haltedWithLiquidOff.join(", ")}`);
}
if (partial) console.log(`PARTIAL RUN, NOT A VERDICT: ${problems.join("; ")}\n`);
console.log(`run ${[...runNames].join(",")} | pin ${[...pins].join(",")} | recording ${[...recs].join(",")} | params ${paramDiff.length ? "differ from §5.6 starts: " + paramDiff.map((k) => `${k}=${JSON.stringify(params[k])}`).join(" ") : "= §5.6 starts"}\n`);
report("SCORED SET (SEQ 1M+5M, EXT 1M, JUMP-DOWN, JUMP-UP)", result.scored);
if (result.probe) {
  const p = result.probe;
  console.log(`  EXT-PROBE 5M beside it (not merged): G4 ${p.g4Verdict} (median ${f(p.g4.median)}, max ${f(p.g4.max)}), G5 ${p.g5Verdict}${p.g5.allConvergedInWindow ? "" : "; with the probe merged, G5 could not read PASS"}`);
}
const lpLeft = scored.filter((r) => r.leftPinLpRange).map((r) => r.id);
if (lpLeft.length) {
  console.log(`\nSENSITIVITY (static LP): ${lpLeft.length} scored plans saw a basket pool leave its pin LP range: ${lpLeft.join(", ")}`);
  report("SCORED SET WITHOUT THOSE PLANS (sensitivity only, not the verdict)", result.scoredExcludingPlansThatLeftPinLpRange);
}
console.log("");
if (result.probe) report("EXT-PROBE 5M (capacity probe, not scored)", result.probe);
console.log("\nBy scenario:");
for (const [k, g] of Object.entries(byScenario)) {
  console.log(`  ${k.padEnd(14)} G4 med ${f(g.g4.median)} max ${f(g.g4.max)} | blocked ${f(100 * g.g5.blockedSkipRate, 2)}% (max plan ${f(100 * g.g5.maxPlanBlockedRate, 1)}%) literal ${f(100 * g.g5.literalSkipRate, 2)}% | unconverged ${g.g5.unconverged.length}/${g.plans}`);
}
if (timed) {
  const t = (result as any).timed;
  const tag = partial ? "PARTIAL " : "";
  const g = t.noJump.g9;
  console.log(`\nTIMED FLOWS (G9 set: ${t.definitions.g9Set.join(", ")}; ${t.noJump.files} files)`);
  console.log(
    `  G9 ${tag}${g.verdict}: first-call share ${f(100 * g.firstCallShare)}% (${g.firstCallsOk}/${g.firstCalls}, pass >= ${100 * G9_FIRST_CALL}%); ` +
      `redemption wait median ${f(g.redeemWaitH.median)} h, p95 ${f(g.redeemWaitH.p95)} h (pass <= ${G9_WAIT_H}; ${g.redeemWaitH.n} requests, ${g.redeemWaitH.unfilledOlderThan14h} unfilled > ${G9_WAIT_H} h, ${g.redeemWaitH.censored} censored); ` +
      `flow cost vs feed median ${f(g.flowCostBps.median)} bps, max ${f(g.flowCostBps.max)} bps (pass <= ${G9_COST_MEDIAN} / ${G9_COST_MAX}; ${g.flowCostBps.n} requests)`,
  );
  console.log(`     first-call outcomes: ${JSON.stringify(g.firstCallOutcomes)}`);
  for (const [name, part] of [["no jump", t.noJump], ["jump", t.jump], ["probe", t.probe], ["all", t.all]] as const) {
    if (part.files === 0) continue;
    console.log(`  ${name.padEnd(8)} attempts ${part.attempts.n} ${JSON.stringify(part.attempts.byOutcome)}; settlements ${part.attempts.settlements}; requests ${part.requests.n} (expired ${part.requests.expired}, part-filled at end ${part.requests.partlyFilledAtEnd})`);
    console.log(`           deposit wait median ${f(part.depositWaitH.median)} h p95 ${f(part.depositWaitH.p95)} h; redemption wait median ${f(part.g9.redeemWaitH.median)} h p95 ${f(part.g9.redeemWaitH.p95)} h; cost median ${f(part.g9.flowCostBps.median)} max ${f(part.g9.flowCostBps.max)} bps (vs reference ${f(part.g9.flowCostRefBps.median)} / ${f(part.g9.flowCostRefBps.max)})`);
    console.log(`           netting would have saved ${f(part.netting.savedUsdcAtFeed)} USDC at the feed (${f(part.netting.savedBpsOfFlowAtFeed)} bps of ${f(part.netting.flowVolumeUsdc, 0)} USDC of flow; ${part.netting.twoSidedSettlements} of ${part.netting.settlements} settlements two-sided)`);
  }
  console.log("  normal range (no-jump set; p50 / p95 / p99 / max, or min / p01 / p05 for slicesInBand) beside each value:");
  const nr = t.noJump.normalRange;
  const line = (k: string, v: unknown, d: any, low = false) =>
    console.log(`     ${k.padEnd(28)} value ${String(v).padEnd(8)} ${low ? `min ${f(d.min, 1)} p01 ${f(d.p01, 1)} p05 ${f(d.p05, 1)}` : `p50 ${f(d.p50, 1)} p95 ${f(d.p95, 1)} p99 ${f(d.p99, 1)} max ${f(d.max, 1)}`} (n ${d.n})`);
  line("refBandBps: |TWAP-feed|", t.flowParams.refBandBps, nr.twapVsFeedAbsBps);
  line("legBandBps: |spot-feed|", t.flowParams.legBandBps, nr.spotVsFeedAbsBps);
  line("legBandBps: settle impact", t.flowParams.legBandBps, nr.settleSpotMoveAbsBps);
  line("dispersionBps: widest slice", t.flowParams.dispersionBps, nr.sliceDevBps);
  line("quorum: slices in band", t.flowParams.quorum, nr.slicesInBand, true);
  line("maxSharePriceMoveBps", t.flowParams.maxSharePriceMoveBps, nr.sharePriceMoveBpsPerEpoch);
  line("maxLendRateGrowthBps/day", t.flowParams.maxLendRateGrowthBps, nr.lendGrowthBpsPerDay);
  line("maxEpochFlowBps: deposits", t.flowParams.maxEpochFlowBps, nr.depositBpsOfNav);
  line("maxEpochFlowBps: redemptions", t.flowParams.maxEpochFlowBps, nr.redeemBpsOfNav);
  line("minRequestUsdc: request size", (t.flowParams.minRequestUsdc ?? NaN) / 1e6, nr.requestUsdc, true);
  console.log(`     not measured: ${t.values.notMeasured}`);
  const bk = scored.reduce(
    (a, r) => ({ feed: a.feed + r.booked.atFeed, twap: a.twap + r.booked.atTwap, zero: a.zero + r.booked.zero, other: a.other + r.booked.other }),
    { feed: 0, twap: 0, zero: 0, other: 0 },
  );
  console.log(`  steps: cost booked at the feed ${bk.feed}, at the TWAP ${bk.twap}, zero ${bk.zero}, neither ${bk.other} (scored set); new-reason skips (FeedCheck) ${scored.reduce((a, r) => a + r.skipFeedCheckOrNew, 0)}`);
}
console.log(`\nrun dir ${dir} (${files.length} files)`);
console.log(`wrote ${join(dir, "sim.json")}`);
