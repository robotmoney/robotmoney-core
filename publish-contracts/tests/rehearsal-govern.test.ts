// Issue 1727: the govern surface of a Base mainnet REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal) on 8453, against the fake timelock of govern-world.ts.
// Per row: unpauses, apply-receipt and release-receipt run in production and in a rehearsal. update-delay, batch and cancel run on 8453 ONLY in a rehearsal, as explicit rows after the unpauses.
// register-committee (the consensus receipt submitter) is rehearsal and Twin only. Every refusal has a mutation check: the same call with the mode on (or the input fixed) succeeds.
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, getAddress } from "viem";
import { EXIT_CODES } from "../src/errors.ts";
import { GATEWAY_REGISTER_ABI, REGISTER_ROW, SUBMITTER_POLICY_CAP, buildRegisterCalls, registerReadBackProblems, registerRecordKey } from "../src/committee-register.ts";
import { GOVERN_ROWS, TWIN_ONLY_ROWS, runGovern, stageRows, twinOnlyRefused } from "../src/govern.ts";
import { newManifest } from "../src/runner.ts";
import { updateTimelockDelay } from "../src/safe/timelock.ts";
import { parseSheet } from "../src/sheet.ts";
import { stageByName } from "../src/stages.ts";
import { A, addr, fakeTimelock, sender, setup, signers } from "./govern-world.ts";

const ALL = { ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,AGENT,RWA", ROUTER_WEIGHTS: "USDC:5000,PROTO:2500,AGENT:1000,RWA:1500" };
const REHEARSAL = { ...ALL, DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "20261010" };
const SUBMITTER = addr(0x5ab1);
const opts = (sheet: ReturnType<typeof parseSheet>, tl: ReturnType<typeof fakeTimelock>, extra: object = {}) =>
  ({ ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: false as const, maxWaitSeconds: 10_000_000, emit: () => {}, ...extra });
const go = (d: ReturnType<typeof setup>, tl: ReturnType<typeof fakeTimelock>, manifest: ReturnType<typeof newManifest>, extra: object = {}) =>
  runGovern(d.ctx, stageByName("govern"), manifest, opts(d.sheet, tl, extra));
const mk = (over: Record<string, string>, delay = 900n) => {
  const d = setup(over, 8453);
  const tl = fakeTimelock(d.sheet, delay);
  return { d, tl, manifest: newManifest(d.ctx, addr(0xa001)) };
};

describe("update-delay, batch and cancel on 8453: refused in production, allowed in a rehearsal", () => {
  test("twinOnlyRefused is true only for the three rows, on 8453, outside a rehearsal", () => {
    for (const row of TWIN_ONLY_ROWS) {
      expect(twinOnlyRefused(row, 8453, "production")).toBe(true);
      expect(twinOnlyRefused(row, 8453, "rehearsal")).toBe(false); // mutation: the mode lifts exactly this refusal
      expect(twinOnlyRefused(row, 918453, "production")).toBe(false);
    }
    expect(twinOnlyRefused("unpause-USDC", 8453, "production")).toBe(false);
  });

  test("production on 8453: all three are refused with USAGE and nothing is sent", async () => {
    for (const row of TWIN_ONLY_ROWS) {
      const { d, tl, manifest } = mk(ALL, 172800n);
      await expect(go(d, tl, manifest, { row })).rejects.toMatchObject({ kind: "USAGE", exitCode: EXIT_CODES.USAGE });
      expect(tl.s.events).toEqual([]);
    }
  });

  test("a rehearsal on 8453: the unpauses first, then update-delay, batch and cancel run as explicit rows, in order", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    expect([...stageRows(8453)]).toEqual(GOVERN_ROWS.slice(0, 4)); // stage 13 on 8453 stays the four unpauses, rehearsal or not
    // a Twin-only row cannot start before the unpauses are complete
    await expect(go(d, tl, manifest, { row: "update-delay" })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("is not complete") });
    await go(d, tl, manifest);
    expect(tl.s.paused.size).toBe(0);
    await go(d, tl, manifest, { row: "update-delay" });
    expect(tl.s.minDelay).toBe(1800n);
    await go(d, tl, manifest, { row: "batch" });
    await go(d, tl, manifest, { row: "cancel" });
    expect(tl.s.events.filter((e) => /update-delay|batch|cancel/.test(e))).toEqual([
      "updateDelay.schedule:update-delay", "updateDelay.execute:update-delay", "scheduleBatch:batch", "executeBatch:batch", "schedule:cancel", "cancel:cancel"]);
  });

  test("batch reads the LIVE rmUSDC cap, not the sheet's, so it stays a no-op (review advisory 5)", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    await go(d, tl, manifest);
    await go(d, tl, manifest, { row: "update-delay" });
    tl.s.reads.perDepositCap = 777n; // a setter changed the cap on chain after the sheet was frozen
    await go(d, tl, manifest, { row: "batch" });
    const capCall = tl.s.scheduled.get("batch")!.calls.find((c) => c.target === A.vaults.USDC)!;
    const { decodeFunctionData: dec, parseAbi: pa } = await import("viem");
    expect(dec({ abi: pa(["function setPerDepositCap(uint256 newCap)"]), data: capCall.data as `0x${string}` }).args).toEqual([777n]);
    expect(d.sheet.vaults.USDC.perDepositCap).not.toBe(777n);
  });

  test("the update-delay floor of the Safe tool follows the kind: 899 refused, 900 passes the floor, 172800 refused as a rehearsal delay; production keeps 172800", async () => {
    const handle = { chain: { chainId: 8453 } } as never;
    const code = async (newDelay: bigint, deploymentKind?: "rehearsal" | "production"): Promise<string> => {
      try { await updateTimelockDelay(handle, { timelock: A.timelock, newDelay, phase: "schedule", salt: `0x${"11".repeat(32)}`, deploymentKind } as never); return "passed the floor"; } catch (e) { return (e as { code?: string }).code ?? String(e); }
    };
    expect(await code(899n, "rehearsal")).toBe("UNSAFE_DELAY");
    expect(await code(172800n, "rehearsal")).toBe("UNSAFE_DELAY");
    expect(await code(900n, "rehearsal")).not.toBe("UNSAFE_DELAY"); // mutation: one second more and the floor no longer refuses (the next failure is the missing chain, not the floor)
    for (const k of [undefined, "production"] as const) {
      expect(await code(1800n, k)).toBe("UNSAFE_DELAY");
      expect(await code(172799n, k)).toBe("UNSAFE_DELAY");
      expect(await code(172800n, k)).not.toBe("UNSAFE_DELAY");
    }
  });
});

describe("register-committee: the consensus receipt submitter, through the Safe and the timelock", () => {
  test("a rehearsal on 8453: ONE batch of authorizeAgent then committeeRegister, a signalling-only policy owned by the timelock, read back, evidence entry in the run manifest", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    const res = await go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER, agentLabel: "rehearsal-submitter" });
    expect(res.rows).toEqual([registerRecordKey(SUBMITTER)]);
    expect(tl.s.events).toEqual([`scheduleBatch:${REGISTER_ROW}`, `executeBatch:${REGISTER_ROW}`]);
    const sc = tl.s.scheduled.get(REGISTER_ROW)!;
    expect(sc.form).toBe("batch");
    expect(sc.calls).toHaveLength(2);
    expect(sc.calls.every((c) => c.target === A.gateway)).toBe(true);
    const [auth, reg] = sc.calls.map((c) => decodeFunctionData({ abi: GATEWAY_REGISTER_ABI, data: c.data as `0x${string}` }));
    expect(auth!.functionName).toBe("authorizeAgent");
    const [agent, p] = auth!.args as unknown as [string, { active: boolean; maxPerPayment: bigint; maxPerWindow: bigint; shareReceiver: string; maxWithdrawPerPayment: bigint; allowedDestinations: string[] }];
    expect(agent.toLowerCase()).toBe(SUBMITTER.toLowerCase());
    expect(p).toMatchObject({ active: true, maxPerPayment: SUBMITTER_POLICY_CAP, maxPerWindow: SUBMITTER_POLICY_CAP, maxWithdrawPerPayment: 0n });
    expect(p.shareReceiver.toLowerCase()).toBe(A.timelock.toLowerCase());
    expect(p.allowedDestinations).toEqual([]);
    expect(reg).toMatchObject({ functionName: "committeeRegister", args: [expect.any(String), "rehearsal-submitter"] });
    expect(tl.s.agentRole.has(SUBMITTER.toLowerCase())).toBe(true);
    expect(tl.s.committee.get(SUBMITTER.toLowerCase())).toBe("rehearsal-submitter");
    const entry = (manifest as unknown as { committee_registrations: Record<string, unknown>[] }).committee_registrations[0]!;
    expect(entry).toMatchObject({ step: REGISTER_ROW, submitter: getAddress(SUBMITTER), agent_label: "rehearsal-submitter", gateway: A.gateway, ic_policy: A.icPolicy, timelock: A.timelock, schedule_status: 1, execute_status: 1 });
    expect(JSON.stringify(entry)).not.toMatch(/key|pass|secret/i);
  });

  test("a second run of the same row sends nothing and keeps the same calldata (validUntil is fixed at the first plan)", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    await go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER });
    const first = tl.s.scheduled.get(REGISTER_ROW)!.calls[0]!.data;
    const n = tl.s.events.length;
    tl.s.clock += 5000n;
    await go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER });
    expect(tl.s.events.length).toBe(n);
    expect(tl.s.scheduled.get(REGISTER_ROW)!.calls[0]!.data).toBe(first);
  });

  test("production on 8453 refuses it with USAGE, nothing sent; the same call in a rehearsal runs (mutation)", async () => {
    const prod = mk(ALL, 172800n);
    await expect(go(prod.d, prod.tl, prod.manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("refused on chain 8453 in production") });
    expect(prod.tl.s.events).toEqual([]);
    const reh = mk(REHEARSAL);
    await expect(go(reh.d, reh.tl, reh.manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).resolves.toBeDefined();
  });

  test("a Safe owner, a role key, the Safe, the timelock, an existing agent and the zero address are refused before anything is scheduled", async () => {
    const bad: [string, string | undefined][] = [["a Safe owner", undefined], ["the timelock", A.timelock], ["the Safe", A.safe]];
    for (const [what, who] of bad) {
      const { d, tl, manifest } = mk(REHEARSAL);
      const submitter = who ?? d.sheet.safeOwners[0]!;
      await expect(go(d, tl, manifest, { row: REGISTER_ROW, submitter })).rejects.toMatchObject({ kind: "USAGE" });
      expect(tl.s.events, what).toEqual([]);
    }
    const agent = mk(REHEARSAL);
    agent.tl.s.agentRole.add(SUBMITTER.toLowerCase());
    await expect(go(agent.d, agent.tl, agent.manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("already holds AGENT_ROLE") });
    const admin = mk(REHEARSAL);
    admin.tl.s.gatewayAdmins.add(SUBMITTER.toLowerCase());
    admin.tl.s.agentRole.delete(SUBMITTER.toLowerCase());
    await expect(go(admin.d, admin.tl, admin.manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toBeDefined();
    const zero = mk(REHEARSAL);
    await expect(go(zero.d, zero.tl, zero.manifest, { row: REGISTER_ROW, submitter: addr(0) })).rejects.toMatchObject({ kind: "USAGE" });
    await expect(go(zero.d, zero.tl, zero.manifest, { row: REGISTER_ROW })).rejects.toMatchObject({ kind: "USAGE" });
  });

  test("--submitter without the register row is a usage error", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    await expect(go(d, tl, manifest, { submitter: SUBMITTER })).rejects.toMatchObject({ kind: "USAGE" });
  });

  test("the read-back names every missing effect, and an empty list is a pass", () => {
    const ok = { agentRole: true, committeeRole: true, label: "x", wantLabel: "x", owner: A.timelock, timelock: A.timelock };
    expect(registerReadBackProblems(ok)).toEqual([]);
    expect(registerReadBackProblems({ ...ok, agentRole: false })).toHaveLength(1);
    expect(registerReadBackProblems({ ...ok, committeeRole: false })).toHaveLength(1);
    expect(registerReadBackProblems({ ...ok, label: "y" })).toHaveLength(1);
    expect(registerReadBackProblems({ ...ok, owner: addr(1) })).toHaveLength(1);
  });

  test("the calls are deterministic and differ with the validity, the label and the submitter", () => {
    const base = buildRegisterCalls(A.gateway, A.timelock, SUBMITTER, "a", 1000n);
    expect(buildRegisterCalls(A.gateway, A.timelock, SUBMITTER, "a", 1000n)).toEqual(base);
    expect(buildRegisterCalls(A.gateway, A.timelock, SUBMITTER, "a", 1001n)[0]!.data).not.toBe(base[0]!.data);
    expect(buildRegisterCalls(A.gateway, A.timelock, SUBMITTER, "b", 1000n)[1]!.data).not.toBe(base[1]!.data);
    expect(buildRegisterCalls(A.gateway, A.timelock, addr(0x5ab2), "a", 1000n)[0]!.data).not.toBe(base[0]!.data);
  });
});
