// Stage 13 govern, one 48-hour round per step, against a fake of the Safe tool's entry points (tests/govern-world.ts). The fake keeps a timelock in
// memory: it checks the order, the one-round-per-step shape, the wait and the resume logic of govern.ts. The real Safe, the real signers and the
// real delay are exercised on the Twin chain run and on 8453 (runbook Q2), never here.
import { describe, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { PublishError } from "../src/errors.ts";
import { GATEWAY_ABI, GOV_ABI, GOVERN_ROWS, REGISTRY_ABI, ROUTER_ABI, VAULT_ABI, buildStepCalls, governSalt, loadGovernAddrs, migrationVector, resolveGovernRow, runGovern, type GovernRowName } from "../src/govern.ts";
import { newManifest } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { stageByName } from "../src/stages.ts";
import { SHA } from "./fixtures.ts";
import { A, addr, fakeTimelock, sender, setup, signers } from "./govern-world.ts";

const ALL = {
  GOVERN_ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", GOVERN_UNPAUSE_VAULTS: "PROTO,AGENT,RWA", GOVERN_AGENT_ADDRESSES: "0x000000000000000000000000000000000000d001",
  ROUTER_WEIGHTS: "USDC:5000,PROTO:2500,AGENT:1000,RWA:1500",
};
const DELAY = 172800n;

const dec = (data: `0x${string}`) => {
  for (const abi of [GOV_ABI, VAULT_ABI, GATEWAY_ABI, REGISTRY_ABI, ROUTER_ABI]) { try { return decodeFunctionData({ abi, data }); } catch { /* next */ } }
  throw new Error("cannot decode");
};

describe("step calldata: each step holds only its own calls", () => {
  const { ctx, sheet } = setup(ALL);
  const a = loadGovernAddrs(ctx);
  const names = (row: GovernRowName) => buildStepCalls(sheet, a, row).map((c) => dec(c.data).functionName as string);

  test("voting-power-quorum: voting power per voter, quorum, voting period, execution delay", () => {
    const n = names("voting-power-quorum");
    expect(n.filter((x) => x === "setVotingPower").length).toBe(sheet.voters.length);
    expect(n).toContain("setQuorumThreshold"); expect(n).toContain("setVotingPeriod"); expect(n).toContain("setExecutionDelay");
    expect(n.length).toBe(sheet.voters.length + 3);
    for (const c of buildStepCalls(sheet, a, "voting-power-quorum")) expect(c.target).toBe(A.governance);
  });
  test("agents: authorizeAgent per sheet agent, with the sheet policy", () => {
    const calls = buildStepCalls(sheet, a, "agents");
    expect(calls.length).toBe(1);
    expect(calls[0]!.target).toBe(A.gateway);
    const d = dec(calls[0]!.data);
    const p = (d.args as unknown as unknown[])[1] as { maxPerPayment: bigint; active: boolean; shareReceiver: string };
    expect(p.active).toBe(true);
    expect(p.maxPerPayment).toBe(sheet.agentPolicy.maxPerPayment);
    expect(p.shareReceiver.toLowerCase()).toBe(sheet.shareReceiver.toLowerCase());
  });
  test("other-setters: the four vault setters on each of the four vaults", () => {
    const calls = buildStepCalls(sheet, a, "other-setters");
    const n = calls.map((c) => dec(c.data).functionName as string);
    for (const f of ["setTvlCap", "setPerDepositCap", "setExitFeeBps", "setFeeRecipient"]) expect(n.filter((x) => x === f).length).toBe(4);
    expect(n.length).toBe(16);
    for (const c of calls) expect(Object.values(A.vaults)).toContain(c.target);
  });
  test("migrate-eligibility-<B>: exactly one atomic migrateEligibility call for that basket, the vector growing and ending on the sheet weights", () => {
    const vectors = (["PROTO", "AGENT", "RWA"] as const).map((k) => {
      const calls = buildStepCalls(sheet, a, `migrate-eligibility-${k}`);
      expect(calls.length).toBe(1);
      expect(calls[0]!.target).toBe(A.registry);
      const d = dec(calls[0]!.data);
      expect(d.functionName).toBe("migrateEligibility");
      expect((d.args as unknown as unknown[])[0]).toBe(A.vaults[k]);
      expect((d.args as unknown as unknown[])[1]).toBe(true);
      return { vaults: (d.args as unknown as unknown[])[2] as string[], bps: (d.args as unknown as unknown[])[3] as bigint[] };
    });
    for (const v of vectors) expect(v.bps.reduce((x, y) => x + y, 0n)).toBe(10000n);
    expect(vectors.map((v) => v.vaults.length)).toEqual([2, 3, 4]);
    expect(vectors[2]!.bps).toEqual([5000n, 2500n, 1000n, 1500n]);
    expect(migrationVector(sheet, a, 2).vaults).toEqual([A.vaults.USDC, A.vaults.PROTO, A.vaults.AGENT, A.vaults.RWA]);
  });
  test("router-weights: one setDefaultWeights with rmUSDC and the eligible baskets", () => {
    const calls = buildStepCalls(sheet, a, "router-weights");
    expect(calls.length).toBe(1);
    expect(calls[0]!.target).toBe(A.router);
    const d = dec(calls[0]!.data);
    expect(d.functionName).toBe("setDefaultWeights");
    expect((d.args as unknown as unknown[])[1]).toEqual([5000n, 2500n, 1000n, 1500n]);
  });
  test("unpause-<B>: one unpause on that basket vault", () => {
    for (const k of ["PROTO", "AGENT", "RWA"] as const) {
      const calls = buildStepCalls(sheet, a, `unpause-${k}`);
      expect(calls.map((c) => [c.target, dec(c.data).functionName])).toEqual([[A.vaults[k], "unpause"]]);
    }
  });
  test("a basket the sheet does not list builds no call: pause and eligibility are sheet data", () => {
    const d = setup();
    const da = loadGovernAddrs(d.ctx);
    expect(buildStepCalls(d.sheet, da, "unpause-AGENT")).toEqual([]);
    expect(buildStepCalls(d.sheet, da, "migrate-eligibility-AGENT")).toEqual([]);
    expect(buildStepCalls(d.sheet, da, "agents")).toEqual([]);
    expect(migrationVector(d.sheet, da, 1).bps).toEqual([6000n, 2500n, 1500n]);
  });
  test("salts are deterministic per SHA, chain and row, and differ between rows", () => {
    expect(governSalt(SHA, 918453, "agents")).toBe(governSalt(SHA, 918453, "agents"));
    expect(governSalt(SHA, 918453, "agents")).not.toBe(governSalt(SHA, 8453, "agents"));
    expect(governSalt(SHA, 918453, "agents")).not.toBe(governSalt(SHA, 918453, "other-setters"));
  });
});

const opts = (sheet: ReturnType<typeof parseSheet>, tl: ReturnType<typeof fakeTimelock>, extra: object = {}) =>
  ({ ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: false as const, maxWaitSeconds: 10_000_000, emit: () => {}, ...extra });
const warpTo = (tl: ReturnType<typeof fakeTimelock>) => async (sec: bigint) => { tl.s.clock += sec; };

describe("one round per step", () => {
  test("a full run is one schedule and one execute per step, in order, never a shared round", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    const warped: bigint[] = [];
    const res = await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: async (s: bigint) => { warped.push(s); tl.s.clock += s; }, emit: (l: string) => out.push(l) }));
    const want = ["voting-power-quorum", "agents", "other-setters", "migrate-eligibility-PROTO", "migrate-eligibility-AGENT", "migrate-eligibility-RWA", "router-weights", "unpause-PROTO", "unpause-AGENT", "unpause-RWA", "update-delay", "batch", "cancel"];
    expect([...GOVERN_ROWS] as string[]).toEqual(want);
    expect(res.rows as string[]).toEqual(want);
    // each row's schedule is followed by its own execute before the next row's schedule
    const expected: string[] = [];
    for (const r of want) {
      if (r === "update-delay") expected.push("updateDelay.schedule:update-delay", "updateDelay.execute:update-delay");
      else if (r === "cancel") expected.push("schedule:cancel", "cancel:cancel");
      else if (r === "batch" || r === "voting-power-quorum" || r === "other-setters") expected.push(`scheduleBatch:${r}`, `executeBatch:${r}`);
      else expected.push(`schedule:${r}`, `execute:${r}`);
    }
    expect(tl.s.events).toEqual(expected);
    // one wait per round that executes: 12 (the cancel round has none)
    expect(warped.length).toBe(12);
    for (const w of warped) expect(w).toBeGreaterThanOrEqual(1n);
    expect(tl.s.minDelay).toBe(sheet.govern.newDelay);
    expect(manifest.stages.govern!.status).toBe("done");
    expect(Object.keys(manifest.govern!)).toEqual(want);
    // one JSON line per round event
    const lines = out.map((l) => JSON.parse(l));
    expect(lines.map((l) => `${l.row}:${l.phase}`)).toEqual(want.flatMap((r) => r === "cancel" ? [`${r}:scheduled`, `${r}:cancelled`] : [`${r}:scheduled`, `${r}:executed`]));
    for (const l of lines) {
      expect(Object.keys(l).sort()).toEqual(["phase", "readyAt", "row", "status", "txHash"]);
      expect(l.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(l.status).toBe(1);
      expect(l.readyAt).toBeGreaterThan(1000);
    }
    // every transaction is signed by the threshold of owners: 26 Safe transactions
    expect(tl.s.signed.length).toBe(26 * sheet.safeThreshold);
  });

  test("a row's schedule and execute are separated by at least the timelock delay on the clock", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const stamps: Record<string, bigint> = {};
    const api = { ...tl.api, executeTx: (async (...args: unknown[]) => { const r = await (tl.api.executeTx as any)(...args); stamps[`${args[1] && (args[1] as any).action}:${tl.s.nonce}`] = tl.s.clock; return r; }) as never };
    await runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { api, warp: warpTo(tl), row: undefined }));
    const sched = Object.entries(stamps).filter(([k]) => k.startsWith("schedule:"));
    const exec = Object.entries(stamps).filter(([k]) => k.startsWith("execute:"));
    expect(sched.length).toBeGreaterThan(5);
    expect(exec.length).toBeGreaterThan(5);
    // pair them in order: the n-th execute follows the n-th schedule by the delay (the first rows run at the 172800 s delay)
    for (let i = 0; i < 10; i++) expect(exec[i]![1] - sched[i]![1]).toBeGreaterThanOrEqual(DELAY);
  });

  test("a default sheet skips the rows it does not ask for and says why", async () => {
    const { ctx, sheet } = setup();
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const res = await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl) }));
    expect(res.skipped).toEqual(["agents", "migrate-eligibility-AGENT", "unpause-AGENT"]);
    expect((manifest.govern as any)["agents"].skipped.reason).toContain("no agents");
    expect((manifest.govern as any)["unpause-AGENT"].skipped.reason).toContain("stays paused");
    expect(tl.s.events.some((e) => e.endsWith(":agents") || e.endsWith(":unpause-AGENT"))).toBe(false);
    expect(manifest.stages.govern!.status).toBe("done");
  });

  const single = (row: GovernRowName) => test(`row ${row}: schedule, wait, execute, read-back, as its own round`, async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    const idx = GOVERN_ROWS.indexOf(row);
    // the rows before it run first (one round each), then this row alone
    for (const earlier of GOVERN_ROWS.slice(0, idx)) await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl), row: earlier }));
    const before = tl.s.events.length;
    await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl), row, emit: (l: string) => out.push(l) }));
    const mine = tl.s.events.slice(before);
    expect(mine.length).toBe(2);
    expect(mine.every((e) => e.endsWith(`:${row === "update-delay" ? "update-delay" : row}`))).toBe(true);
    const lines = out.map((l) => JSON.parse(l));
    expect(lines.map((l) => l.phase)).toEqual(row === "cancel" ? ["scheduled", "cancelled"] : ["scheduled", "executed"]);
    expect(lines.every((l) => l.row === row)).toBe(true);
    // a single-row run does not mark the stage done unless it was the last row
    expect(manifest.stages.govern?.status as string | undefined).toBe(row === "cancel" ? "done" : undefined);
  });
  for (const r of GOVERN_ROWS) single(r);

  test("migrate-eligibility is one call per basket, each its own operation", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    await runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { warp: warpTo(tl) }));
    for (const k of ["PROTO", "AGENT", "RWA"]) {
      const s = tl.s.scheduled.get(`migrate-eligibility-${k}`)!;
      expect(s.form).toBe("single");
      expect(s.calls.length).toBe(1);
    }
    expect(tl.s.scheduled.get("batch")!.form).toBe("batch");
    expect(tl.s.scheduled.get("batch")!.calls.length).toBe(2);
    expect(tl.s.scheduled.get("voting-power-quorum")!.form).toBe("batch");
  });

  test("a failed read-back stops the run on that row", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    tl.s.reads.paused = true;
    const manifest = newManifest(ctx, addr(0xa001));
    await expect(runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl) }))).rejects.toThrow("unpause-PROTO");
    expect((manifest.govern as any)["unpause-PROTO"].scheduled).toBeDefined();
    expect((manifest.govern as any)["unpause-PROTO"].executed).toBeUndefined();
    expect(tl.s.events.some((e) => e.endsWith(":unpause-AGENT"))).toBe(false);
  });
});

describe("ordering", () => {
  test("a row cannot start before the earlier rows are complete", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    let err: unknown;
    try { await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { row: "unpause-PROTO", warp: warpTo(tl) })); } catch (e) { err = e; }
    expect((err as PublishError).kind).toBe("GOVERN");
    expect((err as PublishError).message).toContain("voting-power-quorum");
    expect(tl.s.events).toEqual([]);
  });

  test("rows run one at a time in order add up to the full matrix, and a rerun of a done row reprints its lines with no new transaction", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    for (let n = 1; n <= GOVERN_ROWS.length; n++) await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl), row: String(n), emit: (l: string) => out.push(l) }));
    expect(new Set(out.map((l) => JSON.parse(l).row))).toEqual(new Set(GOVERN_ROWS));
    expect(manifest.stages.govern!.status).toBe("done");
    const events = tl.s.events.length;
    const again: string[] = [];
    await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl), row: "2", emit: (l: string) => again.push(l) }));
    expect(again.map((l) => JSON.parse(l).phase)).toEqual(["scheduled", "executed"]);
    expect(tl.s.events.length).toBe(events);
  });

  test("an unknown or out-of-range row is a usage error", () => {
    for (const bad of ["0", "14", "nope", "-1", "round1.schedule"]) expect(() => resolveGovernRow(bad)).toThrow(PublishError);
    expect(resolveGovernRow("13")).toBe("cancel");
    expect(resolveGovernRow("1")).toBe("voting-power-quorum");
    expect(resolveGovernRow("update-delay")).toBe("update-delay");
  });
});

describe("the wait: warp on a Twin fork only, GOVERN_PENDING on 8453", () => {
  test("on 8453 the run schedules, then exits GOVERN_PENDING with the ready time and the next command, and never warps", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    let warps = 0;
    const out: string[] = [];
    const manifest = newManifest(ctx, addr(0xa001));
    let err: unknown;
    try { await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: async () => { warps++; }, emit: (l: string) => out.push(l), maxWaitSeconds: 10_000_000 })); } catch (e) { err = e; }
    const e = err as PublishError;
    expect(e.kind).toBe("GOVERN_PENDING");
    expect(e.exitCode).toBe(15);
    expect(warps).toBe(0);
    expect(e.message).toContain("voting-power-quorum");
    expect(e.message).toContain("--row voting-power-quorum");
    expect(e.message).toContain("1970-01-03T00:16:40.000Z"); // the ready time, ISO (fake clock)
    expect(e.details.ready_at).toBe((1000n + DELAY).toString());
    expect(String(e.details.next_command)).toContain("--chain 8453");
    expect(tl.s.events).toEqual(["scheduleBatch:voting-power-quorum"]);
    const lines = out.map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ row: "voting-power-quorum", phase: "scheduled", status: 1, readyAt: 1000 + Number(DELAY) });
  });

  test("on 8453 a huge --max-wait still does not block for the delay", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    let slept = 0;
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { maxWaitSeconds: 99_999_999, sleep: async () => { slept++; tl.s.clock += 30n; } }))).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(slept).toBe(0);
  });

  test("on 8453 the same --row resumes after the ready time: no second schedule, then it executes and the next row waits again", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    const run = (row?: string) => runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { row, emit: (l: string) => out.push(l) }));
    await expect(run("voting-power-quorum")).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    tl.s.clock += DELAY;
    await run("voting-power-quorum");
    expect(tl.s.events).toEqual(["scheduleBatch:voting-power-quorum", "executeBatch:voting-power-quorum"]);
    expect(manifest.stages.govern).toBeUndefined();
    // the whole matrix without --row continues at the next row and pends there
    await expect(run()).rejects.toMatchObject({ kind: "GOVERN_PENDING", details: { row: "agents" } });
    expect(tl.s.events.filter((e) => e.startsWith("scheduleBatch:voting")).length).toBe(1);
  });

  test("on a Twin fork the wait runs by warp to one second past the ready time", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const seconds: bigint[] = [];
    await runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { row: "voting-power-quorum", warp: async (s: bigint) => { seconds.push(s); tl.s.clock += s; } }));
    expect(seconds).toEqual([DELAY + 1n]);
  });

  test("with the warp off and a long delay on a non-mainnet chain, the run exits GOVERN_PENDING too", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { maxWaitSeconds: 60 }))).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
  });
});

describe("resume of a half-done step", () => {
  test("a step scheduled on chain but not recorded is adopted, not scheduled twice", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const first = newManifest(ctx, addr(0xa001));
    await expect(runGovern(ctx, stageByName("govern"), first, opts(sheet, tl, { row: "voting-power-quorum", maxWaitSeconds: 60 }))).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    // a fresh manifest: the run lost its state after the schedule transaction
    const lost = newManifest(ctx, addr(0xa001));
    tl.s.clock += DELAY;
    await runGovern(ctx, stageByName("govern"), lost, opts(sheet, tl, { row: "voting-power-quorum", warp: warpTo(tl) }));
    expect(tl.s.events).toEqual(["scheduleBatch:voting-power-quorum", "executeBatch:voting-power-quorum"]);
    expect((lost.govern as any)["voting-power-quorum"].scheduled.note).toContain("already scheduled");
    expect((lost.govern as any)["voting-power-quorum"].executed.tx_hash).toBeDefined();
  });

  test("a step scheduled and recorded, then rerun after the delay: only the execute is sent", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    const run = () => runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { row: "voting-power-quorum", maxWaitSeconds: 60 }));
    await expect(run()).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(Object.keys((manifest.govern as any)["voting-power-quorum"])).toEqual(["scheduled"]);
    tl.s.clock += DELAY;
    await run();
    expect(tl.s.events).toEqual(["scheduleBatch:voting-power-quorum", "executeBatch:voting-power-quorum"]);
    expect(Object.keys((manifest.govern as any)["voting-power-quorum"])).toEqual(["scheduled", "executed"]);
  });

  test("a step executed on chain but not recorded is read back and recorded without a second execute", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const first = newManifest(ctx, addr(0xa001));
    await runGovern(ctx, stageByName("govern"), first, opts(sheet, tl, { row: "voting-power-quorum", warp: warpTo(tl) }));
    const lost = newManifest(ctx, addr(0xa001));
    await runGovern(ctx, stageByName("govern"), lost, opts(sheet, tl, { row: "voting-power-quorum", warp: warpTo(tl) }));
    expect(tl.s.events.length).toBe(2);
    expect((lost.govern as any)["voting-power-quorum"].executed.note).toContain("already executed");
  });

  test("a cancel executed on chain but not recorded is adopted: no second schedule and no second cancel", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    const manifest = newManifest(ctx, addr(0xa001));
    await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl) }));
    // forget the cancel phase only
    delete (manifest.govern as any)["cancel"].cancelled;
    delete (manifest.stages as any).govern;
    const before = tl.s.events.length;
    await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { warp: warpTo(tl) }));
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

  test("refused on 8453 before anything is sent", async () => {
    const { ctx, sheet } = setup(ALL, 8453);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { call }))).rejects.toThrow("refused on chain 8453");
    expect(tl.s.events.length).toBe(0);
  });

  test("not combined with --row, and the label may not be a govern row name", async () => {
    const { ctx, sheet } = setup(ALL);
    const tl = fakeTimelock(sheet, DELAY);
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { call, row: "agents" }))).rejects.toThrow("mutually exclusive");
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { call: { ...call, label: "agents" } }))).rejects.toThrow("not a govern row name");
  });
});
