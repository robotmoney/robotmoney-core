// Issue 1727: the govern surface of a Base mainnet REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal) on 8453, against the fake timelock of govern-world.ts.
// Per row: unpauses, apply-receipt and release-receipt run in production and in a rehearsal. update-delay, batch and cancel run on 8453 ONLY in a rehearsal, as explicit rows after the unpauses.
// register-committee (the consensus receipt submitter) is rehearsal and Twin only. Every refusal has a mutation check: the same call with the mode on (or the input fixed) succeeds.
// QA plan v1 B6 (review CS-2): the submitter Safe authorizes itself in private (commit, reveal, hand-over to the timelock) BEFORE the batch is scheduled, and the public batch is
// setPolicy + committeeRegister, which no squatter can break during the delay (the contract-level proof is ConsensusReceiptSafeSubmitter.t.sol::test_publicRegisterBatchCannotBeFrontRun).
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, getAddress } from "viem";
import { EXIT_CODES } from "../src/errors.ts";
import {
  GATEWAY_REGISTER_ABI, REGISTER_ROW, SUBMITTER_POLICY_CAP, buildRegisterCalls, buildSelfAuthCalls, registerReadBackProblems, registerRecordKey, selfAuthCommitHash, selfAuthPolicyProblems, selfAuthStateOf,
} from "../src/committee-register.ts";
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
  test("a rehearsal on 8453: the submitter Safe self-authorizes in private, THEN ONE batch of setPolicy then committeeRegister, a signalling-only policy owned by the timelock, read back, evidence entry in the run manifest", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    const res = await go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER, agentLabel: "rehearsal-submitter" });
    expect(res.rows).toEqual([registerRecordKey(SUBMITTER)]);
    // QA plan v1 B6: the three submitter-Safe transactions land before the batch is on the timelock, so the address is owned by the timelock before it is public
    expect(tl.s.events).toEqual(["propose:submitter-commit", "propose:submitter-reveal", "propose:submitter-hand-over", `scheduleBatch:${REGISTER_ROW}`, `executeBatch:${REGISTER_ROW}`]);
    const sc = tl.s.scheduled.get(REGISTER_ROW)!;
    expect(sc.form).toBe("batch");
    expect(sc.calls).toHaveLength(2);
    expect(sc.calls.every((c) => c.target === A.gateway)).toBe(true);
    const [auth, reg] = sc.calls.map((c) => decodeFunctionData({ abi: GATEWAY_REGISTER_ABI, data: c.data as `0x${string}` }));
    expect(auth!.functionName).toBe("setPolicy"); // no first-time authorization in the public batch: nothing a squatter does during the delay can make it revert
    expect(tl.s.agentOwner.get(SUBMITTER.toLowerCase())).toBe(A.timelock.toLowerCase());
    expect(tl.s.policies.get(SUBMITTER.toLowerCase())!.shareReceiver).toBe(A.timelock.toLowerCase());
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
    // the private half is in the evidence as its three transactions; the salt stays in the govern state only
    expect(entry.self_authorization).toMatchObject({ commit_tx: expect.stringMatching(/^0x[0-9a-f]{64}$/), reveal_tx: expect.stringMatching(/^0x[0-9a-f]{64}$/), hand_over_tx: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(JSON.stringify(entry)).not.toMatch(/key|pass|secret|salt/i);
  });

  test("QA plan v1 B6: a squatter that already owns the submitter's agent is caught before anything is proposed or scheduled (no timelock round spent); mutation: an unowned Safe runs", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    tl.s.agentOwner.set(SUBMITTER.toLowerCase(), addr(0xbad).toLowerCase());
    tl.s.agentRole.add(SUBMITTER.toLowerCase());
    await expect(go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("Create a NEW submitter Safe") });
    expect(tl.s.events).toEqual([]);
    const ok = mk(REHEARSAL);
    await expect(go(ok.d, ok.tl, ok.manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).resolves.toBeDefined();
  });

  test("QA plan v1 B6: a timelock-owned agent whose policy is not the signalling-only one (a depositor's agent) is refused, the batch would overwrite it; mutation: the submitter shape passes", async () => {
    const seed = (tl: ReturnType<typeof fakeTimelock>, cap: bigint) => {
      tl.s.agentOwner.set(SUBMITTER.toLowerCase(), A.timelock.toLowerCase()); tl.s.agentRole.add(SUBMITTER.toLowerCase());
      tl.s.policies.set(SUBMITTER.toLowerCase(), { maxPerPayment: cap, maxPerWindow: cap, shareReceiver: SUBMITTER.toLowerCase(), maxWithdrawPerPayment: 0n, maxWithdrawPerWindow: 0n });
    };
    const dep = mk(REHEARSAL);
    seed(dep.tl, 1_000_000n);
    await expect(go(dep.d, dep.tl, dep.manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("is not the submitter's signalling-only one") });
    expect(dep.tl.s.events).toEqual([]);
    const own = mk(REHEARSAL);
    seed(own.tl, SUBMITTER_POLICY_CAP); // the private half done by an earlier run (or by the owners by hand): nothing private is sent again
    await go(own.d, own.tl, own.manifest, { row: REGISTER_ROW, submitter: SUBMITTER });
    expect(own.tl.s.events).toEqual([`scheduleBatch:${REGISTER_ROW}`, `executeBatch:${REGISTER_ROW}`]);
  });

  test("QA plan v1 B6: a run that dies after the commit landed reveals the SAME commitment on the next run (no second commit, same salt); an expired one is replaced by a new salt", async () => {
    const dying = (tl: ReturnType<typeof fakeTimelock>, action: string) => {
      const real = tl.api.executeTx as unknown as (...a: unknown[]) => Promise<unknown>;
      let armed = true;
      tl.api.executeTx = (async (h: unknown, b: { action?: string }, snd: unknown) => { if (armed && b.action === action) { armed = false; throw new Error("stale RPC"); } return real(h, b, snd); }) as never;
    };
    const saltOf = (m: ReturnType<typeof newManifest>) => (m as unknown as { govern: Record<string, { register?: { self_authorization?: { salt?: string } } }> }).govern[registerRecordKey(SUBMITTER)]!.register!.self_authorization!.salt;
    const { d, tl, manifest } = mk(REHEARSAL);
    dying(tl, "submitter-reveal");
    await expect(go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toThrow("stale RPC");
    expect(tl.s.events).toEqual(["propose:submitter-commit", "propose:submitter-reveal"]);
    const first = saltOf(manifest);
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    await go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER });
    expect(tl.s.events.slice(2)).toEqual(["propose:submitter-reveal", "propose:submitter-hand-over", `scheduleBatch:${REGISTER_ROW}`, `executeBatch:${REGISTER_ROW}`]);
    expect(saltOf(manifest)).toBe(first);
    // the commitment's window (256 blocks) ran out before the resume: a new commit, with a new salt
    const late = mk(REHEARSAL);
    dying(late.tl, "submitter-reveal");
    await expect(go(late.d, late.tl, late.manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toThrow("stale RPC");
    const old = saltOf(late.manifest);
    late.tl.s.clock += 600n;
    await go(late.d, late.tl, late.manifest, { row: REGISTER_ROW, submitter: SUBMITTER });
    expect(late.tl.s.events.slice(2, 5)).toEqual(["propose:submitter-commit", "propose:submitter-reveal", "propose:submitter-hand-over"]);
    expect(saltOf(late.manifest)).not.toBe(old);
  });

  test("QA plan v1 B6: the private calls hide the agent in the commit, pay the Safe itself in the reveal and hand the agent to the timelock; the state names each step", () => {
    const salt = `0x${"5a".repeat(32)}` as const;
    const c = buildSelfAuthCalls(A.gateway, A.timelock, SUBMITTER, salt, 1000n);
    expect(c.commit.data.toLowerCase()).not.toContain(SUBMITTER.slice(2).toLowerCase()); // the commit names no agent
    expect(decodeFunctionData({ abi: GATEWAY_REGISTER_ABI, data: c.commit.data }).args).toEqual([selfAuthCommitHash(SUBMITTER, salt)]);
    const rv = decodeFunctionData({ abi: GATEWAY_REGISTER_ABI, data: c.reveal.data });
    expect(rv.functionName).toBe("revealAuthorization");
    expect((rv.args![2] as { shareReceiver: string }).shareReceiver.toLowerCase()).toBe(SUBMITTER.toLowerCase()); // a caller without ADMIN_ROLE must name itself
    expect(decodeFunctionData({ abi: GATEWAY_REGISTER_ABI, data: c.handOver.data })).toMatchObject({ functionName: "transferAgentOwnership", args: [getAddress(SUBMITTER), getAddress(A.timelock)] });
    const st = (owner: string, agentRole: boolean) => selfAuthStateOf({ owner, agentRole, submitter: SUBMITTER, timelock: A.timelock });
    expect(st(addr(0), false)).toBe("fresh");
    expect(st(addr(0), true)).toBe("foreign-role");
    expect(st(SUBMITTER, true)).toBe("self-owned");
    expect(st(A.timelock, true)).toBe("handed-over");
    expect(st(addr(0xbad), true)).toBe("squatted");
    const shape = { maxPerPayment: 1n, maxPerWindow: 1n, shareReceiver: A.timelock as string, maxWithdrawPerPayment: 0n, maxWithdrawPerWindow: 0n };
    expect(selfAuthPolicyProblems(shape, SUBMITTER, A.timelock)).toEqual([]);
    expect(selfAuthPolicyProblems({ ...shape, shareReceiver: SUBMITTER }, SUBMITTER, A.timelock)).toEqual([]);
    expect(selfAuthPolicyProblems({ ...shape, maxPerWindow: 5n }, SUBMITTER, A.timelock)).toHaveLength(1);
    expect(selfAuthPolicyProblems({ ...shape, maxWithdrawPerPayment: 1n }, SUBMITTER, A.timelock)).toHaveLength(1);
    expect(selfAuthPolicyProblems({ ...shape, shareReceiver: addr(0xbad) }, SUBMITTER, A.timelock)).toHaveLength(1);
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

  test("issue 1750: the submitter is a Safe: the evidence entry carries its threshold and owners; a key (no code) is refused on 8453 and nothing is scheduled (mutation: a Safe passes)", async () => {
    const ok = mk(REHEARSAL);
    await go(ok.d, ok.tl, ok.manifest, { row: REGISTER_ROW, submitter: SUBMITTER });
    const entry = (ok.manifest as unknown as { committee_registrations: { submitter_safe?: { threshold: number; owners: string[]; code_hash: string } }[] }).committee_registrations[0]!;
    expect(entry.submitter_safe).toMatchObject({ threshold: 2 });
    expect(entry.submitter_safe!.owners).toHaveLength(3);
    const key = mk(REHEARSAL);
    key.tl.s.submitterKind = null;
    await expect(go(key.d, key.tl, key.manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("single key") });
    expect(key.tl.s.events).toEqual([]);
  });

  test("issue 1750: a non-canonical Safe, and the governing Safe or timelock as submitter, are refused before anything is scheduled", async () => {
    const bad = mk(REHEARSAL);
    bad.tl.s.submitterKind = () => { throw Object.assign(new Error("not a canonical SafeL2 1.4.1 multisig: threshold is 1"), { kind: "USAGE" }); };
    await expect(go(bad.d, bad.tl, bad.manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("threshold is 1") });
    expect(bad.tl.s.events).toEqual([]);
    for (const who of [A.safe, A.timelock]) {
      const m = mk(REHEARSAL);
      await expect(go(m.d, m.tl, m.manifest, { row: REGISTER_ROW, submitter: who })).rejects.toMatchObject({ kind: "USAGE" });
      expect(m.tl.s.events).toEqual([]);
    }
  });

  test("issue 1750: on the Twin chain a key submitter is still accepted once it has authorized itself and handed the agent to the timelock; the evidence entry then has no submitter_safe", async () => {
    const d = setup(REHEARSAL, 918453);
    const tl = fakeTimelock(d.sheet, 900n);
    tl.s.submitterKind = null;
    const manifest = newManifest(d.ctx, addr(0xa001));
    // QA plan v1 B6: the tool cannot sign for a key, so a fresh key is refused with the three private steps named, and nothing is scheduled
    await expect(go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("transferAgentOwnership") });
    expect(tl.s.events).toEqual([]);
    // mutation: the key did the private half itself (owner the timelock, the signalling-only policy paying the key)
    tl.s.agentOwner.set(SUBMITTER.toLowerCase(), A.timelock.toLowerCase()); tl.s.agentRole.add(SUBMITTER.toLowerCase());
    tl.s.policies.set(SUBMITTER.toLowerCase(), { maxPerPayment: SUBMITTER_POLICY_CAP, maxPerWindow: SUBMITTER_POLICY_CAP, shareReceiver: SUBMITTER.toLowerCase(), maxWithdrawPerPayment: 0n, maxWithdrawPerWindow: 0n });
    await go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER });
    expect(tl.s.events).toEqual([`scheduleBatch:${REGISTER_ROW}`, `executeBatch:${REGISTER_ROW}`]);
    expect((manifest as unknown as { committee_registrations: Record<string, unknown>[] }).committee_registrations[0]!.submitter_safe).toBeUndefined();
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
    expect(registerReadBackProblems({ ...ok, shareReceiver: A.timelock })).toEqual([]);
    expect(registerReadBackProblems({ ...ok, shareReceiver: SUBMITTER })).toHaveLength(1); // the batch's setPolicy did not land: shares still go to the Safe
  });

  test("the calls are deterministic and differ with the validity, the label and the submitter", () => {
    const base = buildRegisterCalls(A.gateway, A.timelock, SUBMITTER, "a", 1000n);
    expect(buildRegisterCalls(A.gateway, A.timelock, SUBMITTER, "a", 1000n)).toEqual(base);
    expect(buildRegisterCalls(A.gateway, A.timelock, SUBMITTER, "a", 1001n)[0]!.data).not.toBe(base[0]!.data);
    expect(buildRegisterCalls(A.gateway, A.timelock, SUBMITTER, "b", 1000n)[1]!.data).not.toBe(base[1]!.data);
    expect(buildRegisterCalls(A.gateway, A.timelock, addr(0x5ab2), "a", 1000n)[0]!.data).not.toBe(base[0]!.data);
  });
});

describe("production refuses the rehearsal-only rows BEFORE any signer or passphrase prompt (review of PR 1728)", () => {
  const ROWS: string[][] = [["update-delay"], ["batch"], ["cancel"], ["5"], ["6"], ["7"], ["register-committee", "--submitter", SUBMITTER]];
  const probe = async (sheet: Record<string, string>, row: string[]) => {
    const { world: mkWorld } = await import("./harness.ts");
    const w = mkWorld({ chainId: 8453, sheet });
    const calls = { makeSigner: 0, ownerSigner: 0, prompt: 0 };
    const code = await w.run(["govern", "--row", ...row], {
      makeSigner: () => { calls.makeSigner++; throw new Error("stop: a signer was built"); },
      ownerSigner: async () => { calls.ownerSigner++; throw new Error("stop: an owner signer was built"); },
      prompt: async () => { calls.prompt++; return ""; },
      // issue 1816: govern on 8453 passes the release gate, and a rehearsal needs a rehearsal tag
      releaseTag: async () => sheet.DEPLOYMENT_KIND === "rehearsal" ? "release/1.0.0-rehearsal" : "release/1.0.0",
    });
    return { code, calls, msg: w.logs().filter((l) => l.event === "run.failed").pop()?.message as string };
  };
  test("production on 8453: exit USAGE, no signer built, no owner signer, no prompt, for every such row (by name and by number)", async () => {
    for (const row of ROWS) {
      const r = await probe({}, row);
      expect(r.code, row.join(" ")).toBe(EXIT_CODES.USAGE);
      expect(r.calls, row.join(" ")).toEqual({ makeSigner: 0, ownerSigner: 0, prompt: 0 });
      expect(r.msg).toMatch(/refused on chain 8453/);
    }
  });
  test("mutation: the same rows in a rehearsal get past the refusal and reach the signer", async () => {
    for (const row of ROWS) {
      const r = await probe({ DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "20261010" }, row);
      expect(r.calls.makeSigner, row.join(" ")).toBeGreaterThan(0);
    }
  });
  test("the unpauses and the on-demand release and apply rows are not refused early in production", async () => {
    for (const row of [["unpause-USDC"], ["1"], ["release-receipt", "--receipt-id", `0x${"ab".repeat(32)}`]]) {
      const r = await probe({}, row);
      expect(r.calls.makeSigner, row.join(" ")).toBeGreaterThan(0);
    }
  });
});
