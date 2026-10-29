import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PublishError } from "../src/errors.ts";
import { PROOF_TX_NONCES, assertSha, checkNonce, countFor, effectiveCounts, finalDeployerNonce, frozenPath, loadFrozen, loadFrozenFile, resolveCounts, stageTableAtSha, sumCounts, writeFrozen } from "../src/counts.ts";
import { LIBRARY_MOVE_STAGES, crossCheckDiff, libraryMoveCounts } from "../src/counts-reconstruct.ts";
import { getStageTable } from "../src/stages.ts";
import { freezeCounts } from "../scripts/freeze-counts.ts";
import { COUNTS, REPO, SHA, SHA2, tmp, writeCounts } from "./fixtures.ts";

const kind = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return (e as PublishError).kind; } return undefined; };

describe("frozen counts keyed by DEPLOY_SHA", () => {
  test("the nonce check passes when it equals the summed frozen counts", () => {
    const sum = sumCounts(COUNTS);
    expect(sum).toBe(1 + 4 + 18 + 2 + 3 + 2 + 2 + 6 + 6 + 25);
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

describe("the one-time library address move: baseline and 8453 effective counts with no adoption (issue 1926)", () => {
  // The source the runbook copies (upgrade-runbook-drift.test.ts asserts the runbook text equals these numbers).
  const DEPLOY3 = "57fbe61833e9d7f94557d69102138f7c410c1346";
  const anchor = loadFrozenFile(join(REPO, "deployments", "frozen-counts", `${DEPLOY3}.json`), DEPLOY3);
  const m = libraryMoveCounts(getStageTable(), { sha: DEPLOY3, counts: anchor.counts });
  test("libs, vault, proto and rwa: the baseline is the Deploy 3 frozen count, the Twin run adopts each stage's first creations, 8453 adopts nothing", () => {
    expect(m.stages).toEqual({
      libs: { baseline: 1, creations: 1, twinMeasured: 0, mainnet: 1 }, // TickMath
      vault: { baseline: 19, creations: 2, twinMeasured: 17, mainnet: 19 }, // GovernedUpgrade, RobotMoneyVaultOps
      proto: { baseline: 12, creations: 4, twinMeasured: 8, mainnet: 12 }, // BasketAssetConfigGuard, TwapTickMath, BasketViews, BasketSwaps
      rwa: { baseline: 9, creations: 0, twinMeasured: 9, mainnet: 9 }, // every library it links was created by an earlier stage
    });
  });
  test("with nothing adopted effectiveCounts is the baseline and the expected nonce is start + sum(baseline) + 1 proof", () => {
    const baseline = Object.fromEntries(LIBRARY_MOVE_STAGES.map((s) => [s, m.stages[s].baseline]));
    expect(effectiveCounts(baseline, {})).toEqual(baseline);
    expect(finalDeployerNonce(baseline, 7)).toBe(7 + 1 + 19 + 12 + 9 + PROOF_TX_NONCES);
    // the Twin run, which adopted, sent exactly the creations fewer
    const adopted = Object.fromEntries(LIBRARY_MOVE_STAGES.filter((s) => m.stages[s].creations > 0).map((s) => [s, m.stages[s].twinMeasured]));
    expect(effectiveCounts(baseline, adopted)).toEqual(Object.fromEntries(LIBRARY_MOVE_STAGES.map((s) => [s, m.stages[s].twinMeasured])));
  });
  test("a cross-check against the Deploy 3 file needs --accept-diff for the stages the table retired (agent, ic-policy, recorder) and the one it added (receipt); the gateway system's key is not compared", () => {
    expect(m.acceptDiff).toEqual(["agent", "ic-policy", "receipt", "recorder"]);
    // a new baseline equal to Deploy 3 at every stage the table still has differs from it at exactly those stages
    const keys = ["safe", ...getStageTable().stages.filter((s) => s.system !== "gateway").map((s) => s.name)];
    const same = Object.fromEntries(keys.map((k) => [k, anchor.counts[k] ?? 2]));
    expect(crossCheckDiff(same, anchor.counts).map((d) => d.stage)).toEqual(m.acceptDiff);
  });
});

describe("loadFrozen of a reconstructed baseline across a stage-table change (issue 1926)", () => {
  // A hand-made reconstruction (offline: loadFrozen re-verifies the block against the table, never the chain) anchored on a plain file that still has a retired stage.
  const ANCHOR = "d".repeat(40);
  function write(anchorCounts: Record<string, number>, accepted: unknown[]): string {
    const dir = tmp("pc-1926-load-");
    const anchorBytes = JSON.stringify({ deploySha: ANCHOR, measured: { chainId: 918453, at: "2026-10-01T00:00:00Z" }, counts: anchorCounts }, null, 2);
    writeFileSync(join(dir, `${ANCHOR}.json`), anchorBytes);
    const reconstructed = {
      fromRun: { sha: SHA, chainId: 918453 }, measuredCounts: { ...COUNTS, libs: COUNTS.libs! - 1 },
      adopted: [{ stage: "libs", library: "tick_math", artifact: "TickMath", address: `0x${"11".repeat(20)}`, codeHash: `0x${"22".repeat(32)}` }],
      crossCheck: { against: ANCHOR, accepted },
    };
    writeFileSync(join(dir, `${SHA}.json`), JSON.stringify({ deploySha: SHA, measured: { chainId: 918453, at: "2026-10-02T00:00:00Z", reconstructed, crossChecked: { sha: ANCHOR, fileHash: createHash("sha256").update(anchorBytes).digest("hex") } }, counts: COUNTS }, null, 2));
    return dir;
  }
  test("removed stage: the anchor has `agent`, the file accepts { agent, old 11, new null }: it loads", () => {
    expect(loadFrozen(write({ ...COUNTS, agent: 11 }, [{ stage: "agent", old: 11, new: null }]), SHA).counts).toEqual(COUNTS);
  });
  test("added stage: the anchor lacks `receipt`, the file accepts { receipt, old null, new N }: it loads", () => {
    const { receipt, ...rest } = COUNTS;
    expect(loadFrozen(write(rest, [{ stage: "receipt", old: null, new: receipt! }]), SHA).counts).toEqual(COUNTS);
  });
  test("a stage unknown to both the table and the anchor is COUNTS_MISSING, removed-shaped or not; a removed stage missing from the accepted list is too", () => {
    expect(kind(() => loadFrozen(write({ ...COUNTS, agent: 11 }, [{ stage: "agent", old: 11, new: null }, { stage: "nosuch", old: 3, new: null }]), SHA))).toBe("COUNTS_MISSING");
    expect(kind(() => loadFrozen(write({ ...COUNTS, agent: 11 }, [{ stage: "agent", old: 11, new: null }, { stage: "nosuch", old: 3, new: 4 }]), SHA))).toBe("COUNTS_MISSING");
    expect(kind(() => loadFrozen(write({ ...COUNTS, agent: 11 }, []), SHA))).toBe("COUNTS_MISSING");
  });
});

describe("a new baseline loads in the committed frozen-counts directory, whose older files name stages the table retired (issue 1926)", () => {
  // loadFrozen checks every OTHER file of the directory and the anchor chain. Those are earlier releases' files: each is verified against the stage table of
  // its own DEPLOY_SHA (git show <sha>:scripts/deploy/stage-table.json), so the reconstructed 72a87d90, 78c50cbd and f8c869e2 (agent, ic-policy, recorder) load.
  const DEPLOY3 = "57fbe61833e9d7f94557d69102138f7c410c1346";
  const real = join(REPO, "deployments", "frozen-counts");
  const files = readdirSync(real).filter((n) => /^[0-9a-f]{40}\.json$/.test(n));
  const reconstructed = files.filter((n) => JSON.parse(readFileSync(join(real, n), "utf8")).measured?.reconstructed !== undefined).map((n) => n.slice(0, 40));
  function plant(dir: string): void {
    for (const n of files) copyFileSync(join(real, n), join(dir, n));
    const anchorBytes = readFileSync(join(dir, `${DEPLOY3}.json`));
    const anchor = JSON.parse(anchorBytes.toString()).counts;
    const counts = baselineLike(anchor);
    const rec = {
      fromRun: { sha: SHA, chainId: 918453 }, measuredCounts: { ...counts, libs: counts.libs! - 1 },
      adopted: [{ stage: "libs", library: "tick_math", artifact: "TickMath", address: `0x${"11".repeat(20)}`, codeHash: `0x${"22".repeat(32)}` }],
      crossCheck: { against: DEPLOY3, accepted: crossCheckDiff(counts, anchor) },
    };
    writeFileSync(join(dir, `${SHA}.json`), JSON.stringify({ deploySha: SHA, measured: { chainId: 918453, at: "2026-10-29T00:00:00Z", reconstructed: rec, crossChecked: { sha: DEPLOY3, fileHash: createHash("sha256").update(anchorBytes).digest("hex") } }, counts }, null, 2));
  }
  /** Deploy 3's count at every stage the table still has (the fixture count for the added receipt stage). */
  const baselineLike = (anchor: Record<string, number>): Record<string, number> => Object.fromEntries(Object.keys(COUNTS).map((k) => [k, anchor[k] ?? COUNTS[k]!]));
  test("the committed directory holds reconstructed files whose own stage tables are in this repository's history", () => {
    expect(reconstructed.length).toBeGreaterThan(0);
    for (const s of reconstructed) expect(stageTableAtSha(real, s)).toBeDefined(); // fails (never skips) on a checkout without history: publish-contracts-tests fetches it
  });
  test("a baseline anchored on Deploy 3, accepting agent, ic-policy, receipt and recorder, loads next to every committed file", () => {
    // a directory inside the repository, so git resolves each file's own sha; node_modules is ignored by git
    const dir = mkdtempSync(join(import.meta.dir, "..", "node_modules", ".frozen-1926-"));
    try {
      plant(dir);
      const f = loadFrozen(dir, SHA);
      expect(f.counts).toEqual(baselineLike(JSON.parse(readFileSync(join(real, `${DEPLOY3}.json`), "utf8")).counts));
      expect(f.measured.reconstructed!.crossCheck!.accepted.map((d) => d.stage)).toEqual(["agent", "ic-policy", "receipt", "recorder"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("without git history (a copy outside the repository) the older files are verified against today's table, as before: COUNTS_MISSING", () => {
    const dir = tmp("pc-1926-nohistory-");
    plant(dir);
    for (const s of reconstructed) expect(stageTableAtSha(dir, s)).toBeUndefined();
    expect(kind(() => loadFrozen(dir, SHA))).toBe("COUNTS_MISSING");
  });
});
