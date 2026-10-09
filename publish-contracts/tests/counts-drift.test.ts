import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROOF_TX_NONCES } from "../src/counts.ts";
import { checkCountsJson, buildCountsJson } from "../src/ci/rehearsal-counts.ts";
import { driftErrors } from "../src/counts-drift.ts";
import { DEPLOYER_STAGES } from "../src/stages.ts";
import { COUNTS, SHA, tmp, writeCounts } from "./fixtures.ts";

const sum = Object.values(COUNTS).reduce((a, b) => a + b, 0);
const run = (countsFile: string, frozenDir: string) => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/counts-drift.ts"), "--counts", countsFile, "--frozen-dir", frozenDir], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};
const measured = (counts = COUNTS, dir = tmp()) => { const p = join(dir, "counts.json"); writeFileSync(p, JSON.stringify({ deploySha: SHA, chainId: 918453, counts, deployerNonce: sum + PROOF_TX_NONCES })); return p; };

describe("counts-drift.ts", () => {
  test("exits 0 when no frozen file exists for the SHA", () => {
    const r = run(measured(), tmp());
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing to compare");
  });
  test("exits 0 when the counts are equal", () => {
    const dir = tmp();
    writeCounts(dir, SHA);
    const r = run(measured(), dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("counts equal");
  });
  test("exits non-zero and names each differing stage", () => {
    const dir = tmp();
    writeCounts(dir, SHA);
    const r = run(measured({ ...COUNTS, vault: 19, rwa: 5 }), dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("stage vault: measured 19, frozen 18");
    expect(r.out).toContain("stage rwa: measured 5, frozen 6");
    expect(r.out).not.toContain("stage libs");
  });
  test("a stage missing on one side differs", () => {
    const { timelock: _t, ...rest } = COUNTS;
    expect(driftErrors(rest, COUNTS)).toEqual(["stage timelock: measured none, frozen 25"]);
  });
});

describe("rehearsal counts.json", () => {
  const keys = () => DEPLOYER_STAGES.map((s) => s.countKey!);
  test("the stage keys come from the stage table and a run fixture passes", () => {
    expect(keys().sort()).toEqual(Object.keys(COUNTS).sort());
    const dir = tmp();
    writeCounts(dir, SHA);
    expect(checkCountsJson(buildCountsJson(dir, SHA, sum + PROOF_TX_NONCES), keys())).toEqual([]);
  });
  test("a nonce that is not the sum of counts plus the prove-control transaction fails, the bare sum included", () => {
    const dir = tmp();
    writeCounts(dir, SHA);
    expect(checkCountsJson(buildCountsJson(dir, SHA, sum), keys()).join()).toContain("deployerNonce");
    expect(checkCountsJson(buildCountsJson(dir, SHA, sum + PROOF_TX_NONCES + 1), keys()).join()).toContain("deployerNonce");
  });
  test("a missing or extra stage key fails", () => {
    const { rwa: _r, ...rest } = COUNTS;
    expect(checkCountsJson({ deploySha: SHA, chainId: 918453, counts: rest, deployerNonce: sum - 6 }, keys()).join()).toContain("no entry for stage rwa");
    expect(checkCountsJson({ deploySha: SHA, chainId: 918453, counts: { ...COUNTS, extra: 1 }, deployerNonce: sum + 1 }, keys()).join()).toContain("extra");
  });
});
