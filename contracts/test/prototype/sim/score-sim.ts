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

// ─── Provenance checks ───────────────────────────────────────────────────────────────────────────────
const problems: string[] = [];
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
const paramDiff = Object.keys(DEFAULT_PARAMS).filter((k) => JSON.stringify(params[k]) !== JSON.stringify(DEFAULT_PARAMS[k]));
if ((runLabel === "default" || runLabel === "tuned") && !runNames.has(runLabel)) {
  problems.push(`dir ${runLabel} holds files of run ${[...runNames].join(",")}`);
}
if (runNames.has("default") && paramDiff.length) problems.push(`default run params differ from §5.6 starts: ${paramDiff.join(",")}`);
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
    const blocked = num(p.skipMarketDeviation) + num(p.skipCooldown) + num(p.skipStepFailed) + masked;
    const executed = num(p.executed);
    const calls = num(p.calls);
    const oor: number[] = (p.outOfRangeCalls ?? [0, 0, 0]).map(num);
    rows.push({
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
    });
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
console.log(`\nrun dir ${dir} (${files.length} files)`);
console.log(`wrote ${join(dir, "sim.json")}`);
