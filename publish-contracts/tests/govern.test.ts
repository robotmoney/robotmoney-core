// The govern matrix against a fake of the Safe tool's entry points (tests/govern-world.ts). The fake keeps a timelock in memory: it checks the
// order, the batching and the resume logic of govern.ts. The real Safe, the real signers and the real delay are exercised on the Twin chain run
// and on 8453 (runbook Q2), never here.
import { describe, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { PublishError } from "../src/errors.ts";
import { GATEWAY_ABI, GOV_ABI, GOVERN_ROWS, REGISTRY_ABI, ROUTER_ABI, VAULT_ABI, buildRound1, governSalt, loadGovernAddrs, migrationVector, resolveGovernRow, runGovern } from "../src/govern.ts";
import { newManifest } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { stageByName } from "../src/stages.ts";
import { SHA, sheetText } from "./fixtures.ts";
import { A, addr, fakeTimelock, sender, setup, signers } from "./govern-world.ts";

describe("round 1 calldata", () => {
  const { ctx, sheet } = setup();
  const a = loadGovernAddrs(ctx);
  const calls = buildRound1(sheet, a);
  const dec = (c: (typeof calls)[number]) => {
    for (const abi of [GOV_ABI, VAULT_ABI, GATEWAY_ABI, REGISTRY_ABI, ROUTER_ABI]) { try { return decodeFunctionData({ abi, data: c.data }); } catch { /* next */ } }
    throw new Error(`cannot decode ${c.label}`);
  };
  test("one batch holds voting power, quorum, setters, migration, weights and unpause", () => {
    const names: string[] = calls.map((c) => dec(c).functionName);
    expect(names.filter((n) => n === "setVotingPower").length).toBe(sheet.voters.length);
    for (const n of ["setQuorumThreshold", "setVotingPeriod", "setExecutionDelay", "setDefaultWeights"]) expect(names).toContain(n);
    expect(names.filter((n) => n === "setTvlCap").length).toBe(4);
    expect(names.filter((n) => n === "setFeeRecipient").length).toBe(4);
    expect(names.filter((n) => n === "migrateEligibility").length).toBe(2);
    expect(names.filter((n) => n === "unpause").length).toBe(2);
  });
  test("every call targets the matching contract", () => {
    for (const c of calls) {
      const fn: string = dec(c).functionName;
      const expectTarget = ["setVotingPower", "setQuorumThreshold", "setVotingPeriod", "setExecutionDelay"].includes(fn) ? A.governance
        : fn === "migrateEligibility" ? A.registry : fn === "setDefaultWeights" ? A.router : fn === "authorizeAgent" ? A.gateway : undefined;
      if (expectTarget) expect(c.target).toBe(expectTarget);
      else expect(Object.values(A.vaults)).toContain(c.target);
    }
  });
  test("rmAGENT stays paused when the sheet does not list it: pause semantics are sheet data", () => {
    const unpaused = calls.filter((c) => dec(c).functionName === "unpause").map((c) => c.target);
    expect(unpaused).toEqual([A.vaults.PROTO, A.vaults.RWA]);
  });
  test("the migration vectors are valid at every step and the last one is exactly the sheet weights", () => {
    const steps = sheet.govern.eligibleVaults.map((_, i) => migrationVector(sheet, a, i));
    for (const s of steps) { expect(s.bps.reduce((x, y) => x + y, 0n)).toBe(10000n); expect(s.vaults.length).toBe(s.bps.length); }
    expect(steps.map((s) => s.vaults.length)).toEqual([2, 3]);
    const last = steps.at(-1)!;
    expect(last.bps).toEqual([6000n, 2500n, 1500n]);
    expect(last.vaults).toEqual([A.vaults.USDC, A.vaults.PROTO, A.vaults.RWA]);
  });
  test("a registered agent gets the sheet policy", () => {
    const s2 = parseSheet(sheetText({ GOVERN_AGENT_ADDRESSES: "0x000000000000000000000000000000000000d001" }));
    const c = buildRound1(s2, a).find((x) => x.label.startsWith("gateway.authorizeAgent"))!;
    const d = decodeFunctionData({ abi: GATEWAY_ABI, data: c.data });
    const p = (d.args as unknown as unknown[])[1] as { maxPerPayment: bigint; active: boolean; shareReceiver: string };
    expect(p.active).toBe(true);
    expect(p.maxPerPayment).toBe(s2.agentPolicy.maxPerPayment);
    expect(p.shareReceiver.toLowerCase()).toBe(s2.shareReceiver.toLowerCase());
  });
  test("salts are deterministic per SHA, chain and round", () => {
    expect(governSalt(SHA, 918453, "round1")).toBe(governSalt(SHA, 918453, "round1"));
    expect(governSalt(SHA, 918453, "round1")).not.toBe(governSalt(SHA, 8453, "round1"));
  });
});

describe("runGovern", () => {
  test("two rounds: one scheduleBatch and one executeBatch, then cancel and updateDelay, each signed by the threshold of owners", async () => {
    const { ctx, sheet } = setup();
    const tl = fakeTimelock(sheet);
    const manifest = newManifest(ctx, addr(0xa001));
    const res = await runGovern(ctx, stageByName("govern"), manifest, { ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: false as const, maxWaitSeconds: 10_000 });
    expect(tl.s.log).toEqual(["scheduleBatch", "executeBatch", "schedule", "cancel", "updateDelay.schedule", "updateDelay.execute"]);
    expect(tl.s.minDelay).toBe(sheet.govern.newDelay);
    expect(tl.s.signed.length).toBe(6 * sheet.safeThreshold);
    expect(manifest.stages.govern!.status).toBe("done");
    expect(Object.keys(manifest.govern!)).toEqual(["round1.schedule", "round1.execute", "round2.cancel.schedule", "round2.cancel.cancel", "round2.updateDelay.schedule", "round2.updateDelay.execute"]);
    expect(res.round1.length).toBeGreaterThan(10);
    expect(tl.s.ops.get(res.opIds.cancel!)).toBeUndefined();
  });

  test("when the delay is longer than the wait this process accepts, it saves its state and exits GOVERN_PENDING, and a rerun continues", async () => {
    const { ctx, sheet } = setup();
    const tl = fakeTimelock(sheet, 172800n);
    const manifest = newManifest(ctx, addr(0xa001));
    const o = { ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: false as const, maxWaitSeconds: 60 };
    let err: unknown;
    try { await runGovern(ctx, stageByName("govern"), manifest, o); } catch (e) { err = e; }
    expect((err as PublishError).kind).toBe("GOVERN_PENDING");
    expect(tl.s.log).toEqual(["scheduleBatch"]);
    expect(Object.keys(manifest.govern!)).toEqual(["round1.schedule"]);
    // two days later
    tl.s.clock += 172800n;
    let err2: unknown;
    try { await runGovern(ctx, stageByName("govern"), manifest, o); } catch (e) { err2 = e; }
    // round 1 executes, then the updateDelay wait is long again (the min delay is still 172800 until it executes)
    expect(tl.s.log.slice(0, 2)).toEqual(["scheduleBatch", "executeBatch"]);
    expect((err2 as PublishError).kind).toBe("GOVERN_PENDING");
    expect(tl.s.log.filter((l) => l === "scheduleBatch").length).toBe(1);
    tl.s.clock += 172800n;
    await runGovern(ctx, stageByName("govern"), manifest, o);
    expect(tl.s.minDelay).toBe(sheet.govern.newDelay);
    expect(tl.s.log.filter((l) => l === "scheduleBatch").length).toBe(1);
    expect(manifest.stages.govern!.status).toBe("done");
  });

  test("fewer owner signers than the threshold fails with a typed error and sends nothing", async () => {
    const { ctx, sheet } = setup();
    const tl = fakeTimelock(sheet);
    const manifest = newManifest(ctx, addr(0xa001));
    await expect(runGovern(ctx, stageByName("govern"), manifest, { ownerSigners: signers(sheet, 1), sender, api: tl.api, pollMs: 0 })).rejects.toThrow(PublishError);
    expect(tl.s.ops.size).toBe(0);
  });

  test("a Safe whose owners differ from the sheet is refused", async () => {
    const { ctx, sheet } = setup();
    const tl = fakeTimelock(sheet);
    tl.handle.owners = [addr(1), addr(2), addr(3)];
    await expect(runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), { ownerSigners: signers(sheet), sender, api: tl.api })).rejects.toThrow("owners");
  });
});

describe("govern rows: the stdout contract and --row", () => {
  const opts = (sheet: ReturnType<typeof parseSheet>, tl: ReturnType<typeof fakeTimelock>, extra: object = {}) =>
    ({ ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: false as const, maxWaitSeconds: 10_000, ...extra });

  test("a full run prints one {row, txHash, status} line per row, status 1, in run order", async () => {
    const { ctx, sheet } = setup();
    const tl = fakeTimelock(sheet);
    const out: string[] = [];
    await runGovern(ctx, stageByName("govern"), newManifest(ctx, addr(0xa001)), opts(sheet, tl, { emit: (l: string) => out.push(l) }));
    const rows = out.map((l) => JSON.parse(l));
    expect(rows.map((r) => r.row)).toEqual([...GOVERN_ROWS]);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["row", "status", "txHash"]);
      expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.status).toBe(1);
    }
  });

  test("--row by number and by name runs that row only and leaves the stage open", async () => {
    for (const row of ["1", "round1.schedule"]) {
      const { ctx, sheet } = setup();
      const tl = fakeTimelock(sheet);
      const out: string[] = [];
      const manifest = newManifest(ctx, addr(0xa001));
      await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { row, emit: (l: string) => out.push(l) }));
      expect(tl.s.log).toEqual(["scheduleBatch"]);
      expect(out.map((l) => JSON.parse(l).row)).toEqual(["round1.schedule"]);
      expect(Object.keys(manifest.govern!)).toEqual(["round1.schedule"]);
      expect(manifest.stages.govern).toBeUndefined();
    }
  });

  test("rows run one at a time in order add up to the full matrix, and a rerun of a done row reprints its line without a new transaction", async () => {
    const { ctx, sheet } = setup();
    const tl = fakeTimelock(sheet);
    const manifest = newManifest(ctx, addr(0xa001));
    const out: string[] = [];
    for (let n = 1; n <= GOVERN_ROWS.length; n++) await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { row: String(n), emit: (l: string) => out.push(l) }));
    expect(out.map((l) => JSON.parse(l).row)).toEqual([...GOVERN_ROWS]);
    expect(tl.s.log).toEqual(["scheduleBatch", "executeBatch", "schedule", "cancel", "updateDelay.schedule", "updateDelay.execute"]);
    const again: string[] = [];
    await runGovern(ctx, stageByName("govern"), manifest, opts(sheet, tl, { row: "2", emit: (l: string) => again.push(l) }));
    expect(again).toEqual([out[1]!]);
    expect(tl.s.log.length).toBe(6);
  });

  test("an unknown or out-of-range row is a usage error", () => {
    for (const bad of ["0", "7", "nope", "-1"]) expect(() => resolveGovernRow(bad)).toThrow(PublishError);
    expect(resolveGovernRow("6")).toBe("round2.updateDelay.execute");
  });
});
