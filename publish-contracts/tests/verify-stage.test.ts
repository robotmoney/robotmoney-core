import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublishError } from "../src/errors.ts";
import { publishLogger } from "../src/log.ts";
import { newManifest, type RunContext } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { stageByName } from "../src/stages.ts";
import { buildVerifySheet, handoverBlock, loadExpectedAssets, runVerifyStage } from "../src/verify-stage.ts";
import { COUNTS, SHA, sheetText, tmp } from "./fixtures.ts";

import { getStageTable } from "../src/stages.ts";
import { manifestBase } from "../src/stage-table.ts";
import { CONFIG_ASSET, MANIFEST_ADAPTER, writeCoreAssetConfig } from "./fixtures.ts";

/** A core checkout fixture: the real-shaped config files, the vault manifests with the adapter each run deploys, and the Safe manifest. */
function setup(config: { proto?: object[]; rwa?: object[]; shortlist?: object[] } | null = {}, o: { adapters?: boolean; chain?: number } = {}) {
  const chain = o.chain ?? 918453;
  const coreDir = tmp("pc-verify-");
  const m = join(coreDir, "deployments", String(chain));
  mkdirSync(m, { recursive: true });
  writeFileSync(join(m, "safe.json"), JSON.stringify({ safe: "0x00000000000000000000000000000000000050fe" }));
  if (o.adapters !== false) {
    for (const v of getStageTable().vaults) if (v.key !== "USDC") writeFileSync(join(m, `${manifestBase(v.manifest)}.json`), JSON.stringify({ chain_id: chain, vault: "0x00000000000000000000000000000000000000b1", adapter: MANIFEST_ADAPTER }));
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
  test("the verifier sheet covers all four vaults, with baskets and the agent vault paused and the seed on rmUSDC only", () => {
    const { ctx, sheet } = setup();
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe");
    expect(Object.keys(v.vaults)).toEqual(["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"]);
    expect(v.vaults.rmUSDC!.expectPaused).toBe(false);
    for (const k of ["rmPROTO", "rmAGENT", "rmRWA"]) expect(v.vaults[k]!.expectPaused).toBe(true);
    expect(v.vaults.rmUSDC!.seed).toBe(1000000n);
    expect(v.vaults.rmAGENT!.assets).toEqual([]);
    expect(v.vaults.rmPROTO!.assets).toEqual([{ token: CONFIG_ASSET.token, pool: CONFIG_ASSET.pool, swapFee: 500, adapter: MANIFEST_ADAPTER, venue: 0 }]);
    expect(v.vaults.rmUSDC!.seedShareReceiver).toBe(sheet.shareReceiver);
    expect(v.vaults.rmPROTO!.feeRecipient).toBe("0x00000000000000000000000000000000000050fe"); // @safe resolves to the created Safe
    expect(v.timelockDelay).toBe(60);
  });

  test("the verifier sheet carries every deploy-time value of the sheet: voting power, quorum, periods, eligibility and the router default weights (issue 1520)", () => {
    const { ctx, sheet } = setup();
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe");
    expect(v.governance).toEqual({ voters: sheet.voters, voterPower: sheet.voterPower, quorum: sheet.quorum, votingPeriod: sheet.votingPeriod, executionDelay: sheet.executionDelay });
    // the example sheet makes PROTO and RWA eligible: rmUSDC always is, rmAGENT is not
    expect(Object.fromEntries(Object.entries(v.vaults).map(([k, x]) => [k, x.routerEligible]))).toEqual({ rmUSDC: true, rmPROTO: true, rmAGENT: false, rmRWA: true });
    expect(v.defaultWeights).toEqual([{ vault: "rmUSDC", bps: 6000 }, { vault: "rmPROTO", bps: 2500 }, { vault: "rmRWA", bps: 1500 }]);
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

  test("rmAGENT ships empty and needs no adapter", () => {
    const { ctx } = setup({}, { adapters: false });
    expect(loadExpectedAssets(ctx, "AGENT")).toEqual([]);
    expect(loadExpectedAssets(ctx, "USDC")).toEqual([]);
  });

  test("a failing check fails the stage with the VERIFY exit class", async () => {
    const { ctx } = setup();
    const manifest = { ...newManifest(ctx, "0xa"), firstBlock: 5 };
    const deps = { verifyDeployment: async () => ({ ok: false, checks: [{ label: "deployer holds no role", ok: false, detail: "x" }, { label: "seed", ok: true, detail: "" }] }), verifySources: async () => ({ ok: true, checks: [] }) };
    await expect(runVerifyStage({ ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext, stageByName("verify"), manifest, deps as never)).rejects.toMatchObject({ kind: "VERIFY" });
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
    for (const k of ["rmPROTO", "rmAGENT", "rmRWA"]) expect(v.vaults[k]!.expectPaused).toBe(true);
  });

  test("once an unpause row's executed phase is recorded, that vault (and no other) is expected paused=false", () => {
    const { ctx, sheet } = setup();
    const m = newManifest(ctx, "0xa");
    m.govern = Object.fromEntries(sheet.govern.unpauseVaults.map((k) => [`unpause-${k}`, { scheduled: { at: "t", tx_hash: "0x1" }, executed: { at: "t", tx_hash: "0x2" } }]));
    const unpaused = unpausedByGovern(m, sheet);
    expect(unpaused).toEqual(sheet.govern.unpauseVaults);
    expect(unpaused.length).toBeGreaterThan(0);
    const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe", unpaused);
    expect(v.vaults.rmUSDC!.expectPaused).toBe(false);
    for (const [k, name] of [["PROTO", "rmPROTO"], ["AGENT", "rmAGENT"], ["RWA", "rmRWA"]] as const) expect(v.vaults[name]!.expectPaused).toBe(!unpaused.includes(k));
    // rmAGENT stays paused unless the sheet lists it: pause semantics are sheet data
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
});

describe("stage 12 on 8453: all three basket unpauses must have executed (issue 1581)", () => {
  const exec = { scheduled: { at: "t", tx_hash: "0x1" }, executed: { at: "t", tx_hash: "0x2" } };
  async function run(govern: Record<string, unknown>) {
    const { ctx } = setup({}, { chain: 8453 });
    const mctx = { ...ctx, evidenceDir: join(ctx.coreDir, "ev") } as RunContext;
    const manifest = { ...newManifest(mctx, "0xa"), firstBlock: 5, govern };
    let seen: any;
    const deps = { verifyDeployment: async (o: any) => { seen = o; return { ok: true, checks: [{ label: "x", ok: true, detail: "" }] }; }, verifySources: async () => ({ ok: true, checks: [] }), emit: () => {}, recorderSpawn: (() => ({ status: 0, stdout: "", stderr: "" })) as never };
    let err: any;
    try { await runVerifyStage(mctx, stageByName("verify"), manifest as never, deps as never); } catch (e) { err = e; }
    return { err, seen, manifest };
  }

  test("a govern run that executed only unpause-PROTO fails with the named labels for the two unrun baskets", async () => {
    const { err, seen } = await run({ "unpause-PROTO": exec });
    expect(err).toMatchObject({ kind: "VERIFY" });
    expect(err.message).toContain("govern unpause-AGENT executed (stage 13)");
    expect(err.message).toContain("govern unpause-RWA executed (stage 13)");
    expect(err.message).not.toContain("unpause-PROTO");
    // the verifier is told every basket must read unpaused, not just the executed ones
    for (const k of ["rmPROTO", "rmAGENT", "rmRWA"]) expect(seen.sheet.vaults[k].expectPaused).toBe(false);
  });

  test("no govern run at all fails for all three", async () => {
    const { err } = await run({});
    expect(err).toMatchObject({ kind: "VERIFY" });
    for (const k of ["PROTO", "AGENT", "RWA"]) expect(err.message).toContain(`govern unpause-${k} executed`);
  });

  test("a scheduled but not executed row does not count", async () => {
    const { err } = await run({ "unpause-PROTO": exec, "unpause-AGENT": exec, "unpause-RWA": { scheduled: exec.scheduled } });
    expect(err.message).toContain("govern unpause-RWA executed");
  });

  test("all three executed passes", async () => {
    const { err, manifest } = await run({ "unpause-PROTO": exec, "unpause-AGENT": exec, "unpause-RWA": exec });
    expect(err).toBeUndefined();
    expect((manifest as any).stages.verify.status).toBe("done");
  });
});
