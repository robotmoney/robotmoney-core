// Stage 13 govern against a fake of the Safe tool's entry points (tests/govern-world.ts). The fake keeps a timelock in memory: it checks the one-sitting
// schedule, the single wait, the predecessor rule and the resume logic of govern.ts. The real Safe, the real signers and the real delay are exercised
// by the Twin fork publish (core-stages-twin-chain) and on 8453 (runbook Q2), never here.
// Issue 1520: the only mainnet operation after the handover is the basket unpause. Everything else is deploy-time configuration.
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, toFunctionSelector } from "viem";
import { PublishError } from "../src/errors.ts";
import { GOVERN_ROWS, RECEIPT_ABI, RECEIPT_ROW, TWIN_ONLY_ROWS, UNPAUSE_ROWS, UNPAUSE_USDC_ROW, VAULT_ABI, roundKey, buildReleaseCall, buildStepCalls, governRowNames, governSalt, loadGovernAddrs, releaseRecordKey, resolveGovernRow, runGovern, stageRows, type GovernRowName } from "../src/govern.ts";
import { newManifest } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { stageByName } from "../src/stages.ts";
import { SHA, sheetText } from "./fixtures.ts";
import { A, addr, fakeTimelock, sender, setup, signers } from "./govern-world.ts";

const ALL = {
  ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", GOVERN_UNPAUSE_VAULTS: "PROTO,AGENT,RWA",
  ROUTER_WEIGHTS: "USDC:5000,PROTO:2500,AGENT:1000,RWA:1500",
};
const DELAY = 172800n;
const authorizeAgentSelector = toFunctionSelector("authorizeAgent(address,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))");
const BASKETS = ["PROTO", "AGENT", "RWA"] as const;

describe("the govern rows: the basket unpauses plus the Twin-only demonstrations", () => {
  test("governRowNames() is exactly the three unpauses then update-delay, batch, cancel", () => {
    expect([...governRowNames()]).toEqual(["unpause-PROTO", "unpause-AGENT", "unpause-RWA", "update-delay", "batch", "cancel"]);
    expect([...UNPAUSE_ROWS]).toEqual(["unpause-PROTO", "unpause-AGENT", "unpause-RWA"]);
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
  test("an unknown or out-of-range row is a usage error, and the numbers are the six rows", () => {
    for (const bad of ["0", "7", "13", "nope", "-1", "voting-power-quorum", "agents", "other-setters", "router-weights", "migrate-eligibility-PROTO"]) expect(() => resolveGovernRow(bad)).toThrow(PublishError);
    expect(resolveGovernRow("1")).toBe("unpause-PROTO");
    expect(resolveGovernRow("6")).toBe("cancel");
    expect(resolveGovernRow("update-delay")).toBe("update-delay");
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
    const d = setup();
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
  test("one run schedules PROTO, AGENT and RWA, each its own operation and its own Safe transaction, and exits GOVERN_PENDING exactly once", async () => {
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
    // all three scheduled in this one run, in order, none executed
    expect(tl.s.events).toEqual(["schedule:unpause-PROTO", "schedule:unpause-AGENT", "schedule:unpause-RWA"]);
    // distinct timelock operation ids
    const ids = UNPAUSE_ROWS.map((r) => tl.s.ids.get(r)!);
    expect(new Set(ids).size).toBe(3);
    // no Safe transaction is shared by two operations: one transaction per operation, all hashes different
    const hashes = ids.flatMap((id) => tl.s.safeTxs.get(id)!);
    expect(hashes.length).toBe(3);
    expect(new Set(hashes).size).toBe(3);
    // each is a single-call unpause of its own vault
    for (const k of BASKETS) {
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
      "schedule:unpause-PROTO", "schedule:unpause-AGENT", "schedule:unpause-RWA",
      "execute:unpause-PROTO", "execute:unpause-AGENT", "execute:unpause-RWA",
    ]);
    expect([...new Set(paused)].sort()).toEqual(BASKETS.map((k) => A.vaults[k]).sort());
    for (const k of BASKETS) expect((manifest.govern as any)[`unpause-${k}`].executed.tx_hash).toBeDefined();
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
    expect(tl.s.events.length).toBe(3);
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
    for (const row of [...TWIN_ONLY_ROWS, "4", "5", "6"]) {
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
    expect(tl.s.events.slice(3)).toEqual(["execute:unpause-PROTO", "execute:unpause-AGENT", "execute:unpause-RWA"]);
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
    expect(tl.s.events.slice(0, 7)).toEqual(["schedule:unpause-PROTO", "schedule:unpause-AGENT", "schedule:unpause-RWA", "execute:unpause-PROTO", "execute:unpause-AGENT", "execute:unpause-RWA", "updateDelay.schedule:update-delay"]);
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
  test("a full run schedules the three unpauses, warps once, executes them, then the Twin-only rounds, in order", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    const warped: bigint[] = [];
    const res = await run(ctx, manifest, sheet, tl, { warp: async (s: bigint) => { warped.push(s); tl.s.events.push("warp"); tl.s.clock += s; }, emit: (l: string) => out.push(l) });
    expect(res.rows as string[]).toEqual([...GOVERN_ROWS]);
    expect(tl.s.events).toEqual([
      "schedule:unpause-PROTO", "schedule:unpause-AGENT", "schedule:unpause-RWA", "warp",
      "execute:unpause-PROTO", "execute:unpause-AGENT", "execute:unpause-RWA",
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

  test("a default sheet skips the baskets it does not unpause and says why", async () => {
    const { ctx, sheet } = setup();
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
    await expect(run(ctx, manifest, sheet, tl, { warp: warpTo(tl) })).rejects.toThrow("unpause-PROTO");
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
    expect(err.message).toContain("unpause-PROTO");
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
  /** A full default 8453 run: schedule, wait, execute all three baskets. */
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

  test("unpause-USDC is accepted by name, is not a numbered row, and is in no default run on either chain", () => {
    expect(resolveGovernRow("unpause-USDC")).toBe(UNPAUSE_USDC_ROW);
    expect(GOVERN_ROWS as readonly string[]).not.toContain(UNPAUSE_USDC_ROW);
    expect([...stageRows(8453)] as string[]).not.toContain(UNPAUSE_USDC_ROW);
    expect([...stageRows(918453)] as string[]).not.toContain(UNPAUSE_USDC_ROW);
    expect(() => resolveGovernRow("7")).toThrow(PublishError);
  });
  test("its one call is unpauseDeposits() on rmUSDC, whatever GOVERN_UNPAUSE_VAULTS lists", () => {
    for (const over of [ALL, {}]) {
      const { ctx, sheet } = setup(over);
      const calls = buildStepCalls(sheet, loadGovernAddrs(ctx), UNPAUSE_USDC_ROW);
      expect(calls.map((c) => [c.target, decodeFunctionData({ abi: VAULT_ABI, data: c.data }).functionName])).toEqual([[A.vaults.USDC, "unpauseDeposits"]]);
    }
  });
  test("a default run on 8453 never schedules it, even when rmUSDC reads paused", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    tl.s.paused.add(A.vaults.USDC);
    const manifest = newManifest(ctx, addr(0xa001));
    await expect(R(ctx, manifest, sheet, tl)).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(tl.s.events).toEqual(["schedule:unpause-PROTO", "schedule:unpause-AGENT", "schedule:unpause-RWA"]);
    expect(Object.keys(manifest.govern!)).not.toContain(UNPAUSE_USDC_ROW);
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
  test("unpause-USDC while rmUSDC is open (pause-all never paused it) schedules nothing", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
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
    const labels = [...UNPAUSE_ROWS, UNPAUSE_USDC_ROW].flatMap((r) => [1, 2, 3].map((n) => governSalt(SHA, 8453, roundKey(r, n))));
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
