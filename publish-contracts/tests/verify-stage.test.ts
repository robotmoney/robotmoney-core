import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublishError } from "../src/errors.ts";
import { publishLogger } from "../src/log.ts";
import { newManifest, type RunContext } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { stageByName } from "../src/stages.ts";
import { handoverBlock, loadExpectedAssets, mainnetGovernMode, runVerifyStage } from "../src/verify-stage.ts";
import { ADMIN, world } from "./harness.ts";
import { COUNTS, SHA, sheetText, tmp } from "./fixtures.ts";

import { getStageTable } from "../src/stages.ts";
import { manifestBase } from "../src/stage-table.ts";
import { CONFIG_ASSET, MANIFEST_ADAPTER, writeCoreAssetConfig } from "./fixtures.ts";

/** One distinct address per vault, so a test can say which vault reads paused. */
const vaultAddr = (key: string): `0x${string}` => `0x00000000000000000000000000000000000000c${["USDC", "PROTO", "RWA", "HARD"].indexOf(key) + 1}`;
/** rmUSDC's three strategy adapters in the vault stage manifest (issue 1705 C4). */
const STRATEGY_ADAPTERS = { aave_adapter: "0x00000000000000000000000000000000000000e1", compound_adapter: "0x00000000000000000000000000000000000000e2", moonwell_flagship_adapter: "0x00000000000000000000000000000000000000e3" };

/** A core checkout fixture: the real-shaped config files, the vault manifests with the adapter each run deploys, and the Safe manifest. */
function setup(config: { proto?: object[]; rwa?: object[]; shortlist?: object[] } | null = {}, o: { adapters?: boolean; chain?: number } = {}) {
  const chain = o.chain ?? 918453;
  const coreDir = tmp("pc-verify-");
  const m = join(coreDir, "deployments", String(chain));
  mkdirSync(m, { recursive: true });
  writeFileSync(join(m, "safe.json"), JSON.stringify({ safe: "0x00000000000000000000000000000000000050fe" }));
  if (o.adapters !== false) {
    for (const v of getStageTable().vaults) writeFileSync(join(m, `${manifestBase(v.manifest)}.json`), JSON.stringify({ chain_id: chain, vault: vaultAddr(v.key), ...(v.key !== "USDC" ? { adapter: MANIFEST_ADAPTER } : STRATEGY_ADAPTERS) }));
  }
  if (config) writeCoreAssetConfig(coreDir, config);
  const sheet = parseSheet(sheetText());
  const lines: string[] = [];
  const ctx = { coreDir, chainId: chain, sheet, coreSha: SHA, rpc: "http://x", evidenceDir: join(coreDir, "evidence"), frozen: COUNTS, measure: false, log: publishLogger((l) => lines.push(l)) } as unknown as RunContext;
  return { ctx, sheet, lines };
}

describe("stage 12: the agent scan ends at the handover block (core 1527)", () => {
  test("handoverBlock is the last block of the timelock stage, and undefined until that stage has run", () => {
    const { ctx } = setup();
    const m = newManifest(ctx, "0x00000000000000000000000000000000000000a1");
    expect(handoverBlock(m)).toBeUndefined();
    m.stages.timelock = { status: "done", startedAt: "t", firstBlock: 40, lastBlock: 44 } as never;
    expect(handoverBlock(m)).toBe(44n);
  });
});

describe("stage 12: the one verifier", () => {

  test("a missing asset config is an error, not a silent skip", () => {
    const { ctx } = setup(null);
    expect(() => loadExpectedAssets(ctx, "PROTO")).toThrow(PublishError);
    const { ctx: c3 } = setup({ proto: [] });
    expect(() => loadExpectedAssets(c3, "PROTO")).toThrow("must list its assets");
  });

  test("the expected adapter comes from the vault manifest, because the adapter is deployed per run", () => {
    const { ctx } = setup();
    expect(loadExpectedAssets(ctx, "RWA")[0]!.adapter).toBe(MANIFEST_ADAPTER);
    const { ctx: none } = setup({}, { adapters: false });
    expect(() => loadExpectedAssets(none, "PROTO")).toThrow(/manifest .* is missing|has no adapter/);
  });

  test("rmUSDC holds no basket assets", () => {
    const { ctx } = setup({}, { adapters: false });
    expect(loadExpectedAssets(ctx, "USDC")).toEqual([]);
  });

  test("a V4 asset in a basket's config is refused: the three-vault deployment has no V4 venue (ADR-0017)", () => {
    const { ctx } = setup({ proto: [{ ...CONFIG_ASSET, venue: "UniswapV4" }] }, {});
    expect(() => loadExpectedAssets(ctx, "PROTO")).toThrow(/venue 'UniswapV4' is not one of/);
  });

  test("without a first deploy block the role scan cannot run: stop", async () => {
    const { ctx } = setup();
    await expect(runVerifyStage(ctx, stageByName("verify"), newManifest(ctx, "0xa"), { verifyDeployment: async () => ({ ok: true, checks: [] }), verifySources: async () => ({ ok: true, checks: [] }) } as never)).rejects.toMatchObject({ kind: "INPUT_MISSING" });
  });
});

describe("stage 12 on 8453: verify runs before govern and after it, and refuses while govern is part-way (issue 1667)", () => {
  const exec = { scheduled: { at: "t", tx_hash: "0x1" }, executed: { at: "t", tx_hash: "0x2" } };
  const sched = { scheduled: { at: "t", tx_hash: "0x1" } };
  const ALL_EXEC = { "unpause-USDC": exec, "unpause-PROTO": exec, "unpause-RWA": exec, "unpause-HARD": exec };
  /** depositsPaused per vault: all four vaults paused (the launch state, core 1710) unless a test says otherwise. */
  const launch = (over: Partial<Record<string, boolean>> = {}): Record<string, boolean> => ({ USDC: true, PROTO: true, RWA: true, HARD: true, ...over } as Record<string, boolean>);
  async function run(govern: Record<string, unknown>, paused: Record<string, boolean>) {
    const { ctx, lines } = setup({}, { chain: 8453 });
    const mctx = { ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext;
    const manifest = { ...newManifest(mctx, "0xa"), firstBlock: 5, govern };
    const byAddr = Object.fromEntries(Object.entries(paused).map(([k, v]) => [vaultAddr(k).toLowerCase(), v]));
    const calls = { verifier: 0, sources: 0 };
    let seen: any;
    const deps = {
      verifyDeployment: async (o: any) => { calls.verifier++; seen = o; return { ok: true, checks: [{ label: "x", ok: true, detail: "" }] }; },
      verifySources: async () => { calls.sources++; return { ok: true, checks: [] }; }, emit: () => {},
      depositsPaused: async (_rpc: string, vault: string) => byAddr[vault.toLowerCase()]!,
      recorderSpawn: (() => ({ status: 0, stdout: "", stderr: "" })) as never,
    };
    let err: any;
    try { await runVerifyStage(mctx, stageByName("verify"), manifest as never, deps as never); } catch (e) { err = e; }
    return { err, seen, manifest, calls, lines };
  }

  test("part-way: some but not all unpause rows scheduled or executed is refused with GOVERN_PENDING, naming the govern command, and the verifier never runs", async () => {
    for (const govern of [{ "unpause-PROTO": exec }, { "unpause-PROTO": sched }, { "unpause-USDC": sched }, { "unpause-USDC": exec }, { "unpause-USDC": exec, "unpause-PROTO": exec, "unpause-AGENT": exec, "unpause-RWA": sched }, { "unpause-USDC": sched, "unpause-PROTO": sched, "unpause-AGENT": sched, "unpause-RWA": sched }]) {
      const { err, calls, manifest } = await run(govern, launch());
      expect(err).toMatchObject({ kind: "GOVERN_PENDING" });
      expect(err.exitCode).toBe(15);
      expect(err.message).toContain("govern is part-way");
      expect(err.message).toContain("bun publish-contracts/src/cli.ts govern --chain 8453");
      expect(err.message).toContain("Nothing was paused");
      expect(calls).toEqual({ verifier: 0, sources: 0 });
      expect((manifest as any).stages.verify).toBeUndefined();
    }
  });
  test("mainnetGovernMode: the manifest picks the mode, the current round of each row decides", () => {
    expect(mainnetGovernMode({ govern: undefined }).mode).toBe("pre-govern");
    expect(mainnetGovernMode({ govern: ALL_EXEC }).mode).toBe("post-govern");
    expect(mainnetGovernMode({ govern: { "unpause-RWA": sched } }).mode).toBe("part-way");
    // rmUSDC is one of the four rows now (core 1710): alone it is part-way, in either phase
    expect(mainnetGovernMode({ govern: { "unpause-USDC": sched } }).mode).toBe("part-way");
    expect(mainnetGovernMode({ govern: { "unpause-USDC": exec } }).mode).toBe("part-way");
    expect(mainnetGovernMode({ govern: { "unpause-PROTO": exec, "unpause-RWA": exec, "unpause-HARD": exec } }).mode).toBe("part-way");
    // a round 2 opened for one basket after pause-all (its record is fresh, round 1 is archived) leaves the others executed: part-way until it executes
    expect(mainnetGovernMode({ govern: { ...ALL_EXEC, "unpause-PROTO": { round: 2, ...sched }, "unpause-PROTO:round-1": exec } }).mode).toBe("part-way");
    expect(mainnetGovernMode({ govern: { ...ALL_EXEC, "unpause-PROTO": { round: 2, ...exec }, "unpause-PROTO:round-1": exec } }).mode).toBe("post-govern");
  });
});

describe("the CLI on 8453: a part-way govern run pauses nothing, a failed verify still pauses all four (issue 1667)", () => {
  const exec = { scheduled: { at: "t", tx_hash: "0x1" }, executed: { at: "t", tx_hash: "0x2" } };
  function seed(govern: Record<string, unknown>) {
    const w = world({ chainId: 8453, writeSafeManifest: true, writeFrozen: true });
    const m = join(w.coreDir, "deployments", "8453");
    for (const v of getStageTable().vaults) writeFileSync(join(m, `${manifestBase(v.manifest)}.json`), JSON.stringify({ chain_id: 8453, vault: vaultAddr(v.key), adapter: MANIFEST_ADAPTER, ...(v.key === "USDC" ? STRATEGY_ADAPTERS : {}) }));
    mkdirSync(w.evidence, { recursive: true });
    writeFileSync(join(w.evidence, "publish-run.json"), JSON.stringify({ version: 1, chainId: 8453, coreSha: SHA, deployer: ADMIN, environment: "local", startedAt: "t", firstBlock: 7, stages: { safe: { status: "done", startedAt: "t" }, "prove-control": { status: "done", startedAt: "t" }, timelock: { status: "done", startedAt: "t" } }, govern }));
    return w;
  }
  const spy = () => { const calls: string[] = []; return { calls, pauseAll: (async (_c: unknown, _m: unknown, o: { trigger: string }) => { calls.push(o.trigger); return { allPaused: true, vaults: [] }; }) as never }; };
  const verifier = (ok: boolean, calls: { n: number }) => ({ verifyDeployment: (async () => { calls.n++; return { ok, checks: [{ label: "forced", ok, detail: "x" }] }; }) as never, verifySources: (async () => ({ ok: true, checks: [] })) as never, depositsPaused: async () => true });

  test("part-way: exit 15 (GOVERN_PENDING), the verifier did not run, pauseAll was never called", async () => {
    const w = seed({ "unpause-PROTO": exec });
    const p = spy(), v = { n: 0 };
    const code = await w.run(["verify"], { pauseAll: p.pauseAll, verify: verifier(true, v) });
    expect(code).toBe(15);
    expect(v.n).toBe(0);
    expect(p.calls).toEqual([]);
    expect(w.logs().filter((l) => l.event === "run.failed").pop().message).toContain("govern is part-way");
  });

});

// Issue 1927: runbook 4.15 clears the applied receipt vector (govern --row clear-voted-weights) before the retire, so verify must not expect it on the router any more.
describe("the applied receipt after a clear-voted-weights round (issue 1927)", () => {
  test("an executed clear after the last application leaves no applied receipt; a clear before it, a tie, or an unexecuted clear keeps it", async () => {
    const { appliedReceiptOf } = await import("../src/verify-stage.ts");
    const app = { receipt_id: `0x${"11".repeat(32)}`, vaults: [`0x${"22".repeat(20)}`], bps: [10000], execute_block_timestamp: 1000 };
    const clear = (at: number, o: object = {}) => ({ execute_status: 1, voted_weights_active: false, execute_block_timestamp: at, ...o });
    expect(appliedReceiptOf({ receipt_applications: [app] })).toMatchObject({ receiptId: app.receipt_id });
    expect(appliedReceiptOf({ receipt_applications: [app], voted_weights_clears: [clear(1001)] })).toBeUndefined();
    expect(appliedReceiptOf({ receipt_applications: [app], voted_weights_clears: [clear(999)] })).toMatchObject({ receiptId: app.receipt_id });
    expect(appliedReceiptOf({ receipt_applications: [app], voted_weights_clears: [clear(1000)] })).toMatchObject({ receiptId: app.receipt_id });
    expect(appliedReceiptOf({ receipt_applications: [app], voted_weights_clears: [clear(1001, { execute_status: 0 })] })).toMatchObject({ receiptId: app.receipt_id });
    expect(appliedReceiptOf({ receipt_applications: [app], voted_weights_clears: [clear(1001, { voted_weights_active: true })] })).toMatchObject({ receiptId: app.receipt_id });
  });

});
