// Issues 1727, 1750, 1888: the record-receipt verb. The SUBMITTER SAFE anchors one consensus receipt DIRECTLY on the receipt contract, on every chain and in every mode
// (production 8453, rehearsal 8453, Twin). The served payload bytes are mandatory: the digest and the id are recomputed from them. Every refusal happens before any signer is
// constructed and before anything is sent: each case asserts the signer-constructor counters and the send counter are ZERO. No key reaches the evidence.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, getAddress, keccak256, toFunctionSelector, type Address, type Hex } from "viem";
import { RECEIPT_RECORD_ABI, RECEIPT_SUBMITTER_ROLE, assertRecordInputs, recordReceipt, type RecordApi, type RecordRequest, type RecordSigners, type SafeSendRequest } from "../src/record-receipt.ts";
import { RECEIPT_DOMAIN, deriveReceiptId, receiptPayloadDigest, supportedReceiptPayload } from "../src/receipt-digest.ts";
import { loadRunManifest, newManifest, saveRunManifest, type RunContext } from "../src/runner.ts";
import { parseCli } from "../src/cli.ts";
import { RECEIPT_SUBMITTER_ROLE as VERIFIER_SUBMITTER_ROLE } from "../src/verify/constants.ts";
import { A, addr, setup, writeGovernManifests } from "./govern-world.ts";
import { DEPLOYER, OWNERS, STANDIN, SUBSAFE, canonical, chainFor, signer, type SafeFacts } from "./submitter-world.ts";
import { REPO_ROOT } from "./repo-root.ts";
import { world } from "./harness.ts";

const FIXTURES = join(REPO_ROOT, "tests", "fixtures");
const bytes = (p: string): Uint8Array => new Uint8Array(readFileSync(p));
/** The full preimage of the shared valid fixture (domain line + compact JSON + newline) and the bytes the public canonical route serves (the same without the domain line). */
const PREIMAGE = bytes(join(FIXTURES, "consensus-receipt.valid.canonical.txt"));
const SERVED = PREIMAGE.subarray(new TextEncoder().encode(RECEIPT_DOMAIN).length);
const DIGEST = "0xd3e85fdd5fdbc7da72d0853bfeaa3f3a4288ad5392c39f2e0dee0d82c7f7b2d1" as Hex; // pinned by tests/fixtures/consensus-receipt.anchor-digest.json
const RID = deriveReceiptId("12440000-0000-4000-8000-000000000001", "treasury-allocation");
const URI = "https://twin.invalid/r.json";
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const REHEARSAL = { DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "7" };
const MODES = [
  { name: "production 8453", chainId: 8453, over: {} as Record<string, string> },
  { name: "rehearsal 8453", chainId: 8453, over: REHEARSAL },
  { name: "Twin", chainId: 918453, over: {} as Record<string, string> },
];

/** One world: the run manifest, the fake chain (the Safe's facts, the receipt contract) and the counters. */
function mk(over: Record<string, string> = {}, chainId = 918453) {
  const d = setup({ ELIGIBLE_VAULTS: "PROTO,RWA", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,RWA", ROUTER_WEIGHTS: "USDC:5000,PROTO:3500,RWA:1500", ...over }, chainId);
  const ctx = { ...d.ctx, caller: { yes: chainId !== 8453, confirm: "typed" }, prompt: async () => "record-receipt", resume: true, chainId } as unknown as RunContext; // 8453 refuses YES=1: the operator and the reviewer type the name
  saveRunManifest(ctx.evidenceDir, newManifest(ctx, addr(0xa001)));
  const st = {
    role: true, recorded: null as null | { receiptId: Hex; payloadDigest: Hex; payloadUri: string; submitter: Address },
    reqs: [] as SafeSendRequest[], facts: { ...canonical(), code: STANDIN } as SafeFacts, executedBy: undefined as Address | undefined, executionSuccess: true, receiptRecorded: true, status: "success" as "success" | "reverted",
    senderBuilt: 0, ownersBuilt: 0, reads: [] as string[],
  };
  const api: RecordApi = {
    async read(address, _abi, fn, args = []) {
      st.reads.push(fn);
      if (fn === "hasRole") { expect(address).toBe(A.receipt); expect(args[0]).toBe(RECEIPT_SUBMITTER_ROLE); return st.role as never; }
      if (fn === "isRecorded") return (st.recorded !== null) as never;
      if (fn === "getReceiptById") return st.recorded as never;
      throw new Error(`fake ${fn} ${String(args)}`);
    },
    chain: { proxyCodehashPin: keccak256(STANDIN), getCode: (a) => chainFor(st.facts).getCode(a), getStorageAt: (a, s) => chainFor(st.facts).getStorageAt(a, s), read: (a, abi, fn, args) => chainFor(st.facts).read(a, abi, fn, args) },
    async sendViaSafe(req) {
      st.reqs.push(req);
      const [receiptId, payloadDigest, payloadUri] = decodeFunctionData({ abi: RECEIPT_RECORD_ABI, data: req.data }).args as [Hex, Hex, string];
      st.recorded = { receiptId, payloadDigest, payloadUri, submitter: req.safe };
      const signers = await Promise.all(req.ownerSigners.map((s) => s.address()));
      return { txHash: `0x${"22".repeat(32)}` as Hex, status: st.status, blockNumber: 6n, safe: st.executedBy ?? req.safe, safeTxHash: `0x${"33".repeat(32)}` as Hex, nonce: 4, signers, sentBy: await req.sender.address(), executionSuccess: st.executionSuccess, receiptRecorded: st.receiptRecorded };
    },
  };
  const signers: RecordSigners = { sender: async () => { st.senderBuilt++; return signer(DEPLOYER); }, owners: async () => { st.ownersBuilt++; return OWNERS.map((o) => signer(o)); } };
  const req = (r: Partial<RecordRequest> = {}): RecordRequest => ({ receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, payload: SERVED, submitter: SUBSAFE, ...r });
  const counters = () => ({ senderBuilt: st.senderBuilt, ownersBuilt: st.ownersBuilt, sends: st.reqs.length });
  return { ctx, st, api, signers, req, counters };
}

describe("record-receipt: the Safe records directly on the receipt contract", () => {
  for (const m of MODES) {
    test(`${m.name}: the threshold owners sign, the gas payer executes, the calldata targets the receipt contract with recordReceipt(bytes32,bytes32,string); the evidence holds the Safe facts and no key`, async () => {
      const { ctx, st, api, signers, req } = mk(m.over, m.chainId);
      const out = await recordReceipt(ctx, signers, req(), api);
      expect(st.reqs).toHaveLength(1);
      const r = st.reqs[0]!;
      expect(r.safe).toBe(getAddress(SUBSAFE));
      expect(r.to).toBe(A.receipt); // the receipt contract, never the gateway
      expect(r.to).not.toBe(A.gateway);
      expect(r.data.slice(0, 10)).toBe(toFunctionSelector("recordReceipt(bytes32,bytes32,string)"));
      expect(r.ownerSigners).toHaveLength(2); // threshold, not all three
      expect(await r.sender.address()).toBe(DEPLOYER);
      expect(decodeFunctionData({ abi: RECEIPT_RECORD_ABI, data: r.data }).args).toEqual([RID, DIGEST, URI]);
      expect(st.senderBuilt).toBe(1);
      expect(st.ownersBuilt).toBe(1);
      expect(out).toMatchObject({ receipt_id: RID, payload_digest: DIGEST, payload_uri: URI, submitter: getAddress(SUBSAFE), status: 1, tx_hash: `0x${"22".repeat(32)}`, block_number: 6 });
      expect(out.submitter_safe).toMatchObject({ address: getAddress(SUBSAFE), threshold: 2, safe_tx_hash: `0x${"33".repeat(32)}`, nonce: 4, sent_by: DEPLOYER });
      expect(out.submitter_safe!.owners).toHaveLength(3);
      expect(out.submitter_safe!.signers).toHaveLength(2);
      const man = loadRunManifest(ctx.evidenceDir)!;
      expect(man.recorded_receipts).toEqual([out]);
      expect(JSON.stringify(man)).not.toMatch(/passphrase|keystore|private/i);
    });
  }

  test("the role is the contract's RECEIPT_SUBMITTER_ROLE (the verifier constant is the same keccak256)", () => {
    expect(RECEIPT_SUBMITTER_ROLE).toBe(VERIFIER_SUBMITTER_ROLE);
    expect(RECEIPT_SUBMITTER_ROLE).toBe(keccak256(new TextEncoder().encode("RECEIPT_SUBMITTER_ROLE")));
  });

  test("the governing Safe may be the submitter Safe", async () => {
    const { ctx, st, api, signers, req } = mk();
    await expect(recordReceipt(ctx, signers, req({ submitter: A.safe }), api)).resolves.toMatchObject({ submitter: getAddress(A.safe) });
    expect(st.reqs).toHaveLength(1);
  });
});

describe("record-receipt refusals: the signer-constructor counters and the send counter stay ZERO", () => {
  const plain = keccak256(SERVED);
  const json = (mutate: (o: Record<string, unknown>) => void): Uint8Array => { const o = JSON.parse(new TextDecoder().decode(SERVED)); mutate(o); return text(`${JSON.stringify(o)}\n`); };
  const cases: { name: string; kind: "USAGE" | "GOVERN"; want: string; world?: (st: ReturnType<typeof mk>["st"]) => void; req?: () => Partial<RecordRequest> }[] = [
    { name: "missing Safe", kind: "USAGE", want: "needs --submitter", req: () => ({ submitter: undefined }) },
    { name: "a zero-address Safe", kind: "USAGE", want: "needs --submitter", req: () => ({ submitter: "0x0000000000000000000000000000000000000000" }) },
    { name: "an EOA (no code)", kind: "USAGE", want: "single key", world: (st) => { st.facts.code = undefined; } },
    { name: "missing payload", kind: "USAGE", want: "payload bytes are required", req: () => ({ payload: undefined }) },
    { name: "empty payload", kind: "USAGE", want: "payload bytes are required", req: () => ({ payload: new Uint8Array(0) }) },
    { name: "unsupported schema_version", kind: "USAGE", want: "schema_version", req: () => ({ payload: json((o) => { o.schema_version = "2.0"; }) }) },
    { name: "malformed payload (not JSON)", kind: "USAGE", want: "not valid JSON", req: () => ({ payload: text("{not json}\n") }) },
    { name: "malformed payload (not UTF-8)", kind: "USAGE", want: "not valid UTF-8", req: () => ({ payload: new Uint8Array([0xff, 0xfe, 0x7b]) }) },
    { name: "malformed payload (no trailing newline)", kind: "USAGE", want: "canonical form", req: () => ({ payload: SERVED.subarray(0, SERVED.length - 1) }) },
    { name: "malformed payload (a JSON array)", kind: "USAGE", want: "canonical form", req: () => ({ payload: text("[]\n") }) },
    { name: "payload without session_id", kind: "USAGE", want: "no session_id and subject_id", req: () => ({ payload: json((o) => { delete o.session_id; }) }) },
    { name: "wrong receipt id", kind: "USAGE", want: "is not the receipt id", req: () => ({ receiptId: `0x${"ab".repeat(32)}` }) },
    { name: "wrong digest (a made-up one)", kind: "USAGE", want: "is not the receipt digest", req: () => ({ payloadDigest: `0x${"cd".repeat(32)}` }) },
    { name: "wrong digest (plain keccak256 of the served bytes)", kind: "USAGE", want: plain, req: () => ({ payloadDigest: plain }) },
    { name: "bad Safe configuration (threshold 1)", kind: "USAGE", want: "threshold is 1", world: (st) => { st.facts.threshold = 1n; } },
    { name: "bad Safe configuration (a module)", kind: "USAGE", want: "modules are enabled", world: (st) => { st.facts.modules = [addr(0x30d)]; } },
    { name: "bad Safe configuration (not the canonical proxy)", kind: "USAGE", want: "code hash", world: (st) => { st.facts.code = "0x6080" as Hex; } },
    { name: "the timelock as the submitter", kind: "USAGE", want: "the timelock", req: () => ({ submitter: A.timelock }) },
    { name: "absent live RECEIPT_SUBMITTER_ROLE", kind: "GOVERN", want: "RECEIPT_SUBMITTER_ROLE", world: (st) => { st.role = false; } },
  ];
  let refused = 0;
  for (const m of MODES) {
    for (const c of cases) {
      test(`${m.name}: ${c.name}`, async () => {
        const { ctx, st, api, signers, req, counters } = mk(m.over, m.chainId);
        c.world?.(st);
        await expect(recordReceipt(ctx, signers, req(c.req?.()), api)).rejects.toMatchObject({ kind: c.kind, message: expect.stringContaining(c.want) });
        expect(counters()).toEqual({ senderBuilt: 0, ownersBuilt: 0, sends: 0 });
        expect(loadRunManifest(ctx.evidenceDir)!.recorded_receipts).toBeUndefined();
        refused++;
      });
    }
  }
  test("every refusal case ran in every mode (a positive count, no skipped case)", () => {
    expect(refused).toBe(MODES.length * cases.length);
    expect(refused).toBeGreaterThan(0);
  });
  test("the same refusal is not a pass: with the valid inputs the counters move (mutation check)", async () => {
    const { ctx, signers, api, req, counters } = mk();
    await recordReceipt(ctx, signers, req(), api);
    expect(counters()).toEqual({ senderBuilt: 1, ownersBuilt: 1, sends: 1 });
  });
  test("a record API that cannot read or execute a Safe is refused before any signer", async () => {
    const { ctx, api, signers, req, counters } = mk();
    await expect(recordReceipt(ctx, signers, req(), { read: api.read })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("cannot read or execute a Safe") });
    expect(counters()).toEqual({ senderBuilt: 0, ownersBuilt: 0, sends: 0 });
  });
});

describe("record-receipt: the payload bytes derive the digest and the id", () => {
  test("the served bytes and the full preimage derive the same digest and id; both are accepted", async () => {
    expect(supportedReceiptPayload(SERVED)).toMatchObject({ digest: DIGEST, receiptId: RID });
    expect(supportedReceiptPayload(PREIMAGE)).toMatchObject({ digest: DIGEST, receiptId: RID });
    expect(receiptPayloadDigest(SERVED)).toBe(keccak256(PREIMAGE));
    for (const payload of [SERVED, PREIMAGE]) {
      const { ctx, signers, api, req } = mk();
      await expect(recordReceipt(ctx, signers, req({ payload }), api)).resolves.toMatchObject({ payload_digest: DIGEST, receipt_id: RID });
    }
  });
  test("known canonical fixtures derive the pinned digest and id (anchor-digest.json goldens, the escaping fixture, the real production receipt)", () => {
    const anchors = JSON.parse(readFileSync(join(FIXTURES, "consensus-receipt.anchor-digest.json"), "utf8")) as { goldens: { file: string; keccak256: string }[] };
    expect(anchors.goldens.length).toBeGreaterThan(0);
    for (const g of anchors.goldens) {
      const full = bytes(join(FIXTURES, g.file));
      const served = full.subarray(new TextEncoder().encode(RECEIPT_DOMAIN).length);
      expect(supportedReceiptPayload(full).digest).toBe(g.keccak256 as never);
      expect(supportedReceiptPayload(served).digest).toBe(g.keccak256 as never);
      expect(supportedReceiptPayload(served).receiptId).toBe(supportedReceiptPayload(full).receiptId);
    }
    const real = bytes(join(import.meta.dir, "fixtures", "real-consensus-receipt.canonical.json"));
    expect(supportedReceiptPayload(real)).toMatchObject({
      digest: "0x2aebf2b33c117d41813ef338ccf1d44b8006cc8a54eb162b17cbb8ac18adbacb", receiptId: "0xdcf4108eb6186e913447fbf24353ee32b2e75cb6c7a46aabbb27f9a663c7ca81",
      sessionId: "5015526d-27f6-478a-86e9-ac768e310af1",
    });
    expect(keccak256(real)).not.toBe(supportedReceiptPayload(real).digest); // a plain keccak256 of the served file is NOT the anchored digest
  });
  test("assertRecordInputs needs the bytes: the same ids without a payload are refused", () => {
    expect(() => assertRecordInputs({ receiptId: RID, payloadDigest: DIGEST, payloadUri: URI })).toThrow(/payload bytes are required/);
    expect(assertRecordInputs({ receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, payload: SERVED })).toEqual({ receiptId: RID, payloadDigest: DIGEST, payloadUri: URI });
  });
});

describe("record-receipt: evidence, readback and idempotency", () => {
  test("an exact rerun sends zero transactions, builds no signer and keeps the first transaction in the evidence", async () => {
    const { ctx, st, api, signers, req } = mk();
    const first = await recordReceipt(ctx, signers, req(), api);
    expect(st.reqs).toHaveLength(1);
    const built = { s: st.senderBuilt, o: st.ownersBuilt };
    const again = await recordReceipt(ctx, signers, req(), api);
    expect(st.reqs).toHaveLength(1);
    expect({ s: st.senderBuilt, o: st.ownersBuilt }).toEqual(built);
    expect(again).toEqual(first);
    expect((loadRunManifest(ctx.evidenceDir)!.recorded_receipts as unknown[]).length).toBe(1);
  });
  test("a receipt recorded with another digest, uri or submitter is refused: an id is recorded once, nothing is sent", async () => {
    for (const bad of [{ payloadDigest: `0x${"ee".repeat(32)}` as Hex }, { payloadUri: "https://other.invalid/r.json" }, { submitter: addr(0x9999) }]) {
      const { ctx, st, api, signers, req, counters } = mk();
      st.recorded = { receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, submitter: getAddress(SUBSAFE), ...bad };
      await expect(recordReceipt(ctx, signers, req(), api)).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("differs from what was asked") });
      expect(counters()).toEqual({ senderBuilt: 0, ownersBuilt: 0, sends: 0 });
    }
  });
  test("no ExecutionSuccess, no ReceiptRecorded or a reverted transaction is not a record", async () => {
    for (const [tweak, want] of [
      [(s: ReturnType<typeof mk>["st"]) => { s.executionSuccess = false; }, "ExecutionSuccess"],
      [(s: ReturnType<typeof mk>["st"]) => { s.receiptRecorded = false; }, "ReceiptRecorded"],
      [(s: ReturnType<typeof mk>["st"]) => { s.status = "reverted"; }, "reverted"],
    ] as const) {
      const { ctx, st, api, signers, req } = mk();
      tweak(st);
      await expect(recordReceipt(ctx, signers, req(), api)).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining(want) });
      expect(loadRunManifest(ctx.evidenceDir)!.recorded_receipts).toBeUndefined();
    }
  });
  test("the Safe that executed must be --submitter; any other is refused and nothing is written to the evidence", async () => {
    const { ctx, st, api, signers, req } = mk(); st.executedBy = addr(0x7777);
    await expect(recordReceipt(ctx, signers, req(), api)).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("is not --submitter") });
    expect(loadRunManifest(ctx.evidenceDir)!.recorded_receipts).toBeUndefined();
  });
  test("the read-back must show the Safe as the submitter: a receipt stored under another submitter is refused", async () => {
    const { ctx, st, api, signers, req } = mk();
    const send = api.sendViaSafe!;
    api.sendViaSafe = async (r) => { const out = await send(r); st.recorded!.submitter = addr(0x1234); return out; };
    await expect(recordReceipt(ctx, signers, req(), api)).rejects.toMatchObject({ message: expect.stringContaining("differs from what was asked") });
  });
  test("fewer owner signers than the threshold is refused before anything is proposed; a non-owner signer does not count", async () => {
    const { ctx, st, api, req } = mk();
    const few = (list: Address[]): RecordSigners => ({ sender: async () => signer(DEPLOYER), owners: async () => list.map((o) => signer(o)) });
    await expect(recordReceipt(ctx, few([OWNERS[0]!]), req(), api)).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("needs 2 owner signatures") });
    await expect(recordReceipt(ctx, few([OWNERS[0]!, OWNERS[0]!, addr(0x999)]), req(), api)).rejects.toMatchObject({ kind: "USAGE" });
    await expect(recordReceipt(ctx, few([]), req(), api)).rejects.toMatchObject({ kind: "USAGE" });
    expect(st.reqs).toEqual([]);
    await expect(recordReceipt(ctx, few([OWNERS[2]!, OWNERS[1]!]), req(), api)).resolves.toMatchObject({ status: 1 });
  });
  test("rerun after a landed tx whose evidence was lost: the already_recorded path writes tx_hash and safe_tx_hash found on chain; not found writes no guess", async () => {
    const f = mk();
    f.st.recorded = { receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, submitter: getAddress(SUBSAFE) };
    f.api.findRecordTx = async (receipt, id, safe) => { expect([receipt, id, safe]).toEqual([A.receipt, RID, getAddress(SUBSAFE)]); return { txHash: `0x${"77".repeat(32)}` as Hex, blockNumber: 9n, safeTxHash: `0x${"88".repeat(32)}` as Hex }; };
    const out = await recordReceipt(f.ctx, f.signers, f.req(), f.api);
    expect(f.st.reqs).toEqual([]);
    expect(f.counters()).toEqual({ senderBuilt: 0, ownersBuilt: 0, sends: 0 });
    expect(out).toMatchObject({ already_recorded: true, tx_hash: `0x${"77".repeat(32)}`, block_number: 9 });
    expect(out.submitter_safe).toMatchObject({ safe_tx_hash: `0x${"88".repeat(32)}`, threshold: 2 });
    expect((loadRunManifest(f.ctx.evidenceDir)!.recorded_receipts as unknown[])[0]).toEqual(out);
    const g = mk();
    g.st.recorded = { receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, submitter: getAddress(SUBSAFE) };
    g.api.findRecordTx = async () => null;
    const none = await recordReceipt(g.ctx, g.signers, g.req(), g.api);
    expect(none.tx_hash).toBeUndefined();
    expect(none.submitter_safe!.safe_tx_hash).toBeUndefined();
    const h = mk();
    h.st.recorded = { receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, submitter: getAddress(SUBSAFE) };
    h.api.findRecordTx = async () => { throw new Error("rpc"); }; // a lookup that throws is not fatal
    await expect(recordReceipt(h.ctx, h.signers, h.req(), h.api)).resolves.toMatchObject({ already_recorded: true });
  });
  test("a run manifest is required: the evidence entry has nowhere to go without one", async () => {
    const { ctx, api, signers, req } = mk();
    const bare = { ...ctx, evidenceDir: ctx.evidenceDir + "-none" } as RunContext;
    await expect(recordReceipt(bare, signers, req(), api)).rejects.toMatchObject({ kind: "RESUME" });
  });
});

describe("record-receipt at the CLI seam: production 8453, rehearsal 8453 and Twin", () => {
  const OWNER_SPECS = ["--owner-signer", "keystore:/dev/shm/stub/O1", "--owner-signer", "keystore:/dev/shm/stub/O2"];
  const PAYLOAD_FILE = (dir: string, b: Uint8Array): string => { const p = join(dir, "payload.json"); require("node:fs").writeFileSync(p, b); return p; };
  /** A CLI run with the counters: the signer constructor (the run's --signer), the owner-signer constructor and the sends of the injected record API. */
  async function cli(mode: (typeof MODES)[number], build: (w: ReturnType<typeof world>) => { args: string[]; payload?: Uint8Array; facts?: (f: SafeFacts) => void; role?: boolean }) {
    const w = world({ chainId: mode.chainId, sheet: mode.over });
    writeGovernManifests(join(w.coreDir, "deployments", String(mode.chainId)));
    const c = build(w);
    const counts = { signer: 0, owner: 0, sends: 0, chainReads: 0 };
    const facts = { ...canonical(), code: STANDIN } as SafeFacts;
    c.facts?.(facts);
    const api: RecordApi = {
      async read(_a, _abi, fn) { counts.chainReads++; if (fn === "hasRole") return (c.role ?? true) as never; if (fn === "isRecorded") return false as never; throw new Error(`fake ${fn}`); },
      chain: { proxyCodehashPin: keccak256(STANDIN), getCode: (a) => chainFor(facts).getCode(a), getStorageAt: (a, s) => chainFor(facts).getStorageAt(a, s), read: (a, abi, fn, args) => chainFor(facts).read(a, abi, fn, args) },
      async sendViaSafe() { counts.sends++; throw new Error("stop: this test counts the send"); },
    };
    const payloadPath = c.payload ? PAYLOAD_FILE(w.dir, c.payload) : undefined;
    const args = ["record-receipt", ...c.args.map((x) => (x === "$PAYLOAD" ? payloadPath! : x))];
    const { fakeSigner } = await import("./harness.ts");
    const code = await w.run(args, {
      recordApi: api, makeSigner: () => { counts.signer++; return fakeSigner(); },
      ownerSigner: (async () => signer(OWNERS[counts.owner++]!)) as never,
    });
    return { code, counts, logs: w.logs() };
  }
  const base = (over: { rid?: string; digest?: string; sub?: string | null; payload?: boolean | null } = {}) => [
    "--receipt-id", over.rid ?? RID, "--payload-digest", over.digest ?? DIGEST, "--payload-uri", URI,
    ...(over.sub === null ? [] : ["--submitter", over.sub ?? SUBSAFE]), ...(over.payload === null ? [] : ["--payload", "$PAYLOAD"]), ...OWNER_SPECS,
  ];
  const failures = (r: { logs: any[] }) => r.logs.filter((l) => l.event === "run.failed").map((l) => String(l.message));

  for (const mode of MODES) {
    describe(mode.name, () => {
      test("missing Safe, missing payload, wrong id, wrong digest, malformed or unsupported payload exit 2 with no signer constructed and nothing read or sent", async () => {
        const unsupported = text(`${JSON.stringify({ ...JSON.parse(new TextDecoder().decode(SERVED)), schema_version: "9.9" })}\n`);
        const rows: [string, () => ReturnType<typeof base>, Uint8Array | undefined, string][] = [
          ["missing Safe", () => base({ sub: null }), SERVED, "needs --submitter"],
          ["missing payload", () => base({ payload: null }), undefined, "needs --payload"],
          ["wrong id", () => base({ rid: `0x${"ab".repeat(32)}` }), SERVED, "is not the receipt id"],
          ["wrong digest", () => base({ digest: keccak256(SERVED) }), SERVED, "is not the receipt digest"],
          ["malformed payload", () => base(), text("{nope}\n"), "not valid JSON"],
          ["unsupported payload", () => base(), unsupported, "schema_version"],
          ["empty payload file", () => base(), new Uint8Array(0), "payload bytes are required"],
        ];
        let n = 0;
        for (const [name, args, payload, want] of rows) {
          const r = await cli(mode, () => ({ args: args(), payload }));
          expect([name, r.code]).toEqual([name, 2]);
          expect([name, r.counts]).toEqual([name, { signer: 0, owner: 0, sends: 0, chainReads: 0 }]);
          expect(failures(r).join("\n"), name).toContain(want);
          n++;
        }
        expect(n).toBe(rows.length);
      });
      test("an EOA, a bad Safe configuration and an absent live role exit non-zero after the chain reads and BEFORE any signer is constructed", async () => {
        const rows: [string, (f: SafeFacts) => void, boolean, string][] = [
          ["EOA", (f) => { f.code = undefined; }, true, "single key"],
          ["bad Safe configuration", (f) => { f.threshold = 1n; }, true, "threshold is 1"],
          ["absent live role", () => {}, false, "RECEIPT_SUBMITTER_ROLE"],
        ];
        for (const [name, facts, role, want] of rows) {
          const r = await cli(mode, () => ({ args: base(), payload: SERVED, facts, role }));
          expect([name, r.code === 0]).toEqual([name, false]);
          expect(r.counts.signer, name).toBe(0);
          expect(r.counts.owner, name).toBe(0);
          expect(r.counts.sends, name).toBe(0);
          expect(failures(r).join("\n"), name).toContain(want);
        }
      });
      test("valid Safe, live role and the same-byte payload reach the signers and the one send (the counters are not stuck at zero)", async () => {
        const r = await cli(mode, () => ({ args: base(), payload: SERVED }));
        expect(r.counts.signer).toBeGreaterThan(0);
        expect(r.counts.owner).toBeGreaterThan(0);
        expect(r.counts.sends).toBe(1);
      });
    });
  }

  test("parseCli: record-receipt needs the Safe and the payload file on every chain", () => {
    const common = ["record-receipt", "--chain", "8453", "--rpc", "http://x", "--sheet", "s.env", "--signer", "keystore:/k", "--environment", "e", "--core-sha", "a".repeat(40), "--receipt-id", RID, "--payload-digest", DIGEST, "--payload-uri", URI];
    expect(() => parseCli([...common, "--payload", "p.json"])).toThrow(/needs --submitter/);
    expect(() => parseCli([...common, "--submitter", SUBSAFE])).toThrow(/needs --payload FILE/);
    expect(parseCli([...common, "--submitter", SUBSAFE, "--payload", "p.json"])).toMatchObject({ verb: "record-receipt", submitter: SUBSAFE });
    expect(() => parseCli([...common, "--submitter", SUBSAFE, "--payload", "p.json", "--agent-label", "x"])).toThrow();
  });
});
