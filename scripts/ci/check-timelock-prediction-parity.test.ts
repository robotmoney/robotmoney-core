// Canonical: issue 1853. The timelock prediction parity gate is green on agreeing vectors and red on a mismatch, a missing vector file and an empty one.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { predictCoreTimelock } from "../../publish-contracts/src/timelock-pin.ts";

const repo = join(import.meta.dir, "..", "..");
const SCRIPT = join(import.meta.dir, "check-timelock-prediction-parity.ts");
const TABLE = join(repo, "scripts", "deploy", "stage-table.json");
const OUT = join(repo, "publish-contracts", "tests", "fixtures", "build-out"); // a TimelockController build artifact
const u = (await Bun.file(TABLE).json()).upgradeAuthority;
const SAFE = "0x00000000000000000000000000000000000050fe";
const good = () => { const p = predictCoreTimelock(u, OUT, SAFE, 60n); return { safe: SAFE, minDelay: "60", address: p.address, initCodeHash: p.initCodeHash }; };

function run(vectors: unknown | null): { code: number; err: string } {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? join(homedir(), "tmp"), "tl-parity-"));
  const path = join(dir, "vectors.json");
  if (vectors !== null) writeFileSync(path, JSON.stringify(vectors));
  const r = Bun.spawnSync(["bun", SCRIPT, "--vectors", path, "--out", OUT, "--table", TABLE], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, err: r.stderr.toString() };
}

describe("check-timelock-prediction-parity", () => {
  test("agreeing vectors pass", () => {
    expect(run({ vectors: [good()] })).toEqual({ code: 0, err: "" });
  });

  test("a planted mismatched address fails", () => {
    const r = run({ vectors: [{ ...good(), address: "0x00000000000000000000000000000000000000b0" }] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Solidity 0x00000000000000000000000000000000000000b0");
  });

  test("a planted mismatched init code hash fails", () => {
    const r = run({ vectors: [good(), { ...good(), initCodeHash: `0x${"11".repeat(32)}` }] });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`init code hash 0x${"11".repeat(32)}`);
  });

  test("a missing vector file fails", () => {
    const r = run(null);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no vector file");
  });

  test("an empty vector file fails", () => {
    const r = run({ vectors: [] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("holds no vectors");
  });
});
