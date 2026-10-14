// Issue 1743, issue 1698: the router's ACTIVE vector (the storage keeps its pre-1698 "voted" name) overrides the default vector while votedWeightsActive is true. apply-receipt
// WRITES that active vector in one RouterGovernance.applyReceipt call, so an active vector from an earlier receipt is replaced, never a refusal, and its read-back checks the
// EFFECTIVE weights. The clear-voted-weights row is the emergency lever: it drops the active vector through the Safe and the timelock so the default routes again.
// In-memory Safe and timelock (tests/govern-world.ts), whose fake RouterGovernance behaves as the contract does (release + setWeights in one call).
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { receiptPayloadDigest } from "../src/receipt-digest.ts";
import { decodeFunctionData, toBytes } from "viem";
import { APPLY_ROW, GOVERNANCE_APPLY_ABI, applyReadBackProblems, applyRecordKey, planApply, type ApplyInputs } from "../src/apply-receipt.ts";
import { CLEAR_ROW, GOVERNANCE_CLEAR_ABI, buildClearCall, clearReadBackProblems } from "../src/clear-voted-weights.ts";
import { EXIT_CODES } from "../src/errors.ts";
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

/** A router whose DEFAULT is 6000/2500/1500 over the eligible set and, when `active`, whose ACTIVE vector is 100% rmUSDC: the first 8453 deployment's state. */
const GOOD = [
  { bucket: "agent_tokens", weight_bps: 0 }, { bucket: "conservative_defi_yield", weight_bps: 5000 },
  { bucket: "protocol_tokens", weight_bps: 3000 }, { bucket: "real_world_assets", weight_bps: 2000 },
];
const WANT_VAULTS = [A.vaults.USDC, A.vaults.PROTO, A.vaults.RWA];
const DEFAULT_BPS = [6000n, 2500n, 1500n];
function world(chainId = 918453, active = true) {
  const d = setup(ALL, chainId);
  const tl = fakeTimelock(d.sheet, DELAY);
  tl.s.ineligible.add(A.vaults.AGENT);
  tl.s.recorded.add(RID);
  const file = join(d.ctx.coreDir, "payload.json");
  const text = JSON.stringify({ schema_version: "1.0", weights: GOOD });
  writeFileSync(file, text);
  tl.s.digests.set(RID, receiptPayloadDigest(toBytes(text)));
  tl.s.weights = { vaults: WANT_VAULTS, bps: [...DEFAULT_BPS] };
  if (active) tl.s.voted = { vaults: [A.vaults.USDC], bps: [10000n] };
  const manifest = newManifest(d.ctx, addr(0xa001));
  const apply = (extra: object = {}) => runGovern(d.ctx, stageByName("govern"), manifest, opts(d.sheet, tl, { row: APPLY_ROW, receiptId: RID, payload: file, ...extra }));
  const clear = (extra: object = {}) => runGovern(d.ctx, stageByName("govern"), manifest, opts(d.sheet, tl, { row: CLEAR_ROW, ...extra }));
  return { ...d, tl, file, manifest, apply, clear };
}

describe("apply-receipt writes the active vector in one call: an earlier active vector is replaced, not a refusal (issue 1698)", () => {
  test("planApply has no active-vector input: the state of the router is not a precondition of the plan", () => {
    const base: ApplyInputs = { receiptId: RID, payload: toBytes(JSON.stringify({ schema_version: "1.0", weights: GOOD })), recorded: true, released: false, eligible: WANT_VAULTS, vaultOf: A.vaults };
    base.storedDigest = receiptPayloadDigest(base.payload);
    // the type has no votedWeightsActive field, and a pre-1698 caller that still passes one changes nothing
    expect(planApply({ ...base, ...({ votedWeightsActive: true } as object) })).toEqual({ vaults: WANT_VAULTS, bps: [5000, 3000, 2000] });
    expect(planApply(base)).toEqual({ vaults: WANT_VAULTS, bps: [5000, 3000, 2000] });
  });
  test("with an active vector on the router the call is scheduled and executed, the receipt vector becomes the active one and the default is untouched", async () => {
    const w = world();
    expect(w.tl.s.voted).toEqual({ vaults: [A.vaults.USDC], bps: [10000n] });
    await w.apply({ warp: warpTo(w.tl) });
    expect(w.tl.s.events).toEqual(["schedule:apply-receipt", "execute:apply-receipt"]);
    expect(w.tl.s.released.has(RID)).toBe(true);
    // the ACTIVE vector is the receipt's; the DEFAULT (fallback) vector did not move
    expect(w.tl.s.voted).toEqual({ vaults: WANT_VAULTS, bps: [5000n, 3000n, 2000n] });
    expect(w.tl.s.weights).toEqual({ vaults: WANT_VAULTS, bps: DEFAULT_BPS });
    const e = (w.manifest as { receipt_applications?: any[] }).receipt_applications![0];
    expect(e).toMatchObject({ effective_vaults: WANT_VAULTS, effective_bps: [5000, 3000, 2000], governance: A.governance, receipt: A.receipt });
    expect(e).not.toHaveProperty("voted_weights_active");
  });
  test("the one call is RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps), scheduled with `schedule`, never a batch", async () => {
    const w = world();
    await w.apply({ warp: warpTo(w.tl) });
    const sc = w.tl.s.scheduled.get("apply-receipt")!;
    expect(sc.form).toBe("single");
    expect(sc.calls.length).toBe(1);
    expect(sc.calls[0]!.target).toBe(A.governance);
    const d = decodeFunctionData({ abi: GOVERNANCE_APPLY_ABI, data: sc.calls[0]!.data as `0x${string}` });
    expect(d.functionName).toBe("applyReceipt");
    expect(d.args).toEqual([RID, receiptPayloadDigest(toBytes(JSON.stringify({ schema_version: "1.0", weights: GOOD }))), WANT_VAULTS, [5000n, 3000n, 2000n]]);
    expect(w.tl.s.log).toEqual(["schedule", "execute"]);
  });
  test("with no active vector the call executes the same way, and the evidence records the effective weights", async () => {
    const w = world(918453, false);
    await w.apply({ warp: warpTo(w.tl) });
    expect(w.tl.s.voted).toEqual({ vaults: WANT_VAULTS, bps: [5000n, 3000n, 2000n] });
    const e = (w.manifest as { receipt_applications?: any[] }).receipt_applications![0];
    expect(e).toMatchObject({ effective_vaults: WANT_VAULTS, effective_bps: [5000, 3000, 2000], payload_digest: receiptPayloadDigest(toBytes(JSON.stringify({ schema_version: "1.0", weights: GOOD }))) });
  });
  test("an active vector set while the call waits on the timelock is replaced at the execute, not a refusal (8453: schedule, pend, execute)", async () => {
    const w = world(8453, false);
    await expect(w.apply({ warp: noWarp })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(w.tl.s.events).toEqual(["schedule:apply-receipt"]);
    w.tl.s.voted = { vaults: [A.vaults.USDC], bps: [10000n] };
    w.tl.s.clock += DELAY + 1n;
    await w.apply({ warp: noWarp });
    expect(w.tl.s.events).toEqual(["schedule:apply-receipt", "execute:apply-receipt"]);
    expect(w.tl.s.voted).toEqual({ vaults: WANT_VAULTS, bps: [5000n, 3000n, 2000n] });
  });
  test("the read-back exits GOVERN when the EFFECTIVE weights differ from the receipt vector, and records no evidence entry", async () => {
    const w = world(918453, false);
    w.tl.s.reads.getEffectiveWeights = [[A.vaults.USDC], [10000n]];
    await expect(w.apply({ warp: warpTo(w.tl) })).rejects.toMatchObject({ kind: "GOVERN", exitCode: EXIT_CODES.GOVERN, message: expect.stringContaining("getEffectiveWeights") });
    expect(w.manifest.govern![applyRecordKey(RID)]).not.toHaveProperty("executed");
    expect((w.manifest as { receipt_applications?: unknown[] }).receipt_applications).toBeUndefined();
  });
  test("applyReadBackProblems reads the effective vector and the release only: the default vector and the active flag are not its business", () => {
    const v = { vaults: WANT_VAULTS, bps: [5000, 3000, 2000] };
    expect(applyReadBackProblems(RID, true, { effectiveVaults: WANT_VAULTS, effectiveBps: [5000n, 3000n, 2000n] }, v)).toEqual([]);
    expect(applyReadBackProblems(RID, false, { effectiveVaults: WANT_VAULTS, effectiveBps: [5000n, 3000n, 2000n] }, v)).toEqual([expect.stringContaining("isReleased")]);
    expect(applyReadBackProblems(RID, true, { effectiveVaults: WANT_VAULTS, effectiveBps: DEFAULT_BPS }, v)).toEqual([expect.stringContaining("getEffectiveWeights")]);
  });
  test("a rerun of a completed application reprints its lines and sends nothing: a receipt is applied once", async () => {
    const w = world();
    await w.apply({ warp: warpTo(w.tl) });
    expect(w.tl.s.released.has(RID)).toBe(true);
    w.tl.s.events.length = 0;
    await expect(w.apply({ warp: warpTo(w.tl) })).resolves.toBeDefined(); // the completed round reprints, nothing is sent
    expect(w.tl.s.events).toEqual([]);
    expect(w.tl.s.voted).toEqual({ vaults: WANT_VAULTS, bps: [5000n, 3000n, 2000n] });
  });
});

describe("the clear-voted-weights row: the emergency lever (issue 1743)", () => {
  test("it is on demand: not a numbered row, not in the matrix, not part of stage 13, allowed in production on 8453", () => {
    expect([...GOVERN_ROWS]).not.toContain(CLEAR_ROW);
    expect([...stageRows(8453)]).not.toContain(CLEAR_ROW);
    expect(() => resolveGovernRow(CLEAR_ROW)).toThrow("on-demand");
    for (const kind of ["production", "rehearsal"] as const) for (const chain of [8453, 918453]) expect(govRowRefusal(CLEAR_ROW, chain, kind)).toBeUndefined();
  });
  test("one single timelock call, RouterGovernance.clearVotedWeights(), then the active vector is gone and effective equals the default", async () => {
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
  test("it refuses (GOVERN) and schedules nothing when no active vector is set", async () => {
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
  test("a second run is a no-op reprint, and a later applied receipt (an active vector again) opens round 2 with a new operation", async () => {
    const w = world();
    await w.clear({ warp: warpTo(w.tl) });
    const firstId = w.tl.s.ids.get(CLEAR_ROW);
    await expect(w.clear({ warp: warpTo(w.tl) })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("nothing to clear") });
    // the next receipt is applied: the router routes by it, and the lever is needed again
    await w.apply({ warp: warpTo(w.tl) });
    expect(w.tl.s.voted).toEqual({ vaults: WANT_VAULTS, bps: [5000n, 3000n, 2000n] });
    await w.clear({ warp: warpTo(w.tl) });
    expect(w.tl.s.ids.get(CLEAR_ROW)).not.toBe(firstId);
    expect(w.manifest.govern![roundKey(CLEAR_ROW, 1)]).toBeDefined();
    expect((w.manifest as { voted_weights_clears?: any[] }).voted_weights_clears!.map((x) => x.round)).toEqual([1, 2]);
    expect(w.tl.s.voted).toBeUndefined();
    expect(w.tl.s.weights).toEqual({ vaults: WANT_VAULTS, bps: DEFAULT_BPS }); // the default never moved
  });
  test("the flow the rebalance needs: apply (the receipt vector routes), clear (the default routes again), the receipt stays released", async () => {
    const w = world(918453, false);
    await w.apply({ warp: warpTo(w.tl) });
    expect(w.tl.s.voted).toEqual({ vaults: WANT_VAULTS, bps: [5000n, 3000n, 2000n] });
    await w.clear({ warp: warpTo(w.tl) });
    expect(w.tl.s.voted).toBeUndefined();
    expect(w.tl.s.released.has(RID)).toBe(true);
    expect(w.tl.s.weights).toEqual({ vaults: WANT_VAULTS, bps: DEFAULT_BPS });
  });
});
