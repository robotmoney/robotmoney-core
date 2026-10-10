// Issue 1727: the record-receipt verb. The registered submitter anchors one consensus receipt through the gateway. Refused before anything is sent when the
// submitter lacks a role, the gateway routes elsewhere, or the receipt is recorded with other data. Refused on 8453 in production. No key reaches the evidence.
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { AGENT_ROLE, COMMITTEE_AGENT_ROLE, GATEWAY_RECORD_ABI, assertRecordInputs, recordReceipt, type RecordApi } from "../src/record-receipt.ts";
import { loadRunManifest, newManifest, saveRunManifest, type RunContext } from "../src/runner.ts";
import { parseCli, USAGE, VERBS } from "../src/cli.ts";
import { AGENT_ROLE as VERIFIER_AGENT_ROLE } from "../src/verify/constants.ts";
import { A, addr, setup } from "./govern-world.ts";
import { SHA } from "./fixtures.ts";

const RID = `0x${"ab".repeat(32)}` as Hex, DIGEST = `0x${"cd".repeat(32)}` as Hex, URI = "https://twin.invalid/r.json";
const SUB = addr(0x5ab1);
const signer = (who: Address = SUB) => ({ address: async () => who }) as never;

function mk(over: Record<string, string> = {}, chainId = 918453) {
  const d = setup({ ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,AGENT,RWA", ROUTER_WEIGHTS: "USDC:5000,PROTO:2500,AGENT:1000,RWA:1500", ...over }, chainId);
  const ctx = { ...d.ctx, caller: { yes: chainId !== 8453, confirm: "typed" }, prompt: async () => "record-receipt", resume: true, chainId } as unknown as RunContext; // 8453 refuses YES=1: the operator and the reviewer type the name
  saveRunManifest(ctx.evidenceDir, newManifest(ctx, addr(0xa001)));
  const st = { agent: true, committee: true, routed: A.receipt as string, recorded: null as null | { receiptId: Hex; payloadDigest: Hex; payloadUri: string; submitter: Address }, sent: [] as Hex[], revert: false };
  const api: RecordApi = {
    async read(address, _abi, fn, args = []) {
      if (fn === "consensusReceipt") return st.routed as never;
      if (fn === "hasRole") return (address === A.icPolicy ? st.committee : st.agent) as never;
      if (fn === "isRecorded") return (st.recorded !== null) as never;
      if (fn === "getReceiptById") return st.recorded as never;
      throw new Error(`fake ${fn} ${String(args)}`);
    },
    async send(_s, to, data) {
      expect(to).toBe(A.gateway);
      st.sent.push(data);
      if (st.revert) return { txHash: `0x${"11".repeat(32)}` as Hex, status: "reverted", blockNumber: 5n };
      const [receiptId, payloadDigest, payloadUri] = decodeFunctionData({ abi: GATEWAY_RECORD_ABI, data }).args as [Hex, Hex, string];
      st.recorded = { receiptId, payloadDigest, payloadUri, submitter: SUB };
      return { txHash: `0x${"22".repeat(32)}` as Hex, status: "success", blockNumber: 6n };
    },
  };
  return { ctx, st, api, inputs: assertRecordInputs({ receiptId: RID, payloadDigest: DIGEST, payloadUri: URI }) };
}
const REHEARSAL = { DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "7" };

describe("record-receipt", () => {
  test("a registered submitter records the receipt through the gateway; the evidence entry holds the id, digest, uri, submitter address and transaction", async () => {
    const { ctx, st, api, inputs } = mk();
    const out = await recordReceipt(ctx, signer(), inputs, api);
    expect(st.sent).toHaveLength(1);
    expect(decodeFunctionData({ abi: GATEWAY_RECORD_ABI, data: st.sent[0]! }).args).toEqual([RID, DIGEST, URI]);
    expect(out).toMatchObject({ receipt_id: RID, payload_digest: DIGEST, payload_uri: URI, submitter: SUB, status: 1, tx_hash: `0x${"22".repeat(32)}` });
    const m = loadRunManifest(ctx.evidenceDir)!;
    expect(m.recorded_receipts).toEqual([out]);
    expect(JSON.stringify(m)).not.toMatch(/passphrase|keystore|private/i);
  });
  test("a second run finds the same receipt on chain and sends nothing", async () => {
    const { ctx, st, api, inputs } = mk();
    await recordReceipt(ctx, signer(), inputs, api);
    const again = await recordReceipt(ctx, signer(), inputs, api);
    expect(st.sent).toHaveLength(1);
    expect(again.tx_hash).toBe(`0x${"22".repeat(32)}`); // the evidence keeps the first transaction
    expect((loadRunManifest(ctx.evidenceDir)!.recorded_receipts as unknown[]).length).toBe(1);
  });
  test("a receipt recorded with another digest, uri or submitter is refused: an id is recorded once", async () => {
    for (const bad of [{ payloadDigest: `0x${"ee".repeat(32)}` as Hex }, { payloadUri: "https://other.invalid/r.json" }, { submitter: addr(0x9999) }]) {
      const { ctx, st, api, inputs } = mk();
      st.recorded = { receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, submitter: SUB, ...bad };
      await expect(recordReceipt(ctx, signer(), inputs, api)).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("differs from what was asked") });
      expect(st.sent).toEqual([]);
    }
  });
  test("a submitter without AGENT_ROLE or without COMMITTEE_AGENT_ROLE is refused before anything is sent, and the message names the registration row", async () => {
    const a1 = mk(); a1.st.agent = false;
    await expect(recordReceipt(a1.ctx, signer(), a1.inputs, a1.api)).rejects.toMatchObject({ message: expect.stringContaining("AGENT_ROLE on the gateway") });
    const a2 = mk(); a2.st.committee = false;
    await expect(recordReceipt(a2.ctx, signer(), a2.inputs, a2.api)).rejects.toMatchObject({ message: expect.stringContaining("COMMITTEE_AGENT_ROLE on the IC policy") });
    expect(a1.st.sent.length + a2.st.sent.length).toBe(0);
    expect(String((await recordReceipt(mk().ctx, signer(), mk().inputs, mk().api).catch((e) => e))).length).toBeGreaterThan(0);
  });
  test("a gateway that routes receipts to another contract is refused", async () => {
    const { ctx, st, api, inputs } = mk(); st.routed = addr(0xdead);
    await expect(recordReceipt(ctx, signer(), inputs, api)).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("routes receipts to") });
  });
  test("a reverted transaction records nothing", async () => {
    const { ctx, st, api, inputs } = mk(); st.revert = true;
    await expect(recordReceipt(ctx, signer(), inputs, api)).rejects.toMatchObject({ message: expect.stringContaining("reverted") });
    expect(loadRunManifest(ctx.evidenceDir)!.recorded_receipts).toBeUndefined();
  });
  test("on 8453 it is refused in production (rmpc with an HSM or KMS is the production path) and runs in a rehearsal", async () => {
    const prod = mk({}, 8453);
    await expect(recordReceipt(prod.ctx, signer(), prod.inputs, prod.api)).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("rmpc receipt submit") });
    expect(prod.st.sent).toEqual([]);
    const reh = mk(REHEARSAL, 8453);
    await expect(recordReceipt(reh.ctx, signer(), reh.inputs, reh.api)).resolves.toMatchObject({ status: 1 });
  });
  test("the roles are the contract's AGENT_ROLE and COMMITTEE_AGENT_ROLE", () => {
    expect(AGENT_ROLE).toBe(VERIFIER_AGENT_ROLE); // keccak256("AGENT_ROLE"), the same constant the verifier uses
    expect(COMMITTEE_AGENT_ROLE).not.toBe(AGENT_ROLE);
  });
  test("a run manifest is required: the evidence entry has nowhere to go without one", async () => {
    const { ctx, api, inputs } = mk();
    const bare = { ...ctx, evidenceDir: ctx.evidenceDir + "-none" } as RunContext;
    await expect(recordReceipt(bare, signer(), inputs, api)).rejects.toMatchObject({ kind: "RESUME" });
  });
});

describe("record-receipt inputs and the CLI", () => {
  test("ids and digests are bytes32, the uri is http(s), nothing is guessed", () => {
    expect(assertRecordInputs({ receiptId: RID.toUpperCase().replace("0X", "0x"), payloadDigest: DIGEST, payloadUri: URI }).receiptId).toBe(RID);
    for (const bad of [{ receiptId: "0x1" }, { payloadDigest: "nope" }, { payloadUri: "file:///x" }, { payloadUri: undefined }]) {
      expect(() => assertRecordInputs({ receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, ...bad } as never)).toThrow();
    }
  });
  const base = ["--chain", "918453", "--core-sha", SHA, "--rpc", "http://x", "--sheet", "s", "--signer", "keystore:/dev/shm/k/SUBMITTER"];
  test("the verb parses with its flags and refuses them on any other verb", () => {
    expect(VERBS).toContain("record-receipt");
    const p = parseCli(["record-receipt", ...base, "--receipt-id", RID, "--payload-digest", DIGEST, "--payload-uri", URI]);
    expect(p).toMatchObject({ verb: "record-receipt", receiptId: RID, payloadDigest: DIGEST, payloadUri: URI });
    expect(() => parseCli(["record-receipt", ...base, "--receipt-id", RID])).toThrow("--payload-digest");
    expect(() => parseCli(["publish", ...base, "--payload-digest", DIGEST])).toThrow("record-receipt verb only");
  });
  test("govern --row register-committee needs a valid --submitter and refuses --submitter elsewhere", () => {
    const g = ["govern", ...base];
    expect(parseCli([...g, "--row", "register-committee", "--submitter", SUB, "--agent-label", "x"])).toMatchObject({ row: "register-committee", submitter: SUB, agentLabel: "x" });
    expect(() => parseCli([...g, "--row", "register-committee"])).toThrow("--submitter");
    expect(() => parseCli([...g, "--row", "register-committee", "--submitter", "0x0"])).toThrow("--submitter");
    expect(() => parseCli([...g, "--row", "register-committee", "--submitter", SUB, "--agent-label", "bad label"])).toThrow("--agent-label");
    expect(() => parseCli([...g, "--row", "unpause-USDC", "--submitter", SUB])).toThrow("register-committee");
    // update-delay on 8453 parses: whether it runs depends on the sheet kind (runGovern)
    expect(parseCli(["govern", ...base.map((x) => (x === "918453" ? "8453" : x)), "--row", "update-delay"]).row).toBe("update-delay");
  });
  test("the usage text documents the new verb, flags and the rehearsal rows", () => {
    for (const w of ["record-receipt", "--submitter", "--agent-label", "--payload-digest", "--payload-uri", "register-committee", "DEPLOYMENT_KIND=rehearsal"]) expect(USAGE).toContain(w);
  });
});
