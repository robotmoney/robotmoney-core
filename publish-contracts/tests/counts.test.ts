import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublishError } from "../src/errors.ts";
import { PROOF_TX_NONCES, assertSha, checkNonce, countFor, frozenPath, loadFrozen, resolveCounts, sumCounts, writeFrozen } from "../src/counts.ts";
import { freezeCounts } from "../scripts/freeze-counts.ts";
import { COUNTS, SHA, SHA2, tmp, writeCounts } from "./fixtures.ts";

const kind = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return (e as PublishError).kind; } return undefined; };

describe("frozen counts keyed by DEPLOY_SHA", () => {
  test("the nonce check passes when it equals the summed frozen counts", () => {
    const sum = sumCounts(COUNTS);
    expect(sum).toBe(1 + 4 + 6 + 18 + 2 + 3 + 3 + 2 + 5 + 6 + 6 + 6 + 25);
    expect(kind(() => checkNonce(sum + PROOF_TX_NONCES, COUNTS))).toBeUndefined();
    expect(kind(() => checkNonce(sum, COUNTS))).toBe("NONCE"); // the deployer also sent the prove-control transaction (core 1712)
    expect(kind(() => checkNonce(sum, COUNTS, Object.keys(COUNTS)))).toBeUndefined(); // a named subset of stages is just their sum
  });
  test("the nonce check fails on a mismatch, in either direction", () => {
    const sum = sumCounts(COUNTS);
    expect(kind(() => checkNonce(sum, COUNTS))).toBe("NONCE");
    expect(kind(() => checkNonce(sum + PROOF_TX_NONCES - 1, COUNTS))).toBe("NONCE");
    expect(kind(() => checkNonce(sum + PROOF_TX_NONCES + 1, COUNTS))).toBe("NONCE");
    expect(kind(() => checkNonce(56, COUNTS))).toBe("NONCE"); // no hand-typed 56
  });
  test("the nonce check fails on a missing SHA", () => {
    const dir = tmp();
    expect(kind(() => loadFrozen(dir, SHA))).toBe("COUNTS_MISSING");
  });
  test("a file for another SHA is refused", () => {
    const dir = tmp();
    writeCounts(dir, SHA);
    writeFileSync(frozenPath(dir, SHA2), readFileSync(frozenPath(dir, SHA), "utf8"));
    expect(kind(() => loadFrozen(dir, SHA2))).toBe("COUNTS_MISSING");
  });
  test("a frozen file loads by DEPLOY_SHA and gives the per-stage counts", () => {
    const dir = tmp();
    writeCounts(dir);
    const f = loadFrozen(dir, SHA);
    expect(f.counts).toEqual(COUNTS);
    expect(countFor(f.counts, "vault")).toBe(18);
    expect(kind(() => countFor(f.counts, "nope"))).toBe("COUNTS_MISSING");
  });
  test("bad counts are refused", () => {
    const dir = tmp();
    writeFileSync(join(dir, `${SHA}.json`), JSON.stringify({ deploySha: SHA, counts: { safe: -1 } }));
    expect(kind(() => loadFrozen(dir, SHA))).toBe("COUNTS_MISSING");
  });
  test("a SHA must be 40 lowercase hex: no path tricks", () => {
    for (const bad of ["../x", "abc", "A".repeat(40), SHA + "0"]) expect(kind(() => assertSha(bad))).toBe("USAGE");
  });
  test("a frozen file is written once and never rewritten with different counts", () => {
    const dir = tmp();
    const meta = { chainId: 918453, at: "now" };
    writeFrozen(dir, SHA, COUNTS, meta);
    expect(kind(() => writeFrozen(dir, SHA, COUNTS, meta))).toBeUndefined();
    expect(kind(() => writeFrozen(dir, SHA, { ...COUNTS, vault: 19 }, meta))).toBe("COUNT_MISMATCH");
  });
  test("resolveCounts: a file wins, a flag measures, a missing file is a WARN on a dry run, a measure on Twin, a hard error on 8453", () => {
    const dir = tmp();
    const ev: string[] = [];
    const warn = (e: string) => { ev.push(e); };
    const base = { dir, sha: SHA, measureFlag: false, dryRun: false, warn };
    expect(kind(() => resolveCounts({ ...base, chainId: 8453 }))).toBe("COUNTS_MISSING");
    expect(resolveCounts({ ...base, chainId: 8453, dryRun: true }).mode).toBe("dry-run-measure"); // the preflight measures on either chain
    expect(resolveCounts({ ...base, chainId: 918453, dryRun: true }).frozen).toBeUndefined();
    expect(resolveCounts({ ...base, chainId: 918453 })).toMatchObject({ measure: true, mode: "twin-measure" });
    expect(ev).toEqual(["dry_run.counts_missing", "dry_run.counts_missing", "counts.measuring"]);
    expect(resolveCounts({ ...base, chainId: 918453, measureFlag: true }).mode).toBe("measure-flag");
    writeCounts(dir);
    expect(resolveCounts({ ...base, chainId: 8453 })).toMatchObject({ measure: false, mode: "frozen", frozen: COUNTS });
    expect(resolveCounts({ ...base, chainId: 918453, dryRun: true }).mode).toBe("frozen");
  });
});

describe("freeze-counts (core 1524)", () => {
  const counts = (over: Record<string, unknown> = {}): string => {
    const p = join(tmp(), "counts.json");
    writeFileSync(p, JSON.stringify({ deploySha: SHA, chainId: 918453, counts: COUNTS, deployerNonce: sumCounts(COUNTS) + PROOF_TX_NONCES, rehearsal: { conclusion: "success" }, ...over }));
    return p;
  };
  test("writes the frozen file from a counts.json fixture", () => {
    const dir = tmp();
    const p = freezeCounts(counts(), dir);
    expect(p).toBe(frozenPath(dir, SHA));
    expect(loadFrozen(dir, SHA).counts).toEqual(COUNTS);
  });
  test("an identical rerun leaves the file byte-identical", () => {
    const dir = tmp();
    const p = freezeCounts(counts(), dir);
    const before = readFileSync(p, "utf8");
    freezeCounts(counts(), dir);
    expect(readFileSync(p, "utf8")).toBe(before);
  });
  test("a rerun with different counts is COUNT_MISMATCH and leaves the file unchanged", () => {
    const dir = tmp();
    const p = freezeCounts(counts(), dir);
    const before = readFileSync(p, "utf8");
    const other = { ...COUNTS, vault: 19 };
    expect(kind(() => freezeCounts(counts({ counts: other, deployerNonce: sumCounts(other) + PROOF_TX_NONCES }), dir))).toBe("COUNT_MISMATCH");
    expect(readFileSync(p, "utf8")).toBe(before);
  });
  test("the CLI exits 10 (COUNT_MISMATCH) on a differing rerun", () => {
    const dir = tmp();
    const run = (f: string) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "freeze-counts.ts"), "--counts", f, "--counts-dir", dir], { stdout: "pipe", stderr: "pipe" });
    expect(run(counts()).exitCode).toBe(0);
    const other = { ...COUNTS, vault: 19 };
    expect(run(counts({ counts: other, deployerNonce: sumCounts(other) + PROOF_TX_NONCES })).exitCode).toBe(10);
  });
  test("a counts.json from a rehearsal that did not conclude success, or that records no conclusion, is refused and writes nothing", () => {
    const dir = tmp();
    for (const rehearsal of [{ conclusion: "failure" }, { conclusion: "cancelled" }, {}, undefined]) {
      expect(kind(() => freezeCounts(counts({ rehearsal }), dir))).toBe("USAGE");
    }
    expect(existsSync(frozenPath(dir, SHA))).toBe(false);
  });
  test("a counts.json whose nonce is not the summed counts, or from chain 8453, or with a bad sha, is refused", () => {
    const dir = tmp();
    expect(kind(() => freezeCounts(counts({ deployerNonce: 1 }), dir))).toBe("USAGE");
    expect(kind(() => freezeCounts(counts({ chainId: 8453 }), dir))).toBe("USAGE");
    expect(kind(() => freezeCounts(counts({ deploySha: "../x" }), dir))).toBe("USAGE");
  });
});
