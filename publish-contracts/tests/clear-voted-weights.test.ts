// Issue 1743: a voted weight vector overrides the default vector, so apply-receipt (which writes the DEFAULT vector) must refuse while one is active, read the EFFECTIVE weights back,
// and the clear-voted-weights row removes the voted vector through the Safe and the timelock. In-memory Safe and timelock (tests/govern-world.ts).
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { receiptPayloadDigest } from "../src/receipt-digest.ts";
import { decodeFunctionData, keccak256, toBytes } from "viem";
import { APPLY_ROW, applyReadBackProblems, applyRecordKey, planApply } from "../src/apply-receipt.ts";
import { CLEAR_ROW, GOVERNANCE_CLEAR_ABI, buildClearCall, clearReadBackProblems } from "../src/clear-voted-weights.ts";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { GOVERN_ROWS, govRowRefusal, resolveGovernRow, roundKey, runGovern, stageRows } from "../src/govern.ts";
import { newManifest } from "../src/runner.ts";
import { stageByName } from "../src/stages.ts";
import { A, addr, fakeTimelock, sender, setup, signers } from "./govern-world.ts";

const ALL = { ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,AGENT,RWA", ROUTER_WEIGHTS: "USDC:5000,PROTO:2500,AGENT:1000,RWA:1500" };
const DELAY = 172800n;
const RID = `0x${"ab".repeat(32)}` as `0x${string}`;
const noWarp = async () => { throw new Error("no anvil_ or evm_ method on 8453"); };
const opts = (sheet: ReturnType<typeof setup>["sheet"], tl: ReturnType<typeof fakeTimelock>, extra: object = {}) =>
  ({ ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: false as const, maxWaitSeconds: 10_000_000, emit: () => {}, ...extra });
const warpTo = (tl: ReturnType<typeof fakeTimelock>) => async (sec: bigint) => { tl.s.clock += sec; };

/** A router whose DEFAULT is 9500/500 over the eligible set and whose VOTED vector is 100% rmUSDC: the first 8453 deployment. */
const GOOD = [
  { bucket: "agent_tokens", weight_bps: 0 }, { bucket: "conservative_defi_yield", weight_bps: 5000 },
  { bucket: "protocol_tokens", weight_bps: 3000 }, { bucket: "real_world_assets", weight_bps: 2000 },
];
const WANT_VAULTS = [A.vaults.USDC, A.vaults.PROTO, A.vaults.RWA];
function world(chainId = 918453, voted = true) {
  const d = setup(ALL, chainId);
  const tl = fakeTimelock(d.sheet, DELAY);
  tl.s.ineligible.add(A.vaults.AGENT);
  tl.s.recorded.add(RID);
  const file = join(d.ctx.coreDir, "payload.json");
  const text = JSON.stringify({ schema_version: "1.0", weights: GOOD });
  writeFileSync(file, text);
  tl.s.digests.set(RID, receiptPayloadDigest(toBytes(text)));
  tl.s.weights = { vaults: WANT_VAULTS, bps: [6000n, 2500n, 1500n] };
  if (voted) tl.s.voted = { vaults: [A.vaults.USDC], bps: [10000n] };
  const manifest = newManifest(d.ctx, addr(0xa001));
  const apply = (extra: object = {}) => runGovern(d.ctx, stageByName("govern"), manifest, opts(d.sheet, tl, { row: APPLY_ROW, receiptId: RID, payload: file, ...extra }));
  const clear = (extra: object = {}) => runGovern(d.ctx, stageByName("govern"), manifest, opts(d.sheet, tl, { row: CLEAR_ROW, ...extra }));
  return { ...d, tl, file, manifest, apply, clear };
}

describe("apply-receipt refuses while a voted vector is active (issue 1743)", () => {
  test("planApply refuses VOTED_WEIGHTS_ACTIVE (GOVERN) even for a receipt in flight, and names the clear row", () => {
    const base = { receiptId: RID, payload: new Uint8Array(), recorded: true, released: false, eligible: [], vaultOf: A.vaults };
    for (const inFlight of [false, true]) {
      let err: unknown;
      try { planApply({ ...base, inFlight, votedWeightsActive: true }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(PublishError);
      const msg = (err as PublishError).message;
      expect((err as PublishError).kind).toBe("GOVERN");
      expect(msg.includes("VOTED_WEIGHTS_ACTIVE") && msg.includes("--row clear-voted-weights")).toBe(true);
    }
  });
  test("the run refuses before it sends anything: no schedule, no Safe transaction, no manifest row", async () => {
    const w = world();
    await expect(w.apply({ warp: warpTo(w.tl) })).rejects.toMatchObject({ kind: "GOVERN", exitCode: EXIT_CODES.GOVERN, message: expect.stringContaining("VOTED_WEIGHTS_ACTIVE") });
    expect(w.tl.s.events).toEqual([]);
    expect(w.tl.s.log).toEqual([]);
    expect(w.tl.s.released.size).toBe(0);
  });
  test("a vote that activates a voted vector while the batch waits is caught before the execute", async () => {
    const w = world(8453, false);
    await expect(w.apply({ warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(w.tl.s.events).toEqual(["scheduleBatch:apply-receipt"]);
    w.tl.s.voted = { vaults: [A.vaults.USDC], bps: [10000n] };
    w.tl.s.clock += DELAY + 1n;
    await expect(w.apply({ warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("VOTED_WEIGHTS_ACTIVE") });
    expect(w.tl.s.events).toEqual(["scheduleBatch:apply-receipt"]);
  });
  test("with no voted vector the batch executes, the effective weights equal the receipt vector and the evidence records them", async () => {
    const w = world(918453, false);
    await w.apply({ warp: warpTo(w.tl) });
    expect(w.tl.s.weights.vaults).toEqual(WANT_VAULTS);
    const e = (w.manifest as { receipt_applications?: any[] }).receipt_applications![0];
    expect(e).toMatchObject({ voted_weights_active: false, effective_vaults: WANT_VAULTS, effective_bps: [5000, 3000, 2000] });
  });
  test("the read-back exits GOVERN when the EFFECTIVE weights differ from the receipt vector although the default is right", async () => {
    const w = world(918453, false);
    w.tl.s.reads.getEffectiveWeights = [[A.vaults.USDC], [10000n]];
    await expect(w.apply({ warp: warpTo(w.tl) })).rejects.toMatchObject({ kind: "GOVERN", exitCode: EXIT_CODES.GOVERN, message: expect.stringContaining("getEffectiveWeights") });
    expect(w.manifest.govern![applyRecordKey(RID)]).not.toHaveProperty("executed");
    expect((w.manifest as { receipt_applications?: unknown[] }).receipt_applications).toBeUndefined();
  });
  test("the read-back exits GOVERN when votedWeightsActive reads true after the batch", () => {
    const bad = applyReadBackProblems(RID, true, { defaultVaults: WANT_VAULTS, defaultBps: [5000n, 3000n, 2000n], effectiveVaults: WANT_VAULTS, effectiveBps: [5000n, 3000n, 2000n], votedWeightsActive: true }, { vaults: WANT_VAULTS, bps: [5000, 3000, 2000] });
    expect(bad).toEqual([expect.stringContaining("votedWeightsActive() is true")]);
  });
});

describe("the clear-voted-weights row (issue 1743)", () => {
  test("it is on demand: not a numbered row, not in the matrix, not part of stage 13, allowed in production on 8453", () => {
    expect([...GOVERN_ROWS]).not.toContain(CLEAR_ROW);
    expect([...stageRows(8453)]).not.toContain(CLEAR_ROW);
    expect(() => resolveGovernRow(CLEAR_ROW)).toThrow("on-demand");
    for (const kind of ["production", "rehearsal"] as const) for (const chain of [8453, 918453]) expect(govRowRefusal(CLEAR_ROW, chain, kind)).toBeUndefined();
  });
  test("one single timelock call, RouterGovernance.clearVotedWeights(), then the voted vector is gone and effective equals the default", async () => {
    const w = world();
    const res = await w.clear({ warp: warpTo(w.tl) });
    expect(res.rows).toEqual([CLEAR_ROW]);
    expect(w.tl.s.events).toEqual(["schedule:clear-voted-weights", "execute:clear-voted-weights"]);
    const sc = w.tl.s.scheduled.get(CLEAR_ROW)!;
    expect(sc.form).toBe("single");
    expect(sc.calls).toEqual([{ target: A.governance, data: buildClearCall(A.governance).data }]);
    expect(decodeFunctionData({ abi: GOVERNANCE_CLEAR_ABI, data: sc.calls[0]!.data as `0x${string}` }).functionName).toBe("clearVotedWeights");
    expect(w.tl.s.voted).toBeUndefined();
    const entries = (w.manifest as { voted_weights_clears?: any[] }).voted_weights_clears!;
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ step: CLEAR_ROW, round: 1, governance: A.governance, router: A.router, voted_weights_active: false, effective_vaults: WANT_VAULTS, effective_bps: [6000, 2500, 1500], schedule_status: 1, execute_status: 1 });
    expect(entries[0].execute_block_timestamp - entries[0].schedule_block_timestamp).toBeGreaterThanOrEqual(Number(DELAY));
    expect(w.manifest.stages.govern).toBeUndefined();
  });
  test("on 8453 the first run schedules and exits GOVERN_PENDING, the resume after the delay executes", async () => {
    const w = world(8453);
    await expect(w.clear({ warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING", message: expect.stringContaining("--row clear-voted-weights") });
    expect(w.tl.s.events).toEqual(["schedule:clear-voted-weights"]);
    expect(w.tl.s.voted).toBeDefined();
    w.tl.s.clock += DELAY + 1n;
    await w.clear({ warp: noWarp });
    expect(w.tl.s.events).toEqual(["schedule:clear-voted-weights", "execute:clear-voted-weights"]);
    expect(w.tl.s.voted).toBeUndefined();
  });
  test("it refuses (GOVERN) and schedules nothing when no voted vector is active", async () => {
    const w = world(918453, false);
    await expect(w.clear({ warp: warpTo(w.tl) })).rejects.toMatchObject({ kind: "GOVERN", exitCode: EXIT_CODES.GOVERN, message: expect.stringContaining("no voted vector to clear") });
    expect(w.tl.s.events).toEqual([]);
  });
  test("the read-back exits GOVERN when the effective weights are not the default after the execute", async () => {
    const w = world();
    w.tl.s.reads.getEffectiveWeights = [[A.vaults.USDC], [10000n]];
    await expect(w.clear({ warp: warpTo(w.tl) })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("getEffectiveWeights") });
    expect((w.manifest as { voted_weights_clears?: unknown[] }).voted_weights_clears).toBeUndefined();
    expect(clearReadBackProblems({ votedWeightsActive: true, defaultVaults: [], defaultBps: [], effectiveVaults: [], effectiveBps: [] })).toEqual([expect.stringContaining("still true")]);
  });
  test("a second run is a no-op reprint, and a vote that sets a voted vector again opens round 2 with a new operation", async () => {
    const w = world();
    await w.clear({ warp: warpTo(w.tl) });
    const firstId = w.tl.s.ids.get(CLEAR_ROW);
    await expect(w.clear({ warp: warpTo(w.tl) })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("nothing to clear") });
    w.tl.s.voted = { vaults: [A.vaults.USDC], bps: [10000n] };
    await w.clear({ warp: warpTo(w.tl) });
    expect(w.tl.s.ids.get(CLEAR_ROW)).not.toBe(firstId);
    expect(w.manifest.govern![roundKey(CLEAR_ROW, 1)]).toBeDefined();
    expect((w.manifest as { voted_weights_clears?: any[] }).voted_weights_clears!.map((x) => x.round)).toEqual([1, 2]);
  });
  test("the flow the rebalance needs: apply refuses, clear, then apply changes the EFFECTIVE routing", async () => {
    const w = world();
    await expect(w.apply({ warp: warpTo(w.tl) })).rejects.toMatchObject({ message: expect.stringContaining("VOTED_WEIGHTS_ACTIVE") });
    await w.clear({ warp: warpTo(w.tl) });
    await w.apply({ warp: warpTo(w.tl) });
    expect(w.tl.s.voted).toBeUndefined();
    expect(w.tl.s.weights).toEqual({ vaults: WANT_VAULTS, bps: [5000n, 3000n, 2000n] });
  });
});
