import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SCORE_SIM = join(REPO_ROOT, "contracts/test/prototype/sim/score-sim.ts");
const SCRATCH_PARENT = "/drive2/home/lucas/tmp";
const TEMP_DIRS: string[] = [];

function mkSimDir(dirName = "default-timed"): string {
  mkdirSync(SCRATCH_PARENT, { recursive: true });
  const parent = mkdtempSync(join(SCRATCH_PARENT, "score-sim-test-"));
  TEMP_DIRS.push(parent);
  const runDir = join(parent, dirName);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

const MANIFEST_SPECS: { file: string; scenario: string; fundUsdc: number; seeds: number[] }[] = [
  ...[0, 1, 2].map((k) => ({ file: `sim-SEQ-1M-s${k}.json`, scenario: "SEQ", fundUsdc: 1e12, seeds: [1, 2, 3, 4].map((x) => k * 10 + x) })),
  ...[0, 1, 2].map((k) => ({ file: `sim-SEQ-5M-s${k}.json`, scenario: "SEQ", fundUsdc: 5e12, seeds: [1, 2, 3, 4].map((x) => k * 10 + x) })),
  ...[0, 1, 2].map((k) => ({ file: `sim-EXT-1M-s${k}.json`, scenario: "EXT", fundUsdc: 1e12, seeds: [1, 2].map((x) => k * 10 + x) })),
  ...[0, 1, 2].map((k) => ({ file: `sim-JUMP-DOWN-1M-s${k}.json`, scenario: "JUMP-DOWN", fundUsdc: 1e12, seeds: [k + 1] })),
  ...[0, 1, 2].map((k) => ({ file: `sim-JUMP-UP-1M-s${k}.json`, scenario: "JUMP-UP", fundUsdc: 1e12, seeds: [k + 1] })),
  { file: "sim-EXT-PROBE-5M-s0.json", scenario: "EXT-PROBE", fundUsdc: 5e12, seeds: [1, 2] },
];

function defaultTimedParams() {
  return {
    stepInterval: 1800,
    maxOverrun: 604800,
    maxStepCostBps: 50,
    toleranceBps: 50,
    minStepUsdc: 100000000,
    planDuration: 604800,
    costBudgetBps: 30,
    maxStepUsdc: [500000000000, 500000000000, 50000000000, 50000000000, 500000000000],
    maxStepSlippageBps: [0, 0, 50, 50, 0],
    flowParams: {
      epochLength: 21600,
      settleWindow: 3600,
      minHold: 3600,
      keeperGrace: 21600,
      maxEpochFlowBps: 500,
      epochFlowFloorUsdc: 250000000000,
      maxSharePriceMoveBps: 1000,
      maxRoll: 8,
      minRequestUsdc: 100000000,
      maxFreeze: 604800,
      slices: 12,
      quorum: 9,
      dispersionBps: 100,
      refBandBps: 90,
      legBandBps: 100,
      sequencerGrace: 3600,
      usdcPegBandBps: 50,
      maxLendRateGrowthBps: 10,
      cancelBuffer: 900,
      maxPause: 259200,
    },
    step3f: {
      minPoolDepthUsdc: 2000000000000,
      feeMarginBps: 20,
      delistBandBps: 300,
      delistBudgetBps: 300,
    },
  };
}

function makePlan(scenario: string, fundUsdc: number, seedK: number, receipt = 0, over: Record<string, unknown> = {}) {
  return {
    scenario,
    fundUsdc,
    seedK,
    receipt,
    outcome: "Converged",
    convergedInWindow: true,
    liquidAssetOffTolerance: false,
    turnoverUsdc: 100_000e6,
    tradedNotional: 80_000e6,
    execCost: 40e6,
    flowLoss: 10e6,
    unexplainedDrop: 0,
    execCostRef: 45e6,
    flowLossRef: 10e6,
    costSpent: 40e6,
    costBudget: 300e6,
    basisCost: 5e6,
    timeToConvergeSec: 7200,
    overrunSec: 0,
    calls: 12,
    executed: 10,
    maskedCalls: 0,
    skipNothingToTrade: 2,
    skipBelowMinStep: 0,
    skipMarketDeviation: 0,
    skipCooldown: 0,
    skipStepFailed: 0,
    skipOther: 0,
    outOfRangeCalls: [0, 0, 0],
    deposits: 3,
    redeems: 2,
    flowsBlocked: 0,
    bookedAtFeed: 8,
    bookedAtTwap: 2,
    bookedZero: 0,
    bookedOther: 0,
    depositRequests: 3,
    redeemRequests: 2,
    settleAttempts: 4,
    settleBlockedAttempts: 0,
    signedFeedCost: 10e6,
    signedTwapCost: 12e6,
    ...over,
  };
}

function makeTimedData(over: Record<string, unknown> = {}) {
  return {
    attempts: {
      outcome: [0, 0],
      kind: [1, 1],
      twapVsFeedBps0: [5, -6],
      twapVsFeedBps1: [4, -4],
      spotVsFeedBps0: [8, 7],
      spotVsFeedBps1: [6, 5],
      slicesInBand0: [12, 11],
      slicesInBand1: [12, 12],
      sliceDevBps0: [10, 12],
      sliceDevBps1: [9, 11],
      spotMoveBps0: [3, 2],
      spotMoveBps1: [2, 1],
      sharePriceMoveBpsPerEpoch: [4, 5],
      lendGrowthCentiBpsPerDay: [10, 12],
    },
    requests: {
      at: [0, 3600],
      doneAt: [7200, 10800],
      unlockAt: [10800, 14400],
      isDeposit: [1, 0],
      basis: [10_000e6, 10_000e6],
      costFeed: [5e6, 6e6],
      costRef: [6e6, 7e6],
      status: [1, 1],
      valueUsdc: [10_000e6, 10_000e6],
      filled: [10_000e6, 10_000e6],
    },
    settlements: {
      depUsdc: [10_000e6],
      depFairFeed: [9_995e6],
      depFairRef: [9_994e6],
      redGross: [9_994e6],
      redFairFeed: [10_000e6],
      redFairRef: [10_001e6],
      navFeed: [1_000_000e6],
      matchedUsdc: [2_500e6],
      matchedShares: [2500],
    },
    depositStops: 1,
    blockedWaitsH: [1.5],
    ...over,
  };
}

function writeTimedFixture(
  dir: string,
  mutate?: (spec: (typeof MANIFEST_SPECS)[number], doc: Record<string, any>) => void,
): void {
  for (const spec of MANIFEST_SPECS) {
    const doc: Record<string, any> = {
      meta: {
        pinBlock: 25_000_000,
        recording: "replay",
        run: "default",
        flows: "timed",
        tag: "",
        step3f: true,
        endAt: 40_000,
        scenario: spec.scenario,
        params: defaultTimedParams(),
      },
      plans: spec.seeds.map((s, idx) => makePlan(spec.scenario, spec.fundUsdc, s, idx)),
      timed: makeTimedData(),
    };
    if (mutate) mutate(spec, doc);
    writeFileSync(join(dir, spec.file), JSON.stringify(doc));
  }
}

function runScore(dir: string, extraArgs: string[] = []) {
  const res = Bun.spawnSync([process.execPath, SCORE_SIM, "--dir", dir, ...extraArgs], { stdout: "pipe", stderr: "pipe" });
  const simPath = join(dir, "sim.json");
  let sim: any = null;
  try {
    sim = JSON.parse(readFileSync(simPath, "utf8"));
  } catch {
    sim = null;
  }
  return {
    code: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
    sim,
  };
}

describe("score-sim Step 3f provenance and scoring invariants (E45, E46, G9)", () => {
  test("passes a healthy 16-file Step 3f timed fixture and computes G4, G5, G9, and step3f aggregates", () => {
    const dir = mkSimDir("default-timed");
    writeTimedFixture(dir);
    const r = runScore(dir);
    expect(r.code).toBe(0);
    expect(r.sim.partial).toBe(false);
    expect(r.sim.provenance.problems).toEqual([]);
    expect(r.sim.provenance.diffFromDefaults).toEqual([]);
    expect(r.sim.scored.plans).toBe(36);
    expect(r.sim.scored.g4.n).toBe(36);
    expect(r.sim.scored.g4Verdict).toBe("PASS");
    expect(r.sim.scored.g5Verdict).toBe("PASS");
    expect(r.sim.timed.noJump.g9.verdict).toBe("PASS");
    // 16 files total -> all.step3f has 16 * 2500 USDC = 40000, 16 * 2500 shares = 40000, 16 depositStops, maxBlockedWaitH 1.5
    expect(r.sim.timed.all.step3f).toEqual({
      matchedUsdc: 40_000,
      matchedShares: 40_000,
      depositStops: 16,
      maxBlockedWaitH: 1.5,
    });
  });

  test("E45: detects nested param disagreements across files and nested deviations from defaults, while ignoring JSON key order", () => {
    // 1) Same nested objects with reversed key ordering pass
    const orderedDir = mkSimDir("default-timed");
    writeTimedFixture(orderedDir, (spec, doc) => {
      if (spec.file === "sim-EXT-1M-s0.json") {
        const fp = doc.meta.params.flowParams;
        doc.meta.params.flowParams = Object.fromEntries(Object.entries(fp).reverse());
        doc.meta.params.step3f = Object.fromEntries(Object.entries(doc.meta.params.step3f).reverse());
      }
    });
    expect(runScore(orderedDir).code).toBe(0);

    // 2) Nested param mismatch across two files is refused (exit 2)
    const disagreeDir = mkSimDir("default-timed");
    writeTimedFixture(disagreeDir, (spec, doc) => {
      if (spec.file === "sim-EXT-1M-s1.json") doc.meta.params.flowParams.cancelBuffer = 600;
    });
    const disagree = runScore(disagreeDir);
    expect(disagree.code).toBe(2);
    expect(disagree.stderr).toContain("files disagree on params");

    // 3) Uniform nested Step 3f diff from defaults on "default" run is refused (exit 2)
    const diffDir = mkSimDir("default-timed");
    writeTimedFixture(diffDir, (_spec, doc) => {
      doc.meta.params.step3f.delistBandBps = 450;
    });
    const diff = runScore(diffDir);
    expect(diff.code).toBe(2);
    expect(diff.stderr).toContain("default run params differ");
    expect(diff.stderr).toContain("step3f");
  });

  test("E46: fails closed on missing/non-finite cost fields, invalid denominators, and dropped plans; explicitly excludes zero-turnover plans from G4", () => {
    // Missing/non-finite required cost field
    const nanDir = mkSimDir("default-timed");
    writeTimedFixture(nanDir, (spec, doc) => {
      if (spec.file === "sim-SEQ-1M-s0.json") doc.plans[0].execCost = "";
    });
    const nanRes = runScore(nanDir);
    expect(nanRes.code).toBe(2);
    expect(nanRes.stderr).toContain("missing or non-finite execCost");

    // Invalid denominator when turnoverUsdc=0 but tradedNotional > 0
    const badDenomDir = mkSimDir("default-timed");
    writeTimedFixture(badDenomDir, (spec, doc) => {
      if (spec.file === "sim-SEQ-1M-s0.json") doc.plans[0].turnoverUsdc = 0;
    });
    const badDenom = runScore(badDenomDir);
    expect(badDenom.code).toBe(2);
    expect(badDenom.stderr).toContain("invalid denominator");

    // Dropped plan refuses scoring
    const dropDir = mkSimDir("default-timed");
    writeTimedFixture(dropDir, (spec, doc) => {
      if (spec.file === "sim-SEQ-1M-s2.json") doc.plans.pop();
    });
    const dropRes = runScore(dropDir);
    expect(dropRes.code).toBe(2);
    expect(dropRes.stderr).toContain("3 plans, expected 4");
    expect(dropRes.stderr).toContain("scored plans count 35 !== expected 36");

    // Explicit zero-turnover exclusion (turnoverUsdc === 0 && tradedNotional === 0) passes and lowers g4.n to 35
    const zeroDir = mkSimDir("default-timed");
    writeTimedFixture(zeroDir, (spec, doc) => {
      if (spec.file === "sim-SEQ-1M-s0.json") {
        doc.plans[0].turnoverUsdc = 0;
        doc.plans[0].tradedNotional = 0;
        doc.plans[0].execCost = 0;
        doc.plans[0].flowLoss = 0;
        doc.plans[0].execCostRef = 0;
        doc.plans[0].flowLossRef = 0;
        doc.plans[0].costSpent = 0;
      }
    });
    const zeroRes = runScore(zeroDir);
    expect(zeroRes.code).toBe(0);
    expect(zeroRes.sim.excludedZeroTurnoverCount).toBe(1);
    expect(zeroRes.sim.excludedZeroTurnoverPlans).toEqual(["SEQ-1M-s1/0"]);
    expect(zeroRes.sim.scored.plans).toBe(36);
    expect(zeroRes.sim.scored.g4.n).toBe(35);
  });

  test("G9 & Step 3e/3f timed scoring: enforces firstCallShare >= 95%, >14h unfilled redeem wait = Infinity FAIL, censoring <= 14h, cost limits, and skipOther blocked rate", () => {
    // 1) Low firstCallShare (< 95%) fails G9
    const fcDir = mkSimDir("default-timed");
    writeTimedFixture(fcDir, (spec, doc) => {
      if (spec.file === "sim-SEQ-1M-s0.json") {
        doc.timed.attempts.outcome = [11, 11]; // both first calls fail (redeemSideFailed)
      }
    });
    const fcRes = runScore(fcDir);
    expect(fcRes.code).toBe(0);
    expect(fcRes.sim.timed.noJump.g9.firstCallShare).toBeLessThan(0.95);
    expect(fcRes.sim.timed.noJump.g9.verdict).toBe("FAIL");

    // 2) Unfilled redemption > 14h -> unfilledOlderThan14h=1, p95=null(Infinity), FAIL; <= 14h -> censored=1, PASS
    const oldUnfilledDir = mkSimDir("default-timed");
    writeTimedFixture(oldUnfilledDir, (spec, doc) => {
      if (spec.file === "sim-SEQ-1M-s0.json") {
        doc.meta.endAt = 60_000; // endAt - at[1] = (60000 - 3600)/3600 = 15.67h > 14h
        doc.timed.requests.doneAt = [7200, 0];
      }
    });
    const oldRes = runScore(oldUnfilledDir);
    expect(oldRes.sim.timed.noJump.g9.redeemWaitH.unfilledOlderThan14h).toBe(1);
    expect(oldRes.sim.timed.noJump.g9.redeemWaitH.p95).toBeNull();
    expect(oldRes.sim.timed.noJump.g9.verdict).toBe("FAIL");

    const censoredDir = mkSimDir("default-timed");
    writeTimedFixture(censoredDir, (spec, doc) => {
      if (spec.file === "sim-SEQ-1M-s0.json") {
        doc.meta.endAt = 40_000; // (40000 - 3600)/3600 = 10.11h <= 14h
        doc.timed.requests.doneAt = [7200, 0];
      }
    });
    const censoredRes = runScore(censoredDir);
    expect(censoredRes.sim.timed.noJump.g9.redeemWaitH.censored).toBe(1);
    expect(censoredRes.sim.timed.noJump.g9.redeemWaitH.unfilledOlderThan14h).toBe(0);
    expect(censoredRes.sim.timed.noJump.g9.verdict).toBe("PASS");

    // 3) High flowCostBps (> 30 bps max) fails G9
    const costDir = mkSimDir("default-timed");
    writeTimedFixture(costDir, (spec, doc) => {
      if (spec.file === "sim-SEQ-1M-s0.json") {
        doc.timed.requests.costFeed = [40e6, 6e6]; // 40 / 10000 = 40 bps > 30 bps max
      }
    });
    const costRes = runScore(costDir);
    expect(costRes.sim.timed.noJump.g9.flowCostBps.max).toBe(40);
    expect(costRes.sim.timed.noJump.g9.verdict).toBe("FAIL");

    // 4) skipOther counts toward blocked attempts & G5 skip rate in timed runs
    const skipDir = mkSimDir("default-timed");
    writeTimedFixture(skipDir, (_spec, doc) => {
      for (const p of doc.plans) p.skipOther = 2; // 2/(10+2) = 16.7% > 10%
    });
    const skipRes = runScore(skipDir);
    expect(skipRes.sim.scored.g5.blocked).toBe(72);
    expect(skipRes.sim.scored.g5Verdict).toBe("FAIL");
  });
});
