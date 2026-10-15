import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { RM_TOKEN } from "../src/verify/constants.ts";
import { join } from "node:path";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { parseCli } from "../src/cli.ts";
import { publishLogger } from "../src/log.ts";
import { newManifest, type RunContext } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { stageByName } from "../src/stages.ts";
import { buildVerifySheet, handoverBlock, layoutHashOf, loadExpectedAssets, mainnetGovernMode, runVerifyStage, upgradeBuildRefusal, withUpgradeBuilds } from "../src/verify-stage.ts";
import { ADMIN, world } from "./harness.ts";
import { COUNTS, SHA, sheetText, tmp } from "./fixtures.ts";

import { getStageTable } from "../src/stages.ts";
import { manifestBase, tableProxies } from "../src/stage-table.ts";
import { CONFIG_ASSET, MANIFEST_ADAPTER, writeCoreAssetConfig } from "./fixtures.ts";

/** One distinct address per vault, so a test can say which vault reads paused. */
const vaultAddr = (key: string): `0x${string}` => `0x00000000000000000000000000000000000000c${["USDC", "PROTO", "AGENT", "RWA"].indexOf(key) + 1}`;
const MANIFEST_ADAPTER_V4 = "0x00000000000000000000000000000000000000a4";
const MANIFEST_RECORDER = "0x00000000000000000000000000000000000000d5";
const USDC_ADAPTER_FIELDS = { aave_adapter: "0x00000000000000000000000000000000000000e1", compound_adapter: "0x00000000000000000000000000000000000000e2", moonwell_flagship_adapter: "0x00000000000000000000000000000000000000e3" } as const;

/** A core checkout fixture: the real-shaped config files, the vault manifests with the adapter each run deploys, and the Safe manifest. */
function setup(config: { proto?: object[]; rwa?: object[]; shortlist?: object[] } | null = {}, o: { adapters?: boolean; chain?: number } = {}) {
  const chain = o.chain ?? 918453;
  const coreDir = tmp("pc-verify-");
  const m = join(coreDir, "deployments", String(chain));
  mkdirSync(m, { recursive: true });
  writeFileSync(join(m, "safe.json"), JSON.stringify({ safe: "0x00000000000000000000000000000000000050fe" }));
  if (o.adapters !== false) {
    // the rmUSDC manifest names the three lending adapters its stage registered (issue 1705 C4: the verify sheet reads them)
    for (const v of getStageTable().vaults) writeFileSync(join(m, `${manifestBase(v.manifest)}.json`), JSON.stringify({ chain_id: chain, vault: vaultAddr(v.key), ...(v.key !== "USDC" ? { adapter: MANIFEST_ADAPTER, adapter_v4: MANIFEST_ADAPTER_V4, recorder: MANIFEST_RECORDER } : USDC_ADAPTER_FIELDS) }));
    writeFileSync(join(m, "recorder.json"), JSON.stringify({ chain_id: chain, recorder: MANIFEST_RECORDER }));
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
  test("the verifier sheet covers all four vaults, with all four vaults paused (rmUSDC deploys paused too, core 1710) and the seed on rmUSDC only", () => {
    const { ctx, sheet } = setup();
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe");
    expect(Object.keys(v.vaults)).toEqual(["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"]);
    for (const k of ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"]) expect(v.vaults[k]!.expectPaused).toBe(true);
    expect(v.vaults.rmUSDC!.seed).toBe(1000000n);
    expect(v.vaults.rmAGENT!.assets).toEqual([]);
    expect(v.vaults.rmPROTO!.assets).toEqual([{ token: CONFIG_ASSET.token, pool: CONFIG_ASSET.pool, swapFee: 500, adapter: MANIFEST_ADAPTER, venue: 0 }]);
    expect(v.vaults.rmUSDC!.seedShareReceiver).toBe(sheet.shareReceiver);
    expect(v.vaults.rmPROTO!.feeRecipient).toBe("0x00000000000000000000000000000000000050fe"); // @safe resolves to the created Safe
    expect(v.timelockDelay).toBe(60);
  });

  test("the verifier sheet carries rmUSDC's lending adapters at the deploy script's caps and every basket's swap bound, and a missing adapter field is an error (issue 1705 C4)", () => {
    const { ctx } = setup();
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe");
    expect(v.vaults.rmUSDC!.adapters).toEqual([
      { address: USDC_ADAPTER_FIELDS.aave_adapter, capBps: 3334 }, { address: USDC_ADAPTER_FIELDS.compound_adapter, capBps: 3333 }, { address: USDC_ADAPTER_FIELDS.moonwell_flagship_adapter, capBps: 3333 },
    ]);
    expect(v.vaults.rmUSDC!.maxSlippageBps).toBeUndefined();
    // the fixture configs set no root maxSlippageBps, so each basket keeps its vault default
    expect([v.vaults.rmPROTO!.maxSlippageBps, v.vaults.rmAGENT!.maxSlippageBps, v.vaults.rmRWA!.maxSlippageBps]).toEqual([100n, 300n, 100n]);
    for (const k of ["rmPROTO", "rmAGENT", "rmRWA"]) expect(v.vaults[k]!.adapters).toBeUndefined();
    writeFileSync(join(ctx.coreDir, "deployments", String(ctx.chainId), "vault.json"), JSON.stringify({ chain_id: ctx.chainId, vault: vaultAddr("USDC"), aave_adapter: USDC_ADAPTER_FIELDS.aave_adapter }));
    expect(() => buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe")).toThrow("manifest vault.json has no compound_adapter");
  });

  test("the verifier sheet carries the NAV deviation guard and the pool liquidity floor of every basket, and none for rmUSDC (issue 1666)", () => {
    const { ctx, sheet } = setup();
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe");
    for (const [k, key] of [["rmPROTO", "PROTO"], ["rmAGENT", "AGENT"], ["rmRWA", "RWA"]] as const) {
      expect(v.vaults[k]!.navDeviationBps).toBe(sheet.vaults[key].navDeviationBps!);
      expect(v.vaults[k]!.minPoolLiquidity).toBe(sheet.vaults[key].minPoolLiquidity!);
      expect(v.vaults[k]!.navDeviationBps!).toBeGreaterThan(0n);
    }
    expect(v.vaults.rmUSDC!.navDeviationBps).toBeUndefined();
    expect(v.vaults.rmUSDC!.minPoolLiquidity).toBeUndefined();
  });

  test("the verifier sheet carries every deploy-time value of the sheet: eligibility and the router default weights, and no voting block (issues 1520, 1698)", () => {
    const { ctx } = setup();
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe");
    // issue 1698: the weight setter has no voters, quorum or periods, so the verifier sheet has no governance block to compare
    expect((v as unknown as Record<string, unknown>).governance).toBeUndefined();
    // the example sheet makes PROTO, AGENT and RWA eligible: rmUSDC always is
    expect(Object.fromEntries(Object.entries(v.vaults).map(([k, x]) => [k, x.routerEligible]))).toEqual({ rmUSDC: true, rmPROTO: true, rmAGENT: true, rmRWA: true });
    expect(v.defaultWeights).toEqual([{ vault: "rmUSDC", bps: 9500 }, { vault: "rmPROTO", bps: 500 }, { vault: "rmAGENT", bps: 0 }, { vault: "rmRWA", bps: 0 }]);
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

  test("an empty agent list needs no adapter, and rmUSDC holds no basket assets", () => {
    const { ctx } = setup({}, { adapters: false });
    expect(loadExpectedAssets(ctx, "AGENT")).toEqual([]);
    expect(loadExpectedAssets(ctx, "USDC")).toEqual([]);
  });

  test("the committed agent shortlist expects RM as rmAGENT's one asset, on the V4 venue (1) at fee 29100, with the recorder as its pool and the run's V4 adapter (core 1676)", () => {
    const { ctx } = setup({}, {});
    copyFileSync(join(import.meta.dir, "..", "..", "config", "agent-token-shortlist.json"), join(ctx.coreDir, "config", "agent-token-shortlist.json"));
    const want = loadExpectedAssets(ctx, "AGENT");
    expect(want.map((a) => [a.token.toLowerCase(), a.pool, a.swapFee, a.adapter, a.venue])).toEqual([
      [RM_TOKEN.toLowerCase(), MANIFEST_RECORDER, 29100, MANIFEST_ADAPTER_V4, 1],
    ]);
    // the PoolKey the verifier compares the recorder and the adapter with comes from the config, hooks zero, tickSpacing 582
    expect(want[0]!.v4).toMatchObject({ poolId: "0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391", key: { fee: 29100, tickSpacing: 582, hooks: "0x0000000000000000000000000000000000000000" } });
  });

  test("a V4 asset whose vault manifest has no adapter_v4 is an error, not a silent V3 fallback", () => {
    const { ctx } = setup({}, {});
    copyFileSync(join(import.meta.dir, "..", "..", "config", "agent-token-shortlist.json"), join(ctx.coreDir, "config", "agent-token-shortlist.json"));
    const m = join(ctx.coreDir, "deployments", String(ctx.chainId), "agent-token-vault.json");
    writeFileSync(m, JSON.stringify({ chain_id: ctx.chainId, vault: "0x00000000000000000000000000000000000000b1", adapter: MANIFEST_ADAPTER }));
    expect(() => loadExpectedAssets(ctx, "AGENT")).toThrow(/adapter_v4/);
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
  test("before the govern execute row, every basket and agent vault is expected paused", () => {
    const { ctx, sheet } = setup();
    const m = newManifest(ctx, "0xa");
    expect(unpausedByGovern(m, sheet)).toEqual([]);
    m.govern = { "unpause-PROTO": { scheduled: { at: "t", tx_hash: "0x1" } } };
    expect(unpausedByGovern(m, sheet)).toEqual([]);
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe", unpausedByGovern(m, sheet));
    for (const k of ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"]) expect(v.vaults[k]!.expectPaused).toBe(true);
  });

  test("once an unpause row's executed phase is recorded, that vault (and no other) is expected paused=false", () => {
    const { ctx, sheet } = setup();
    const m = newManifest(ctx, "0xa");
    m.govern = Object.fromEntries(sheet.govern.unpauseVaults.map((k) => [`unpause-${k}`, { scheduled: { at: "t", tx_hash: "0x1" }, executed: { at: "t", tx_hash: "0x2" } }]));
    const unpaused = unpausedByGovern(m, sheet);
    expect(unpaused).toEqual(sheet.govern.unpauseVaults);
    expect(unpaused.length).toBeGreaterThan(0);
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe", unpaused);
    for (const [k, name] of [["USDC", "rmUSDC"], ["PROTO", "rmPROTO"], ["AGENT", "rmAGENT"], ["RWA", "rmRWA"]] as const) expect(v.vaults[name]!.expectPaused).toBe(!unpaused.includes(k));
    // rmAGENT is expected paused only when the sheet does not list it: pause semantics are sheet data
    expect(v.vaults.rmAGENT!.expectPaused).toBe(!sheet.govern.unpauseVaults.includes("AGENT"));
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
    const gated = { gating: "timelock", holders: [{ address: GOVERNANCE, routerGovernanceCode: true, admins: [TL], timelockGated: true }], timelock: TL, delaySeconds: 60 };
    const open = { ...gated, gating: "not-timelock", holders: [{ address: GOVERNANCE, routerGovernanceCode: true, admins: [TL, SAFE_ADDR], timelockGated: false }] };
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
  const ALL_EXEC = { "unpause-USDC": exec, "unpause-PROTO": exec, "unpause-AGENT": exec, "unpause-RWA": exec };
  /** depositsPaused per vault: all four vaults paused (the launch state, core 1710) unless a test says otherwise. */
  const launch = (over: Partial<Record<string, boolean>> = {}): Record<string, boolean> => ({ USDC: true, PROTO: true, AGENT: true, RWA: true, ...over } as Record<string, boolean>);
  async function run(govern: Record<string, unknown>, paused: Record<string, boolean>, extra: Record<string, unknown> = {}) {
    const { ctx, lines } = setup({}, { chain: 8453 });
    const mctx = { ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext;
    const manifest = { ...newManifest(mctx, "0xa"), firstBlock: 5, govern, ...extra };
    const byAddr = Object.fromEntries(Object.entries(paused).map(([k, v]) => [vaultAddr(k).toLowerCase(), v]));
    const calls = { verifier: 0, sources: 0 };
    let seen: any;
    let sources: Record<string, string> | undefined;
    const deps = {
      verifyDeployment: async (o: any) => { calls.verifier++; seen = o; return { ok: true, checks: [{ label: "x", ok: true, detail: "" }] }; },
      verifySources: async (o: { contracts: Record<string, string> }) => { calls.sources++; sources = o.contracts; return { ok: true, checks: [] }; }, emit: () => {},
      depositsPaused: async (_rpc: string, vault: string) => byAddr[vault.toLowerCase()]!,
      recorderSpawn: (() => ({ status: 0, stdout: "", stderr: "" })) as never,
    };
    let err: any;
    try { await runVerifyStage(mctx, stageByName("verify"), manifest as never, deps as never); } catch (e) { err = e; }
    return { err, seen, manifest, calls, lines, sources };
  }

  test("security round 2: a proxy an executed upgrade-proxy round moved has the round's implementation source-verified, not only the deploy-time one", async () => {
    const NEW = "0x00000000000000000000000000000000000c0de1";
    const up = { step: "upgrade-proxy", proxy: "gateway", implementation: NEW, build_dir: "/b", execute_tx: "0x9" };
    const done = await run({}, launch(), { proxy_upgrades: [up] });
    expect(done.err).toBeUndefined();
    expect(done.sources!["implementation[gateway]"]).toBe(NEW);
    expect(done.seen.upgrades).toEqual([{ proxy: "gateway", implementation: NEW, buildDir: "/b" }]);
    // mutation: a round scheduled and never executed changes nothing
    const pending = await run({}, launch(), { proxy_upgrades: [{ ...up, execute_tx: undefined }] });
    expect(pending.sources!["implementation[gateway]"]).not.toBe(NEW);
  });

  test("pre-govern: no unpause row scheduled passes when all four vaults read paused", async () => {
    const { err, seen, manifest } = await run({}, launch());
    expect(err).toBeUndefined();
    expect((manifest as any).stages.verify.status).toBe("done");
    for (const k of ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"]) expect(seen.sheet.vaults[k].expectPaused).toBe(true);
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

  test("post-govern: all four unpause rows executed passes only when all four vaults read open", async () => {
    const ok = await run(ALL_EXEC, launch({ USDC: false, PROTO: false, AGENT: false, RWA: false }));
    expect(ok.err).toBeUndefined();
    for (const k of ["rmPROTO", "rmAGENT", "rmRWA", "rmUSDC"]) expect(ok.seen.sheet.vaults[k].expectPaused).toBe(false);
    for (const k of ["PROTO", "AGENT", "RWA", "USDC"]) {
      const bad = await run(ALL_EXEC, launch({ USDC: false, PROTO: false, AGENT: false, RWA: false, [k]: true }));
      expect(bad.err).toMatchObject({ kind: "VERIFY" });
      expect(bad.err.message).toContain(`govern post-govern: ${{ USDC: "rmUSDC", PROTO: "rmPROTO", AGENT: "rmAGENT", RWA: "rmRWA" }[k]} depositsPaused is false`);
    }
  });
  test("post-govern with a vault that pause-all paused again names the govern row that reopens it", async () => {
    const { err, lines } = await run(ALL_EXEC, launch({ PROTO: false, AGENT: false, RWA: false, USDC: true }));
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
    expect(mainnetGovernMode({ govern: { "unpause-PROTO": exec, "unpause-AGENT": exec, "unpause-RWA": exec } }).mode).toBe("part-way");
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
    for (const v of getStageTable().vaults) writeFileSync(join(m, `${manifestBase(v.manifest)}.json`), JSON.stringify({ chain_id: 8453, vault: vaultAddr(v.key), adapter: MANIFEST_ADAPTER }));
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
});

// Security round 3 (review: SECURITY_AVAILABILITY_SELF_PAUSE, RELIABILITY_FAIL_CLOSED_OUTAGE): the build an executed upgrade-proxy round recorded is a path on the
// machine that ran govern. Before, a verify where it was gone, relative to another directory or at another HEAD failed the proxy's code label, threw VERIFY and paused
// all four vaults. Now the stage checks every upgraded proxy's build before the verifier and refuses (USAGE, refused_before_verify), so nothing is paused.
describe("security round 3: an upgrade round's build is checked before the verifier, and a build that moved never pauses the four vaults", () => {
  const BUILD_SHA = "b".repeat(40);
  const NEW = "0x00000000000000000000000000000000000c0de1";
  const round = (o: Record<string, unknown> = {}) => ({ step: "upgrade-proxy", proxy: "gateway", implementation: NEW, build_sha: BUILD_SHA, execute_tx: "0x9", ...o });
  /** A checkout whose HEAD is `sha` (a detached HEAD file, as readGitHead reads it), with an empty `sub` directory. */
  function checkoutAt(sha: string, sub = "out"): { root: string; dir: string } {
    const root = tmp("pc-r3-build-");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), `${sha}\n`);
    mkdirSync(join(root, sub), { recursive: true });
    return { root, dir: join(root, sub) };
  }
  async function verifyWith(chain: number, extra: Record<string, unknown>, over: Partial<RunContext> = {}) {
    const { ctx } = setup({}, { chain });
    const mctx = { ...ctx, evidenceDir: join(ctx.coreDir, "ev"), ...over } as RunContext;
    const manifest = { ...newManifest(mctx, "0xa"), firstBlock: 5, ...extra };
    const calls = { verifier: 0 };
    let seen: any;
    const deps = {
      verifyDeployment: async (o: any) => { calls.verifier++; seen = o; return { ok: true, checks: [{ label: "x", ok: true, detail: "" }] }; },
      verifySources: async () => ({ ok: true, checks: [] }), emit: () => {}, depositsPaused: async () => true, recorderSpawn: (() => ({ status: 0, stdout: "", stderr: "" })) as never,
    };
    let err: any;
    try { await runVerifyStage(mctx, stageByName("verify"), manifest as never, deps as never); } catch (e) { err = e; }
    return { err, calls, seen, manifest: manifest as any };
  }
  const refusedBeforeVerify = (r: { err: any; calls: { verifier: number }; manifest: any }, text: string) => {
    expect(r.err).toMatchObject({ kind: "USAGE", details: { refused_before_verify: true } });
    expect(r.err.message).toContain(text);
    expect(r.err.message).toContain("--upgrade-build");
    expect(r.calls.verifier).toBe(0);
    expect(r.manifest.stages.verify).toBeUndefined();
  };

  test("a round whose build_dir is missing, or relative, is refused before the verifier with USAGE refused_before_verify", async () => {
    refusedBeforeVerify(await verifyWith(8453, { proxy_upgrades: [round({ build_dir: "/nonexistent-rm-r2/out" })] }), "/nonexistent-rm-r2/out does not exist");
    refusedBeforeVerify(await verifyWith(8453, { proxy_upgrades: [round({ build_dir: "../rm-r2/out" })] }), "relative");
    refusedBeforeVerify(await verifyWith(918453, { proxy_upgrades: [round({ build_dir: "/nonexistent-rm-r2/out" })] }), "does not exist");
  });

  test("a build_dir that is a checkout at another sha (the next release checked out in the same place), or not its checkout's out/ on 8453, is refused", async () => {
    const moved = checkoutAt("c".repeat(40));
    refusedBeforeVerify(await verifyWith(8453, { proxy_upgrades: [round({ build_dir: moved.dir })] }), `a checkout at ${"c".repeat(40)}, but the upgrade round recorded build_sha ${BUILD_SHA}`);
    const notOut = checkoutAt(BUILD_SHA, "build");
    refusedBeforeVerify(await verifyWith(8453, { proxy_upgrades: [round({ build_dir: notOut.dir })] }), "is not the forge out/ of its checkout");
    // mutation: off 8453 the same checkout at build_sha is the build, and the verifier runs
    const ok = await verifyWith(918453, { proxy_upgrades: [round({ build_dir: notOut.dir })] });
    expect(ok.err).toBeUndefined();
    expect(ok.calls.verifier).toBe(1);
  });

  test("a build checkout at build_sha whose storage-layout snapshot no longer hashes to the round's build_layout_hash is refused, not a failed layout label", async () => {
    const b = checkoutAt(BUILD_SHA);
    const artifact = tableProxies(getStageTable()).find((p) => p.name === "gateway")!.artifact;
    mkdirSync(join(b.root, "contracts", "test", "fixtures", "storage-layout"), { recursive: true });
    writeFileSync(join(b.root, "contracts", "test", "fixtures", "storage-layout", `${artifact}.json`), JSON.stringify({ storage: [] }));
    const recorded = layoutHashOf(b.root, artifact)!;
    const same = await verifyWith(918453, { proxy_upgrades: [round({ build_dir: b.dir, build_layout_hash: recorded })] });
    expect(same.err).toBeUndefined();
    refusedBeforeVerify(await verifyWith(918453, { proxy_upgrades: [round({ build_dir: b.dir, build_layout_hash: `0x${"ab".repeat(32)}` })] }), "the checkout is modified");
  });

  test("--upgrade-build stands for a missing build_dir, is held to build_sha, and is never written into the run manifest", async () => {
    const b = checkoutAt(BUILD_SHA);
    const gone = round({ build_dir: "/nonexistent-rm-r2/out" });
    const r = await verifyWith(918453, { proxy_upgrades: [gone] }, { upgradeBuilds: { gateway: b.dir } });
    expect(r.err).toBeUndefined();
    expect(r.seen.upgrades).toEqual([{ proxy: "gateway", implementation: NEW, buildDir: b.dir, buildSha: BUILD_SHA }]);
    expect(r.manifest.proxy_upgrades).toEqual([gone]);
    expect(r.manifest.stages.verify.status).toBe("done");
    // an override at another sha is refused like the recorded build; one naming a proxy no round moved is refused too
    refusedBeforeVerify(await verifyWith(918453, { proxy_upgrades: [gone] }, { upgradeBuilds: { gateway: checkoutAt("c".repeat(40)).dir } }), "a checkout at");
    refusedBeforeVerify(await verifyWith(918453, { proxy_upgrades: [gone] }, { upgradeBuilds: { gateway: b.dir, router: b.dir } }), "--upgrade-build names router");
    // withUpgradeBuilds copies: the manifest it was given keeps its build_dir
    const m = { proxy_upgrades: [gone] };
    expect((withUpgradeBuilds(m, { gateway: b.dir }).proxy_upgrades![0] as any).build_dir).toBe(b.dir);
    expect((m.proxy_upgrades[0] as any).build_dir).toBe("/nonexistent-rm-r2/out");
  });

  test("a round with no build_sha (a Twin build outside a checkout, as before) and a round not executed are not held to a build", () => {
    const { ctx } = setup({}, { chain: 918453 });
    expect(upgradeBuildRefusal({ proxy_upgrades: [round({ build_sha: undefined, build_dir: "/nonexistent-rm-r2/out" })] }, ctx)).toBeUndefined();
    expect(upgradeBuildRefusal({ proxy_upgrades: [round({ execute_tx: undefined, build_dir: "/nonexistent-rm-r2/out" })] }, ctx)).toBeUndefined();
    expect(upgradeBuildRefusal({ proxy_upgrades: [round({ build_dir: "/nonexistent-rm-r2/out" })] }, ctx)).toBeInstanceOf(PublishError);
  });
});

describe("security round 3, the CLI on 8453: a verify whose upgrade build moved exits USAGE and never calls pauseAll", () => {
  const BUILD_SHA = "b".repeat(40);
  function seed(buildDir: string) {
    const w = world({ chainId: 8453, writeSafeManifest: true, writeFrozen: true });
    const m = join(w.coreDir, "deployments", "8453");
    for (const v of getStageTable().vaults) writeFileSync(join(m, `${manifestBase(v.manifest)}.json`), JSON.stringify({ chain_id: 8453, vault: vaultAddr(v.key), adapter: MANIFEST_ADAPTER }));
    mkdirSync(w.evidence, { recursive: true });
    const up = { step: "upgrade-proxy", proxy: "gateway", implementation: "0x00000000000000000000000000000000000c0de1", build_dir: buildDir, build_sha: BUILD_SHA, execute_tx: "0x9" };
    writeFileSync(join(w.evidence, "publish-run.json"), JSON.stringify({ version: 1, chainId: 8453, coreSha: SHA, deployer: ADMIN, environment: "local", startedAt: "t", firstBlock: 7, stages: { safe: { status: "done", startedAt: "t" }, "prove-control": { status: "done", startedAt: "t" }, timelock: { status: "done", startedAt: "t" } }, govern: {}, proxy_upgrades: [up] }));
    return w;
  }
  const spy = () => { const calls: string[] = []; return { calls, pauseAll: (async (_c: unknown, _m: unknown, o: { trigger: string }) => { calls.push(o.trigger); return { allPaused: true, vaults: [] }; }) as never }; };
  const verifier = (calls: { n: number }) => ({ verifyDeployment: (async () => { calls.n++; return { ok: false, checks: [{ label: "gateway: runtime code equals build artifact (masked)", ok: false, detail: "x" }] }; }) as never, verifySources: (async () => ({ ok: true, checks: [] })) as never, depositsPaused: async () => true });

  test("the round's build_dir is gone: exit USAGE, the verifier did not run, pauseAll was never called", async () => {
    const w = seed("/nonexistent-rm-r2/out");
    const p = spy(), v = { n: 0 };
    expect(await w.run(["verify"], { pauseAll: p.pauseAll, verify: verifier(v) })).toBe(EXIT_CODES.USAGE);
    expect(v.n).toBe(0);
    expect(p.calls).toEqual([]);
    expect(w.logs().filter((l) => l.event === "run.failed").pop().message).toContain("verify refused before the verifier ran");
  });

  test("--upgrade-build goes with a run that reaches verify only, and is resolved against the working directory", () => {
    const base = ["--chain", "8453", "--core-sha", "a".repeat(40), "--rpc", "http://x", "--sheet", "s", "--signer", "ledger"];
    expect(parseCli(["verify", ...base, "--upgrade-build", "gateway=../rel/out", "--upgrade-build", "router=/r/out"]).upgradeBuilds).toEqual({ gateway: "../rel/out", router: "/r/out" });
    expect(() => parseCli(["govern", ...base, "--upgrade-build", "gateway=/o"])).toThrow("--upgrade-build goes with the verify verb");
    expect(() => parseCli(["verify", ...base, "--upgrade-build", "gateway"])).toThrow("--upgrade-build takes <proxy>=");
    expect(() => parseCli(["verify", ...base, "--upgrade-build", "gateway=/a", "--upgrade-build", "gateway=/b"])).toThrow("is given twice");
  });
});
