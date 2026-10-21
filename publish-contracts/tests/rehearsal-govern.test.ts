// Issue 1727: the govern surface of a Base mainnet REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal) on 8453, against the fake timelock of govern-world.ts.
// Per row: unpauses, apply-receipt and release-receipt run in production and in a rehearsal. update-delay, batch and cancel run on 8453 ONLY in a rehearsal, as explicit rows after the unpauses.
// Issue 1888: register-submitter (the consensus receipt submitter Safe) is ONE delayed receipt.grantRole(RECEIPT_SUBMITTER_ROLE, safe) on every chain and kind. The retired
// register-committee batch (setPolicy, committeeRegister and the private commit/reveal/hand-over) is gone. Every refusal has a mutation check.
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { EXIT_CODES } from "../src/errors.ts";
import { REGISTER_ROW, RECEIPT_ROLE_ABI, buildRegisterCall, registerReadBackProblems, registerRecordKey } from "../src/submitter-register.ts";
import { PublishError } from "../src/errors.ts";
import { inspectSubmitterSafe } from "../src/submitter-safe.ts";
import { GOVERN_ROWS, TWIN_ONLY_ROWS, runGovern, stageRows, twinOnlyRefused } from "../src/govern.ts";
import { newManifest } from "../src/runner.ts";
import { updateTimelockDelay } from "../src/safe/timelock.ts";
import { parseSheet } from "../src/sheet.ts";
import { stageByName } from "../src/stages.ts";
import { A, SUBMITTER_ROLE_ID, addr, fakeTimelock, sender, setup, signers } from "./govern-world.ts";

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

describe("register-submitter: the receipt submitter Safe, through the Safe and the timelock (issue 1888)", () => {
  const WANT_CALL = () => buildRegisterCall(A.receipt, getAddress(SUBMITTER));
  test("a production sheet on 8453 schedules the ONE grantRole and exits GOVERN_PENDING with a resume command for this row (the 48 hour delay is not waited in one process)", async () => {
    const { d, tl, manifest } = mk(ALL, 172800n);
    await expect(go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "GOVERN_PENDING", message: expect.stringContaining(`--row ${REGISTER_ROW} --submitter ${SUBMITTER}`) });
    expect(tl.s.events).toEqual([`schedule:${REGISTER_ROW}`]);
    expect(tl.s.scheduled.get(REGISTER_ROW)!.calls).toEqual([{ target: A.receipt, data: buildRegisterCall(A.receipt, getAddress(SUBMITTER)).data }]);
    tl.s.clock += 172800n; // the delay passes: the resume executes the same operation and reads the role back
    await go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER, maxWaitSeconds: 3600 });
    expect(tl.s.events).toEqual([`schedule:${REGISTER_ROW}`, `execute:${REGISTER_ROW}`]);
    expect(tl.s.submitterRoles.has(SUBMITTER.toLowerCase())).toBe(true);
  });
  for (const [name, over, chainId] of [["a rehearsal on 8453", REHEARSAL, 8453], ["the Twin chain", ALL, 918453]] as const) {
    test(`${name}: ONE delayed receipt.grantRole(RECEIPT_SUBMITTER_ROLE, safe), no batch, no gateway, no private half; read back; evidence entry written`, async () => {
      const d = setup(over, chainId);
      const tl = fakeTimelock(d.sheet, chainId === 8453 ? 900n : 60n);
      const manifest = newManifest(d.ctx, addr(0xa001));
      const res = await go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER });
      expect(res.rows).toEqual([registerRecordKey(SUBMITTER)]);
      // exactly one schedule and one execute, in the single form: no batch, and no private submitter-Safe transaction before it
      expect(tl.s.events).toEqual([`schedule:${REGISTER_ROW}`, `execute:${REGISTER_ROW}`]);
      const sc = tl.s.scheduled.get(REGISTER_ROW)!;
      expect(sc.form).toBe("single");
      expect(sc.calls).toHaveLength(1);
      expect(sc.calls[0]).toEqual({ target: A.receipt, data: WANT_CALL().data });
      expect(sc.calls[0]!.target).not.toBe(A.gateway);
      const call = decodeFunctionData({ abi: RECEIPT_ROLE_ABI, data: sc.calls[0]!.data as Hex });
      expect(call).toMatchObject({ functionName: "grantRole", args: [SUBMITTER_ROLE_ID, getAddress(SUBMITTER)] });
      expect(tl.s.submitterRoles.has(SUBMITTER.toLowerCase())).toBe(true);
      const entry = (manifest as unknown as { submitter_registrations: Record<string, unknown>[] }).submitter_registrations[0]!;
      expect(entry).toMatchObject({ step: REGISTER_ROW, submitter: getAddress(SUBMITTER), receipt: A.receipt, timelock: A.timelock, schedule_status: 1, execute_status: 1 });
      expect(entry.submitter_safe).toMatchObject({ threshold: 2 });
      expect((manifest as unknown as { committee_registrations?: unknown }).committee_registrations).toBeUndefined();
      expect(JSON.stringify(manifest)).not.toMatch(/salt"?:\s*"0x[0-9a-f]{64}".*self_authorization/);
    });
  }

  test("a rerun after completion schedules nothing more (idempotent) and keeps the one evidence entry", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    await go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER });
    const events = [...tl.s.events];
    await go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER });
    expect(tl.s.events).toEqual(events);
    expect((manifest as unknown as { submitter_registrations: unknown[] }).submitter_registrations).toHaveLength(1);
  });

  test("a submitter that already holds the role is refused before anything is scheduled", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    tl.s.submitterRoles.add(SUBMITTER.toLowerCase());
    await expect(go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("already holds RECEIPT_SUBMITTER_ROLE") });
    expect(tl.s.events).toEqual([]);
  });

  test("the timelock must administer the role: without ADMIN_ROLE on the receipt the grant is refused before it is scheduled", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    tl.s.timelockIsReceiptAdmin = false;
    await expect(go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("does not hold the admin role of RECEIPT_SUBMITTER_ROLE") });
    expect(tl.s.events).toEqual([]);
  });

  test("a key (no code), a non-canonical Safe, the timelock and the deployment role addresses are refused before anything is scheduled; the governing Safe is not", async () => {
    const key = mk(REHEARSAL); key.tl.s.submitterKind = null;
    await expect(go(key.d, key.tl, key.manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("single key") });
    const bad = mk(REHEARSAL);
    bad.tl.s.submitterKind = (async () => { throw new PublishError("USAGE", "the submitter is not a canonical SafeL2 1.4.1 multisig: its threshold is 1, want at least 2. Nothing sent."); }) as never;
    await expect(go(bad.d, bad.tl, bad.manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("threshold is 1") });
    // the real forbidden list refuses the timelock, admin, pauser and emergency before any chain read (forbiddenSubmitters is unit-tested in submitter-safe.test.ts)
    for (const pick of [(m: ReturnType<typeof mk>) => A.timelock, (m: ReturnType<typeof mk>) => m.d.sheet.admin, (m: ReturnType<typeof mk>) => m.d.sheet.pauser, (m: ReturnType<typeof mk>) => m.d.sheet.emergency]) {
      const m = mk(REHEARSAL);
      m.tl.api.inspectSubmitter = ((_h: unknown, who: Address, forbidden: ReadonlyMap<string, string>) => inspectSubmitterSafe({ getCode: async () => undefined, getStorageAt: async () => undefined, read: async () => { throw new Error("no read"); } }, who, forbidden)) as never;
      await expect(go(m.d, m.tl, m.manifest, { row: REGISTER_ROW, submitter: pick(m) as Address })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("Nothing sent") });
      expect(m.tl.s.events).toEqual([]);
    }
    const governing = mk(REHEARSAL);
    await expect(go(governing.d, governing.tl, governing.manifest, { row: REGISTER_ROW, submitter: A.safe })).resolves.toBeDefined();
  });

  test("a bad address or a missing --submitter is a usage error; --submitter without the register row is a usage error; --agent-label no longer exists", async () => {
    const zero = mk(REHEARSAL);
    await expect(go(zero.d, zero.tl, zero.manifest, { row: REGISTER_ROW, submitter: addr(0) })).rejects.toMatchObject({ kind: "USAGE" });
    await expect(go(zero.d, zero.tl, zero.manifest, { row: REGISTER_ROW })).rejects.toMatchObject({ kind: "USAGE" });
    await expect(go(zero.d, zero.tl, zero.manifest, { submitter: SUBMITTER })).rejects.toMatchObject({ kind: "USAGE" });
    expect(zero.tl.s.events).toEqual([]);
  });

  test("a different operation under the same key is refused: one submitter is one operation", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    await go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER });
    const rec = (manifest as unknown as { govern: Record<string, { scheduled?: { operation_id: string } }> }).govern[registerRecordKey(SUBMITTER)]!;
    rec.scheduled!.operation_id = `0x${"ee".repeat(32)}`;
    await expect(go(d, tl, manifest, { row: REGISTER_ROW, submitter: SUBMITTER })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("already used for a different call") });
  });

  test("the read-back names a missing role, and an empty list is a pass; the call is deterministic and differs with the submitter", () => {
    expect(registerReadBackProblems({ submitterRole: true })).toEqual([]);
    expect(registerReadBackProblems({ submitterRole: false })).toHaveLength(1);
    const base = buildRegisterCall(A.receipt, SUBMITTER);
    expect(buildRegisterCall(A.receipt, SUBMITTER)).toEqual(base);
    expect(buildRegisterCall(A.receipt, addr(0x5ab2)).data).not.toBe(base.data);
    expect(buildRegisterCall(A.receipt, SUBMITTER).target).toBe(A.receipt);
  });
});

describe("release-receipt after the narrow-role handover (issue 1888)", () => {
  const RID = `0x${"ab".repeat(32)}` as Hex;
  test("RouterGovernance holds RECEIPT_RELEASER_ROLE: the standalone release is refused with a clear message and nothing is scheduled", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    tl.s.recorded.add(RID);
    await expect(go(d, tl, manifest, { row: "release-receipt", receiptId: RID })).rejects.toMatchObject({
      kind: "USAGE", message: expect.stringMatching(/RouterGovernance .* holds the receipt contract's RECEIPT_RELEASER_ROLE.*the timelock cannot release directly.*--row apply-receipt/s),
    });
    expect(tl.s.events).toEqual([]);
  });
  test("a not-yet-migrated proxy where RouterGovernance still holds ADMIN_ROLE is refused too", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    tl.s.recorded.add(RID); tl.s.governanceIsReceiptReleaser = false; tl.s.governanceIsReceiptAdmin = true;
    await expect(go(d, tl, manifest, { row: "release-receipt", receiptId: RID })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("ADMIN_ROLE") });
    expect(tl.s.events).toEqual([]);
  });
  test("mutation: with no governance release role at all the standalone row still schedules", async () => {
    const { d, tl, manifest } = mk(REHEARSAL);
    tl.s.recorded.add(RID); tl.s.governanceIsReceiptReleaser = false; tl.s.governanceIsReceiptAdmin = false;
    await go(d, tl, manifest, { row: "release-receipt", receiptId: RID });
    expect(tl.s.events).toEqual(["schedule:release-receipt", "execute:release-receipt"]);
  });
});

describe("production refuses the rehearsal-only rows BEFORE any signer or passphrase prompt (review of PR 1728)", () => {
  const ROWS: string[][] = [["update-delay"], ["batch"], ["cancel"], ["5"], ["6"], ["7"]]; // register-submitter is allowed on 8453 in production (issue 1888): see the next describe
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
    for (const row of [["unpause-USDC"], ["1"], ["release-receipt", "--receipt-id", `0x${"ab".repeat(32)}`], ["register-submitter", "--submitter", SUBMITTER]]) {
      const r = await probe({}, row);
      expect(r.calls.makeSigner, row.join(" ")).toBeGreaterThan(0);
    }
  });
});
