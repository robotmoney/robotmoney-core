// Deploy 4: the fund system's measured counts (src/ci/rehearsal-counts.ts build --system fund, check, pair) and the drift check of a counts.json that names its system
// (src/counts-drift.ts). One frozen file per sha holds every system's keys; a fund counts.json holds the fund's stage counts only and says so, so it is never read as the
// vaults system's. A counts.json without a system is the vaults system's, exactly as before.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROOF_TX_NONCES } from "../src/counts.ts";
import { buildCountsJson, checkCountsJson, pairProblems, systemCountKeys, type CountsJson } from "../src/ci/rehearsal-counts.ts";
import { loadStageTable } from "../src/stage-table.ts";
import { DEPLOYER_STAGES } from "../src/stages.ts";
import { COUNTS, SHA, tmp, writeCounts } from "./fixtures.ts";
import { REPO_ROOT } from "./repo-root.ts";

const TABLE = loadStageTable(REPO_ROOT);
const FUND_COUNTS: Record<string, number> = { safe: 1, "fund-libs": 14, "fund-receipt": 2, fund: 18, rebalancer: 7, "fund-governance": 2, queue: 2, "fund-wiring": 3, "fund-timelock": 15 };
const fundSum = Object.values(FUND_COUNTS).reduce((a, b) => a + b, 0);
const vaultsSum = Object.values(COUNTS).reduce((a, b) => a + b, 0);
const FUND_KEYS = systemCountKeys(TABLE, "fund");
const tool = (args: string[]) => {
  const r = Bun.spawnSync([process.execPath, join(REPO_ROOT, "publish-contracts/src/ci/rehearsal-counts.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};
const write = (j: unknown, dir = tmp("rcf-"), name = "counts.json") => { const p = join(dir, name); writeFileSync(p, JSON.stringify(j)); return p; };
const fundJson = (over: Partial<CountsJson> = {}): CountsJson => ({ deploySha: SHA, chainId: 918453, counts: { ...FUND_COUNTS }, deployerNonce: fundSum + PROOF_TX_NONCES, system: "fund", rehearsal: { conclusion: "success" }, ...over });

describe("the fund system's counts.json", () => {
  test("the fund's stage keys are its deployer stages, and the loaded system is restored after reading them", () => {
    expect(FUND_KEYS.sort()).toEqual(Object.keys(FUND_COUNTS).sort());
    const before = DEPLOYER_STAGES.map((s) => s.countKey);
    systemCountKeys(TABLE, "fund");
    expect(DEPLOYER_STAGES.map((s) => s.countKey)).toEqual(before);
  });
  test("build --system fund keeps only the fund's counts of a file that holds both systems, and names the system", () => {
    const dir = tmp("rcf-dir-");
    writeCounts(dir, SHA, { ...COUNTS, ...FUND_COUNTS });
    const j = buildCountsJson(dir, SHA, fundSum + 1, {}, undefined, undefined, { name: "fund", keys: FUND_KEYS });
    expect(j.system).toBe("fund");
    expect(j.counts).toEqual(FUND_COUNTS);
    expect(checkCountsJson(j, FUND_KEYS)).toEqual([]);
    // without a system: every count of the file and no system named, the vaults behaviour
    const v = buildCountsJson(dir, SHA, vaultsSum + 1);
    expect(v.system).toBeUndefined();
    expect(v.counts).toEqual({ ...COUNTS, ...FUND_COUNTS });
  });
  test("the CLI builds and checks a fund counts.json against the fund keys, and a fund file read as the vaults system's fails", () => {
    const dir = tmp("rcf-cli-");
    const countsDir = join(dir, "counts"); mkdirSync(countsDir);
    writeCounts(countsDir, SHA, { ...COUNTS, ...FUND_COUNTS });
    const out = join(dir, "counts.json");
    expect(tool(["build", "--system", "fund", "--counts-dir", countsDir, "--sha", SHA, "--nonce", String(fundSum + 1), "--out", out]).code).toBe(0);
    const ok = tool(["check", "--file", out]);
    expect(ok.out).toContain("(system fund)");
    expect(ok.code).toBe(0);
    const asVaults = write({ ...fundJson(), system: undefined });
    const bad = tool(["check", "--file", asVaults]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("counts has no entry for stage vault");
  });
  test("an unknown system is refused", () => {
    expect(tool(["check", "--file", write({ ...fundJson(), system: "treasury" })]).code).toBe(1);
    expect(tool(["build", "--system", "treasury", "--counts-dir", tmp(), "--sha", SHA, "--nonce", "1", "--out", join(tmp(), "x.json")]).out).toContain("--system is vaults, fund or gateway");
  });
});

describe("the Twin pair", () => {
  const keysOf = (s: "vaults" | "fund" | "gateway") => systemCountKeys(TABLE, s);
  test("two green runs at one sha with equal counts pass", () => {
    expect(pairProblems(fundJson(), fundJson(), keysOf)).toEqual([]);
  });
  test("a differing count, sha, system or a run that is not green fails, each named", () => {
    expect(pairProblems(fundJson(), fundJson({ counts: { ...FUND_COUNTS, fund: 19 }, deployerNonce: fundSum + 2 }), keysOf).join()).toContain("stage fund: 18 in a, 19 in b");
    expect(pairProblems(fundJson(), fundJson({ deploySha: "f".repeat(40) }), keysOf).join()).toContain("different shas");
    expect(pairProblems(fundJson(), fundJson({ rehearsal: { conclusion: "failure" } }), keysOf).join()).toContain("b: the run did not conclude success");
    expect(pairProblems(fundJson(), fundJson({ rehearsal: undefined }), keysOf).join()).toContain("b: the run did not conclude success");
    const vaults: CountsJson = { deploySha: SHA, chainId: 918453, counts: { ...COUNTS }, deployerNonce: vaultsSum + 1, rehearsal: { conclusion: "success" } };
    expect(pairProblems(fundJson(), vaults, keysOf).join()).toContain("different systems: fund and vaults");
  });
  test("each run must pass its own check: a nonce that is not the counts plus prove-control fails the pair", () => {
    expect(pairProblems(fundJson({ deployerNonce: 3 }), fundJson(), keysOf).join()).toContain("a: deployerNonce 3 differs");
  });
  test("the CLI exits 0 on a good pair and 1 otherwise", () => {
    const d = tmp("rcf-pair-");
    const a = write(fundJson(), d, "a.json"), b = write(fundJson(), d, "b.json"), c = write(fundJson({ counts: { ...FUND_COUNTS, queue: 3 }, deployerNonce: fundSum + 2 }), d, "c.json");
    const good = tool(["pair", "--a", a, "--b", b]);
    expect(good.code).toBe(0);
    expect(good.out).toContain("twin pair ok: fund system");
    expect(tool(["pair", "--a", a, "--b", c]).code).toBe(1);
  });
});

describe("counts-drift of a counts.json that names its system", () => {
  const drift = (counts: string, frozenDir: string) => {
    const r = Bun.spawnSync([process.execPath, join(REPO_ROOT, "publish-contracts/src/counts-drift.ts"), "--counts", counts, "--frozen-dir", frozenDir], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  test("a fund counts.json is compared with the fund stages of a frozen file that holds both systems", () => {
    const frozen = tmp("rcf-frozen-");
    writeCounts(frozen, SHA, { ...COUNTS, ...FUND_COUNTS });
    const ok = drift(write(fundJson()), frozen);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("the fund system's stages");
    const bad = drift(write(fundJson({ counts: { ...FUND_COUNTS, rebalancer: 8 } })), frozen);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("stage rebalancer: measured 8, frozen 7");
  });
  test("a fund stage the frozen file lacks is still a drift", () => {
    const frozen = tmp("rcf-frozen-");
    const { queue: _q, ...partial } = FUND_COUNTS;
    writeCounts(frozen, SHA, { ...COUNTS, ...partial });
    expect(drift(write(fundJson()), frozen).out).toContain("stage queue: measured 2, frozen none");
  });
  test("a counts.json without a system is compared with the whole file, as before", () => {
    const frozen = tmp("rcf-frozen-");
    writeCounts(frozen, SHA, { ...COUNTS, ...FUND_COUNTS });
    const r = drift(write({ deploySha: SHA, chainId: 918453, counts: COUNTS, deployerNonce: vaultsSum + 1 }), frozen);
    expect(r.code).toBe(1);
    expect(r.out).toContain("stage fund: measured none, frozen 18");
  });
});
