// Issue 1750: the consensus receipt submitter is a multisig (a SafeL2 1.4.1 proxy). Owner decision 2026-10-10: no single key.
// Covers the canonical-Safe check (every refusal has a mutation that passes), record-receipt in Safe mode (threshold signers, executeTx by the deployer, Safe address,
// ExecutionSuccess, read-back submitter == the Safe), the govern register row with a Safe submitter, and the evidence block. The real Safe runs on the Twin chain
// (testing/smoke-test/tests/twin_publish.rs), never here.
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, getAddress, keccak256, type Address, type Hex } from "viem";
import { GATEWAY_RECORD_ABI, assertRecordInputs, recordReceipt, type RecordApi, type SafeSendRequest } from "../src/record-receipt.ts";
import { SAFE_GUARD_SLOT, SAFE_SENTINEL } from "../src/verify/constants.ts";
import { FALLBACK_HANDLER_SLOT, SAFE_141 } from "../src/safe/constants.ts";
import { assertSubmitterSafe, forbiddenSubmitters, inspectSubmitterSafe, type SubmitterChain } from "../src/submitter-safe.ts";
import { loadRunManifest, newManifest, saveRunManifest, type RunContext } from "../src/runner.ts";
import { A, addr, setup } from "./govern-world.ts";

const RID = `0x${"ab".repeat(32)}` as Hex, DIGEST = `0x${"cd".repeat(32)}` as Hex, URI = "https://twin.invalid/r.json";
const SUBSAFE = addr(0x5afe);
const OWNERS = [addr(0xa1), addr(0xa2), addr(0xa3)];
const DEPLOYER = addr(0xde11);
const REHEARSAL = { DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "7" };
const signer = (who: Address) => ({ address: async () => who }) as never;
const word = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;

/** A SafeL2 1.4.1 look-alike on a fake chain. `over` mutates one fact at a time. */
interface SafeFacts { code: Hex | undefined; slot0: Hex; version: string; owners: Address[]; threshold: bigint; modules: string[]; guard: Hex; fallback: Hex }
function canonical(): SafeFacts {
  return { code: "0x" as Hex, slot0: word(SAFE_141.singletonL2), version: "1.4.1", owners: OWNERS, threshold: 2n, modules: [], guard: ZERO32, fallback: word(SAFE_141.fallbackHandler) };
}
function chainFor(f: SafeFacts): SubmitterChain {
  return {
    proxyCodehashPin: keccak256(STANDIN),
    getCode: async () => f.code,
    getStorageAt: async (_a, slot) => (slot === "0x0000000000000000000000000000000000000000000000000000000000000000" ? f.slot0 : slot === SAFE_GUARD_SLOT ? f.guard : slot === FALLBACK_HANDLER_SLOT ? f.fallback : ZERO32),
    read: async <T,>(_a: Address, _abi: readonly unknown[], fn: string, args: unknown[] = []): Promise<T> => {
      if (fn === "VERSION") return f.version as never;
      if (fn === "getOwners") return f.owners as never;
      if (fn === "getThreshold") return f.threshold as never;
      if (fn === "getModulesPaginated") { expect(args[0]).toBe(SAFE_SENTINEL); return [f.modules, SAFE_SENTINEL] as never; }
      throw new Error(`fake ${fn}`);
    },
  };
}

describe("submitter-safe: the canonical SafeL2 1.4.1 check", () => {
  const forbidden = forbiddenSubmitters({ governingSafe: A.safe, timelock: A.timelock, admin: addr(0xad), pauser: addr(0xb0), emergency: addr(0xe0) });
  test("every forbidden address is refused with no chain read: the governing Safe, the timelock, admin (= the deployer), the pauser, the emergency key", async () => {
    let reads = 0;
    const chain: SubmitterChain = { getCode: async () => { reads++; return undefined; }, getStorageAt: async () => { reads++; return undefined; }, read: async () => { reads++; throw new Error("x"); } };
    for (const who of [A.safe, A.timelock, addr(0xad), addr(0xb0), addr(0xe0)]) {
      await expect(inspectSubmitterSafe(chain, who, forbidden)).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("Nothing sent") });
    }
    expect(reads).toBe(0);
  });
  test("an address with no code is a key: inspect reports null, assert refuses", async () => {
    const f = canonical(); f.code = undefined;
    expect(await inspectSubmitterSafe(chainFor(f), SUBSAFE, forbidden)).toBeNull();
    await expect(assertSubmitterSafe(chainFor(f), SUBSAFE, forbidden)).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("single key") });
  });
  test("a contract that is not the canonical proxy is refused and EVERY difference is named", async () => {
    const f = canonical(); f.code = "0x6080" as Hex; f.slot0 = word(addr(0xbad)); f.version = "1.3.0"; f.threshold = 1n; f.modules = [addr(0x30d)]; f.guard = word(addr(0x9a)); f.fallback = word(addr(0xfb)); f.owners = [OWNERS[0]!, addr(0xb0)];
    const e = await inspectSubmitterSafe(chainFor(f), SUBSAFE, forbidden).catch((x) => x);
    expect(e).toMatchObject({ kind: "USAGE" });
    for (const w of ["code hash", "singleton", "VERSION()", "threshold is 1", "modules are enabled", "guard", "fallback handler", "role separation", "its owner 2 of 2", getAddress(addr(0xb0))]) expect(e.message).toContain(w);
  });
  test("each single difference alone is refused (mutations of a passing Safe)", async () => {
    const real = await realProxyCode();
    const base = (): SafeFacts => ({ ...canonical(), code: real });
    expect((await inspectSubmitterSafe(chainFor(base()), SUBSAFE, forbidden))!).toMatchObject({ address: getAddress(SUBSAFE), threshold: 2, code_hash: keccak256(STANDIN) });
    const muts: [string, (f: SafeFacts) => void, string][] = [
      ["wrong code", (f) => { f.code = `${real}00` as Hex; }, "code hash"],
      ["wrong singleton", (f) => { f.slot0 = word(SAFE_141.fallbackHandler); }, "singleton"],
      ["L1 singleton", (f) => { f.slot0 = word(addr(0x41)); }, "singleton"],
      ["wrong version", (f) => { f.version = "1.5.0"; }, "VERSION()"],
      ["threshold 1", (f) => { f.threshold = 1n; }, "threshold is 1"],
      ["threshold above owners", (f) => { f.threshold = 4n; }, "above its 3 owners"],
      ["a module", (f) => { f.modules = [addr(0x30d)]; }, "modules are enabled"],
      ["a guard", (f) => { f.guard = word(addr(0x9a)); }, "guard"],
      ["a custom fallback handler", (f) => { f.fallback = word(addr(0xfb)); }, "fallback handler"],
      ["no fallback handler", (f) => { f.fallback = ZERO32; }, "fallback handler"],
      ["the pauser as owner", (f) => { f.owners = [OWNERS[0]!, OWNERS[1]!, addr(0xb0)]; }, "role separation"],
      ["the timelock as owner", (f) => { f.owners = [OWNERS[0]!, OWNERS[1]!, A.timelock]; }, "role separation"],
    ];
    for (const [name, mutate, want] of muts) {
      const f = base(); mutate(f);
      await expect(inspectSubmitterSafe(chainFor(f), SUBSAFE, forbidden), name).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining(want) });
    }
  });
});

/** A stand-in proxy code: its hash is the pin the fake chain reports (the real hash is pinned in SAFE_141 and checked against a real Safe in the Twin test). */
const STANDIN = "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167f" as Hex;
const realProxyCode = async (): Promise<Hex> => STANDIN;

function mk(over: Record<string, string> = {}, chainId = 918453) {
  const d = setup({ ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,AGENT,RWA", ROUTER_WEIGHTS: "USDC:5000,PROTO:2500,AGENT:1000,RWA:1500", ...over }, chainId);
  const ctx = { ...d.ctx, caller: { yes: chainId !== 8453, confirm: "typed" }, prompt: async () => "record-receipt", resume: true, chainId } as unknown as RunContext;
  saveRunManifest(ctx.evidenceDir, newManifest(ctx, addr(0xa001)));
  const st = {
    agent: true, committee: true, recorded: null as null | { receiptId: Hex; payloadDigest: Hex; payloadUri: string; submitter: Address },
    reqs: [] as SafeSendRequest[], eoaSent: 0, facts: canonical(), executedBy: SUBSAFE as Address, executionSuccess: true, status: "success" as "success" | "reverted",
  };
  const api: RecordApi = {
    async read(address, _abi, fn, args = []) {
      if (fn === "consensusReceipt") return A.receipt as never;
      if (fn === "hasRole") return (address === A.icPolicy ? st.committee : st.agent) as never;
      if (fn === "isRecorded") return (st.recorded !== null) as never;
      if (fn === "getReceiptById") return st.recorded as never;
      throw new Error(`fake ${fn} ${String(args)}`);
    },
    async send() { st.eoaSent++; throw new Error("the key path must not be used in Safe mode"); },
    chain: { proxyCodehashPin: keccak256(STANDIN), getCode: (a) => chainFor(st.facts).getCode(a), getStorageAt: (a, s) => chainFor(st.facts).getStorageAt(a, s), read: (a, abi, fn, args) => chainFor(st.facts).read(a, abi, fn, args) },
    async sendViaSafe(req) {
      st.reqs.push(req);
      const [receiptId, payloadDigest, payloadUri] = decodeFunctionData({ abi: GATEWAY_RECORD_ABI, data: req.data }).args as [Hex, Hex, string];
      st.recorded = { receiptId, payloadDigest, payloadUri, submitter: req.safe };
      const signers = await Promise.all(req.ownerSigners.map((s) => s.address()));
      return { txHash: `0x${"22".repeat(32)}` as Hex, status: st.status, blockNumber: 6n, safe: st.executedBy, safeTxHash: `0x${"33".repeat(32)}` as Hex, nonce: 4, signers, sentBy: await req.sender.address(), executionSuccess: st.executionSuccess };
    },
  };
  return { ctx, st, api, d, inputs: assertRecordInputs({ receiptId: RID, payloadDigest: DIGEST, payloadUri: URI }), owners: OWNERS.map((o) => signer(o)) };
}

describe("record-receipt in Safe mode (the submitter is a multisig)", () => {
  test("the threshold owners sign, the deployer executes, the Safe is the submitter; the evidence entry holds the Safe facts and no key", async () => {
    await realProxyCode();
    const { ctx, st, api, inputs, owners } = mk(REHEARSAL, 8453);
    st.facts.code = await realProxyCode();
    const out = await recordReceipt(ctx, signer(DEPLOYER), inputs, api, { safe: SUBSAFE, ownerSigners: owners });
    expect(st.reqs).toHaveLength(1);
    const r = st.reqs[0]!;
    expect(r.safe).toBe(getAddress(SUBSAFE));
    expect(r.to).toBe(A.gateway);
    expect(await r.sender.address()).toBe(DEPLOYER);
    expect(r.ownerSigners).toHaveLength(2); // threshold, not all three
    expect(decodeFunctionData({ abi: GATEWAY_RECORD_ABI, data: r.data }).args).toEqual([RID, DIGEST, URI]);
    expect(out).toMatchObject({ receipt_id: RID, payload_digest: DIGEST, submitter: getAddress(SUBSAFE), status: 1 });
    expect(out.submitter_safe).toMatchObject({ address: getAddress(SUBSAFE), threshold: 2, safe_tx_hash: `0x${"33".repeat(32)}`, nonce: 4, sent_by: DEPLOYER });
    expect(out.submitter_safe!.owners).toHaveLength(3);
    expect(out.submitter_safe!.signers).toHaveLength(2);
    const m = loadRunManifest(ctx.evidenceDir)!;
    expect((m.recorded_receipts as unknown[])[0]).toEqual(out);
    expect(JSON.stringify(m)).not.toMatch(/passphrase|keystore|private/i);
    expect(st.eoaSent).toBe(0);
  });

  test("fewer owner signers than the threshold is refused before anything is proposed; a non-owner signer does not count (mutation: two owners pass)", async () => {
    const { ctx, st, api, inputs, owners } = mk(REHEARSAL, 8453);
    st.facts.code = await realProxyCode();
    await expect(recordReceipt(ctx, signer(DEPLOYER), inputs, api, { safe: SUBSAFE, ownerSigners: [owners[0]!] })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("needs 2 owner signatures") });
    await expect(recordReceipt(ctx, signer(DEPLOYER), inputs, api, { safe: SUBSAFE, ownerSigners: [owners[0]!, owners[0]!, signer(addr(0x999))] })).rejects.toMatchObject({ kind: "USAGE" });
    await expect(recordReceipt(ctx, signer(DEPLOYER), inputs, api, { safe: SUBSAFE, ownerSigners: [] })).rejects.toMatchObject({ kind: "USAGE" });
    expect(st.reqs).toEqual([]);
    await expect(recordReceipt(ctx, signer(DEPLOYER), inputs, api, { safe: SUBSAFE, ownerSigners: [owners[2]!, owners[1]!] })).resolves.toMatchObject({ status: 1 });
  });

  test("the Safe that executed must be --submitter; any other Safe is refused and nothing is recorded in the evidence (mutation: the same Safe passes)", async () => {
    const bad = mk(REHEARSAL, 8453); bad.st.facts.code = await realProxyCode(); bad.st.executedBy = addr(0x7777);
    await expect(recordReceipt(bad.ctx, signer(DEPLOYER), bad.inputs, bad.api, { safe: SUBSAFE, ownerSigners: bad.owners })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("is not --submitter") });
    expect(loadRunManifest(bad.ctx.evidenceDir)!.recorded_receipts).toBeUndefined();
  });

  test("no ExecutionSuccess for the Safe transaction hash, or a reverted tx, is not a record", async () => {
    const a = mk(REHEARSAL, 8453); a.st.facts.code = await realProxyCode(); a.st.executionSuccess = false;
    await expect(recordReceipt(a.ctx, signer(DEPLOYER), a.inputs, a.api, { safe: SUBSAFE, ownerSigners: a.owners })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("ExecutionSuccess") });
    const b = mk(REHEARSAL, 8453); b.st.facts.code = await realProxyCode(); b.st.status = "reverted";
    await expect(recordReceipt(b.ctx, signer(DEPLOYER), b.inputs, b.api, { safe: SUBSAFE, ownerSigners: b.owners })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("reverted") });
    expect(loadRunManifest(a.ctx.evidenceDir)!.recorded_receipts).toBeUndefined();
  });

  test("the read-back must show the Safe as the submitter: a receipt stored under another submitter is refused", async () => {
    const { ctx, st, api, inputs, owners } = mk(REHEARSAL, 8453); st.facts.code = await realProxyCode();
    const send = api.sendViaSafe!;
    api.sendViaSafe = async (req) => { const r = await send(req); st.recorded!.submitter = addr(0x1234); return r; };
    await expect(recordReceipt(ctx, signer(DEPLOYER), inputs, api, { safe: SUBSAFE, ownerSigners: owners })).rejects.toMatchObject({ message: expect.stringContaining("differs from what was asked") });
  });

  test("a second run finds the receipt on chain with the Safe as submitter and sends nothing; the evidence keeps the first Safe transaction", async () => {
    const { ctx, st, api, inputs, owners } = mk(REHEARSAL, 8453); st.facts.code = await realProxyCode();
    const first = await recordReceipt(ctx, signer(DEPLOYER), inputs, api, { safe: SUBSAFE, ownerSigners: owners });
    const again = await recordReceipt(ctx, signer(DEPLOYER), inputs, api, { safe: SUBSAFE, ownerSigners: owners });
    expect(st.reqs).toHaveLength(1);
    expect(again).toEqual(first);
  });

  test("rerun after a landed tx whose evidence was lost: the already_recorded path writes tx_hash and safe_tx_hash found on chain; not found writes no guess", async () => {
    const f = mk(REHEARSAL, 8453); f.st.facts.code = STANDIN;
    f.st.recorded = { receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, submitter: getAddress(SUBSAFE) };
    f.api.findRecordTx = async (receipt, id, safe) => { expect([receipt, id, safe]).toEqual([A.receipt, RID, getAddress(SUBSAFE)]); return { txHash: `0x${"77".repeat(32)}` as Hex, blockNumber: 9n, safeTxHash: `0x${"88".repeat(32)}` as Hex }; };
    const out = await recordReceipt(f.ctx, signer(DEPLOYER), f.inputs, f.api, { safe: SUBSAFE, ownerSigners: f.owners });
    expect(f.st.reqs).toEqual([]);
    expect(out).toMatchObject({ already_recorded: true, tx_hash: `0x${"77".repeat(32)}`, block_number: 9 });
    expect(out.submitter_safe).toMatchObject({ safe_tx_hash: `0x${"88".repeat(32)}`, threshold: 2 });
    expect((loadRunManifest(f.ctx.evidenceDir)!.recorded_receipts as unknown[])[0]).toEqual(out);
    const g = mk(REHEARSAL, 8453); g.st.facts.code = STANDIN;
    g.st.recorded = { receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, submitter: getAddress(SUBSAFE) };
    g.api.findRecordTx = async () => null;
    const none = await recordReceipt(g.ctx, signer(DEPLOYER), g.inputs, g.api, { safe: SUBSAFE, ownerSigners: g.owners });
    expect(none.tx_hash).toBeUndefined();
    expect(none.submitter_safe!.safe_tx_hash).toBeUndefined();
    // a lookup that throws is not fatal
    const h = mk(REHEARSAL, 8453); h.st.facts.code = STANDIN;
    h.st.recorded = { receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, submitter: getAddress(SUBSAFE) };
    h.api.findRecordTx = async () => { throw new Error("rpc"); };
    await expect(recordReceipt(h.ctx, signer(DEPLOYER), h.inputs, h.api, { safe: SUBSAFE, ownerSigners: h.owners })).resolves.toMatchObject({ already_recorded: true });
  });

  test("the Safe must hold both roles: registration comes first", async () => {
    const a = mk(REHEARSAL, 8453); a.st.facts.code = await realProxyCode(); a.st.agent = false;
    await expect(recordReceipt(a.ctx, signer(DEPLOYER), a.inputs, a.api, { safe: SUBSAFE, ownerSigners: a.owners })).rejects.toMatchObject({ message: expect.stringContaining("AGENT_ROLE on the gateway") });
    const b = mk(REHEARSAL, 8453); b.st.facts.code = await realProxyCode(); b.st.committee = false;
    await expect(recordReceipt(b.ctx, signer(DEPLOYER), b.inputs, b.api, { safe: SUBSAFE, ownerSigners: b.owners })).rejects.toMatchObject({ message: expect.stringContaining("COMMITTEE_AGENT_ROLE on the IC policy") });
    expect(a.st.reqs.length + b.st.reqs.length).toBe(0);
  });

  test("the governing Safe, the timelock, admin, the pauser and the emergency key are refused as the submitter Safe; so is a key and a non-canonical Safe", async () => {
    for (const pick of [(c: RunContext) => A.safe, (c: RunContext) => A.timelock, (c: RunContext) => c.sheet.admin, (c: RunContext) => c.sheet.pauser, (c: RunContext) => c.sheet.emergency]) {
      const { ctx, st, api, inputs, owners } = mk(REHEARSAL, 8453); st.facts.code = await realProxyCode();
      await expect(recordReceipt(ctx, signer(DEPLOYER), inputs, api, { safe: pick(ctx) as Address, ownerSigners: owners })).rejects.toMatchObject({ kind: "USAGE" });
      expect(st.reqs).toEqual([]);
    }
    const key = mk(REHEARSAL, 8453); // no code
    await expect(recordReceipt(key.ctx, signer(DEPLOYER), key.inputs, key.api, { safe: SUBSAFE, ownerSigners: key.owners })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("single key") });
    const one = mk(REHEARSAL, 8453); one.st.facts.code = await realProxyCode(); one.st.facts.threshold = 1n;
    await expect(recordReceipt(one.ctx, signer(DEPLOYER), one.inputs, one.api, { safe: SUBSAFE, ownerSigners: one.owners })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("threshold is 1") });
  });

  test("on 8453 the single-key mode does not exist; on the Twin chain it still does (the old path is unchanged)", async () => {
    const m = mk(REHEARSAL, 8453);
    await expect(recordReceipt(m.ctx, signer(addr(0x5ab1)), m.inputs, m.api)).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("multisig") });
  });
});

