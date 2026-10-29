import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { RPC_REFUSED_DETAIL, verifyDeployment } from "../src/verify/index.ts";
import { TIMELOCK, WORLD_CREATE2_FACTORY, adoptTimelock, deployedWorld } from "./verify/world.ts";
import { publishLogger } from "../src/log.ts";
import { newManifest, type RunContext } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { manifestRef, receiptRef, stageByName, useStageTable } from "../src/stages.ts";
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters } from "viem";
import { applyCalldata } from "../src/evidence-check.ts";
import { buildVerifySheet, handoverBlock, loadExpectedAssets, mainnetGovernMode, runVerifyStage } from "../src/verify-stage.ts";
import { ADMIN, world } from "./harness.ts";
import { COUNTS, SHA, sheetText, tmp } from "./fixtures.ts";

import { getStageTable } from "../src/stages.ts";
import { manifestBase, parseStageTable } from "../src/stage-table.ts";
import { CONFIG_ASSET, MANIFEST_ADAPTER, writeCoreAssetConfig } from "./fixtures.ts";

/** One distinct address per vault, so a test can say which vault reads paused. */
const vaultAddr = (key: string): `0x${string}` => `0x00000000000000000000000000000000000000c${["USDC", "PROTO", "RWA"].indexOf(key) + 1}`;
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
  test("the verifier sheet covers all three vaults, with all three vaults paused (rmUSDC deploys paused too, core 1710) and the seed on rmUSDC only", () => {
    const { ctx, sheet } = setup();
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe");
    expect(Object.keys(v.vaults)).toEqual(["rmUSDC", "rmPROTO", "rmRWA"]);
    for (const k of ["rmUSDC", "rmPROTO", "rmRWA"]) expect(v.vaults[k]!.expectPaused).toBe(true);
    expect(v.vaults.rmUSDC!.seed).toBe(1000000n);
    expect(v.vaults.rmAGENT).toBeUndefined();
    expect(v.vaults.rmPROTO!.assets).toEqual([{ token: CONFIG_ASSET.token, pool: CONFIG_ASSET.pool, swapFee: 500, adapter: MANIFEST_ADAPTER, venue: 0 }]);
    expect(v.vaults.rmUSDC!.seedShareReceiver).toBe(sheet.shareReceiver);
    expect(v.vaults.rmPROTO!.feeRecipient).toBe("0x00000000000000000000000000000000000050fe"); // @safe resolves to the created Safe
    expect(v.timelockDelay).toBe(60);
  });

  test("the verifier sheet carries the NAV deviation guard and the pool liquidity floor of every basket, and none for rmUSDC (issue 1666)", () => {
    const { ctx, sheet } = setup();
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe");
    for (const [k, key] of [["rmPROTO", "PROTO"], ["rmRWA", "RWA"]] as const) {
      expect(v.vaults[k]!.navDeviationBps).toBe(sheet.vaults[key].navDeviationBps!);
      expect(v.vaults[k]!.minPoolLiquidity).toBe(sheet.vaults[key].minPoolLiquidity!);
      expect(v.vaults[k]!.navDeviationBps!).toBeGreaterThan(0n);
    }
    expect(v.vaults.rmUSDC!.navDeviationBps).toBeUndefined();
    expect(v.vaults.rmUSDC!.minPoolLiquidity).toBeUndefined();
  });

  test("the verifier sheet carries every deploy-time value of the sheet: eligibility and the router default weights, and no voting value (issue 1520, issue 1698)", () => {
    const { ctx } = setup();
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe");
    expect(v).not.toHaveProperty("governance");
    // the example sheet makes PROTO and RWA eligible: rmUSDC always is
    expect(Object.fromEntries(Object.entries(v.vaults).map(([k, x]) => [k, x.routerEligible]))).toEqual({ rmUSDC: true, rmPROTO: true, rmRWA: true });
    expect(v.defaultWeights).toEqual([{ vault: "rmUSDC", bps: 9500 }, { vault: "rmPROTO", bps: 500 }, { vault: "rmRWA", bps: 0 }]);
  });

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

  test("a failing check fails the stage with the VERIFY exit class", async () => {
    const { ctx } = setup();
    const manifest = { ...newManifest(ctx, "0xa"), firstBlock: 5 };
    const deps = { verifyDeployment: async () => ({ ok: false, checks: [{ label: "deployer holds no role", ok: false, detail: "x" }, { label: "seed", ok: true, detail: "" }] }), verifySources: async () => ({ ok: true, checks: [] }) };
    await expect(runVerifyStage({ ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext, stageByName("verify"), manifest, deps as never)).rejects.toMatchObject({ kind: "VERIFY" });
  });

  test("an adopted libs stage (issue 1721) reaches the verifier at the transactions the deployer sent: the nonce check expects the sum minus the libs count", async () => {
    const { ctx } = setup();
    const manifest = { ...newManifest(ctx, "0xa"), firstBlock: 5 };
    manifest.stages.libs = { status: "done", adopted: true, adoption: { deployerTxs: 0, factory: "0x4e59b44847b379578588920cA78FbF26c0B4956C", libraries: [] }, startedAt: "t" } as never;
    let seen: any;
    const deps = { verifyDeployment: async (o: any) => { seen = o; return { ok: true, checks: [{ label: "x", ok: true, detail: "" }] }; }, verifySources: async () => { throw new Error("no explorer on the Twin chain"); } };
    await runVerifyStage({ ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext, stageByName("verify"), manifest, deps as never);
    expect(seen.frozenCounts).toEqual({ ...COUNTS, libs: 0 });
  });

  test("a passing run records the stage and passes the frozen counts and the first block to the verifier", async () => {
    const { ctx } = setup();
    const manifest = { ...newManifest(ctx, "0xa"), firstBlock: 5 };
    let seen: any;
    const deps = { verifyDeployment: async (o: any) => { seen = o; return { ok: true, checks: [{ label: "x", ok: true, detail: "" }] }; }, verifySources: async () => { throw new Error("no explorer on the Twin chain"); } };
    await runVerifyStage({ ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext, stageByName("verify"), manifest, deps as never);
    expect(seen.frozenCounts).toEqual(COUNTS);
    expect(seen.fromBlock).toBe(5n);
    expect(manifest.stages.verify!.status).toBe("done");
  });

  test("the verifier is handed the last receipt the Safe applied, from the run manifest receipt_applications (issue 1696)", async () => {
    const { ctx } = setup();
    const entry = (id: string, bps: number[]) => ({ receipt_id: id, vaults: ["0x00000000000000000000000000000000000000c1", "0x00000000000000000000000000000000000000c2"], bps });
    const manifest = { ...newManifest(ctx, "0xa"), firstBlock: 5, receipt_applications: [entry("0x" + "01".repeat(32), [1000, 9000]), { bogus: true }, entry("0x" + "02".repeat(32), [4000, 6000])] };
    let seen: any;
    const deps = { verifyDeployment: async (o: any) => { seen = o; return { ok: true, checks: [{ label: "x", ok: true, detail: "" }] }; }, verifySources: async () => { throw new Error("no explorer"); } };
    await runVerifyStage({ ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext, stageByName("verify"), manifest, deps as never);
    expect(seen.appliedReceipt).toEqual({ receiptId: "0x" + "02".repeat(32), vaults: ["0x00000000000000000000000000000000000000c1", "0x00000000000000000000000000000000000000c2"], bps: [4000, 6000] });
    // no application: nothing is handed over
    const none = { ...newManifest(ctx, "0xa"), firstBlock: 5 };
    await runVerifyStage({ ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext, stageByName("verify"), none, deps as never);
    expect(seen.appliedReceipt).toBeUndefined();
  });

  test("without a first deploy block the role scan cannot run: stop", async () => {
    const { ctx } = setup();
    await expect(runVerifyStage(ctx, stageByName("verify"), newManifest(ctx, "0xa"), { verifyDeployment: async () => ({ ok: true, checks: [] }), verifySources: async () => ({ ok: true, checks: [] }) } as never)).rejects.toMatchObject({ kind: "INPUT_MISSING" });
  });
});

import { expectedTimelockDelay, unpausedByGovern } from "../src/verify-stage.ts";

describe("stage 12 after govern: the unpause rows are linked to the paused reads", () => {
  test("before the govern execute row, every basket vault is expected paused", () => {
    const { ctx, sheet } = setup();
    const m = newManifest(ctx, "0xa");
    expect(unpausedByGovern(m, sheet)).toEqual([]);
    m.govern = { "unpause-PROTO": { scheduled: { at: "t", tx_hash: "0x1" } } };
    expect(unpausedByGovern(m, sheet)).toEqual([]);
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe", unpausedByGovern(m, sheet));
    for (const k of ["rmUSDC", "rmPROTO", "rmRWA"]) expect(v.vaults[k]!.expectPaused).toBe(true);
  });

  test("once an unpause row's executed phase is recorded, that vault (and no other) is expected paused=false", () => {
    const { ctx, sheet } = setup();
    const m = newManifest(ctx, "0xa");
    m.govern = Object.fromEntries(sheet.govern.unpauseVaults.map((k) => [`unpause-${k}`, { scheduled: { at: "t", tx_hash: "0x1" }, executed: { at: "t", tx_hash: "0x2" } }]));
    const unpaused = unpausedByGovern(m, sheet);
    expect(unpaused).toEqual(sheet.govern.unpauseVaults);
    expect(unpaused.length).toBeGreaterThan(0);
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe", unpaused);
    for (const [k, name] of [["USDC", "rmUSDC"], ["PROTO", "rmPROTO"], ["RWA", "rmRWA"]] as const) expect(v.vaults[name]!.expectPaused).toBe(!unpaused.includes(k));
  });

  test("the expected timelock delay is TIMELOCK_MIN_DELAY until the update-delay row executes, then GOVERN_NEW_DELAY (verify after govern failed on 60 vs 3600)", () => {
    const { ctx, sheet } = setup();
    const m = newManifest(ctx, "0xa");
    expect(expectedTimelockDelay(m, sheet)).toBe(Number(sheet.timelockMinDelay));
    m.govern = { "update-delay": { scheduled: { at: "t", tx_hash: "0x3" } } };
    expect(expectedTimelockDelay(m, sheet)).toBe(Number(sheet.timelockMinDelay));
    m.govern = { "update-delay": { scheduled: { at: "t", tx_hash: "0x3" }, executed: { at: "t", tx_hash: "0x4" } } };
    expect(expectedTimelockDelay(m, sheet)).toBe(Number(sheet.govern.newDelay));
    expect(buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe", [], expectedTimelockDelay(m, sheet)).timelockDelay).toBe(Number(sheet.govern.newDelay));
  });

  test("runVerifyStage hands the verifier the post-govern expectation", async () => {
    const { ctx, sheet } = setup();
    const manifest = { ...newManifest(ctx, "0xa"), firstBlock: 5, govern: Object.fromEntries(sheet.govern.unpauseVaults.map((k) => [`unpause-${k}`, { executed: { at: "t", tx_hash: "0x2" } }])) };
    let seen: any;
    const deps = { verifyDeployment: async (o: any) => { seen = o; return { ok: true, checks: [] }; }, verifySources: async () => ({ ok: true, checks: [] }), emit: () => {} };
    await runVerifyStage({ ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext, stageByName("verify"), manifest as never, deps as never);
    expect(seen.sheet.vaults.rmPROTO.expectPaused).toBe(!sheet.govern.unpauseVaults.includes("PROTO"));
  });

  test("stdout carries the verifier labels, one per line under [verify]", async () => {
    const { ctx } = setup();
    const manifest = { ...newManifest(ctx, "0xa"), firstBlock: 5 };
    const out: string[] = [];
    const deps = { verifyDeployment: async () => ({ ok: true, checks: [{ label: "chain: id equals sheet", ok: true, detail: "" }, { label: "manifest: vault.json present", ok: true, detail: "" }] }), verifySources: async () => ({ ok: true, checks: [] }), emit: (l: string) => out.push(l) };
    await runVerifyStage({ ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext, stageByName("verify"), manifest as never, deps as never);
    expect(out).toEqual(["[verify]", "chain: id equals sheet", "manifest: vault.json present"]);
  });

  // QA plan v1 C3 (CS-6): the run records the current weight setter's gating in the verify stage record and on the log (stderr), never on stdout.
  test("the stage record and the log carry the weight setter's gating, also when the gate is wrong and verify fails", async () => {
    const TL = "0x000000000000000000000000000000000071e10c", GOVERNANCE = "0x000000000000000000000000000000000000060b", SAFE_ADDR = "0x00000000000000000000000000000000000050fe";
    const gated = { gating: "timelock", holders: [{ address: GOVERNANCE, routerGovernanceCode: true, admins: [TL], setters: [TL], timelockGated: true }], timelock: TL, delaySeconds: 60 };
    const open = { ...gated, gating: "not-timelock", holders: [{ address: GOVERNANCE, routerGovernanceCode: true, admins: [TL, SAFE_ADDR], setters: [TL], timelockGated: false }] };
    const label = "router: every WEIGHT_SETTER_ROLE holder is timelock-gated";
    for (const [weightSetter, ok] of [[gated, true], [open, false]] as const) {
      const { ctx, lines } = setup();
      const manifest = { ...newManifest(ctx, "0xa"), firstBlock: 5 };
      const out: string[] = [];
      const deps = { verifyDeployment: async () => ({ ok, checks: [{ label, ok, detail: "" }], weightSetter }), verifySources: async () => ({ ok: true, checks: [] }), emit: (l: string) => out.push(l) };
      const run = runVerifyStage({ ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext, stageByName("verify"), manifest as never, deps as never);
      if (ok) await run; else await expect(run).rejects.toMatchObject({ kind: "VERIFY" });
      expect(manifest.stages[stageByName("verify").name]).toMatchObject({ status: ok ? "done" : "started", weightSetterGating: weightSetter });
      const logged = lines.map((l) => JSON.parse(l)).find((j) => j.event === "verify.weight_setter_gating");
      expect(logged).toMatchObject({ level: ok ? "info" : "error", gating: weightSetter.gating, holders: weightSetter.holders, timelock: TL, delay_seconds: 60 });
      expect(out).toEqual(["[verify]", label]);
    }
  });
});

describe("stage 12 on 8453: verify runs before govern and after it, and refuses while govern is part-way (issue 1667)", () => {
  const exec = { scheduled: { at: "t", tx_hash: "0x1" }, executed: { at: "t", tx_hash: "0x2" } };
  const sched = { scheduled: { at: "t", tx_hash: "0x1" } };
  const ALL_EXEC = { "unpause-USDC": exec, "unpause-PROTO": exec, "unpause-RWA": exec };
  /** depositsPaused per vault: all three vaults paused (the launch state, core 1710) unless a test says otherwise. */
  const launch = (over: Partial<Record<string, boolean>> = {}): Record<string, boolean> => ({ USDC: true, PROTO: true, RWA: true, ...over } as Record<string, boolean>);
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

  test("pre-govern: no unpause row scheduled passes when all three vaults read paused", async () => {
    const { err, seen, manifest } = await run({}, launch());
    expect(err).toBeUndefined();
    expect((manifest as any).stages.verify.status).toBe("done");
    for (const k of ["rmUSDC", "rmPROTO", "rmRWA"]) expect(seen.sheet.vaults[k].expectPaused).toBe(true);
  });
  test("pre-govern fails closed when the chain disagrees with the manifest: any one vault already open (rmUSDC included)", async () => {
    const live = await run({}, launch({ PROTO: false }));
    expect(live.err).toMatchObject({ kind: "VERIFY" });
    expect(live.err.message).toContain("govern pre-govern: rmPROTO depositsPaused is true");
    const usdcOpen = await run({}, launch({ USDC: false }));
    expect(usdcOpen.err).toMatchObject({ kind: "VERIFY" });
    expect(usdcOpen.err.message).toContain("govern pre-govern: rmUSDC depositsPaused is true");
  });
  test("a chain read that fails is a failed check, not a pass", async () => {
    const { ctx } = setup({}, { chain: 8453 });
    const mctx = { ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext;
    const deps = { verifyDeployment: async () => ({ ok: true, checks: [] }), verifySources: async () => ({ ok: true, checks: [] }), emit: () => {}, depositsPaused: async () => { throw new Error("rpc down"); } };
    await expect(runVerifyStage(mctx, stageByName("verify"), { ...newManifest(mctx, "0xa"), firstBlock: 5 } as never, deps as never)).rejects.toMatchObject({ kind: "VERIFY" });
  });

  test("post-govern: all three unpause rows executed passes only when all three vaults read open", async () => {
    const ok = await run(ALL_EXEC, launch({ USDC: false, PROTO: false, RWA: false }));
    expect(ok.err).toBeUndefined();
    for (const k of ["rmPROTO", "rmRWA", "rmUSDC"]) expect(ok.seen.sheet.vaults[k].expectPaused).toBe(false);
    for (const k of ["PROTO", "RWA", "USDC"]) {
      const bad = await run(ALL_EXEC, launch({ USDC: false, PROTO: false, RWA: false, [k]: true }));
      expect(bad.err).toMatchObject({ kind: "VERIFY" });
      expect(bad.err.message).toContain(`govern post-govern: ${{ USDC: "rmUSDC", PROTO: "rmPROTO", RWA: "rmRWA" }[k]} depositsPaused is false`);
    }
  });
  test("post-govern with a vault that pause-all paused again names the govern row that reopens it", async () => {
    const { err, lines } = await run(ALL_EXEC, launch({ PROTO: false, RWA: false, USDC: true }));
    expect(err.details.failed.join()).toContain("rmUSDC depositsPaused is false");
    expect(lines.join("\n")).toContain("govern --row unpause-USDC --chain 8453");
  });
  test("a manifest that claims post-govern while the vaults are still paused fails (a tampered or stale manifest)", async () => {
    const { err } = await run(ALL_EXEC, launch());
    expect(err).toMatchObject({ kind: "VERIFY" });
    expect(err.message).toContain("rmUSDC depositsPaused is false");
    expect(err.message).toContain("rmPROTO depositsPaused is false");
  });

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
    expect(mainnetGovernMode({ govern: { "unpause-PROTO": exec, "unpause-RWA": exec } }).mode).toBe("part-way");
    // a round 2 opened for one basket after pause-all (its record is fresh, round 1 is archived) leaves the others executed: part-way until it executes
    expect(mainnetGovernMode({ govern: { ...ALL_EXEC, "unpause-PROTO": { round: 2, ...sched }, "unpause-PROTO:round-1": exec } }).mode).toBe("part-way");
    expect(mainnetGovernMode({ govern: { ...ALL_EXEC, "unpause-PROTO": { round: 2, ...exec }, "unpause-PROTO:round-1": exec } }).mode).toBe("post-govern");
  });
});

describe("the CLI on 8453: a part-way govern run pauses nothing, a failed verify still pauses all three (issue 1667)", () => {
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
  test("a verify that fails on 8453 still calls pauseAll once with the verify trigger", async () => {
    const w = seed({});
    const p = spy(), v = { n: 0 };
    const code = await w.run(["verify"], { pauseAll: p.pauseAll, verify: verifier(false, v) });
    expect(code).toBe(13);
    expect(v.n).toBe(1);
    expect(p.calls).toEqual(["verify"]);
  });

  // Issue 1851: a verify whose only failures are reads the RPC refused (a pruned node cannot serve a receipt) found nothing wrong on chain: it fails RPC_REFUSED and pauses nothing.
  const failing = (checks: { label: string; ok: boolean; detail: string }[]) => ({ verifyDeployment: (async () => ({ ok: false, checks })) as never, verifySources: (async () => ({ ok: true, checks: [] })) as never, depositsPaused: async () => true });
  const refused = { label: "deployer: holds no role on any contract (log scan)", ok: false, detail: `${RPC_REFUSED_DETAIL}: the RPC refused eth_getTransactionReceipt for the deploy transaction 0xab: missing trie node` };
  test("a verify failure classified RPC_REFUSED: exit 30 (RPC_REFUSED), pauseAll is never called", async () => {
    const w = seed({});
    const p = spy();
    const code = await w.run(["verify"], { pauseAll: p.pauseAll, verify: failing([{ label: "chain: id equals sheet", ok: true, detail: "ok" }, refused]) });
    expect(code).toBe(EXIT_CODES.RPC_REFUSED);
    expect(p.calls).toEqual([]);
    const msg = w.logs().filter((l) => l.event === "run.failed").pop().message;
    expect(msg).toContain("No vault was paused");
    expect(msg).toContain("The deployment is NOT verified");
    expect(msg).toContain("do not proceed to govern");
  });
  test("the verifier is given every deploy transaction hash the run manifest recorded (the creation proof of the log scans)", async () => {
    const w = seed({});
    const path = join(w.evidence, "publish-run.json");
    const m = JSON.parse(readFileSync(path, "utf8"));
    const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    m.stages.safe.txHashes = [h(1)];
    m.stages.timelock.txHashes = [h(2), h(3), h(1)];
    writeFileSync(path, JSON.stringify(m));
    let seen: string[] | undefined;
    const verify = { verifyDeployment: (async (o: { deployTxs?: string[] }) => { seen = o.deployTxs; return { ok: true, checks: [] }; }) as never, verifySources: (async () => ({ ok: true, checks: [] })) as never, depositsPaused: async () => true };
    await w.run(["verify"], { pauseAll: spy().pauseAll, verify });
    expect(seen).toEqual([h(1), h(2), h(3)]);
  });
  // Issue 1835, 1851: the timelock stage adopted the core timelock, so no deploy transaction of the run created it. The run manifest's adoption record reaches the real
  // verifier (stubbed only for the chain it reads: the in-memory world), the receipt proof accepts the adopted timelock, verify passes and nothing is paused.
  test("an 8453 verify of a run whose timelock stage adopted the timelock: the adoption reaches the verifier, verify passes, pauseAll is never called", async () => {
    const w = seed({});
    const path = join(w.evidence, "publish-run.json");
    const m = JSON.parse(readFileSync(path, "utf8"));
    const world = adoptTimelock(deployedWorld(), 105n, () => ({ blockNumber: 105n, status: "success", contractAddress: null, to: WORLD_CREATE2_FACTORY, logs: [{ address: TIMELOCK }] }));
    m.firstBlock = 100;
    m.stages.safe.txHashes = world.opts.deployTxs; // the run's own creations (the stage they belong to does not matter to the proof)
    m.stages.timelock = { status: "done", startedAt: "t", txHashes: [], adopted: true, adoption: { libraries: [{ name: "TimelockController", artifact: "TimelockController", address: TIMELOCK, codeHash: "0x00" }], factory: WORLD_CREATE2_FACTORY, deployerTxs: 0 } };
    writeFileSync(path, JSON.stringify(m));
    const p = spy();
    let report: { ok: boolean; checks: { label: string; ok: boolean }[] } | undefined;
    const verify = {
      verifyDeployment: (async (o: { deployTxs?: `0x${string}`[]; adoptedContracts?: `0x${string}`[]; fromBlock: bigint }) => {
        report = await verifyDeployment({ ...world.opts, fromBlock: o.fromBlock, deployTxs: o.deployTxs, adoptedContracts: o.adoptedContracts });
        return report;
      }) as never,
      verifySources: (async () => ({ ok: true, checks: [] })) as never, depositsPaused: async () => true,
    };
    const code = await w.run(["verify"], { pauseAll: p.pauseAll, verify });
    expect(report!.checks.filter((c) => !c.ok).map((c) => c.label)).toEqual([]);
    expect(report!.checks.find((c) => c.label === "timelock: only the safe holds PROPOSER, CANCELLER or EXECUTOR role (log scan)")?.ok).toBe(true);
    expect(code).toBe(0);
    expect(p.calls).toEqual([]);
  });
  // Issue 1864: the real verifier on the in-memory world, reached through the CLI. A null receipt is RPC_REFUSED only when the same RPC serves none of the run's receipts.
  async function nullReceiptRun(drop: (world: ReturnType<typeof deployedWorld>) => void) {
    const w = seed({});
    const path = join(w.evidence, "publish-run.json");
    const m = JSON.parse(readFileSync(path, "utf8"));
    const world = deployedWorld();
    m.firstBlock = 100;
    m.stages.safe.txHashes = world.opts.deployTxs;
    writeFileSync(path, JSON.stringify(m));
    drop(world);
    const p = spy();
    const verify = {
      verifyDeployment: (async (o: { deployTxs?: `0x${string}`[]; fromBlock: bigint }) => await verifyDeployment({ ...world.opts, fromBlock: o.fromBlock, deployTxs: o.deployTxs })) as never,
      verifySources: (async () => ({ ok: true, checks: [] })) as never, depositsPaused: async () => true,
    };
    const code = await w.run(["verify"], { pauseAll: p.pauseAll, verify });
    return { code, calls: p.calls, w, world };
  }
  test("one recorded deploy receipt is null while the same RPC serves the run's other receipts: exit 13 (VERIFY), the detail names the missing transaction, pauseAll is called", async () => {
    let gone = "";
    const { code, calls, w } = await nullReceiptRun((world) => { gone = world.opts.deployTxs![0]!; world.chain.receipts.delete(gone.toLowerCase()); });
    expect(code).toBe(EXIT_CODES.VERIFY);
    expect(calls).toEqual(["verify"]);
    const details = w.logs().filter((l) => l.event === "verify.check" && l.ok === false).map((l) => String(l.detail));
    expect(details.length).toBeGreaterThan(0);
    for (const d of details) { expect(d).toContain(gone); expect(d.startsWith(RPC_REFUSED_DETAIL)).toBe(false); }
  });
  test("the RPC returns null for every recorded receipt and for eth_getTransactionByHash (a pruned node): exit 30 (RPC_REFUSED), pauseAll is never called", async () => {
    const { code, calls, w } = await nullReceiptRun((world) => world.chain.receipts.clear());
    expect(code).toBe(EXIT_CODES.RPC_REFUSED);
    expect(calls).toEqual([]);
    expect(w.logs().filter((l) => l.event === "run.failed").pop().message).toContain("No vault was paused");
  });
  test("an RPC_REFUSED failure beside a real failure is a real verify failure: pauseAll is called once", async () => {
    const w = seed({});
    const p = spy();
    const code = await w.run(["verify"], { pauseAll: p.pauseAll, verify: failing([refused, { label: "router: default weights equal sheet", ok: false, detail: "got x, want y" }]) });
    expect(code).toBe(EXIT_CODES.VERIFY);
    expect(p.calls).toEqual(["verify"]);
  });
});

describe("issue 1701: on 8453 the applied receipt vector of the run manifest must be backed by its timelock batch on chain", () => {
  const TL = "0x0000000000000000000000000000000000000071", GOV = "0x0000000000000000000000000000000000000072", RCPT = "0x0000000000000000000000000000000000000073";
  const RID = ("0x" + "0a".repeat(32)) as `0x${string}`;
  const DIGEST = ("0x" + "0d".repeat(32)) as `0x${string}`;
  const VAULTS = [vaultAddr("USDC"), vaultAddr("PROTO"), vaultAddr("RWA")];
  const ONCHAIN_BPS = [5000, 3000, 2000];
  const TLEV = parseAbi([
    "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
    "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  ]);
  const OP = ("0x" + "77".repeat(32)) as `0x${string}`;
  const tlLog = (name: "CallScheduled" | "CallExecuted", index: bigint, target: string, data: `0x${string}`) => ({
    address: TL, topics: encodeEventTopics({ abi: TLEV, eventName: name, args: { id: OP, index } } as never) as `0x${string}`[],
    data: name === "CallScheduled" ? encodeAbiParameters(parseAbiParameters("address, uint256, bytes, bytes32, uint256"), [target as `0x${string}`, 0n, data, ("0x" + "00".repeat(32)) as `0x${string}`, 172800n])
      : encodeAbiParameters(parseAbiParameters("address, uint256, bytes"), [target as `0x${string}`, 0n, data]),
  });
  /** The chain: one real applyReceipt call (issue 1698) that set ONCHAIN_BPS, scheduled at t=1000 and executed one 172800 s delay later. */
  const chain = () => {
    const calls = [{ target: GOV, data: applyCalldata(RID, DIGEST, VAULTS, ONCHAIN_BPS) }];
    const rc: Record<string, { status: "success"; blockNumber: bigint; logs: any[] }> = {
      ["0x" + "51".repeat(32)]: { status: "success", blockNumber: 1n, logs: calls.map((c, i) => tlLog("CallScheduled", BigInt(i), c.target, c.data)) },
      ["0x" + "52".repeat(32)]: { status: "success", blockNumber: 2n, logs: calls.map((c, i) => tlLog("CallExecuted", BigInt(i), c.target, c.data)) },
    };
    return {
      getChainId: async () => 8453, getTransactionCount: async () => 0, readContract: async () => undefined,
      getTransactionReceipt: async ({ hash }: { hash: string }) => { const r = rc[hash]; if (!r) throw new Error("not found"); return r; },
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: blockNumber === 1n ? 1000n : 1000n + 172800n }),
    };
  };
  const entry = (bps: number[]) => ({
    step: "apply-receipt", receipt_id: RID, target: GOV, governance: GOV, payload_digest: DIGEST, vaults: VAULTS, bps, voted_weights_active: true, effective_vaults: VAULTS, effective_bps: bps,
    operation_id: OP, schedule_tx: "0x" + "51".repeat(32), schedule_status: 1, schedule_block_timestamp: 1000, execute_tx: "0x" + "52".repeat(32), execute_status: 1, execute_block_timestamp: 1000 + 172800,
  });
  /** Issue 1933: the v0.5.0 stage table has no receipt stage (the receipt sits in ic-policy). The table of this line with that one stage renamed is the shape verify loads on Deploy 3. */
  const priorLineTable = () => {
    const t = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "scripts", "deploy", "stage-table.json"), "utf8"));
    t.stages = t.stages.map((x: any) => (x.name === "receipt" ? { ...x, name: "ic-policy" } : x));
    t.systems.vaults.stages = t.systems.vaults.stages.map((n: string) => (n === "receipt" ? "ic-policy" : n));
    return parseStageTable(t);
  };
  async function run(apps: unknown[], prior = false) {
    const { ctx } = setup({}, { chain: 8453 });
    const saved = getStageTable();
    if (prior) useStageTable(priorLineTable());
    try { return await runIn(ctx, apps); } finally { useStageTable(saved); }
  }
  async function runIn(ctx: RunContext, apps: unknown[]) {
    const dir = join(ctx.coreDir, "deployments", "8453");
    for (const [ref, v] of [[manifestRef("timelock", "timelock"), TL], [manifestRef("governance", "governance"), GOV], [receiptRef(), RCPT]] as const) {
      const [file, field] = ref.split(":") as [string, string];
      writeFileSync(join(dir, `${file}.json`), JSON.stringify({ chain_id: 8453, [field]: v }));
    }
    const mctx = { ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext;
    const manifest = { ...newManifest(mctx, "0xa"), firstBlock: 5, receipt_applications: apps };
    let seen: any;
    // The verifier stub plays the router check: it passes whenever the router weights equal the applied vector the manifest hands it (a drifted router plus a forged entry agree).
    const deps = {
      verifyDeployment: async (o: any) => { seen = o; return { ok: true, checks: [{ label: "router: default weights equal sheet", ok: true, detail: "" }] }; },
      verifySources: async () => ({ ok: true, checks: [] }), emit: () => {}, depositsPaused: async () => true, receiptChain: chain(),
      recorderSpawn: (() => ({ status: 0, stdout: "", stderr: "" })) as never,
    };
    let err: any;
    try { await runVerifyStage(mctx, stageByName("verify"), manifest as never, deps as never); } catch (e) { err = e; }
    return { err, seen };
  }

  test("an entry backed by its batch passes; a forged entry naming the drifted router vector fails the verify even though the router check passed", async () => {
    const ok = await run([entry(ONCHAIN_BPS)]);
    expect(ok.err).toBeUndefined();
    const drifted = [6000, 2000, 2000];
    const forged = await run([entry(drifted)]);
    expect(forged.seen.appliedReceipt.bps).toEqual(drifted);
    expect(forged.err).toMatchObject({ kind: "VERIFY" });
    expect(forged.err.details.failed).toContain("govern post-govern: receipt_applications are backed by their timelock batches on chain");
    // an entry whose transactions are not on chain at all is refused too
    const unbacked = await run([{ ...entry(drifted), schedule_tx: "0x" + "99".repeat(32), execute_tx: "0x" + "98".repeat(32) }]);
    expect(unbacked.err).toMatchObject({ kind: "VERIFY" });
  });

  test("issue 1933: verify with an applied receipt reads the receipt from the ic-policy manifest when --core-dir is the v0.5.0 checkout", async () => {
    const r = await run([entry(ONCHAIN_BPS)], true);
    expect(r.err).toBeUndefined();
    expect(r.seen.appliedReceipt.bps).toEqual(ONCHAIN_BPS);
  });
});

// Issue 1809: the verify stage hands the verifier the sheet's release mode and the core checkout (the layout snapshots), and writes the verifier's upgradeability record
// beside the deployment manifests on every run, pass or fail, for the evidence to copy.
describe("stage 12 records the upgradeability of the deployment (issue 1809)", () => {
  const record = (core_immutable: boolean) => ({ mode: "frozen", freeze_deadline: null, timelock: { address: "0x0000000000000000000000000000000000000009", min_delay: "60" }, transactions_per_proxy: 2, proxies: {}, core_immutable, immutability_refused_because: core_immutable ? [] : ["x"], remaining_governed_parameters: ["p"], upstream_dependencies: ["d"] });
  test("the verifier sheet carries UPGRADE_MODE, the options carry the core checkout, and upgradeability.json is written with the chain and the DEPLOY_SHA", async () => {
    const { ctx } = setup();
    const manifest = { ...newManifest(ctx, "0xa"), firstBlock: 5 };
    let seen: any;
    const deps = { verifyDeployment: async (o: any) => { seen = o; return { ok: true, checks: [{ label: "x", ok: true, detail: "" }], upgradeability: record(true) }; }, verifySources: async () => ({ ok: true, checks: [] }), emit: () => {} };
    await runVerifyStage({ ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext, stageByName("verify"), manifest, deps as never);
    expect(seen.sheet.upgradeMode).toBe("frozen");
    expect(seen.sheet.freezeDeadline).toBeUndefined();
    expect(seen.coreDir).toBe(ctx.coreDir);
    const out = JSON.parse(readFileSync(join(ctx.coreDir, "deployments", "918453", "upgradeability.json"), "utf8"));
    expect(out).toMatchObject({ chain_id: 918453, core_sha: SHA, mode: "frozen", core_immutable: true, transactions_per_proxy: 2 });
  });
  test("a failing verify still writes the record (core_immutable false), then fails the stage", async () => {
    const { ctx } = setup();
    const manifest = { ...newManifest(ctx, "0xa"), firstBlock: 5 };
    const deps = { verifyDeployment: async () => ({ ok: false, checks: [{ label: "router: upgradesFrozen() agrees with the release mode", ok: false, detail: "x" }], upgradeability: record(false) }), verifySources: async () => ({ ok: true, checks: [] }), emit: () => {} };
    await expect(runVerifyStage({ ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext, stageByName("verify"), manifest, deps as never)).rejects.toMatchObject({ kind: "VERIFY" });
    expect(JSON.parse(readFileSync(join(ctx.coreDir, "deployments", "918453", "upgradeability.json"), "utf8")).core_immutable).toBe(false);
  });
  test("an upgradeable sheet hands the verifier its freeze deadline", () => {
    const { ctx } = setup();
    const s = buildVerifySheet({ ...ctx, sheet: parseSheet(sheetText({ UPGRADE_MODE: "upgradeable" }, ["UPGRADE_FREEZE_DEADLINE=2027-01-31T00:00:00Z"]), { verb: "verify" }) }, "0x00000000000000000000000000000000000050fe");
    expect(s).toMatchObject({ upgradeMode: "upgradeable", freezeDeadline: "2027-01-31T00:00:00Z" });
  });
});

// Issue 1988: nothing clears an applied vector, so verify expects the last application on the router. A HISTORICAL clear entry in an older manifest changes nothing.
describe("the applied receipt is the last application (issue 1988)", () => {
  test("the last well formed application is expected on the router, with or without a historical clear entry", async () => {
    const { appliedReceiptOf } = await import("../src/verify-stage.ts");
    const app = { receipt_id: `0x${"11".repeat(32)}`, vaults: [`0x${"22".repeat(20)}`], bps: [10000], execute_block_timestamp: 1000 };
    const later = { ...app, receipt_id: `0x${"33".repeat(32)}`, execute_block_timestamp: 2000 };
    expect(appliedReceiptOf({})).toBeUndefined();
    expect(appliedReceiptOf({ receipt_applications: [app] })).toMatchObject({ receiptId: app.receipt_id });
    expect(appliedReceiptOf({ receipt_applications: [app, later] })).toMatchObject({ receiptId: later.receipt_id });
    expect(appliedReceiptOf({ receipt_applications: [app], voted_weights_clears: [{ execute_status: 1, voted_weights_active: false, execute_block_timestamp: 1001 }] } as never)).toMatchObject({ receiptId: app.receipt_id });
  });

});
