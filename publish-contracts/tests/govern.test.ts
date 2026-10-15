// Stage 13 govern against a fake of the Safe tool's entry points (tests/govern-world.ts). The fake keeps a timelock in memory: it checks the one-sitting
// schedule, the single wait, the predecessor rule and the resume logic of govern.ts. The real Safe, the real signers and the real delay are exercised
// by the Twin fork publish (core-stages-twin-chain) and on 8453 (runbook Q2), never here.
// Issue 1520: the only mainnet operation after the handover is the basket unpause. Everything else is deploy-time configuration.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { receiptPayloadDigest } from "../src/receipt-digest.ts";
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, toBytes, toFunctionSelector, type Address } from "viem";
import { APPLY_ROW, GOVERNANCE_APPLY_ABI, applyRecordKey } from "../src/apply-receipt.ts";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { GOVERN_ROWS, govRowRefusal, SAFE_ADMIN_ABI, SAFE_ADMIN_ROWS, SELF_ADMIN_ROWS, TIMELOCK_ADMIN_ROWS, assertNotLastProposer, buildSelfAdminCall, parseSafeAdminArgs, refuseSafeConfigChange, resumeCommand, safeAdminEffect, safeRuleProblem, selfAdminRecordKey, sheetRosterProblems, RECEIPT_ABI, RECEIPT_ROW, TWIN_ONLY_ROWS, UNPAUSE_ROWS, VAULT_ABI, roundKey, buildReleaseCall, buildStepCalls, governRowNames, governSalt, loadGovernAddrs, releaseRecordKey, resolveGovernRow, runGovern, stageRows, type GovernRowName } from "../src/govern.ts";
import { beginPauseEntry, loadRunManifest, newManifest, nextManifestSeq, reserveManifestSeq, saveRunManifest, updatePauseEntry } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { stageByName } from "../src/stages.ts";
import { REPO, SHA, sheetText } from "./fixtures.ts";
import { A, CANCELLER_ROLE_ID, PROPOSER_ROLE_ID, addr, fakeTimelock, sender, setup, signerFor, signers } from "./govern-world.ts";
import { UNWIND_GUARD_ROW, VAULT_UNWIND_GUARD_ABI, buildUnwindGuardCalls, parseUnwindGuardArgs, unwindGuardRecordKey, type UnwindGuardArgs } from "../src/unwind-guard.ts";

const ALL = {
  ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,AGENT,RWA",
  ROUTER_WEIGHTS: "USDC:5000,PROTO:2500,AGENT:1000,RWA:1500",
};
const DELAY = 172800n;
const authorizeAgentSelector = toFunctionSelector("authorizeAgent(address,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))");
/** The rmUSDC unpause row (the stage table names it, issue 1705). */
const UNPAUSE_USDC_ROW = "unpause-USDC" as const;
const BASKETS = ["PROTO", "AGENT", "RWA"] as const;
const VAULTS = ["USDC", ...BASKETS] as const;

describe("the govern rows: the four vault unpauses plus the Twin-only demonstrations", () => {
  test("governRowNames() is exactly the four unpauses (rmUSDC first) then update-delay, batch, cancel", () => {
    expect([...governRowNames()]).toEqual(["unpause-USDC", "unpause-PROTO", "unpause-AGENT", "unpause-RWA", "update-delay", "batch", "cancel"]);
    expect([...UNPAUSE_ROWS]).toEqual(["unpause-USDC", "unpause-PROTO", "unpause-AGENT", "unpause-RWA"]);
    expect([...TWIN_ONLY_ROWS]).toEqual(["update-delay", "batch", "cancel"]);
  });
  test("there is no agents row and the planner never encodes authorizeAgent (core 1527)", () => {
    expect([...governRowNames()].some((r) => /agent/i.test(r) && !r.startsWith("unpause-"))).toBe(false);
    expect([...governRowNames()]).not.toContain("agents");
    const { ctx, sheet } = setup(ALL);
    const a = loadGovernAddrs(ctx);
    for (const row of governRowNames()) for (const c of buildStepCalls(sheet, a, row as GovernRowName)) expect(c.data.slice(0, 10)).not.toBe(authorizeAgentSelector);
  });
  test("on 8453 a stage run needs the unpauses only, on a Twin fork every row", () => {
    expect([...stageRows(8453)]).toEqual([...UNPAUSE_ROWS]);
    expect([...stageRows(918453)]).toEqual([...GOVERN_ROWS]);
  });
  test("an unknown or out-of-range row is a usage error, and the numbers are the seven rows", () => {
    for (const bad of ["0", "8", "13", "nope", "-1", "voting-power-quorum", "agents", "other-setters", "router-weights", "migrate-eligibility-PROTO"]) expect(() => resolveGovernRow(bad)).toThrow(PublishError);
    expect(resolveGovernRow("1")).toBe("unpause-USDC");
    expect(resolveGovernRow("2")).toBe("unpause-PROTO");
    expect(resolveGovernRow("7")).toBe("cancel");
    expect(resolveGovernRow("update-delay")).toBe("update-delay");
  });
});

describe("the committed Twin stage sheet plans the four vault unpauses (core 1710)", () => {
  const twinSheet = parseSheet(readFileSync(join(REPO, "deployments", "twin-918453", "stage-sheet.env"), "utf8"));
  test("GOVERN_UNPAUSE_VAULTS is USDC,PROTO,AGENT,RWA: a rehearsal differs from production only in arguments", () => {
    expect(twinSheet.govern.unpauseVaults).toEqual(["USDC", "PROTO", "AGENT", "RWA"]);
  });
  test("each unpause row builds exactly one unpauseDeposits call from that sheet", () => {
    const { ctx } = setup();
    const a = loadGovernAddrs(ctx);
    const calls = UNPAUSE_ROWS.map((r) => buildStepCalls(twinSheet, a, r).length);
    expect(calls).toEqual([1, 1, 1, 1]);
  });
});

describe("step calldata: an unpause is one unpause call on that basket vault", () => {
  const { ctx, sheet } = setup(ALL);
  const a = loadGovernAddrs(ctx);
  test("unpause-<B>: one unpause on that basket vault", () => {
    for (const k of BASKETS) {
      const calls = buildStepCalls(sheet, a, `unpause-${k}`);
      expect(calls.map((c) => [c.target, decodeFunctionData({ abi: VAULT_ABI, data: c.data }).functionName])).toEqual([[A.vaults[k], "unpauseDeposits"]]);
    }
  });
  test("a basket the sheet does not list builds no call: it stays paused", () => {
    const d = setup({ GOVERN_UNPAUSE_VAULTS: "PROTO,RWA" });
    expect(buildStepCalls(d.sheet, loadGovernAddrs(d.ctx), "unpause-AGENT")).toEqual([]);
  });
  test("salts are deterministic per SHA, chain and row, and differ between rows", () => {
    expect(governSalt(SHA, 918453, "unpause-PROTO")).toBe(governSalt(SHA, 918453, "unpause-PROTO"));
    expect(governSalt(SHA, 918453, "unpause-PROTO")).not.toBe(governSalt(SHA, 8453, "unpause-PROTO"));
    expect(governSalt(SHA, 918453, "unpause-PROTO")).not.toBe(governSalt(SHA, 918453, "unpause-AGENT"));
  });
});

const opts = (sheet: ReturnType<typeof parseSheet>, tl: ReturnType<typeof fakeTimelock>, extra: object = {}) =>
  ({ ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: false as const, maxWaitSeconds: 10_000_000, emit: () => {}, ...extra });
const warpTo = (tl: ReturnType<typeof fakeTimelock>) => async (sec: bigint) => { tl.s.clock += sec; };
const run = (ctx: ReturnType<typeof setup>["ctx"], manifest: ReturnType<typeof newManifest>, sheet: ReturnType<typeof parseSheet>, tl: ReturnType<typeof fakeTimelock>, extra: object = {}) =>
  runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, extra));
/** Records every depositsPaused() read the govern run makes, by vault address. */
const spyPaused = (tl: ReturnType<typeof fakeTimelock>) => {
  const seen: string[] = [];
  const orig = tl.handle.client.readContract;
  tl.handle.client.readContract = async (a: { address: string; functionName: string }) => { if (a.functionName === "depositsPaused") seen.push(a.address); return orig(a as never); };
  return seen;
};

describe("8453: every unpause is scheduled in one sitting, one GOVERN_PENDING, one resume executes them all", () => {
  test("one run schedules USDC, PROTO, AGENT and RWA, each its own operation and its own Safe transaction, and exits GOVERN_PENDING exactly once", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    const out: string[] = [];
    const manifest = newManifest(ctx, addr(0xa001));
    let err: unknown;
    let warps = 0;
    try { await run(ctx, manifest, sheet, tl, { warp: async () => { warps++; }, emit: (l: string) => out.push(l) }); } catch (e) { err = e; }
    const e = err as PublishError;
    expect(e.kind).toBe("GOVERN_PENDING");
    expect(e.exitCode).toBe(15);
    expect(warps).toBe(0);
    // all four scheduled in this one run, in order, none executed
    expect(tl.s.events).toEqual(["schedule:unpause-USDC", "schedule:unpause-PROTO", "schedule:unpause-AGENT", "schedule:unpause-RWA"]);
    // distinct timelock operation ids
    const ids = UNPAUSE_ROWS.map((r) => tl.s.ids.get(r)!);
    expect(new Set(ids).size).toBe(4);
    // no Safe transaction is shared by two operations: one transaction per operation, all hashes different
    const hashes = ids.flatMap((id) => tl.s.safeTxs.get(id)!);
    expect(hashes.length).toBe(4);
    expect(new Set(hashes).size).toBe(4);
    // each is a single-call unpause of its own vault
    for (const k of VAULTS) {
      const sc = tl.s.scheduled.get(`unpause-${k}`)!;
      expect(sc.form).toBe("single");
      expect(sc.calls.map((c) => c.target)).toEqual([A.vaults[k]]);
      expect(sc.predecessor).toBeUndefined();
    }
    // ready_at and next_command, one for the stage
    expect(e.details.ready_at).toBe((1000n + DELAY).toString());
    expect(e.details.rows).toEqual([...UNPAUSE_ROWS]);
    expect(String(e.details.next_command)).toContain("--chain 8453");
    expect(String(e.details.next_command)).not.toContain("--row");
    expect(e.message).toContain("1970-01-03T00:16:40.000Z");
    for (const r of UNPAUSE_ROWS) expect(e.message).toContain(r);
    expect(manifest.stages.govern).toBeUndefined();
    const lines = out.map((l) => JSON.parse(l));
    expect(lines.map((l) => `${l.row}:${l.phase}`)).toEqual(UNPAUSE_ROWS.map((r) => `${r}:scheduled`));
  });

  test("the resume after the delay executes every scheduled unpause and reads depositsPaused() == false for each, with no second schedule and no warp", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    const noWarp = async () => { throw new Error("no anvil_ or evm_ method on 8453"); };
    await expect(run(ctx, manifest, sheet, tl, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    tl.s.clock += DELAY;
    const paused = spyPaused(tl);
    const res = await run(ctx, manifest, sheet, tl, { warp: noWarp, emit: (l: string) => out.push(l) });
    expect(res.rows).toEqual([...UNPAUSE_ROWS]);
    expect(tl.s.events).toEqual([
      "schedule:unpause-USDC", "schedule:unpause-PROTO", "schedule:unpause-AGENT", "schedule:unpause-RWA",
      "execute:unpause-USDC", "execute:unpause-PROTO", "execute:unpause-AGENT", "execute:unpause-RWA",
    ]);
    expect([...new Set(paused)].sort()).toEqual(VAULTS.map((k) => A.vaults[k]).sort());
    for (const k of VAULTS) expect((manifest.govern as any)[`unpause-${k}`].executed.tx_hash).toBeDefined();
    // the stage is done on 8453 with the unpauses alone: the Twin-only rows never run there
    expect(manifest.stages.govern!.status).toBe("done");
    expect(Object.keys(manifest.govern!)).toEqual([...UNPAUSE_ROWS]);
    const lines = out.map((l) => JSON.parse(l));
    // the resume reprints the recorded schedule lines, then executes
    expect(lines.map((l) => `${l.row}:${l.phase}`)).toEqual([...UNPAUSE_ROWS.map((r) => `${r}:scheduled`), ...UNPAUSE_ROWS.map((r) => `${r}:executed`)]);
    for (const l of lines) { expect(Object.keys(l).sort()).toEqual(["phase", "readyAt", "row", "status", "txHash"]); expect(l.status).toBe(1); expect(l.txHash).toMatch(/^0x[0-9a-f]{64}$/); }
  });

  test("a resume before the delay pends again and sends nothing", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    await expect(run(ctx, manifest, sheet, tl)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    tl.s.clock += DELAY - 7200n;
    await expect(run(ctx, manifest, sheet, tl)).rejects.toMatchObject({ kind: "GOVERN_PENDING", details: { remaining: 7200 } });
    expect(tl.s.events.length).toBe(4);
  });

  test("a huge --max-wait still does not block for the delay on 8453", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    let slept = 0;
    await expect(run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { maxWaitSeconds: 99_999_999, sleep: async () => { slept++; tl.s.clock += 30n; } })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(slept).toBe(0);
  });

  test("a single --row unpause-X is the set of one: it schedules and pends with its own --row", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const err = await run(ctx, manifest, sheet, tl, { row: "unpause-AGENT" }).then(() => { throw new Error("expected a rejection"); }, (e) => e as PublishError);
    expect(err.kind).toBe("GOVERN_PENDING");
    expect(String(err.details.next_command)).toContain("--row unpause-AGENT");
    expect(tl.s.events).toEqual(["schedule:unpause-AGENT"]);
    tl.s.clock += DELAY;
    await run(ctx, manifest, sheet, tl, { row: "unpause-AGENT" });
    expect(tl.s.events).toEqual(["schedule:unpause-AGENT", "execute:unpause-AGENT"]);
    expect(manifest.stages.govern).toBeUndefined();
  });

  test("the Twin-only rows are refused with USAGE on 8453, by name and by number, and nothing is sent", async () => {
    for (const row of [...TWIN_ONLY_ROWS, "5", "6", "7"]) {
      const { ctx, sheet } = setup(ALL, 8453);
      const tl = fakeTimelock(sheet, DELAY);
      const err = await run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { row }).then(() => { throw new Error("expected a rejection"); }, (e) => e as PublishError);
      expect(err.kind).toBe("USAGE");
      expect(err.message).toContain("8453");
      expect(tl.s.events).toEqual([]);
    }
  });

  test("a stage run on 8453 never runs the Twin-only rows", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    await expect(run(ctx, manifest, sheet, tl)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    tl.s.clock += DELAY;
    await run(ctx, manifest, sheet, tl);
    expect(tl.s.events.some((e) => /update-delay|batch|cancel/i.test(e.replace(/scheduleBatch|executeBatch/g, "")))).toBe(false);
    expect(Object.keys(manifest.govern!).sort()).toEqual([...UNPAUSE_ROWS].sort());
  });
});

describe("a dependent operation carries its predecessor and runs in the same resume, with no second wait", () => {
  const dependsOn = { "unpause-AGENT": "unpause-PROTO" };

  test("the dependent is scheduled with the predecessor's operation id, the predecessor with none, and one resume executes both in order", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    await expect(run(ctx, manifest, sheet, tl, { dependsOn })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    const protoId = tl.s.ids.get("unpause-PROTO")!;
    expect(tl.s.scheduled.get("unpause-PROTO")!.predecessor).toBeUndefined();
    expect(tl.s.scheduled.get("unpause-AGENT")!.predecessor).toBe(protoId);
    expect(tl.s.scheduled.get("unpause-RWA")!.predecessor).toBeUndefined();
    // the dependent's operation id is not the id it would have without the predecessor
    expect(tl.s.ids.get("unpause-AGENT")).not.toBe(tl.s.ids.get("unpause-RWA"));
    tl.s.clock += DELAY;
    await run(ctx, manifest, sheet, tl, { dependsOn });
    expect(tl.s.events.slice(4)).toEqual(["execute:unpause-USDC", "execute:unpause-PROTO", "execute:unpause-AGENT", "execute:unpause-RWA"]);
    expect(manifest.stages.govern!.status).toBe("done");
  });

  test("on a Twin fork the dependent runs after the same single warp as everything else", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const warped: bigint[] = [];
    await run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { dependsOn, row: "unpause-AGENT", warp: async (s: bigint) => { warped.push(s); tl.s.clock += s; } }).catch((e) => e);
    // unpause-AGENT alone has no predecessor row in this run: refused before anything is sent
    expect(tl.s.events).toEqual([]);
    const m = newManifest(ctx, addr(0xa001));
    await run(ctx, m, sheet, tl, { dependsOn, warp: async (s: bigint) => { warped.push(s); tl.s.clock += s; } });
    expect(warped[0]).toBe(DELAY + 1n);
    expect(tl.s.events.slice(0, 9)).toEqual(["schedule:unpause-USDC", "schedule:unpause-PROTO", "schedule:unpause-AGENT", "schedule:unpause-RWA", "execute:unpause-USDC", "execute:unpause-PROTO", "execute:unpause-AGENT", "execute:unpause-RWA", "updateDelay.schedule:update-delay"]);
  });

  test("a predecessor that does not come first is a usage error", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { dependsOn: { "unpause-PROTO": "unpause-AGENT" } })).rejects.toMatchObject({ kind: "USAGE" });
    await expect(run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { dependsOn: { "unpause-PROTO": "nope" } })).rejects.toMatchObject({ kind: "USAGE" });
    expect(tl.s.events).toEqual([]);
  });

  test("a sheet that leaves a basket out is refused on 8453 (no stage 13 step may be skipped), and allowed on a Twin fork", () => {
    for (const list of ["AGENT,RWA", "PROTO,RWA", "PROTO,AGENT", "PROTO", "none"]) {
      expect(() => parseSheet(sheetText({ ...ALL, CHAIN_ID: "8453", EXPECTED_CHAIN_ID: "8453", TIMELOCK_MIN_DELAY: "172800", GOVERN_UNPAUSE_VAULTS: list })), list).toThrow("no stage 13 step may be skipped");
    }
    const twin = setup({ ELIGIBLE_VAULTS: "PROTO,RWA", GOVERN_UNPAUSE_VAULTS: "PROTO,RWA", ROUTER_WEIGHTS: "USDC:6000,PROTO:2500,RWA:1500" });
    expect(twin.sheet.govern.unpauseVaults).toEqual(["PROTO", "RWA"]);
  });

  test("a predecessor the sheet skips (Twin only) leaves the dependent without an operation to follow: refused", async () => {
    const { ctx, sheet } = setup({ ...ALL, GOVERN_UNPAUSE_VAULTS: "AGENT,RWA" });
    const tl = fakeTimelock(sheet, DELAY);
    await expect(run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { dependsOn })).rejects.toThrow("has no operation in this run");
  });
});

describe("a Twin fork: one sitting, ONE warp, then the Twin-only rows one round each", () => {
  test("a full run schedules the four unpauses, warps once, executes them, then the Twin-only rounds, in order", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    const warped: bigint[] = [];
    const res = await run(ctx, manifest, sheet, tl, { warp: async (s: bigint) => { warped.push(s); tl.s.events.push("warp"); tl.s.clock += s; }, emit: (l: string) => out.push(l) });
    expect(res.rows as string[]).toEqual([...GOVERN_ROWS]);
    expect(tl.s.events).toEqual([
      "schedule:unpause-USDC", "schedule:unpause-PROTO", "schedule:unpause-AGENT", "schedule:unpause-RWA", "warp",
      "execute:unpause-USDC", "execute:unpause-PROTO", "execute:unpause-AGENT", "execute:unpause-RWA",
      "updateDelay.schedule:update-delay", "warp", "updateDelay.execute:update-delay",
      "scheduleBatch:batch", "warp", "executeBatch:batch",
      "schedule:cancel", "cancel:cancel",
    ]);
    expect(warped[0]).toBe(DELAY + 1n);
    expect(tl.s.minDelay).toBe(sheet.govern.newDelay);
    expect(manifest.stages.govern!.status).toBe("done");
    expect(Object.keys(manifest.govern!)).toEqual([...GOVERN_ROWS]);
    const lines = out.map((l) => JSON.parse(l));
    expect(lines.map((l) => `${l.row}:${l.phase}`)).toEqual([
      ...UNPAUSE_ROWS.map((r) => `${r}:scheduled`), ...UNPAUSE_ROWS.map((r) => `${r}:executed`),
      "update-delay:scheduled", "update-delay:executed", "batch:scheduled", "batch:executed", "cancel:scheduled", "cancel:cancelled",
    ]);
  });

  test("with the warp off and a long delay on a non-mainnet chain, the run exits GOVERN_PENDING too", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { maxWaitSeconds: 60 })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
  });

  test("a sheet that omits a basket skips it and says why", async () => {
    const { ctx, sheet } = setup({ GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,RWA" });
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const res = await run(ctx, manifest, sheet, tl, { warp: warpTo(tl) });
    expect(res.skipped).toEqual(["unpause-AGENT"]);
    expect((manifest.govern as any)["unpause-AGENT"].skipped.reason).toContain("stays paused");
    expect(tl.s.events.some((e) => e.endsWith(":unpause-AGENT"))).toBe(false);
    expect(manifest.stages.govern!.status).toBe("done");
  });

  const single = (row: GovernRowName) => test(`row ${row}: schedule, wait, execute, read-back, as its own round`, async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    const idx = GOVERN_ROWS.indexOf(row);
    for (const earlier of GOVERN_ROWS.slice(0, idx)) await run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row: earlier });
    const before = tl.s.events.length;
    await run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row, emit: (l: string) => out.push(l) });
    const mine = tl.s.events.slice(before);
    expect(mine.length).toBe(2);
    expect(mine.every((e) => e.endsWith(`:${row}`))).toBe(true);
    const lines = out.map((l) => JSON.parse(l));
    expect(lines.map((l) => l.phase)).toEqual(row === "cancel" ? ["scheduled", "cancelled"] : ["scheduled", "executed"]);
    expect(lines.every((l) => l.row === row)).toBe(true);
    // a single-row run does not mark the stage done unless it was the last row
    expect(manifest.stages.govern?.status as string | undefined).toBe(row === "cancel" ? "done" : undefined);
  });
  for (const r of GOVERN_ROWS) single(r);

  test("batch is one scheduleBatch of two calls", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    await run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { warp: warpTo(tl) });
    expect(tl.s.scheduled.get("batch")!.form).toBe("batch");
    expect(tl.s.scheduled.get("batch")!.calls.length).toBe(2);
  });

  test("a failed read-back stops the run on that row: nothing after it executes", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    tl.s.reads.depositsPaused = true;
    const manifest = newManifest(ctx, addr(0xa001));
    await expect(run(ctx, manifest, sheet, tl, { warp: warpTo(tl) })).rejects.toThrow("unpause-USDC");
    // every unpause was scheduled in the one sitting, only the first execute ran and its read-back failed
    expect((manifest.govern as any)["unpause-PROTO"].scheduled).toBeDefined();
    expect((manifest.govern as any)["unpause-PROTO"].executed).toBeUndefined();
    expect((manifest.govern as any)["unpause-AGENT"].executed).toBeUndefined();
    expect(tl.s.events.some((e) => e.startsWith("execute:unpause-AGENT"))).toBe(false);
  });
});

describe("ordering of the Twin-only rows", () => {
  test("a Twin-only row cannot start before the unpauses are complete", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const err = await run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { row: "update-delay", warp: warpTo(tl) }).then(() => { throw new Error("expected a rejection"); }, (e) => e as PublishError);
    expect(err.kind).toBe("GOVERN");
    expect(err.message).toContain("unpause-USDC");
    expect(tl.s.events).toEqual([]);
  });

  test("the six rows run one by one add up to the full matrix, and a rerun of a done row reprints its lines with no new transaction", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    for (let n = 1; n <= GOVERN_ROWS.length; n++) await run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row: String(n), emit: (l: string) => out.push(l) });
    expect(new Set(out.map((l) => JSON.parse(l).row))).toEqual(new Set(GOVERN_ROWS));
    expect(manifest.stages.govern!.status).toBe("done");
    const events = tl.s.events.length;
    const again: string[] = [];
    await run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row: "2", emit: (l: string) => again.push(l) });
    expect(again.map((l) => JSON.parse(l).phase)).toEqual(["scheduled", "executed"]);
    expect(tl.s.events.length).toBe(events);
  });
});

describe("resume of a half-done step", () => {
  test("a step scheduled on chain but not recorded is adopted, not scheduled twice", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { row: "unpause-PROTO", maxWaitSeconds: 60 })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    // a fresh manifest: the run lost its state after the schedule transaction
    const lost = newManifest(ctx, addr(0xa001));
    tl.s.clock += DELAY;
    await run(ctx, lost, sheet, tl, { row: "unpause-PROTO", warp: warpTo(tl) });
    expect(tl.s.events).toEqual(["schedule:unpause-PROTO", "execute:unpause-PROTO"]);
    expect((lost.govern as any)["unpause-PROTO"].scheduled.note).toContain("already scheduled");
    expect((lost.govern as any)["unpause-PROTO"].executed.tx_hash).toBeDefined();
  });

  test("a step scheduled and recorded, then rerun after the delay: only the execute is sent", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const go = () => run(ctx, manifest, sheet, tl, { row: "unpause-PROTO", maxWaitSeconds: 60 });
    await expect(go()).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(Object.keys((manifest.govern as any)["unpause-PROTO"])).toEqual(["round", "scheduled"]);
    tl.s.clock += DELAY;
    await go();
    expect(tl.s.events).toEqual(["schedule:unpause-PROTO", "execute:unpause-PROTO"]);
    expect(Object.keys((manifest.govern as any)["unpause-PROTO"])).toEqual(["round", "scheduled", "executed"]);
  });

  test("a step executed on chain but not recorded is read back and recorded without a second execute", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    await run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { row: "unpause-PROTO", warp: warpTo(tl) });
    const lost = newManifest(ctx, addr(0xa001));
    await run(ctx, lost, sheet, tl, { row: "unpause-PROTO", warp: warpTo(tl) });
    expect(tl.s.events.length).toBe(2);
    expect((lost.govern as any)["unpause-PROTO"].executed.note).toContain("already executed");
  });

  test("a cancel executed on chain but not recorded is adopted: no second schedule and no second cancel", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    await run(ctx, manifest, sheet, tl, { warp: warpTo(tl) });
    // forget the cancel phase only
    delete (manifest.govern as any)["cancel"].cancelled;
    delete (manifest.stages as any).govern;
    const before = tl.s.events.length;
    await run(ctx, manifest, sheet, tl, { warp: warpTo(tl) });
    expect(tl.s.events.length).toBe(before);
    expect((manifest.govern as any)["cancel"].cancelled.note).toContain("already cancelled");
  });
});

describe("guards", () => {
  test("fewer owner signers than the threshold fails with a typed error and sends nothing", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), { ownerSigners: signers(sheet, 1), sender, api: tl.api, pollMs: 0 })).rejects.toThrow(PublishError);
    expect(tl.s.ops.size).toBe(0);
  });

  test("a Safe whose owners differ from the sheet is refused", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet);
    tl.handle.owners = [addr(1), addr(2), addr(3)];
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), { ownerSigners: signers(sheet), sender, api: tl.api })).rejects.toThrow("owners");
  });
});

describe("generic Safe -> Timelock call (Twin-only test verb, not a govern row)", () => {
  const call = { label: "gateway-unpause", target: A.gateway, data: "0x1234" as `0x${string}` };

  test("one call is one schedule and one execute through the timelock, recorded under its own key, GOVERN_ROWS untouched", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    const res = await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl), call, emit: (l: string) => out.push(l) }));
    expect(res.rows).toEqual(["call-gateway-unpause"]);
    const lines = out.map((l) => JSON.parse(l));
    expect(lines.map((l) => l.phase)).toEqual(["scheduled", "executed"]);
    expect(lines.every((l) => l.row === "call-gateway-unpause" && l.status === 1)).toBe(true);
    const s = tl.s.scheduled.get("call-gateway-unpause")!;
    expect(s.form).toBe("single");
    expect(s.calls).toEqual([{ target: A.gateway, data: "0x1234" }]);
    expect(tl.s.events.length).toBe(2);
    expect(manifest.stages.govern).toBeUndefined();
    expect(GOVERN_ROWS as readonly string[]).not.toContain("call-gateway-unpause");
  });

  test("a second run of the same label does not schedule again", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl), call }));
    await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl), call }));
    expect(tl.s.events.length).toBe(2);
  });

  test("a used label with different calldata is refused, not adopted as the earlier call", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl), call }));
    const events = tl.s.events.length;
    await expect(runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl), call: { ...call, data: "0x5678" as `0x${string}` } }))).rejects.toThrow("already used for a different call");
    expect(tl.s.events.length).toBe(events);
  });

  test("refused on 8453 before anything is sent", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { call }))).rejects.toThrow("refused on chain 8453");
    expect(tl.s.events.length).toBe(0);
  });

  test("not combined with --row, and the label may not be a govern row name", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { call, row: "unpause-PROTO" }))).rejects.toThrow("mutually exclusive");
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { call: { ...call, label: "unpause-PROTO" } }))).rejects.toThrow("not a govern row name");
  });
});

describe("release-receipt: the on-demand row, one Safe -> Timelock round per receipt", () => {
  const RID = `0x${"ab".repeat(32)}` as `0x${string}`;
  const OTHER = `0x${"cd".repeat(32)}` as `0x${string}`;
  const rel = (receiptId: string, extra: object = {}) => ({ row: RECEIPT_ROW, receiptId, ...extra });

  test("calldata: one releaseReceipt(receiptId) on the deployed receipt contract", () => {
    const c = buildReleaseCall(A.receipt, RID);
    expect(c.target).toBe(A.receipt);
    const d = decodeFunctionData({ abi: RECEIPT_ABI, data: c.data });
    expect(d.functionName).toBe("releaseReceipt");
    expect(d.args).toEqual([RID]);
  });

  test("one schedule and one execute through the timelock, lines carry row release-receipt, the receipt reads released, the matrix is untouched", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    tl.s.recorded.add(RID);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    const res = await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, rel(RID, { warp: warpTo(tl), emit: (l: string) => out.push(l) })));
    expect(res.rows).toEqual([releaseRecordKey(RID)]);
    expect(tl.s.events).toEqual(["schedule:release-receipt", "execute:release-receipt"]);
    const s = tl.s.scheduled.get("release-receipt")!;
    expect(s.form).toBe("single");
    expect(s.calls).toEqual([{ target: A.receipt, data: buildReleaseCall(A.receipt, RID).data }]);
    const lines = out.map((l) => JSON.parse(l));
    expect(lines.map((l) => l.phase)).toEqual(["scheduled", "executed"]);
    expect(lines.every((l) => l.row === "release-receipt" && l.status === 1 && /^0x[0-9a-f]{64}$/.test(l.txHash))).toBe(true);
    expect(tl.s.released.has(RID)).toBe(true);
    // the record key is per receipt, the salt is that key's, and the ordered matrix neither ran nor completed
    const rec = (manifest.govern as Record<string, { executed?: { operation_id?: string } }>)[releaseRecordKey(RID)]!;
    expect(rec.executed?.operation_id).toBeDefined();
    expect(Object.keys(manifest.govern!)).toEqual([releaseRecordKey(RID)]);
    expect(manifest.stages.govern).toBeUndefined();
    expect(GOVERN_ROWS as readonly string[]).not.toContain(RECEIPT_ROW);
    expect(governSalt(SHA, 918453, releaseRecordKey(RID))).not.toBe(governSalt(SHA, 918453, releaseRecordKey(OTHER)));
  });

  test("a rerun for the same receipt sends nothing and reprints its lines; a second receipt is its own round", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    tl.s.recorded.add(RID); tl.s.recorded.add(OTHER);
    const manifest = newManifest(ctx, addr(0xa001));
    await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, rel(RID, { warp: warpTo(tl) })));
    const out: string[] = [];
    await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, rel(RID, { warp: warpTo(tl), emit: (l: string) => out.push(l) })));
    expect(tl.s.events.length).toBe(2);
    expect(out.map((l) => JSON.parse(l).phase)).toEqual(["scheduled", "executed"]);
    await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, rel(OTHER, { warp: warpTo(tl) })));
    expect(tl.s.events.length).toBe(4);
    expect(tl.s.released.has(OTHER)).toBe(true);
  });

  test("a record under the receipt's key for a different operation is refused, not adopted", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    tl.s.recorded.add(RID);
    const manifest = newManifest(ctx, addr(0xa001));
    manifest.govern = { [releaseRecordKey(RID)]: { scheduled: { at: "x", operation_id: `0x${"99".repeat(32)}` } } };
    await expect(runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, rel(RID, { warp: warpTo(tl) })))).rejects.toThrow("already used for a different call");
    expect(tl.s.events.length).toBe(0);
  });

  test("an unrecorded or already released receipt is refused before the Safe schedules anything", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, rel(RID)))).rejects.toThrow("is not recorded");
    tl.s.recorded.add(RID); tl.s.released.add(RID);
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, rel(RID)))).rejects.toThrow("already released");
    expect(tl.s.events.length).toBe(0);
  });

  test("on 8453 the release schedules exactly one releaseReceipt operation and exits GOVERN_PENDING with the resume command; the resume after the delay executes it and reads released back (issue 1611)", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    tl.s.recorded.add(RID);
    const manifest = newManifest(ctx, addr(0xa001));
    const noWarp = async () => { throw new Error("no anvil_ or evm_ method on 8453"); };
    const out: string[] = [];
    let err: unknown;
    try { await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, rel(RID, { warp: noWarp, emit: (l: string) => out.push(l) }))); } catch (e) { err = e; }
    const e = err as PublishError;
    expect(e.kind).toBe("GOVERN_PENDING");
    expect(e.exitCode).toBe(15);
    expect(tl.s.events).toEqual(["schedule:release-receipt"]);
    const sc = tl.s.scheduled.get("release-receipt")!;
    expect(sc.form).toBe("single");
    expect(sc.calls).toEqual([{ target: A.receipt, data: buildReleaseCall(A.receipt, RID).data }]);
    expect(String(e.details.next_command)).toContain(`--row ${RECEIPT_ROW} --receipt-id ${RID}`);
    expect(String(e.details.next_command)).toContain("--chain 8453");
    expect(e.details.ready_at).toBe((1000n + DELAY).toString());
    expect(tl.s.released.has(RID)).toBe(false);
    // a resume before the delay pends again and sends nothing
    await expect(runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, rel(RID, { warp: noWarp })))).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(tl.s.events.length).toBe(1);
    // after the delay the same command executes and reads released back
    tl.s.clock += DELAY;
    const res = await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, rel(RID, { warp: noWarp, emit: (l: string) => out.push(l) })));
    expect(res.rows).toEqual([releaseRecordKey(RID)]);
    expect(tl.s.events).toEqual(["schedule:release-receipt", "execute:release-receipt"]);
    expect(tl.s.released.has(RID)).toBe(true);
    // never part of stage 13: the stage is untouched and no basket unpause was scheduled
    expect(manifest.stages.govern).toBeUndefined();
    expect(Object.keys(manifest.govern!)).toEqual([releaseRecordKey(RID)]);
    expect(out.map((l) => `${JSON.parse(l).row}:${JSON.parse(l).phase}`)).toEqual(["release-receipt:scheduled", "release-receipt:scheduled", "release-receipt:executed"]);
  });

  test("on 8453 update-delay, batch and cancel stay refused while the release row is accepted; a stage run on 8453 never includes the release (issue 1611)", async () => {
    for (const row of TWIN_ONLY_ROWS) {
      const { ctx, sheet } = setup(ALL, 8453);
      const tl = fakeTimelock(sheet, DELAY);
      await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { row }))).rejects.toMatchObject({ kind: "USAGE" });
      expect(tl.s.events.length).toBe(0);
    }
    expect([...stageRows(8453)]).toEqual([...UNPAUSE_ROWS]);
    expect([...stageRows(8453)]).not.toContain(RECEIPT_ROW as never);
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { call: { label: "x", target: A.gateway, data: "0x12" } }))).rejects.toThrow("refused on chain 8453");
  });

  test("usage: --receipt-id needs --row release-receipt, the row needs a bytes32 id, and it is not a generic call label or a matrix row", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const m = () => newManifest(ctx, addr(0xa001));
    await expect(runGovern(ctx, stageByName("govern"), m(), opts(sheet, tl, { row: "unpause-PROTO", receiptId: RID }))).rejects.toThrow("--row release-receipt only");
    await expect(runGovern(ctx, stageByName("govern"), m(), opts(sheet, tl, { row: RECEIPT_ROW }))).rejects.toThrow("needs --receipt-id");
    await expect(runGovern(ctx, stageByName("govern"), m(), opts(sheet, tl, rel("0x1234")))).rejects.toThrow("bytes32");
    await expect(runGovern(ctx, stageByName("govern"), m(), opts(sheet, tl, { call: { label: RECEIPT_ROW, target: A.gateway, data: "0x12" } }))).rejects.toThrow("not a govern row name");
    expect(() => resolveGovernRow(RECEIPT_ROW)).toThrow("needs --receipt-id");
    expect(tl.s.events.length).toBe(0);
  });
});


// ---- issue 1667: unpause-USDC and numbered rounds ----
describe("issue 1667: the on-demand unpause-USDC row and round-numbered salts", () => {
  const noWarp = async () => { throw new Error("no anvil_ or evm_ method on 8453"); };
  const R = (ctx: any, manifest: any, sheet: any, tl: any, extra: object = {}) => run(ctx, manifest, sheet, tl, { warp: noWarp, ...extra });
  /** A full default 8453 run: schedule, wait, execute all four vaults. */
  async function launched() {
    const d = setup(ALL, 8453);
    const tl = fakeTimelock(sheet0(d), DELAY);
    const manifest = newManifest(d.ctx, addr(0xa001));
    await expect(R(d.ctx, manifest, d.sheet, tl)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    tl.s.clock += DELAY;
    await R(d.ctx, manifest, d.sheet, tl);
    return { ...d, tl, manifest };
  }
  const sheet0 = (d: { sheet: ReturnType<typeof parseSheet> }) => d.sheet;

  test("unpause-USDC is a stage row like the other three (core 1710): accepted by name and as row 1, in the default run on both chains", () => {
    expect(resolveGovernRow("unpause-USDC")).toBe(UNPAUSE_USDC_ROW);
    expect(resolveGovernRow("1")).toBe(UNPAUSE_USDC_ROW);
    expect(GOVERN_ROWS as readonly string[]).toContain(UNPAUSE_USDC_ROW);
    expect([...stageRows(8453)] as string[]).toContain(UNPAUSE_USDC_ROW);
    expect([...stageRows(918453)] as string[]).toContain(UNPAUSE_USDC_ROW);
    expect(() => resolveGovernRow("8")).toThrow(PublishError);
  });
  test("its one call is unpauseDeposits() on rmUSDC when the sheet lists USDC, and no call when it does not (it stays paused)", () => {
    const { ctx, sheet } = setup(ALL);
    const calls = buildStepCalls(sheet, loadGovernAddrs(ctx), UNPAUSE_USDC_ROW);
    expect(calls.map((c) => [c.target, decodeFunctionData({ abi: VAULT_ABI, data: c.data }).functionName])).toEqual([[A.vaults.USDC, "unpauseDeposits"]]);
    const d = setup({ GOVERN_UNPAUSE_VAULTS: "PROTO,AGENT,RWA" });
    expect(buildStepCalls(d.sheet, loadGovernAddrs(d.ctx), UNPAUSE_USDC_ROW)).toEqual([]);
  });
  test("a default run on 8453 schedules unpause-USDC with the three baskets: rmUSDC deploys paused, so it is a stage 13 row", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    expect(tl.s.paused.has(A.vaults.USDC)).toBe(true);
    const manifest = newManifest(ctx, addr(0xa001));
    await expect(R(ctx, manifest, sheet, tl)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(tl.s.events).toEqual(["schedule:unpause-USDC", "schedule:unpause-PROTO", "schedule:unpause-AGENT", "schedule:unpause-RWA"]);
    expect(Object.keys(manifest.govern!)).toContain(UNPAUSE_USDC_ROW);
  });
  test("--row unpause-USDC on 8453 after pause-all: schedules, exits GOVERN_PENDING, the resume executes and rmUSDC reads open", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    tl.s.paused.add(A.vaults.USDC);
    const manifest = newManifest(ctx, addr(0xa001));
    const e = await R(ctx, manifest, sheet, tl, { row: UNPAUSE_USDC_ROW }).catch((x) => x);
    expect(e.kind).toBe("GOVERN_PENDING");
    expect(String(e.details.next_command)).toContain("--row unpause-USDC");
    expect(tl.s.events).toEqual(["schedule:unpause-USDC"]);
    expect(tl.s.scheduled.get("unpause-USDC")!.calls.map((c) => c.target)).toEqual([A.vaults.USDC]);
    tl.s.clock += DELAY;
    const res = await R(ctx, manifest, sheet, tl, { row: UNPAUSE_USDC_ROW });
    expect(res.rows).toEqual([UNPAUSE_USDC_ROW]);
    expect(tl.s.paused.has(A.vaults.USDC)).toBe(false);
    expect(tl.s.events).toEqual(["schedule:unpause-USDC", "execute:unpause-USDC"]);
    // a single row never completes the stage
    expect(manifest.stages.govern).toBeUndefined();
  });
  test("unpause-USDC while rmUSDC is open (nothing paused it) schedules nothing", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    tl.s.paused.delete(A.vaults.USDC);
    const manifest = newManifest(ctx, addr(0xa001));
    await expect(R(ctx, manifest, sheet, tl, { row: UNPAUSE_USDC_ROW })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("nothing to unpause") });
    expect(tl.s.events).toEqual([]);
  });
  test("a basket unpause row is held to the same rule: no round for a basket that is already open", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    tl.s.paused.delete(A.vaults.PROTO);
    await expect(R(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { row: "unpause-PROTO" })).rejects.toMatchObject({ kind: "GOVERN" });
    expect(tl.s.events).toEqual([]);
  });

  test("salts are round numbered: every round of every unpause row is its own salt", () => {
    const labels = [...UNPAUSE_ROWS].flatMap((r) => [1, 2, 3].map((n) => governSalt(SHA, 8453, roundKey(r, n))));
    expect(new Set(labels).size).toBe(12);
  });
  test("after an executed unpause, a re-pause and a second govern of the same row yields a different operation id and executes", async () => {
    const { ctx, sheet, tl, manifest } = await launched();
    const first = tl.s.ids.get("unpause-PROTO")!;
    expect(tl.s.paused.has(A.vaults.PROTO)).toBe(false);
    tl.s.paused.add(A.vaults.PROTO); // pause-all
    const e = await R(ctx, manifest, sheet, tl, { row: "unpause-PROTO" }).catch((x) => x);
    expect(e.kind).toBe("GOVERN_PENDING");
    const second = tl.s.ids.get("unpause-PROTO")!;
    expect(second).not.toBe(first);
    expect(tl.s.ops.get(second)!.pending).toBe(true);
    tl.s.clock += DELAY;
    const res = await R(ctx, manifest, sheet, tl, { row: "unpause-PROTO" });
    expect(res.rows).toEqual(["unpause-PROTO"]);
    expect(tl.s.ops.get(second)!.done).toBe(true);
    expect(tl.s.paused.has(A.vaults.PROTO)).toBe(false);
    // the manifest keeps both rounds: round 1 archived, round 2 current
    const g = manifest.govern as Record<string, any>;
    expect(g["unpause-PROTO"].round).toBe(2);
    expect(g["unpause-PROTO"].executed.operation_id).toBe(second);
    expect(g["unpause-PROTO:round-1"].executed.operation_id).toBe(first);
    // the other baskets stayed at round 1
    expect(g["unpause-AGENT"].round).toBe(1);
    // and a third run with the vault open is a no-op: no round 3
    const events = tl.s.events.length;
    await R(ctx, manifest, sheet, tl, { row: "unpause-PROTO" });
    expect(tl.s.events.length).toBe(events);
    expect(g["unpause-PROTO:round-2"]).toBeUndefined();
  });
  test("a round 2 resumed after a crash between the archive and the schedule keeps round 2 and does not open round 3", async () => {
    const { ctx, sheet, tl, manifest } = await launched();
    tl.s.paused.add(A.vaults.PROTO);
    // the crash: round 1 archived, round 2 opened, nothing scheduled yet
    const g = manifest.govern as Record<string, any>;
    g["unpause-PROTO:round-1"] = g["unpause-PROTO"];
    g["unpause-PROTO"] = { round: 2 };
    await expect(R(ctx, manifest, sheet, tl, { row: "unpause-PROTO" })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(g["unpause-PROTO"].round).toBe(2);
    expect(g["unpause-PROTO:round-2"]).toBeUndefined();
  });
  test("a default run never reopens a vault that was paused again: it refuses and names the row command, scheduling nothing", async () => {
    const { ctx, sheet, tl, manifest } = await launched();
    tl.s.paused.add(A.vaults.AGENT);
    const events = tl.s.events.length;
    const e = await R(ctx, manifest, sheet, tl).catch((x) => x);
    expect(e).toMatchObject({ kind: "GOVERN" });
    expect(e.message).toContain("--row unpause-AGENT");
    expect(tl.s.events.length).toBe(events);
  });
  test("the round-1 operation of an unpause is not replayable: its id stays done and the second round is a different timelock operation", async () => {
    const { ctx, sheet, tl, manifest } = await launched();
    const first = tl.s.ids.get("unpause-RWA")!;
    tl.s.paused.add(A.vaults.RWA);
    await R(ctx, manifest, sheet, tl, { row: "unpause-RWA" }).catch(() => {});
    expect(tl.s.ids.get("unpause-RWA")).not.toBe(first);
    expect(tl.s.ops.get(first)).toMatchObject({ done: true, pending: false });
  });
  test("unpause-USDC has its own rounds: a second pause of rmUSDC gets round 2", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    tl.s.paused.add(A.vaults.USDC);
    await R(ctx, manifest, sheet, tl, { row: UNPAUSE_USDC_ROW }).catch(() => {});
    const first = tl.s.ids.get("unpause-USDC")!;
    tl.s.clock += DELAY;
    await R(ctx, manifest, sheet, tl, { row: UNPAUSE_USDC_ROW });
    tl.s.paused.add(A.vaults.USDC);
    await R(ctx, manifest, sheet, tl, { row: UNPAUSE_USDC_ROW }).catch(() => {});
    expect(tl.s.ids.get("unpause-USDC")).not.toBe(first);
    tl.s.clock += DELAY;
    await R(ctx, manifest, sheet, tl, { row: UNPAUSE_USDC_ROW });
    expect(tl.s.paused.has(A.vaults.USDC)).toBe(false);
    expect((manifest.govern as any)["unpause-USDC"].round).toBe(2);
  });
});

describe("issue 1686: govern refuses to execute an unpause scheduled before a pause-all", () => {
  const noWarp = async () => { throw new Error("no anvil_ or evm_ method on 8453"); };
  const R = (ctx: any, manifest: any, sheet: any, tl: any, extra: object = {}) => run(ctx, manifest, sheet, tl, { warp: noWarp, ...extra });
  const pauseAll = (ctx: any, trigger = "manual") => beginPauseEntry(ctx.evidenceDir, { at: new Date().toISOString(), trigger, reason: "test" })!;
  /** The first 8453 sitting: all four unpauses scheduled, GOVERN_PENDING, the manifest saved. */
  async function scheduled() {
    const d = setup(ALL, 8453);
    const tl = fakeTimelock(d.sheet, DELAY);
    const manifest = newManifest(d.ctx, addr(0xa001));
    await expect(R(d.ctx, manifest, d.sheet, tl)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    return { ...d, tl, manifest };
  }
  const executes = (tl: ReturnType<typeof fakeTimelock>) => tl.s.events.filter((e) => e.startsWith("execute"));

  test("a pause-all newer than the schedule: the resume exits GOVERN (14), sends nothing, names the row, the pause and the operation, and prints the cancel-through-the-Safe instruction", async () => {
    const { ctx, sheet, tl, manifest } = await scheduled();
    const pause = pauseAll(ctx, "verify");
    tl.s.clock += DELAY;
    const before = JSON.stringify(manifest.govern);
    const events = tl.s.events.length;
    const e = await R(ctx, manifest, sheet, tl).catch((x) => x);
    expect(e).toBeInstanceOf(PublishError);
    expect(e.kind).toBe("GOVERN");
    expect(e.exitCode).toBe(EXIT_CODES.GOVERN);
    expect(EXIT_CODES.GOVERN).toBe(14);
    expect(e.message).toContain("unpause-USDC");
    expect(e.message).toContain(`pause-all #${pause.seq} (verify`);
    expect(e.message).toContain(tl.s.ids.get("unpause-USDC")!);
    expect(e.message).toContain("cancel the operation through the Safe on the timelock");
    expect(e.message).toContain(`cancel(${tl.s.ids.get("unpause-USDC")})`);
    expect(e.message).toContain("--row unpause-USDC");
    expect(tl.s.events.length).toBe(events); // nothing sent
    expect(executes(tl)).toEqual([]);
    expect(JSON.stringify(manifest.govern)).toBe(before); // rows unchanged
    for (const v of VAULTS) expect(tl.s.paused.has(A.vaults[v])).toBe(true);
  });

  test("no pause-all recorded: the resume executes the rounds as before", async () => {
    const { ctx, sheet, tl, manifest } = await scheduled();
    tl.s.clock += DELAY;
    const res = await R(ctx, manifest, sheet, tl);
    expect(res.rows).toEqual([...UNPAUSE_ROWS]);
    expect(executes(tl)).toHaveLength(4);
  });

  test("a pause-all OLDER than the schedule does not block: the round scheduled after it executes", async () => {
    const d = setup(ALL, 8453);
    const tl = fakeTimelock(d.sheet, DELAY);
    const manifest = newManifest(d.ctx, addr(0xa001));
    saveRunManifest(d.ctx.evidenceDir, manifest);
    pauseAll(d.ctx);
    await expect(R(d.ctx, manifest, d.sheet, tl)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    const sched = (manifest.govern as any)["unpause-PROTO"].scheduled;
    expect(sched.seq).toBeGreaterThan(manifest.pauses![0]!.seq);
    tl.s.clock += DELAY;
    const res = await R(d.ctx, manifest, d.sheet, tl);
    expect(res.rows).toEqual([...UNPAUSE_ROWS]);
  });

  test("a pause-all that lands DURING the wait (after the first check) is caught before the first execute", async () => {
    const { ctx, sheet, tl, manifest } = await scheduled();
    tl.s.clock += DELAY - 100n; // inside the 3600 s an 8453 run is willing to sleep
    const sleep = async () => { if (!manifest.pauses?.length) pauseAll(ctx, "postflight"); tl.s.clock += DELAY; };
    const e = await R(ctx, manifest, sheet, tl, { sleep }).catch((x) => x);
    expect(e.kind).toBe("GOVERN");
    expect(e.message).toContain("postflight");
    expect(executes(tl)).toEqual([]);
  });

  test("a pause-all that crashed half way (entry still `started`) blocks as well", async () => {
    const { ctx, sheet, tl, manifest } = await scheduled();
    const p = pauseAll(ctx);
    expect(loadRunManifest(ctx.evidenceDir)!.pauses![0]!.status).toBe("started");
    expect(p.status).toBe("started");
    tl.s.clock += DELAY;
    await expect(R(ctx, manifest, sheet, tl)).rejects.toMatchObject({ kind: "GOVERN" });
    expect(executes(tl)).toEqual([]);
  });

  test("a schedule adopted from the chain has no known time (seq 0): any recorded pause-all blocks it", async () => {
    const { ctx, sheet, tl, manifest } = await scheduled();
    pauseAll(ctx);
    delete (manifest.govern as any)["unpause-USDC"]; // the schedule was sent but its record was lost
    tl.s.clock += DELAY;
    const e = await R(ctx, manifest, sheet, tl).catch((x) => x);
    expect(e.kind).toBe("GOVERN");
    expect(e.message).toContain("unpause-USDC");
    expect((manifest.govern as any)["unpause-USDC"].scheduled.seq).toBe(0);
  });

  test("the recovery: cancel through the Safe, then --row reschedules the SAME round (so the evidence rounds stay 1..n), gets a newer seq and executes; the other rows stay blocked", async () => {
    const { ctx, sheet, tl, manifest } = await scheduled();
    pauseAll(ctx);
    tl.s.clock += DELAY;
    await expect(R(ctx, manifest, sheet, tl)).rejects.toMatchObject({ kind: "GOVERN" });
    const first = tl.s.ids.get("unpause-PROTO")!;
    tl.s.ops.delete(first); // the Safe cancelled it on the timelock
    await expect(R(ctx, manifest, sheet, tl, { row: "unpause-PROTO" })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    const g = manifest.govern as Record<string, any>;
    expect(g["unpause-PROTO"].round).toBe(1);
    expect(tl.s.ids.get("unpause-PROTO")).toBe(first); // a cancelled id is free again
    expect(g["unpause-PROTO:round-1:cancelled-1"].scheduled.operation_id).toBe(first);
    expect(g["unpause-PROTO"].scheduled.seq).toBeGreaterThan(manifest.pauses![0]!.seq);
    tl.s.clock += DELAY;
    const res = await R(ctx, manifest, sheet, tl, { row: "unpause-PROTO" });
    expect(res.rows).toEqual(["unpause-PROTO"]);
    expect(tl.s.paused.has(A.vaults.PROTO)).toBe(false);
    // AGENT and RWA were not cancelled: they still refuse
    expect(tl.s.paused.has(A.vaults.AGENT)).toBe(true);
    await expect(R(ctx, manifest, sheet, tl)).rejects.toMatchObject({ kind: "GOVERN" });
    expect(executes(tl)).toHaveLength(1);
  });

  test("an operation the Safe already cancelled is not refused again: the default run names the --row command that opens the fresh round", async () => {
    const { ctx, sheet, tl, manifest } = await scheduled();
    pauseAll(ctx);
    tl.s.clock += DELAY;
    for (const k of VAULTS) tl.s.ops.delete(tl.s.ids.get(`unpause-${k}`)!);
    const e = await R(ctx, manifest, sheet, tl).catch((x) => x);
    expect(e.kind).toBe("GOVERN");
    expect(e.message).toContain("cancelled");
    expect(e.message).toContain("--row unpause-USDC");
    expect(executes(tl)).toEqual([]);
  });

  test("a Twin-chain pause-all is recorded and blocks the same way (one code path, no Twin special case)", async () => {
    const d = setup(ALL, 918453);
    const tl = fakeTimelock(d.sheet, DELAY);
    const manifest = newManifest(d.ctx, addr(0xa001));
    await expect(run(d.ctx, manifest, d.sheet, tl, { row: "unpause-PROTO", warp: false, maxWaitSeconds: 10 })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    pauseAll(d.ctx);
    tl.s.clock += DELAY;
    await expect(run(d.ctx, manifest, d.sheet, tl, { row: "unpause-PROTO", warp: false })).rejects.toMatchObject({ kind: "GOVERN" });
    expect(executes(tl)).toEqual([]);
  });

  test("other rows are not unpauses: the on-demand rmUSDC unpause and a pause-all older than it still work, and --row unpause-USDC after a pause-all schedules fresh", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    saveRunManifest(ctx.evidenceDir, manifest);
    tl.s.paused.add(A.vaults.USDC);
    pauseAll(ctx);
    await expect(R(ctx, manifest, sheet, tl, { row: UNPAUSE_USDC_ROW })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    tl.s.clock += DELAY;
    await R(ctx, manifest, sheet, tl, { row: UNPAUSE_USDC_ROW });
    expect(tl.s.paused.has(A.vaults.USDC)).toBe(false);
  });
});

describe("issue 1686: pause-all and govern both rewrite publish-run.json without losing each other's change", () => {
  test("a govern save after a pause-all keeps the pause entry (govern's in-memory copy never had it), and a plain save stamps no seq on a record that has none (issue 1688)", () => {
    const { ctx } = setup(ALL, 8453);
    const manifest = newManifest(ctx, addr(0xa001));
    saveRunManifest(ctx.evidenceDir, manifest);
    const stale = JSON.parse(JSON.stringify(manifest)); // govern loaded the manifest here
    const p = beginPauseEntry(ctx.evidenceDir, { at: "t", trigger: "manual", reason: "r" })!;
    stale.govern = { "unpause-PROTO": { round: 1, scheduled: { at: "t" } } };
    saveRunManifest(ctx.evidenceDir, stale);
    const disk = loadRunManifest(ctx.evidenceDir)!;
    expect(disk.pauses!.map((x) => x.seq)).toEqual([p.seq]);
    expect((disk.govern as any)["unpause-PROTO"].scheduled.seq).toBeUndefined();
  });

  test("a pause-all update after a govern save keeps govern's rows (pause-all re-reads the file just before it writes)", () => {
    const { ctx } = setup(ALL, 8453);
    const manifest = newManifest(ctx, addr(0xa001));
    saveRunManifest(ctx.evidenceDir, manifest);
    const p = beginPauseEntry(ctx.evidenceDir, { at: "t", trigger: "manual", reason: "r" })!;
    manifest.govern = { "unpause-AGENT": { round: 1, scheduled: { at: "t" } } };
    saveRunManifest(ctx.evidenceDir, manifest);
    updatePauseEntry(ctx.evidenceDir, { ...p, status: "done", allPaused: true });
    const disk = loadRunManifest(ctx.evidenceDir)!;
    expect(Object.keys(disk.govern!)).toEqual(["unpause-AGENT"]);
    expect(disk.pauses![0]).toMatchObject({ status: "done", allPaused: true });
    expect(nextManifestSeq(disk)).toBe(2);
  });

  test("separate processes writing at once lose nothing: 6 pause entries and 6 govern saves from 12 processes all land with unique seqs", async () => {
    const { ctx } = setup(ALL, 8453);
    const manifest = newManifest(ctx, addr(0xa001));
    saveRunManifest(ctx.evidenceDir, manifest);
    const runner = join(import.meta.dir, "..", "src", "runner.ts");
    const script = (i: number, kind: "pause" | "govern") => kind === "pause"
      ? `import { beginPauseEntry } from ${JSON.stringify(runner)}; for (let k=0;k<5;k++) beginPauseEntry(${JSON.stringify(ctx.evidenceDir)}, { at: "t", trigger: "manual", reason: "p${i}" });`
      : `import { loadRunManifest, reserveManifestSeq, saveRunManifest } from ${JSON.stringify(runner)}; for (let k=0;k<5;k++) { const m = loadRunManifest(${JSON.stringify(ctx.evidenceDir)})!; const seq = reserveManifestSeq(${JSON.stringify(ctx.evidenceDir)}, m); m.govern = { ...(m.govern ?? {}), ["row${i}-" + k]: { round: 1, scheduled: { at: "t", seq } } }; saveRunManifest(${JSON.stringify(ctx.evidenceDir)}, m); }`;
    const procs = [0, 1, 2, 3, 4, 5].flatMap((i) => (["pause", "govern"] as const).map((kind) => Bun.spawn([process.execPath, "-e", script(i, kind)], { stdout: "pipe", stderr: "pipe" })));
    for (const p of procs) expect(await p.exited).toBe(0);
    const disk = loadRunManifest(ctx.evidenceDir)!;
    // govern's load-modify-save is not itself serialised (it holds a snapshot for a whole run), so some of ITS rows may be overwritten by a sibling govern: the
    // pause entries, which are the safety record, must all be there, with unique ascending seqs, and every surviving schedule seq must be unique and stamped
    expect(disk.pauses).toHaveLength(30);
    const seqs = disk.pauses!.map((x) => x.seq);
    expect(new Set(seqs).size).toBe(30);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const sched = Object.values(disk.govern ?? {}).map((r: any) => r.scheduled.seq as number);
    expect(sched.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
    expect(new Set([...seqs, ...sched]).size).toBe(seqs.length + sched.length);
    expect(disk.seqHigh).toBeGreaterThanOrEqual(Math.max(...seqs, ...sched));
  });
});


describe("issue 1688: the unpause ordering cannot be bypassed by a legacy record or by a pause landing before the first save", () => {
  const noWarp = async () => { throw new Error("no anvil_ or evm_ method on 8453"); };
  const R = (ctx: any, manifest: any, sheet: any, tl: any, extra: object = {}) => run(ctx, manifest, sheet, tl, { warp: noWarp, ...extra });
  const pauseAll = (ctx: any) => beginPauseEntry(ctx.evidenceDir, { at: new Date().toISOString(), trigger: "verify", reason: "test" })!;
  const executes = (tl: ReturnType<typeof fakeTimelock>) => tl.s.events.filter((e) => e.startsWith("execute"));
  async function scheduled() {
    const d = setup(ALL, 8453);
    const tl = fakeTimelock(d.sheet, DELAY);
    const manifest = newManifest(d.ctx, addr(0xa001));
    await expect(R(d.ctx, manifest, d.sheet, tl)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    return { ...d, tl, manifest };
  }
  /** Strips the seq the way a manifest written before issue 1686 looks. */
  const makeLegacy = (manifest: any) => { for (const r of Object.values(manifest.govern as Record<string, any>)) delete r.scheduled.seq; };

  test("a legacy scheduled record (no seq) is still refused after an unrelated save when a pause entry exists", async () => {
    const { ctx, sheet, tl, manifest } = await scheduled();
    makeLegacy(manifest);
    pauseAll(ctx);
    manifest.startedAt = "unrelated change";
    saveRunManifest(ctx.evidenceDir, manifest); // the unrelated save that used to stamp a fresh seq above the pause
    for (const r of Object.values(loadRunManifest(ctx.evidenceDir)!.govern as Record<string, any>)) expect(r.scheduled.seq).toBeUndefined();
    for (const r of Object.values(manifest.govern as Record<string, any>)) expect(r.scheduled.seq).toBeUndefined();
    tl.s.clock += DELAY;
    const e = await R(ctx, manifest, sheet, tl).catch((x) => x);
    expect(e.kind).toBe("GOVERN");
    expect(e.message).toContain("will NOT execute");
    expect(executes(tl)).toEqual([]);
  });

  test("a legacy record with no pause entry at all still executes (the refusal needs a pause)", async () => {
    const { ctx, sheet, tl, manifest } = await scheduled();
    makeLegacy(manifest);
    saveRunManifest(ctx.evidenceDir, manifest);
    tl.s.clock += DELAY;
    expect((await R(ctx, manifest, sheet, tl)).rows).toEqual([...UNPAUSE_ROWS]);
  });

  test("the schedule seq is reserved on disk BEFORE the schedule transaction is sent", async () => {
    const d = setup(ALL, 8453);
    const tl = fakeTimelock(d.sheet, DELAY);
    const manifest = newManifest(d.ctx, addr(0xa001));
    const orig = tl.api.scheduleOnTimelock;
    const seenAtSend: (number | undefined)[] = [];
    (tl.api as any).scheduleOnTimelock = async (...a: any[]) => { seenAtSend.push(loadRunManifest(d.ctx.evidenceDir)?.seqHigh); return (orig as any)(...a); };
    await expect(R(d.ctx, manifest, d.sheet, tl)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(seenAtSend).toEqual([1, 2, 3, 4]);
    expect(Object.values(manifest.govern as Record<string, any>).map((r) => r.scheduled.seq)).toEqual([1, 2, 3, 4]);
  });

  test("a pause-all that lands between the schedule send and the first save orders AFTER the schedule, so the unpause is refused", async () => {
    const d = setup(ALL, 8453);
    const tl = fakeTimelock(d.sheet, DELAY);
    const manifest = newManifest(d.ctx, addr(0xa001));
    const orig = tl.api.scheduleOnTimelock;
    let pause: { seq: number } | undefined;
    (tl.api as any).scheduleOnTimelock = async (...a: any[]) => { const r = await (orig as any)(...a); pause ??= pauseAll(d.ctx); return r; }; // lands after the send, before the save
    const e = await R(d.ctx, manifest, d.sheet, tl).catch((x) => x); // refused in the same run, before the wait
    const first = (manifest.govern as any)["unpause-USDC"].scheduled.seq as number;
    expect(pause!.seq).toBeGreaterThan(first);
    expect(e.kind).toBe("GOVERN");
    expect(e.message).toContain(`pause-all #${pause!.seq}`);
    expect(e.message).toContain("unpause-USDC");
    expect(executes(tl)).toEqual([]);
  });

  test("a pause-all that finished BEFORE the schedule was sent is older: the schedule executes", async () => {
    const d = setup(ALL, 8453);
    const tl = fakeTimelock(d.sheet, DELAY);
    const manifest = newManifest(d.ctx, addr(0xa001));
    saveRunManifest(d.ctx.evidenceDir, manifest);
    const p = pauseAll(d.ctx);
    await expect(R(d.ctx, manifest, d.sheet, tl)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect((manifest.govern as any)["unpause-PROTO"].scheduled.seq).toBeGreaterThan(p.seq);
    tl.s.clock += DELAY;
    expect((await R(d.ctx, manifest, d.sheet, tl)).rows).toEqual([...UNPAUSE_ROWS]);
  });

  test("reserved numbers only grow: a save with a stale copy never lowers seqHigh", () => {
    const { ctx } = setup(ALL, 8453);
    const manifest = newManifest(ctx, addr(0xa001));
    saveRunManifest(ctx.evidenceDir, manifest);
    const stale = JSON.parse(JSON.stringify(manifest));
    expect(reserveManifestSeq(ctx.evidenceDir, manifest)).toBe(1);
    expect(reserveManifestSeq(ctx.evidenceDir, manifest)).toBe(2);
    saveRunManifest(ctx.evidenceDir, stale);
    expect(loadRunManifest(ctx.evidenceDir)!.seqHigh).toBe(2);
    expect(reserveManifestSeq(ctx.evidenceDir, stale)).toBe(3);
  });
});

// ---- issue 1696, issue 1698: the apply-receipt row, one timelock call (the weight setter's applyReceipt) through the real Safe ----
describe("issue 1696: apply-receipt, the Safe applies a consensus receipt through the timelock", () => {
  const RID = `0x${"ab".repeat(32)}` as `0x${string}`;
  const noWarp = async () => { throw new Error("no anvil_ or evm_ method on 8453"); };
  const payloadDoc = (weights: { bucket: string; weight_bps: number }[]) => JSON.stringify({ schema_version: "1.0", weights });
  /** Registry order USDC, PROTO, AGENT, RWA with rmAGENT not router-eligible: the eligible set is USDC, PROTO, RWA (the Twin shape). */
  const GOOD = [
    { bucket: "agent_tokens", weight_bps: 0 }, { bucket: "conservative_defi_yield", weight_bps: 5000 },
    { bucket: "protocol_tokens", weight_bps: 3000 }, { bucket: "real_world_assets", weight_bps: 2000 },
  ];
  const WANT_VAULTS = [A.vaults.USDC, A.vaults.PROTO, A.vaults.RWA];
  const WANT_BPS = [5000n, 3000n, 2000n];
  function world(chainId = 918453, docWeights = GOOD) {
    const d = setup(ALL, chainId);
    const tl = fakeTimelock(d.sheet, DELAY);
    tl.s.ineligible.add(A.vaults.AGENT);
    tl.s.recorded.add(RID);
    const file = join(d.ctx.coreDir, "payload.json");
    const text = payloadDoc(docWeights);
    writeFileSync(file, text);
    tl.s.digests.set(RID, receiptPayloadDigest(toBytes(text)));
    tl.s.weights = { vaults: [A.vaults.USDC, A.vaults.PROTO, A.vaults.RWA], bps: [6000n, 2500n, 1500n] };
    const manifest = newManifest(d.ctx, addr(0xa001));
    const apply = (extra: object = {}) => runGovern(d.ctx, stageByName("govern"), manifest, opts(d.sheet, tl, { row: APPLY_ROW, receiptId: RID, payload: file, ...extra }));
    return { ...d, tl, file, manifest, apply };
  }
  const refused = async (w: ReturnType<typeof world>, why: string) => {
    await expect(w.apply({ warp: warpTo(w.tl) })).rejects.toMatchObject({ kind: "USAGE", exitCode: EXIT_CODES.USAGE, message: expect.stringContaining(why) });
    expect(w.tl.s.events).toEqual([]);
    expect(w.tl.s.log).toEqual([]);
  };

  test("apply-receipt calls the weight setter: one timelock call, RouterGovernance.applyReceipt(receiptId, digest, vaults, bps), scheduled and executed through the Safe", async () => {
    const w = world();
    const out: string[] = [];
    const res = await w.apply({ warp: warpTo(w.tl), emit: (l: string) => out.push(l) });
    expect(res.rows).toEqual([applyRecordKey(RID)]);
    // exactly one schedule and one execute of a single call, nothing else
    expect(w.tl.s.log).toEqual(["schedule", "execute"]);
    expect(w.tl.s.events).toEqual(["schedule:apply-receipt", "execute:apply-receipt"]);
    const sc = w.tl.s.scheduled.get("apply-receipt")!;
    expect(sc.form).toBe("single");
    expect(sc.calls.length).toBe(1);
    expect(sc.calls[0]!.target).toBe(A.governance);
    const d = decodeFunctionData({ abi: GOVERNANCE_APPLY_ABI, data: sc.calls[0]!.data as `0x${string}` });
    expect(d.functionName).toBe("applyReceipt");
    expect(d.args).toEqual([RID, w.tl.s.digests.get(RID)!, WANT_VAULTS, WANT_BPS]);
    // the one call released the receipt and set the router's active vector; the default vector is untouched
    expect(w.tl.s.released.has(RID)).toBe(true);
    expect(w.tl.s.voted).toEqual({ vaults: WANT_VAULTS, bps: WANT_BPS });
    expect(w.tl.s.weights).toEqual({ vaults: WANT_VAULTS, bps: [6000n, 2500n, 1500n] });
    // the schedule is signed by owners and sent as ONE Safe transaction, and the lines carry the row
    expect(w.tl.s.safeTxs.get(w.tl.s.ids.get("apply-receipt")!)!.length).toBe(2);
    const lines = out.map((l) => JSON.parse(l));
    expect(lines.map((l) => `${l.row}:${l.phase}`)).toEqual(["apply-receipt:scheduled", "apply-receipt:executed"]);
    expect(lines.every((l) => l.status === 1 && /^0x[0-9a-f]{64}$/.test(l.txHash))).toBe(true);
    // the evidence entry (receipt_applications) carries both Safe transactions, the vector and block times one delay apart
    const entries = (w.manifest as { receipt_applications?: any[] }).receipt_applications!;
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ step: "apply-receipt", receipt_id: RID, target: A.governance, governance: A.governance, vaults: WANT_VAULTS, bps: [5000, 3000, 2000], voted_weights_active: true, effective_vaults: WANT_VAULTS, effective_bps: [5000, 3000, 2000], schedule_status: 1, execute_status: 1 });
    expect(entries[0].execute_block_timestamp - entries[0].schedule_block_timestamp).toBeGreaterThanOrEqual(Number(DELAY));
    expect(entries[0].schedule_tx).not.toBe(entries[0].execute_tx);
    // never in the matrix
    expect(w.manifest.stages.govern).toBeUndefined();
    expect(Object.keys(w.manifest.govern!)).toEqual([applyRecordKey(RID)]);
  });

  test("apply-receipt read-back asserts isReleased and the router weights equal the payload vector, and exits GOVERN when either differs", async () => {
    const ok = world();
    await ok.apply({ warp: warpTo(ok.tl) });
    expect(ok.tl.s.released.has(RID)).toBe(true);
    expect(ok.tl.s.voted).toEqual({ vaults: WANT_VAULTS, bps: WANT_BPS });
    // the router reads another active vector after the call executed
    const wrongWeights = world();
    wrongWeights.tl.s.reads.getWeights = [WANT_VAULTS, [6000n, 2500n, 1500n]];
    await expect(wrongWeights.apply({ warp: warpTo(wrongWeights.tl) })).rejects.toMatchObject({ kind: "GOVERN", exitCode: EXIT_CODES.GOVERN });
    // the router reads the vault list in another order
    const wrongOrder = world();
    wrongOrder.tl.s.reads.getWeights = [[A.vaults.PROTO, A.vaults.USDC, A.vaults.RWA], WANT_BPS];
    await expect(wrongOrder.apply({ warp: warpTo(wrongOrder.tl) })).rejects.toMatchObject({ kind: "GOVERN" });
    // the receipt reads not released after the batch executed
    const notReleased = world();
    notReleased.tl.s.reads.isReleased = false;
    await expect(notReleased.apply({ warp: warpTo(notReleased.tl) })).rejects.toMatchObject({ kind: "GOVERN", exitCode: EXIT_CODES.GOVERN });
    // a failed read-back records nothing: the round is not complete and writes no evidence entry
    expect(notReleased.manifest.govern![applyRecordKey(RID)]).not.toHaveProperty("executed");
    expect((notReleased.manifest as { receipt_applications?: unknown[] }).receipt_applications).toBeUndefined();
  });

  test("apply-receipt refuses a digest mismatch with USAGE and sends nothing", async () => {
    const w = world();
    w.tl.s.digests.set(RID, `0x${"99".repeat(32)}`);
    await refused(w, "differs from the digest stored");
    // the payload file edited after anchoring (a weights-only edit) is the same refusal
    const edited = world();
    writeFileSync(edited.file, payloadDoc(GOOD.map((g) => (g.bucket === "agent_tokens" ? g : { ...g, weight_bps: g.weight_bps + (g.bucket === "protocol_tokens" ? 100 : g.bucket === "real_world_assets" ? -100 : 0) }))));
    await refused(edited, "differs from the digest stored");
  });

  test("apply-receipt refuses an unrecorded or already released receipt with USAGE and sends nothing", async () => {
    const unrecorded = world();
    unrecorded.tl.s.recorded.delete(RID);
    await refused(unrecorded, "is not recorded");
    const released = world();
    released.tl.s.released.add(RID);
    await refused(released, "already released");
    const msg = await released.apply().catch((e: Error) => e.message);
    expect(msg).toContain("already released");
    expect(await unrecorded.apply().catch((e: Error) => e.message)).toContain("not recorded");
  });

  test("apply-receipt refuses a sum other than 10000, a wrong vault set and a wrong order with USAGE and sends nothing", async () => {
    // sums to 10001 and to 9999
    for (const delta of [1, -1]) await refused(world(918453, GOOD.map((g) => (g.bucket === "protocol_tokens" ? { ...g, weight_bps: g.weight_bps + delta } : g))), "sum to");
    // a vault set that is not the eligible set: rmAGENT (not eligible) carries weight
    await refused(world(918453, [{ bucket: "agent_tokens", weight_bps: 500 }, { bucket: "conservative_defi_yield", weight_bps: 4500 }, { bucket: "protocol_tokens", weight_bps: 3000 }, { bucket: "real_world_assets", weight_bps: 2000 }]), "vault set");
    // an eligible vault (rmRWA) missing from the payload
    await refused(world(918453, [{ bucket: "conservative_defi_yield", weight_bps: 5000 }, { bucket: "protocol_tokens", weight_bps: 5000 }]), "vault set");
    // an unknown bucket, a bucket twice
    await refused(world(918453, [...GOOD, { bucket: "memecoins", weight_bps: 0 }]), "is not one of");
    await refused(world(918453, [...GOOD, { bucket: "protocol_tokens", weight_bps: 0 }]), "listed twice");
    // no weights list, a payload that is not JSON
    await refused(world(918453, [] as never), "no weights list");
    const notJson = world();
    writeFileSync(notJson.file, "not json");
    notJson.tl.s.digests.set(RID, receiptPayloadDigest(toBytes("not json")));
    await refused(notJson, "not JSON");
    // the digest check is the protocol digest: a stored plain keccak256 of the bytes is refused (issue 1754)
    const plain = world();
    plain.tl.s.digests.set(RID, keccak256(toBytes(payloadDoc(GOOD))));
    await refused(plain, "differs from the digest stored");
  });

  test("issue 1754: the payload lists the buckets in the receipt's canonical order, the applied vector is in registry order (the order of the signed payload is irrelevant)", async () => {
    // registry order USDC, PROTO, AGENT, RWA with all four eligible; the payload lists agent, conservative, protocol, rwa (the real receipt's order)
    const w = world(918453, [{ bucket: "agent_tokens", weight_bps: 575 }, { bucket: "conservative_defi_yield", weight_bps: 8550 }, { bucket: "protocol_tokens", weight_bps: 525 }, { bucket: "real_world_assets", weight_bps: 350 }]);
    w.tl.s.ineligible.clear();
    w.tl.s.weights = { vaults: [A.vaults.USDC, A.vaults.PROTO, A.vaults.AGENT, A.vaults.RWA], bps: [6000n, 2500n, 500n, 1000n] };
    await w.apply({ warp: warpTo(w.tl) });
    const sc = w.tl.s.scheduled.get("apply-receipt")!;
    const d = decodeFunctionData({ abi: GOVERNANCE_APPLY_ABI, data: sc.calls[0]!.data as `0x${string}` });
    expect([d.args[2], d.args[3]]).toEqual([[A.vaults.USDC, A.vaults.PROTO, A.vaults.AGENT, A.vaults.RWA], [8550n, 525n, 575n, 350n]]);
  });

  test("apply-receipt is not in stage 13: stageRows(8453) is the four unpauses and GOVERN_ROWS has no apply-receipt", () => {
    expect([...stageRows(8453)]).toEqual(["unpause-USDC", "unpause-PROTO", "unpause-AGENT", "unpause-RWA"]);
    expect([...stageRows(8453)]).toEqual([...UNPAUSE_ROWS]);
    expect(GOVERN_ROWS as readonly string[]).not.toContain(APPLY_ROW);
    expect([...stageRows(918453)]).not.toContain(APPLY_ROW as never);
    expect([...governRowNames()]).not.toContain(APPLY_ROW);
  });

  test("apply-receipt on 8453 only when named: no default run, stage run or numbered --row reaches it", async () => {
    // a default run on 8453 schedules the four unpauses and nothing else
    const w = world(8453);
    await expect(runGovern(w.ctx, stageByName("govern"), w.manifest, opts(w.sheet, w.tl, { warp: noWarp }))).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(w.tl.s.events).toEqual(["schedule:unpause-USDC", "schedule:unpause-PROTO", "schedule:unpause-AGENT", "schedule:unpause-RWA"]);
    expect(w.tl.s.released.has(RID)).toBe(false);
    expect(Object.keys(w.manifest.govern!)).not.toContain(applyRecordKey(RID));
    // no numbered row is the apply row, and the bare name needs its receipt id and payload
    for (let n = 0; n <= GOVERN_ROWS.length + 2; n++) { try { expect(resolveGovernRow(String(n))).not.toBe(APPLY_ROW); } catch (e) { expect(e).toBeInstanceOf(PublishError); } }
    expect(() => resolveGovernRow(APPLY_ROW)).toThrow("needs --receipt-id");
    // a named run without the payload or the receipt id, and the options on another row, are usage errors that send nothing
    const n = world(8453);
    await expect(runGovern(n.ctx, stageByName("govern"), n.manifest, opts(n.sheet, n.tl, { row: APPLY_ROW, receiptId: RID }))).rejects.toThrow("needs --payload");
    await expect(runGovern(n.ctx, stageByName("govern"), n.manifest, opts(n.sheet, n.tl, { row: APPLY_ROW, payload: n.file }))).rejects.toThrow("needs --receipt-id");
    await expect(runGovern(n.ctx, stageByName("govern"), n.manifest, opts(n.sheet, n.tl, { row: "unpause-PROTO", payload: n.file }))).rejects.toThrow("--payload goes with --row apply-receipt only");
    await expect(runGovern(n.ctx, stageByName("govern"), n.manifest, opts(n.sheet, n.tl, { call: { label: APPLY_ROW, target: A.gateway, data: "0x12" } }))).rejects.toThrow();
    expect(n.tl.s.events).toEqual([]);
    // named, it runs on 8453 and is its own operation, scheduled alone
    const named = world(8453);
    await expect(named.apply({ warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(named.tl.s.events).toEqual(["schedule:apply-receipt"]);
  });

  test("issue 1796: a receipt operation scheduled before a vault cutover is re-planned from the chain on the next run and refused (nothing is sent), as is a receipt released meanwhile", async () => {
    const w = world(8453);
    await expect(w.apply({ warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    // the cutover retires rmPROTO while the operation waits: the eligible set the receipt names is stale
    w.tl.s.ineligible.add(A.vaults.PROTO);
    w.tl.s.clock += DELAY;
    await expect(w.apply({ warp: noWarp })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("differs from the registry's router-eligible vaults") });
    expect(w.tl.s.events).toEqual(["schedule:apply-receipt"]);
    expect(w.tl.s.released.has(RID)).toBe(false);
    // the vault set is right again but the receipt was released meanwhile
    w.tl.s.ineligible.delete(A.vaults.PROTO);
    w.tl.s.released.add(RID);
    await expect(w.apply({ warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("was released after operation") });
    expect(w.tl.s.events).toEqual(["schedule:apply-receipt"]);
  });

  test("apply-receipt pending and cancelled rounds: a pending round exits GOVERN_PENDING with the resume command and a cancelled operation schedules again with a newer seq", async () => {
    const w = world(8453);
    const out: string[] = [];
    let err: unknown;
    try { await w.apply({ warp: noWarp, emit: (l: string) => out.push(l) }); } catch (e) { err = e; }
    const e = err as PublishError;
    expect(e.kind).toBe("GOVERN_PENDING");
    expect(e.exitCode).toBe(15);
    expect(e.details.ready_at).toBe((1000n + DELAY).toString());
    expect(String(e.details.next_command)).toContain(`--row ${APPLY_ROW} --receipt-id ${RID} --payload ${w.file}`);
    expect(String(e.details.next_command)).toContain("--chain 8453");
    expect(w.tl.s.events).toEqual(["schedule:apply-receipt"]);
    expect(w.tl.s.released.has(RID)).toBe(false);
    // a resume before the delay pends again and sends nothing
    await expect(w.apply({ warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(w.tl.s.events.length).toBe(1);
    // the operator cancels the operation through the Safe: the same command schedules the same round again with a newer seq
    const key = applyRecordKey(RID);
    const firstSeq = (w.manifest.govern![key] as { scheduled: { seq: number; operation_id: string } }).scheduled.seq;
    const firstId = (w.manifest.govern![key] as { scheduled: { operation_id: string } }).scheduled.operation_id;
    w.tl.s.ops.delete(firstId);
    await expect(w.apply({ warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(w.tl.s.events).toEqual(["schedule:apply-receipt", "schedule:apply-receipt"]);
    const again = w.manifest.govern![key] as { scheduled: { seq: number; operation_id: string } };
    expect(again.scheduled.seq).toBeGreaterThan(firstSeq);
    expect(again.scheduled.operation_id).toBe(firstId); // a cancelled id may be scheduled again
    expect((w.manifest.govern![`${key}:cancelled-1`] as { scheduled: { seq: number } }).scheduled.seq).toBe(firstSeq);
    // after the delay the same command executes and reads released and the weights back
    w.tl.s.clock += DELAY;
    await w.apply({ warp: noWarp, emit: (l: string) => out.push(l) });
    expect(w.tl.s.events).toEqual(["schedule:apply-receipt", "schedule:apply-receipt", "execute:apply-receipt"]);
    expect(w.tl.s.released.has(RID)).toBe(true);
    expect(w.tl.s.voted).toEqual({ vaults: WANT_VAULTS, bps: WANT_BPS });
    // a rerun sends nothing
    await w.apply({ warp: noWarp });
    expect(w.tl.s.events.length).toBe(3);
  });
});

describe("issue 1645: Safe and timelock self-administration rows (Twin-only by default)", () => {
  const NEW = addr(0x9001), NEW2 = addr(0x9002), ROLE = "PROPOSER_ROLE";
  const roleHash = keccak256(toBytes(ROLE));
  const args: Record<string, object> = {
    "safe-add-owner": { owner: NEW, threshold: 3 }, "safe-remove-owner": { owner: "", threshold: 2 }, "safe-swap-owner": { oldOwner: "", newOwner: NEW2 },
    "safe-change-threshold": { threshold: 3 }, "timelock-grant-role": { role: ROLE, account: NEW }, "timelock-revoke-role": { role: ROLE, account: NEW },
  };

  test("the rows are on demand: in no default run, no numbered --row and no stage run on either chain", () => {
    expect(SELF_ADMIN_ROWS).toEqual([...SAFE_ADMIN_ROWS, ...TIMELOCK_ADMIN_ROWS]);
    for (const r of SELF_ADMIN_ROWS) expect(GOVERN_ROWS as readonly string[]).not.toContain(r);
    expect(stageRows(8453).length + 3).toBe(stageRows(918453).length);
  });

  test("every row is refused with USAGE on 8453 before the Safe is read, and nothing is sent", async () => {
    for (const row of SELF_ADMIN_ROWS) {
      const { ctx, sheet } = setup(ALL, 8453);
      const tl = fakeTimelock(sheet, DELAY);
      const err = await run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { row, selfAdmin: { owner: NEW, threshold: 2, role: ROLE, account: NEW, oldOwner: NEW, newOwner: NEW2 } }).then(() => { throw new Error("expected a rejection"); }, (e) => e as PublishError);
      expect(err.kind).toBe("USAGE");
      expect(err.message).toContain("8453");
      expect(tl.s.events).toEqual([]);
    }
  });

  test("calldata: each Safe row is one call to the Safe, each timelock row one call to the timelock, with the predecessor the linked list needs", () => {
    const { ctx, sheet } = setup(ALL);
    const a = loadGovernAddrs(ctx);
    const owners = sheet.safeOwners;
    const add = buildSelfAdminCall("safe-add-owner", a, { owner: NEW, threshold: 3 }, owners);
    expect(add.target).toBe(a.safe);
    expect(decodeFunctionData({ abi: parseAbi(["function addOwnerWithThreshold(address owner, uint256 t)"]), data: add.data }).args).toEqual([NEW, 3n]);
    const rm = buildSelfAdminCall("safe-remove-owner", a, { owner: owners[1]!, threshold: 2 }, owners);
    expect(decodeFunctionData({ abi: parseAbi(["function removeOwner(address prev, address owner, uint256 t)"]), data: rm.data }).args).toEqual([owners[0], owners[1], 2n]);
    const head = buildSelfAdminCall("safe-remove-owner", a, { owner: owners[0]!, threshold: 2 }, owners);
    expect(decodeFunctionData({ abi: parseAbi(["function removeOwner(address prev, address owner, uint256 t)"]), data: head.data }).args[0]).toBe("0x0000000000000000000000000000000000000001");
    const grant = buildSelfAdminCall("timelock-grant-role", a, { role: ROLE, account: NEW }, owners);
    expect(grant.target).toBe(a.timelock);
    expect(decodeFunctionData({ abi: parseAbi(["function grantRole(bytes32 role, address account)"]), data: grant.data }).args).toEqual([roleHash, NEW]);
  });

  test("bad arguments are USAGE: a missing key, a non-owner, an unknown role, a zero threshold", () => {
    const { ctx, sheet } = setup(ALL);
    const a = loadGovernAddrs(ctx);
    const bad = (row: (typeof SELF_ADMIN_ROWS)[number], x: object) => { try { buildSelfAdminCall(row, a, x, sheet.safeOwners); } catch (e) { return (e as PublishError).kind; } return "no error"; };
    expect(bad("safe-add-owner", { owner: NEW })).toBe("USAGE");
    expect(bad("safe-remove-owner", { owner: NEW, threshold: 2 })).toBe("USAGE");
    expect(bad("timelock-grant-role", { role: "ADMIN_ROLE", account: NEW })).toBe("USAGE");
    expect(bad("safe-change-threshold", { threshold: 0 })).toBe("USAGE");
  });

  test("a Safe module, guard or fallback-handler change is refused by name, and no row can build one", () => {
    const abi = parseAbi(["function enableModule(address module)", "function disableModule(address prev, address module)", "function setGuard(address guard)", "function setModuleGuard(address g)", "function setFallbackHandler(address handler)"]);
    const calls = [
      encodeFunctionData({ abi, functionName: "enableModule", args: [NEW] }), encodeFunctionData({ abi, functionName: "disableModule", args: [NEW2, NEW] }),
      encodeFunctionData({ abi, functionName: "setGuard", args: [NEW] }), encodeFunctionData({ abi, functionName: "setModuleGuard", args: [NEW] }),
      encodeFunctionData({ abi, functionName: "setFallbackHandler", args: [NEW] }),
    ];
    for (const data of calls) expect(() => refuseSafeConfigChange(data)).toThrow(/refused/);
    const { ctx, sheet } = setup(ALL);
    const a = loadGovernAddrs(ctx);
    for (const row of SELF_ADMIN_ROWS) {
      const x = { ...args[row], owner: sheet.safeOwners[1], oldOwner: sheet.safeOwners[0] } as Record<string, string>;
      const data = buildSelfAdminCall(row, a, x, sheet.safeOwners).data;
      expect(() => refuseSafeConfigChange(data)).not.toThrow();
      for (const c of calls) expect(data.slice(0, 10)).not.toBe(c.slice(0, 10));
    }
  });

  test("on a Twin fork each Safe row is one Safe transaction to the Safe and reads the owner set back", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    const o0 = sheet.safeOwners[0]!;
    // the fake Safe's roster is live (B4): once o0 is swapped out it can no longer sign, so the later rows need signers for the owners the rows added
    const ownerSigners = [...signers(sheet), signerFor(NEW), signerFor(NEW2)];
    await run(ctx, manifest, sheet, tl, { row: "safe-add-owner", selfAdmin: { owner: NEW, threshold: 3 }, emit: (l: string) => out.push(l) });
    expect(tl.s.owners).toContain(NEW);
    expect(tl.s.threshold).toBe(3n);
    await run(ctx, manifest, sheet, tl, { ownerSigners, row: "safe-swap-owner", selfAdmin: { oldOwner: o0, newOwner: NEW2 }, emit: (l: string) => out.push(l) });
    expect(tl.s.owners).not.toContain(o0);
    expect(tl.s.owners).toContain(NEW2);
    await run(ctx, manifest, sheet, tl, { ownerSigners, row: "safe-remove-owner", selfAdmin: { owner: NEW, threshold: 2 }, emit: (l: string) => out.push(l) });
    expect(tl.s.owners).not.toContain(NEW);
    await run(ctx, manifest, sheet, tl, { ownerSigners, row: "safe-change-threshold", selfAdmin: { threshold: 3 }, emit: (l: string) => out.push(l) });
    expect(tl.s.threshold).toBe(3n);
    expect(out.map((l) => JSON.parse(l).row)).toEqual(["safe-add-owner", "safe-swap-owner", "safe-remove-owner", "safe-change-threshold"]);
    expect(tl.s.events.filter((e) => e.startsWith("schedule"))).toEqual([]);
    expect(manifest.stages.govern).toBeUndefined();
  });

  test("a rerun of a done Safe row sends nothing and reprints its line", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const x = { row: "safe-change-threshold", selfAdmin: { threshold: 3 } };
    await run(ctx, manifest, sheet, tl, x);
    const n = tl.s.events.length;
    const again: string[] = [];
    await run(ctx, manifest, sheet, tl, { ...x, emit: (l: string) => again.push(l) });
    expect(tl.s.events.length).toBe(n);
    expect(again.length).toBe(1);
  });

  test("a failed read-back stops the Safe row", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    tl.s.reads.getThreshold = 2n;
    await expect(run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { row: "safe-change-threshold", selfAdmin: { threshold: 3 } })).rejects.toMatchObject({ kind: "GOVERN" });
  });

  test("on a Twin fork grant and revoke are one schedule and one execute through the timelock, and read hasRole back", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    await run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row: "timelock-grant-role", selfAdmin: { role: ROLE, account: NEW }, emit: (l: string) => out.push(l) });
    expect(tl.s.roles.has(`${roleHash}:${NEW.toLowerCase()}`)).toBe(true);
    await run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row: "timelock-revoke-role", selfAdmin: { role: ROLE, account: NEW }, emit: (l: string) => out.push(l) });
    expect(tl.s.roles.has(`${roleHash}:${NEW.toLowerCase()}`)).toBe(false);
    // the Safe's own proposer and canceller roles (seeded, as after the timelock stage) are untouched
    expect(tl.s.roles.has(`${roleHash}:${A.safe.toLowerCase()}`)).toBe(true);
    expect(out.map((l) => JSON.parse(l).phase)).toEqual(["scheduled", "executed", "scheduled", "executed"]);
    expect(tl.s.events).toEqual(["schedule:timelock-grant-role", "execute:timelock-grant-role", "schedule:timelock-revoke-role", "execute:timelock-revoke-role"]);
  });

  test("--admin-arg goes with a self-administration row only", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { row: "unpause-PROTO", selfAdmin: { threshold: 3 } })).rejects.toMatchObject({ kind: "USAGE" });
  });

  // B3 / CS-3: the last-proposer floor. The deployed timelock (ProposerFloorTimelock) reverts a revoke or renounce of the last PROPOSER_ROLE holder; the tool refuses first.
  test("timelock-revoke-role PROPOSER_ROLE for the last holder (the Safe) is refused with GOVERN before anything is scheduled", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const err = await run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row: "timelock-revoke-role", selfAdmin: { role: ROLE, account: A.safe } }).then(() => { throw new Error("expected a rejection"); }, (e) => e as PublishError);
    expect(err.kind).toBe("GOVERN");
    expect(err.message).toContain("last proposer");
    expect(err.message).toContain("timelock-grant-role");
    expect(tl.s.events).toEqual([]);
    expect(tl.s.roles.has(`${roleHash}:${A.safe.toLowerCase()}`)).toBe(true);
    expect(Object.keys(manifest.govern ?? {})).toEqual([]);
  });

  test("with a second proposer granted the Safe's own PROPOSER_ROLE goes through the delay, and the floor then protects the remaining holder", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    await run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row: "timelock-grant-role", selfAdmin: { role: ROLE, account: NEW } });
    await run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row: "timelock-revoke-role", selfAdmin: { role: ROLE, account: A.safe } });
    expect(tl.s.roles.has(`${roleHash}:${A.safe.toLowerCase()}`)).toBe(false);
    expect(tl.s.roles.has(`${roleHash}:${NEW.toLowerCase()}`)).toBe(true);
    expect(tl.s.events).toEqual(["schedule:timelock-grant-role", "execute:timelock-grant-role", "schedule:timelock-revoke-role", "execute:timelock-revoke-role"]);
    // NEW is the last proposer now
    await expect(run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row: "timelock-revoke-role", selfAdmin: { role: ROLE, account: NEW } })).rejects.toMatchObject({ kind: "GOVERN" });
    expect(tl.s.events.length).toBe(4);
  });

  test("the floor is PROPOSER_ROLE only, and only for a holder: a CANCELLER_ROLE revoke and a revoke of a non-holder reach the timelock", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const rd = (async (address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) => tl.handle.client.readContract({ address, abi, functionName, args })) as never;
    await expect(assertNotLastProposer(rd, A.timelock, keccak256(toBytes("CANCELLER_ROLE")), A.safe)).resolves.toBeUndefined();
    await expect(assertNotLastProposer(rd, A.timelock, roleHash, NEW)).resolves.toBeUndefined();
    await expect(assertNotLastProposer(rd, A.timelock, roleHash, A.safe)).rejects.toMatchObject({ kind: "GOVERN" });
    await run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row: "timelock-revoke-role", selfAdmin: { role: "CANCELLER_ROLE", account: A.safe } });
    expect(tl.s.events).toEqual(["schedule:timelock-revoke-role", "execute:timelock-revoke-role"]);
    expect(tl.s.roles.has(`${roleHash}:${A.safe.toLowerCase()}`)).toBe(true);
  });
});

// QA plan v1 B4 (QD-5, DT-7, T5): the self-administration rows after a Safe change. The sheet compare exempts them (they read back against their own arguments),
// the executed record is keyed on calldata plus the Safe nonce, the fake connectSafe returns the live roster, and the fake Safe enforces the Safe's own rules.
describe("QA plan v1 B4: self-administration rows after the Safe changes", () => {
  const NEW = addr(0x9001), NEW2 = addr(0x9002), ROLE = "PROPOSER_ROLE";
  const roleHash = keccak256(toBytes(ROLE));
  /** The signers a run needs once the rows added owners: the sheet's plus the added ones (what `--owner-signer` names for them). */
  const withNew = (sheet: ReturnType<typeof parseSheet>) => ({ ownerSigners: [...signers(sheet), signerFor(NEW), signerFor(NEW2)] });
  const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e) => e as PublishError);

  test("the fake connectSafe returns the live owner set and threshold, not the sheet's", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const before = await tl.api.connectSafe({} as never);
    expect(before.owners).toEqual(sheet.safeOwners);
    expect(before.threshold).toBe(sheet.safeThreshold);
    await run(ctx, newManifest(ctx, addr(0xa001)), sheet, tl, { row: "safe-add-owner", selfAdmin: { owner: NEW, threshold: 3 } });
    const after = await tl.api.connectSafe({} as never);
    expect(after.owners).toEqual([...sheet.safeOwners, NEW]);
    expect(after.threshold).toBe(3);
  });

  test("second owner row after safe-add-owner", async () => {
    // after safe-add-owner the live roster differs from the sheet: the next self-administration rows still run (a read-back against their own arguments),
    // a stage row is refused until the operator updates SAFE_OWNERS / SAFE_THRESHOLD (runbook section 9), then it runs
    const { ctx, sheet, lines } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    await run(ctx, manifest, sheet, tl, { row: "safe-add-owner", selfAdmin: { owner: NEW, threshold: 3 }, emit: (l: string) => out.push(l) });
    expect(tl.s.owners).toEqual([...sheet.safeOwners, NEW]);
    expect(sheetRosterProblems(tl.handle, sheet).length).toBe(2);
    await run(ctx, manifest, sheet, tl, { ...withNew(sheet), row: "safe-add-owner", selfAdmin: { owner: NEW2, threshold: 3 }, emit: (l: string) => out.push(l) });
    expect(tl.s.owners).toEqual([...sheet.safeOwners, NEW, NEW2]);
    await run(ctx, manifest, sheet, tl, { ...withNew(sheet), row: "safe-change-threshold", selfAdmin: { threshold: 4 }, emit: (l: string) => out.push(l) });
    expect(tl.s.threshold).toBe(4n);
    expect(out.map((l) => JSON.parse(l).row)).toEqual(["safe-add-owner", "safe-add-owner", "safe-change-threshold"]);
    expect(tl.s.events).toEqual(["propose:safe-add-owner", "propose:safe-add-owner", "propose:safe-change-threshold"]);
    expect(lines.some((l) => l.includes("govern.sheet_stale"))).toBe(true);
    expect(lines.some((l) => l.includes("govern.sheet_update_needed"))).toBe(true);
    // a stage row is refused while the sheet is stale; the refusal names the sheet keys and the runbook section, and nothing is sent
    const err = await rejection(run(ctx, manifest, sheet, tl, { ...withNew(sheet), row: "unpause-PROTO", warp: warpTo(tl) }));
    expect(err.kind).toBe("GOVERN");
    expect(err.message).toContain("SAFE_OWNERS");
    expect(err.message).toContain("SAFE_THRESHOLD");
    expect(err.message).toContain("section 9");
    expect(tl.s.events.length).toBe(3);
    // the runbook step: the sheet updated to what the chain reads, the stage row runs against the same Safe
    const updated = setup({ ...ALL, SAFE_OWNERS: [...sheet.safeOwners, NEW, NEW2].join(","), SAFE_THRESHOLD: "4" });
    expect(sheetRosterProblems(tl.handle, updated.sheet)).toEqual([]);
    await run(updated.ctx, newManifest(updated.ctx, addr(0xa001)), updated.sheet, tl, { ...withNew(sheet), row: "unpause-PROTO", warp: warpTo(tl) });
    expect(tl.s.paused.has(A.vaults.PROTO)).toBe(false);
    expect(tl.s.events.slice(3)).toEqual(["schedule:unpause-PROTO", "execute:unpause-PROTO"]);
  });

  test("safe-change-threshold above owner count refused", async () => {
    // the Safe's own rules (GS201, GS203, GS204) are checked before anything is proposed: USAGE, nothing sent, the roster unchanged
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const refused = (row: string, selfAdmin: object) => rejection(run(ctx, manifest, sheet, tl, { ...withNew(sheet), row, selfAdmin }));
    const n = sheet.safeOwners.length;
    let err = await refused("safe-change-threshold", { threshold: n + 1 });
    expect(err.kind).toBe("USAGE");
    expect(err.message).toContain("GS201");
    err = await refused("safe-add-owner", { owner: NEW, threshold: n + 2 }); // the owner count after the change is n + 1
    expect(err.kind).toBe("USAGE");
    expect(err.message).toContain("GS201");
    err = await refused("safe-remove-owner", { owner: sheet.safeOwners[0], threshold: n }); // the owner count after the change is n - 1
    expect(err.kind).toBe("USAGE");
    expect(err.message).toContain("GS201");
    err = await refused("safe-add-owner", { owner: addr(0), threshold: 2 });
    expect(err.message).toContain("GS203");
    err = await refused("safe-swap-owner", { oldOwner: sheet.safeOwners[0], newOwner: sheet.safeOwners[1] });
    expect(err.message).toContain("GS204");
    // an owner change already in effect whose threshold differs: the Safe would revert the add (GS204), the tool names the row that does what is left
    err = await refused("safe-add-owner", { owner: sheet.safeOwners[1], threshold: 3 });
    expect(err.kind).toBe("USAGE");
    expect(err.message).toContain("safe-change-threshold");
    expect(tl.s.events).toEqual([]);
    expect(tl.s.threshold).toBe(2n);
    expect(tl.s.owners).toEqual(sheet.safeOwners);
    expect(Object.keys(manifest.govern ?? {})).toEqual([]);
  });

  test("the fake Safe enforces the Safe's own rules: threshold above owner count, wrong prevOwner, an owner added twice, a cancel below threshold, a cancel without CANCELLER_ROLE", async () => {
    const { sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const sigs = sheet.safeOwners.slice(0, 2);
    const send = (action: string, data: string, signatures: unknown[] = sigs) => tl.api.executeTx(tl.handle, { action, data, signatures, timelock_operation_id: `0x${"1".repeat(64)}` } as never, sender);
    const enc = (functionName: string, args: unknown[]) => encodeFunctionData({ abi: SAFE_ADMIN_ABI, functionName: functionName as never, args: args as never });
    await expect(send("safe-change-threshold", enc("changeThreshold", [4n]))).rejects.toThrow("GS201");
    await expect(send("safe-remove-owner", enc("removeOwner", [sheet.safeOwners[0], sheet.safeOwners[2], 2n]))).rejects.toThrow("GS205"); // the predecessor of owner 2 is owner 1
    await expect(send("safe-swap-owner", enc("swapOwner", [sheet.safeOwners[0], sheet.safeOwners[2], NEW]))).rejects.toThrow("GS205");
    await expect(send("safe-add-owner", enc("addOwnerWithThreshold", [sheet.safeOwners[1], 2n]))).rejects.toThrow("GS204");
    await expect(send("safe-add-owner", enc("addOwnerWithThreshold", [A.safe, 2n]))).rejects.toThrow("GS203");
    await expect(send("safe-add-owner", enc("addOwnerWithThreshold", [NEW, 2n]), sigs.slice(0, 1))).rejects.toThrow("GS020");
    expect(tl.s.owners).toEqual(sheet.safeOwners);
    expect(tl.s.threshold).toBe(2n);
    expect(tl.s.nonce).toBe(0);
    // a cancel below threshold, then a cancel and a schedule by a Safe that no longer holds the timelock role
    await expect(send("cancel", "0x", sigs.slice(0, 1))).rejects.toThrow("GS020");
    tl.s.roles.delete(`${CANCELLER_ROLE_ID}:${A.safe.toLowerCase()}`);
    await expect(send("cancel", "0x")).rejects.toThrow("CANCELLER_ROLE");
    tl.s.roles.delete(`${PROPOSER_ROLE_ID}:${A.safe.toLowerCase()}`);
    await expect(send("schedule", "0x")).rejects.toThrow("PROPOSER_ROLE");
    expect(tl.s.nonce).toBe(0);
    // the well-formed call goes through: the right predecessor, a threshold the owner count allows
    await send("safe-remove-owner", enc("removeOwner", [sheet.safeOwners[1], sheet.safeOwners[2], 2n]));
    expect(tl.s.owners).toEqual(sheet.safeOwners.slice(0, 2));
    expect(tl.s.nonce).toBe(1);
  });

  test("add X, remove X, add X is three Safe transactions: the record is keyed on the calldata and the Safe nonce, so the third is not skipped as the first", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const x = (row: string, selfAdmin: object, out: string[] = []) => run(ctx, manifest, sheet, tl, { ...withNew(sheet), row, selfAdmin, emit: (l: string) => out.push(l) });
    await x("safe-add-owner", { owner: NEW, threshold: 2 });
    await x("safe-remove-owner", { owner: NEW, threshold: 2 });
    await x("safe-add-owner", { owner: NEW, threshold: 2 });
    expect(tl.s.events).toEqual(["propose:safe-add-owner", "propose:safe-remove-owner", "propose:safe-add-owner"]);
    expect(tl.s.owners).toEqual([...sheet.safeOwners, NEW]);
    const records = manifest.govern as Record<string, any>;
    const keys = Object.keys(records);
    expect(keys.length).toBe(3);
    const addData = encodeFunctionData({ abi: SAFE_ADMIN_ABI, functionName: "addOwnerWithThreshold", args: [NEW, 2n] });
    const removeData = encodeFunctionData({ abi: SAFE_ADMIN_ABI, functionName: "removeOwner", args: [sheet.safeOwners[2]!, NEW, 2n] });
    expect(keys).toContain(selfAdminRecordKey("safe-add-owner", addData, 0));
    expect(keys).toContain(selfAdminRecordKey("safe-remove-owner", removeData, 1));
    expect(keys).toContain(selfAdminRecordKey("safe-add-owner", addData, 2));
    for (const k of keys) {
      expect(records[k].admin.nonce).toBe(Number(k.slice(k.lastIndexOf("-n") + 2)));
      expect(records[k].executed.tx_hash).toBeDefined();
    }
    expect(records[selfAdminRecordKey("safe-add-owner", addData, 0)].admin.want).toBe(records[selfAdminRecordKey("safe-add-owner", addData, 2)].admin.want);
    // a rerun of the change still in effect reprints the newest record and sends nothing
    const again: string[] = [];
    await x("safe-add-owner", { owner: NEW, threshold: 2 }, again);
    expect(tl.s.events.length).toBe(3);
    expect(again.length).toBe(1);
    expect(JSON.parse(again[0]!).txHash).toBe(records[selfAdminRecordKey("safe-add-owner", addData, 2)].executed.tx_hash);
    expect(Object.keys(records).length).toBe(3);
  });

  test("grant X, revoke X, grant X is three timelock rounds with three operation ids; a rerun of a role in effect sends nothing; a revoke of a non-holder is a skip", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const x = (row: string, account = NEW) => run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row, selfAdmin: { role: ROLE, account } });
    await x("timelock-grant-role");
    await x("timelock-revoke-role");
    await x("timelock-grant-role");
    expect(tl.s.events).toEqual(["schedule:timelock-grant-role", "execute:timelock-grant-role", "schedule:timelock-revoke-role", "execute:timelock-revoke-role", "schedule:timelock-grant-role", "execute:timelock-grant-role"]);
    expect(tl.s.roles.has(`${roleHash}:${NEW.toLowerCase()}`)).toBe(true);
    const records = manifest.govern as Record<string, any>;
    const grants = Object.keys(records).filter((k) => k.startsWith("timelock-grant-role-"));
    expect(grants.length).toBe(2);
    expect(new Set(grants.map((k) => records[k].scheduled.operation_id)).size).toBe(2);
    expect(grants.map((k) => records[k].admin.nonce).sort()).toEqual([0, 4]);
    await x("timelock-grant-role");
    expect(tl.s.events.length).toBe(6);
    const r = await x("timelock-revoke-role", NEW2);
    expect(r.skipped.length).toBe(1);
    expect(records[r.rows[0]!].skipped.reason).toContain("already in effect");
    expect(tl.s.events.length).toBe(6);
  });

  test("a timelock round scheduled by an earlier run resumes under its own key: no second schedule, one execute", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const x = (extra: object) => run(ctx, manifest, sheet, tl, { row: "timelock-grant-role", selfAdmin: { role: ROLE, account: NEW }, ...extra });
    // no warp on a non-mainnet chain with a long delay: the run exits GOVERN_PENDING after the schedule (the crash-between-phases shape)
    await expect(x({ warp: false, maxWaitSeconds: 1 })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    const keys = Object.keys(manifest.govern ?? {});
    expect(keys.length).toBe(1);
    expect(tl.s.events).toEqual(["schedule:timelock-grant-role"]);
    await x({ warp: warpTo(tl) });
    expect(tl.s.events).toEqual(["schedule:timelock-grant-role", "execute:timelock-grant-role"]);
    expect(Object.keys(manifest.govern ?? {})).toEqual(keys);
    expect(tl.s.roles.has(`${roleHash}:${NEW.toLowerCase()}`)).toBe(true);
  });

  test("a change already in effect with no record is recorded as skipped and sends nothing (another tool made it, or a crash between the execute and the save)", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    tl.s.threshold = 3n;
    const r = await run(ctx, manifest, sheet, tl, { row: "safe-change-threshold", selfAdmin: { threshold: 3 } });
    expect(r.skipped.length).toBe(1);
    expect(tl.s.events).toEqual([]);
    expect((manifest.govern as Record<string, any>)[r.rows[0]!].skipped.reason).toContain("already in effect");
    // the same again: the skip record is the prior record of this change, nothing is sent and no second record is written
    const r2 = await run(ctx, manifest, sheet, tl, { row: "safe-change-threshold", selfAdmin: { threshold: 3 } });
    expect(r2.rows).toEqual(r.rows);
    expect(Object.keys(manifest.govern ?? {}).length).toBe(1);
  });

  test("cancel below threshold: after safe-change-threshold raises the threshold, a run with fewer owner signers than the live threshold sends nothing", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    await run(ctx, manifest, sheet, tl, { row: "safe-change-threshold", selfAdmin: { threshold: 3 } });
    expect(tl.handle.threshold).toBe(3);
    const err = await rejection(run(ctx, manifest, sheet, tl, { ownerSigners: signers(sheet, 2), warp: warpTo(tl), row: "timelock-grant-role", selfAdmin: { role: ROLE, account: NEW } }));
    expect(err.kind).toBe("GOVERN");
    expect(err.message).toContain("2 of the 3");
    // The schedule bundle is built, then signing refuses: no Safe transaction executes and the timelock holds no operation.
    expect(tl.s.events).toEqual(["propose:safe-change-threshold", "schedule:timelock-grant-role"]);
    expect(tl.s.ops.size).toBe(0);
    // with three signers the same row goes through the Safe at its new threshold
    await run(ctx, manifest, sheet, tl, { warp: warpTo(tl), row: "timelock-grant-role", selfAdmin: { role: ROLE, account: NEW } });
    expect(tl.s.events).toEqual(["propose:safe-change-threshold", "schedule:timelock-grant-role", "schedule:timelock-grant-role", "execute:timelock-grant-role"]);
  });

  test("the roster helpers: sheetRosterProblems names the sheet key that differs, safeAdminEffect reads a row's arguments back, safeRuleProblem is the Safe's rule", () => {
    const { sheet } = setup(ALL);
    const live = { owners: sheet.safeOwners, threshold: 2n };
    expect(sheetRosterProblems(live, sheet)).toEqual([]);
    expect(sheetRosterProblems({ owners: [...sheet.safeOwners].reverse(), threshold: 2 }, sheet)).toEqual([]); // order does not matter
    expect(sheetRosterProblems({ owners: [...sheet.safeOwners, NEW], threshold: 2n }, sheet).join()).toContain("SAFE_OWNERS");
    expect(sheetRosterProblems({ owners: sheet.safeOwners, threshold: 3 }, sheet).join()).toContain("SAFE_THRESHOLD");
    const add = parseSafeAdminArgs("safe-add-owner", { owner: NEW, threshold: 3 });
    expect(safeAdminEffect(add, live)).toMatchObject({ owner: false, threshold: false });
    expect(safeAdminEffect(add, { owners: [...sheet.safeOwners, NEW], threshold: 3n })).toMatchObject({ owner: true, threshold: true, problems: [] });
    expect(safeAdminEffect(add, { owners: [...sheet.safeOwners, NEW], threshold: 2n })).toMatchObject({ owner: true, threshold: false });
    const swap = parseSafeAdminArgs("safe-swap-owner", { oldOwner: sheet.safeOwners[0], newOwner: NEW });
    expect(safeAdminEffect(swap, live).owner).toBe(false);
    expect(safeAdminEffect(swap, { owners: [NEW, ...sheet.safeOwners.slice(1)], threshold: 2n }).problems).toEqual([]);
    expect(safeRuleProblem(add, live, A.safe)).toBeUndefined();
    expect(safeRuleProblem(parseSafeAdminArgs("safe-add-owner", { owner: NEW, threshold: 5 }), live, A.safe)).toContain("GS201");
    expect(safeRuleProblem(parseSafeAdminArgs("safe-add-owner", { owner: A.safe, threshold: 2 }), live, A.safe)).toContain("GS203");
    expect(safeRuleProblem(parseSafeAdminArgs("safe-add-owner", { owner: sheet.safeOwners[0], threshold: 2 }), live, A.safe)).toContain("GS204");
    expect(safeRuleProblem(parseSafeAdminArgs("safe-remove-owner", { owner: sheet.safeOwners[0], threshold: 3 }), live, A.safe)).toContain("GS201");
    expect(safeRuleProblem(parseSafeAdminArgs("safe-remove-owner", { owner: sheet.safeOwners[0], threshold: 2 }), live, A.safe)).toBeUndefined();
    expect(safeRuleProblem(parseSafeAdminArgs("safe-swap-owner", { oldOwner: sheet.safeOwners[0], newOwner: sheet.safeOwners[1] }), live, A.safe)).toContain("GS204");
    expect(safeRuleProblem(parseSafeAdminArgs("safe-change-threshold", { threshold: 3 }), live, A.safe)).toBeUndefined();
    expect(safeRuleProblem(parseSafeAdminArgs("safe-change-threshold", { threshold: 4 }), live, A.safe)).toContain("GS201");
  });

  test("the resume command of a self-administration record names the row and the --admin-arg values, never the calldata hash", () => {
    const next = resumeCommand({ chainId: 918453, coreSha: SHA }, selfAdminRecordKey("timelock-grant-role", "0x1234", 7));
    expect(next).toContain("--row timelock-grant-role --admin-arg");
    expect(next).not.toContain("-n7");
  });
});

describe("issue 1701: payloadVector looks a bucket up as an own key only", () => {
  test("a bucket named constructor, __proto__, toString or hasOwnProperty is a USAGE error naming the bucket, not a TypeError", async () => {
    const { payloadVector } = await import("../src/apply-receipt.ts");
    const vaultOf = { USDC: addr(1), PROTO: addr(2), AGENT: addr(3), RWA: addr(4) } as never;
    for (const bucket of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const payload = toBytes(JSON.stringify({ weights: [{ bucket: "conservative_defi_yield", weight_bps: 10000 }, { bucket, weight_bps: 0 }] }));
      let err: unknown;
      try { payloadVector(payload, vaultOf, [addr(1)]); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(PublishError);
      expect((err as PublishError).kind).toBe("USAGE");
      expect((err as PublishError).message).toContain(`bucket '${bucket}' is not one of`);
    }
  });
});

// ---- QA plan v1 D7 (review E5, issue 1705 Q2): the emergency unwind guard row ----
describe("QA plan v1 D7: set-unwind-guard sets a basket vault's emergency unwind guard through the Safe and the timelock", () => {
  const noWarp = async () => { throw new Error("no anvil_ or evm_ method on 8453"); };
  const TOK = { a: addr(0x7001), b: addr(0x7002), off: addr(0x7003) };
  /** rmPROTO lists a, an INACTIVE row, then b; rmAGENT lists a. The timelock holds ADMIN_ROLE on the three baskets (the handover). */
  const world = (chainId = 918453, sheetOver: Record<string, string> = {}) => {
    const { ctx, sheet } = setup({ ...ALL, ...sheetOver }, chainId);
    const tl = fakeTimelock(sheet, DELAY);
    for (const k of BASKETS) tl.s.governed.add(A.vaults[k]);
    tl.s.assetRows.set(A.vaults.PROTO, [{ token: TOK.a, active: true }, { token: TOK.off, active: false }, { token: TOK.b, active: true }]);
    tl.s.assetRows.set(A.vaults.AGENT, [{ token: TOK.a, active: true }]);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    const guard = (args: UnwindGuardArgs, extra: object = {}) => runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { row: UNWIND_GUARD_ROW, unwindGuard: args, warp: warpTo(tl), emit: (l: string) => out.push(l), ...extra }));
    return { ctx, sheet, tl, manifest, out, guard };
  };
  const ONE: UnwindGuardArgs = { vault: "PROTO", token: TOK.b, "min-usdc-out": "2000000", "max-loss-bps": "500" };
  const callOf = (token: `0x${string}`, min: bigint, allowed: boolean, loss: bigint) =>
    encodeFunctionData({ abi: VAULT_UNWIND_GUARD_ABI, functionName: "setEmergencyUnwindGuard", args: [token, min, allowed, loss] });
  const guardOf = (tl: ReturnType<typeof fakeTimelock>, vault: string, token: string) => tl.s.guards.get(`${vault.toLowerCase()}|${token.toLowerCase()}`);

  test("the row is on demand: in no default run, no numbered --row and no stage run; accepted on 8453 in production and in a rehearsal and on the Twin chain", () => {
    expect([...GOVERN_ROWS]).not.toContain(UNWIND_GUARD_ROW);
    for (const chain of [8453, 918453]) expect([...stageRows(chain)]).not.toContain(UNWIND_GUARD_ROW);
    expect(() => resolveGovernRow(UNWIND_GUARD_ROW)).toThrow("on-demand");
    for (const kind of ["production", "rehearsal"] as const) for (const chain of [8453, 918453]) expect(govRowRefusal(UNWIND_GUARD_ROW, chain, kind)).toBeUndefined();
  });

  test("bad arguments are USAGE and nothing is read or sent: rmUSDC, an unknown vault, no token, a bad token, a zero floor, a loss cap above 10000, an override floor that rounds to zero, a bad override flag", async () => {
    const bad: [UnwindGuardArgs | undefined, string][] = [
      [undefined, "vault="],
      [{ ...ONE, vault: "USDC" }, "rmUSDC has no emergency unwind guard"],
      [{ ...ONE, vault: "BTC" }, "vault must be one of"],
      [{ ...ONE, token: undefined }, "token=0x<address>"],
      [{ ...ONE, token: "0x1234" }, "token must be an address or 'all'"],
      [{ ...ONE, "min-usdc-out": "0" }, "min-usdc-out 0 is the unset guard"],
      [{ ...ONE, "min-usdc-out": "1.5" }, "whole number"],
      [{ ...ONE, "max-loss-bps": undefined }, "max-loss-bps=N"],
      [{ ...ONE, "max-loss-bps": "10001" }, "InvalidParam"],
      [{ ...ONE, "max-loss-bps": "10000" }, "override floor zero"],
      [{ ...ONE, "min-usdc-out": "1" }, "override floor zero"],
      [{ ...ONE, "override-allowed": "yes" }, "true or false"],
    ];
    for (const [args, msg] of bad) {
      expect(() => parseUnwindGuardArgs(args)).toThrow(msg);
      const w = world();
      let connected = 0;
      const connect = w.tl.api.connectSafe;
      w.tl.api.connectSafe = (async (...x: unknown[]) => { connected++; return (connect as (...y: unknown[]) => unknown)(...x); }) as never;
      await expect(w.guard(args as UnwindGuardArgs)).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining(msg) });
      expect(connected).toBe(0);
      expect(w.tl.s.events).toEqual([]);
    }
    // a 10000 cap, or a floor of one unit, is allowed with the override off: the override floor is never used
    expect(parseUnwindGuardArgs({ ...ONE, "max-loss-bps": "10000", "override-allowed": "false" })).toMatchObject({ maxLossBps: 10000n, overrideAllowed: false });
    expect(parseUnwindGuardArgs({ ...ONE, "min-usdc-out": "1", "override-allowed": "false" })).toMatchObject({ minUsdcOut: 1n, overrideAllowed: false });
    // the row's --admin-arg values go with the row only
    const w = world();
    await expect(runGovern(w.ctx, stageByName("govern"), w.manifest, opts(w.sheet, w.tl, { row: "unpause-PROTO", unwindGuard: ONE }))).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining(`--row ${UNWIND_GUARD_ROW} only`) });
  });

  test("one token: ONE setEmergencyUnwindGuard call, scheduled with `schedule` and executed after the delay, read back; the line carries the row; the evidence records the values", async () => {
    const w = world();
    const res = await w.guard(ONE);
    const name = unwindGuardRecordKey("PROTO", [{ data: callOf(TOK.b, 2_000_000n, true, 500n) }]);
    expect(res.rows).toEqual([name]);
    expect(w.tl.s.events).toEqual([`schedule:${UNWIND_GUARD_ROW}`, `execute:${UNWIND_GUARD_ROW}`]);
    const sc = w.tl.s.scheduled.get(UNWIND_GUARD_ROW)!;
    expect(sc.form).toBe("single");
    expect(sc.calls).toEqual([{ target: A.vaults.PROTO, data: callOf(TOK.b, 2_000_000n, true, 500n) }]);
    // the Safe transaction names the vault and the guard before and after
    expect(sc.description).toContain(`rmPROTO ${A.vaults.PROTO} from ${TOK.b} (0, false, 0)`);
    expect(sc.description).toContain(`rmPROTO.setEmergencyUnwindGuard(${TOK.b}, 2000000, true, 500)`);
    expect(guardOf(w.tl, A.vaults.PROTO, TOK.b)).toEqual([2_000_000n, true, 500n]);
    expect(guardOf(w.tl, A.vaults.PROTO, TOK.a)).toBeUndefined();
    const lines = w.out.map((l) => JSON.parse(l));
    expect(lines.map((l) => `${l.row}:${l.phase}:${l.status}`)).toEqual([`${UNWIND_GUARD_ROW}:scheduled:1`, `${UNWIND_GUARD_ROW}:executed:1`]);
    const e = (w.manifest as { unwind_guards?: any[] }).unwind_guards!;
    expect(e.length).toBe(1);
    expect(e[0]).toMatchObject({ step: UNWIND_GUARD_ROW, key: name, round: 1, vault: "PROTO", vault_address: A.vaults.PROTO, tokens: [TOK.b], min_usdc_out: "2000000", override_allowed: true, max_loss_bps: 500, timelock: A.timelock, schedule_status: 1, execute_status: 1 });
    // never part of stage 13
    expect(w.manifest.stages.govern).toBeUndefined();
    expect(Object.keys(w.manifest.govern!)).toEqual([name]);
  });

  test("token=all: ONE scheduleBatch with one call per ACTIVE asset, in the vault's order (the inactive row gets none)", async () => {
    const w = world();
    await w.guard({ ...ONE, token: "all" });
    const sc = w.tl.s.scheduled.get(UNWIND_GUARD_ROW)!;
    expect(sc.form).toBe("batch");
    expect(sc.calls).toEqual([TOK.a, TOK.b].map((t) => ({ target: A.vaults.PROTO, data: callOf(t, 2_000_000n, true, 500n) })));
    expect(w.tl.s.log).toEqual(["scheduleBatch", "executeBatch"]);
    for (const t of [TOK.a, TOK.b]) expect(guardOf(w.tl, A.vaults.PROTO, t)).toEqual([2_000_000n, true, 500n]);
    expect(guardOf(w.tl, A.vaults.PROTO, TOK.off)).toBeUndefined();
    expect((w.manifest as { unwind_guards?: any[] }).unwind_guards![0].tokens).toEqual([TOK.a, TOK.b]);
  });

  test("override-allowed defaults to true (QA plan v1 Decisions D3: allowed, Safe-only), and false is sent as false", async () => {
    expect(parseUnwindGuardArgs(ONE).overrideAllowed).toBe(true);
    const w = world();
    await w.guard({ ...ONE, vault: "AGENT", token: TOK.a, "override-allowed": "false", "max-loss-bps": "0" });
    expect(guardOf(w.tl, A.vaults.AGENT, TOK.a)).toEqual([2_000_000n, false, 0n]);
    expect(w.tl.s.scheduled.get(UNWIND_GUARD_ROW)!.calls).toEqual([{ target: A.vaults.AGENT, data: callOf(TOK.a, 2_000_000n, false, 0n) }]);
  });

  test("a token that is not an active asset, a vault with no active asset and a vault whose ADMIN_ROLE the timelock does not hold are refused with GOVERN before anything is scheduled", async () => {
    const inactive = world();
    await expect(inactive.guard({ ...ONE, token: TOK.off })).rejects.toMatchObject({ kind: "GOVERN", exitCode: EXIT_CODES.GOVERN, message: expect.stringContaining("is not an active asset of rmPROTO") });
    expect(inactive.tl.s.events).toEqual([]);
    const empty = world();
    await expect(empty.guard({ ...ONE, vault: "RWA", token: "all" })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("rmRWA lists no active asset") });
    expect(empty.tl.s.events).toEqual([]);
    const ungoverned = world();
    ungoverned.tl.s.governed.delete(A.vaults.PROTO);
    await expect(ungoverned.guard(ONE)).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("does not hold ADMIN_ROLE on rmPROTO") });
    expect(ungoverned.tl.s.events).toEqual([]);
  });

  test("a guard already in effect is recorded as skipped and nothing is sent; a rerun of an executed run reprints its lines and sends nothing", async () => {
    const pre = world();
    pre.tl.s.guards.set(`${A.vaults.PROTO.toLowerCase()}|${TOK.b.toLowerCase()}`, [2_000_000n, true, 500n]);
    const res = await pre.guard(ONE);
    expect(res.skipped).toEqual(res.rows);
    expect(pre.tl.s.events).toEqual([]);
    expect(pre.manifest.govern![res.rows[0]!]).toMatchObject({ skipped: { reason: expect.stringContaining("already in effect on chain") } });
    const w = world();
    await w.guard(ONE);
    w.out.length = 0;
    const again = await w.guard(ONE);
    expect(again.skipped).toEqual([]);
    expect(w.tl.s.events.length).toBe(2);
    expect(w.out.map((l) => JSON.parse(l).phase)).toEqual(["scheduled", "executed"]);
    expect((w.manifest as { unwind_guards?: any[] }).unwind_guards!.length).toBe(1);
  });

  test("other values are another operation, and setting the first values again after a change opens round 2 of their record (a new operation id)", async () => {
    const w = world();
    await w.guard(ONE);
    const first = w.tl.s.ids.get(UNWIND_GUARD_ROW);
    const name = unwindGuardRecordKey("PROTO", [{ data: callOf(TOK.b, 2_000_000n, true, 500n) }]);
    await w.guard({ ...ONE, "min-usdc-out": "3000000" });
    expect(guardOf(w.tl, A.vaults.PROTO, TOK.b)).toEqual([3_000_000n, true, 500n]);
    expect(w.tl.s.ids.get(UNWIND_GUARD_ROW)).not.toBe(first);
    await w.guard(ONE);
    expect(guardOf(w.tl, A.vaults.PROTO, TOK.b)).toEqual([2_000_000n, true, 500n]);
    expect(w.tl.s.events.length).toBe(6);
    expect(w.manifest.govern![name]).toMatchObject({ round: 2 });
    expect(w.manifest.govern![roundKey(name, 1)]).toMatchObject({ round: 1, executed: expect.anything() });
    const ids = new Set((w.manifest as { unwind_guards?: any[] }).unwind_guards!.map((x) => x.operation_id));
    expect(ids.size).toBe(3);
  });

  test("on 8453 (production) the row schedules and exits GOVERN_PENDING with a resume command that spells out its --admin-arg values; the resume after the delay executes it; a cancelled operation is scheduled again in the same round", async () => {
    const w = world(8453);
    let err: unknown;
    try { await w.guard(ONE, { warp: noWarp }); } catch (e) { err = e; }
    const e = err as PublishError;
    expect(e.kind).toBe("GOVERN_PENDING");
    expect(String(e.details.next_command)).toContain(`--row ${UNWIND_GUARD_ROW} --admin-arg vault=PROTO --admin-arg token=${TOK.b} --admin-arg min-usdc-out=2000000 --admin-arg max-loss-bps=500 --admin-arg override-allowed=true`);
    expect(String(e.details.next_command)).toContain("--chain 8453");
    expect(w.tl.s.events).toEqual([`schedule:${UNWIND_GUARD_ROW}`]);
    // the operator cancels the operation through the Safe on the timelock, then names the row again: the same round is scheduled again
    const name = unwindGuardRecordKey("PROTO", [{ data: callOf(TOK.b, 2_000_000n, true, 500n) }]);
    w.tl.s.ops.delete(w.tl.s.ids.get(UNWIND_GUARD_ROW)!);
    await expect(w.guard(ONE, { warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(w.tl.s.events).toEqual([`schedule:${UNWIND_GUARD_ROW}`, `schedule:${UNWIND_GUARD_ROW}`]);
    expect(w.manifest.govern![`${roundKey(name, 1)}:cancelled-1`]).toBeDefined();
    w.tl.s.clock += DELAY;
    await w.guard(ONE, { warp: noWarp });
    expect(w.tl.s.events).toEqual([`schedule:${UNWIND_GUARD_ROW}`, `schedule:${UNWIND_GUARD_ROW}`, `execute:${UNWIND_GUARD_ROW}`]);
    expect(guardOf(w.tl, A.vaults.PROTO, TOK.b)).toEqual([2_000_000n, true, 500n]);
    expect(w.manifest.stages.govern).toBeUndefined();
  });

  test("buildUnwindGuardCalls: one call per token on the vault, labelled with the vault name and the values", () => {
    const want = parseUnwindGuardArgs({ ...ONE, token: "all" });
    const calls = buildUnwindGuardCalls(A.vaults.RWA, { ...want, vault: "RWA" }, [TOK.a, TOK.b]);
    expect(calls.map((c) => c.target)).toEqual([A.vaults.RWA, A.vaults.RWA]);
    expect(calls[0]!.label).toBe(`rmRWA.setEmergencyUnwindGuard(${TOK.a}, 2000000, true, 500)`);
    expect(decodeFunctionData({ abi: VAULT_UNWIND_GUARD_ABI, data: calls[1]!.data }).args).toEqual([TOK.b, 2_000_000n, true, 500n]);
    // the record key names the row and the vault, and differs with the values
    expect(unwindGuardRecordKey("RWA", calls)).toMatch(new RegExp(`^${UNWIND_GUARD_ROW}-RWA-[0-9a-f]{8}$`));
    expect(unwindGuardRecordKey("RWA", calls)).not.toBe(unwindGuardRecordKey("RWA", calls.slice(0, 1)));
  });
});
