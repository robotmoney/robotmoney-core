import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublishError } from "../src/errors.ts";
import { assertSha, checkNonce, countFor, frozenPath, loadFrozen, resolveCounts, sumCounts, writeFrozen } from "../src/counts.ts";
import { COUNTS, SHA, SHA2, tmp, writeCounts } from "./fixtures.ts";

const kind = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return (e as PublishError).kind; } return undefined; };

describe("frozen counts keyed by DEPLOY_SHA", () => {
  test("the nonce check passes when it equals the summed frozen counts", () => {
    const sum = sumCounts(COUNTS);
    expect(sum).toBe(1 + 4 + 18 + 2 + 3 + 3 + 2 + 5 + 6 + 6 + 6 + 25);
    expect(kind(() => checkNonce(sum, COUNTS))).toBeUndefined();
  });
  test("the nonce check fails on a mismatch, in either direction", () => {
    const sum = sumCounts(COUNTS);
    expect(kind(() => checkNonce(sum - 1, COUNTS))).toBe("NONCE");
    expect(kind(() => checkNonce(sum + 1, COUNTS))).toBe("NONCE");
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
