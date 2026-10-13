// Issue 1754: the consensus receipt digest scheme. The oracle is the REAL production receipt (session 5015526d-27f6-478a-86e9-ac768e310af1, subject robotmoney-allocation),
// copied byte for byte from https://robotmoney.network/api/swarm/sessions/5015526d-27f6-478a-86e9-ac768e310af1/consensus-receipt/canonical.
// Its payload_digest and receipt_id are what `rmpc receipt verify --receipt-file` prints (rmpc cross-check done when this test was written).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { planApply } from "../src/apply-receipt.ts";
import { assertRecordInputs } from "../src/record-receipt.ts";
import { assertDigestMatchesBytes, deriveReceiptId, receiptIdOfBytes, receiptPayloadDigest, receiptPreimage, RECEIPT_DOMAIN } from "../src/receipt-digest.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "real-consensus-receipt.canonical.json");
const SHA256 = "db3f2b3cf2791d5743528c23097c75e9fead00fb75a61aadab3b3f1a919a4b99";
const DIGEST = "0x2aebf2b33c117d41813ef338ccf1d44b8006cc8a54eb162b17cbb8ac18adbacb";
const PLAIN = "0x19d64ec6822ff72e19a5a7f0126491b3dc17b0b458c12356b3b78a8a577f7f86";
const RID = "0xdcf4108eb6186e913447fbf24353ee32b2e75cb6c7a46aabbb27f9a663c7ca81";
const bytes = new Uint8Array(readFileSync(FIXTURE));
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };

describe("issue 1754: the real production receipt is the oracle of the digest scheme", () => {
  test("the fixture is the served canonical route's bytes (31941 bytes, pinned sha256)", () => {
    expect(bytes.length).toBe(31941);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(SHA256);
  });
  test("the shared function gives the rmpc payload_digest and receipt_id", () => {
    expect(receiptPayloadDigest(bytes)).toBe(DIGEST);
    expect(deriveReceiptId("5015526d-27f6-478a-86e9-ac768e310af1", "robotmoney-allocation")).toBe(RID);
    expect(receiptIdOfBytes(bytes)).toBe(RID);
  });
  test("the full preimage (domain line + served bytes) hashes to the same digest and the same id", () => {
    const full = cat(new TextEncoder().encode(RECEIPT_DOMAIN), bytes);
    expect(receiptPreimage(full)).toBe(full);
    expect(receiptPayloadDigest(full)).toBe(DIGEST);
    expect(receiptIdOfBytes(full)).toBe(RID);
  });
  test("mutation: a plain keccak256 of the served bytes is NOT the digest (it is the value the old code computed)", () => {
    expect(keccak256(bytes)).toBe(PLAIN);
    expect(keccak256(bytes)).not.toBe(DIGEST);
    expect(() => assertDigestMatchesBytes(bytes, PLAIN, "--payload-digest")).toThrow(/not the receipt digest/);
  });
  test("mutation: a wrong domain prefix, a missing newline in the prefix and a missing trailing newline each change the digest", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    for (const prefix of ["robotmoney:consensus-receipt:v2\n", "robotmoney:consensus-receipt:v1", "robotmoney:consensus-receipt-id:v1\n", "Robotmoney:consensus-receipt:v1\n"]) {
      expect(keccak256(cat(enc(prefix), bytes))).not.toBe(DIGEST);
    }
    expect(receiptPayloadDigest(bytes.subarray(0, bytes.length - 1))).not.toBe(DIGEST);
  });
  test("mutation: one flipped byte anywhere changes the digest", () => {
    for (const at of [0, 1, 500, 15000, bytes.length - 2]) {
      const m = new Uint8Array(bytes);
      m[at] = m[at]! ^ 0x01;
      expect(receiptPayloadDigest(m)).not.toBe(DIGEST);
    }
  });
  test("mutation: another session or subject gives another receipt id", () => {
    expect(deriveReceiptId("5015526d-27f6-478a-86e9-ac768e310af2", "robotmoney-allocation")).not.toBe(RID);
    expect(deriveReceiptId("5015526d-27f6-478a-86e9-ac768e310af1", "robotmoney-allocation2")).not.toBe(RID);
    expect(keccak256(toBytes("5015526d-27f6-478a-86e9-ac768e310af1\nrobotmoney-allocation"))).not.toBe(RID);
  });
});

describe("issue 1754: record-receipt checks the digest and the id against the payload bytes BEFORE sending", () => {
  const URI = "https://robotmoney.network/api/swarm/sessions/5015526d-27f6-478a-86e9-ac768e310af1/consensus-receipt/canonical";
  test("the protocol digest and id with the real bytes are accepted", () => {
    expect(assertRecordInputs({ receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, payload: bytes })).toMatchObject({ receiptId: RID, payloadDigest: DIGEST });
  });
  test("a plain keccak256 digest is refused, the message names both digests", () => {
    let err: Error | undefined;
    try { assertRecordInputs({ receiptId: RID, payloadDigest: PLAIN, payloadUri: URI, payload: bytes }); } catch (e) { err = e as Error; }
    expect(err?.message).toContain(PLAIN);
    expect(err?.message).toContain(DIGEST);
  });
  test("a digest of a one-byte-different payload is refused", () => {
    const m = new Uint8Array(bytes); m[700] = m[700]! ^ 1;
    expect(() => assertRecordInputs({ receiptId: RID, payloadDigest: DIGEST, payloadUri: URI, payload: m })).toThrow(/not the receipt digest/);
  });
  test("a receipt id that is not derived from the payload's session and subject is refused, naming both", () => {
    const other = `0x${"11".repeat(32)}`;
    expect(() => assertRecordInputs({ receiptId: other, payloadDigest: DIGEST, payloadUri: URI, payload: bytes })).toThrow(new RegExp(`${other}.*${RID}`));
  });
});

describe("issue 1754: apply-receipt accepts the real receipt only under the protocol digest", () => {
  const V = { USDC: "0x00000000000000000000000000000000000000a1", PROTO: "0x00000000000000000000000000000000000000a2", AGENT: "0x00000000000000000000000000000000000000a3", RWA: "0x00000000000000000000000000000000000000a4" } as Record<"USDC" | "PROTO" | "AGENT" | "RWA", Address>;
  const base = { receiptId: RID as Hex, payload: bytes, recorded: true, released: false, eligible: [V.USDC, V.PROTO, V.AGENT, V.RWA], vaultOf: V, votedWeightsActive: false };
  test("stored protocol digest: the vector is the real weights in registry order", () => {
    const v = planApply({ ...base, storedDigest: DIGEST });
    expect(v.vaults).toEqual([V.USDC, V.PROTO, V.AGENT, V.RWA]);
    expect(v.bps).toEqual([8550, 525, 575, 350]);
  });
  test("mutation: a stored plain keccak256 is refused", () => {
    expect(() => planApply({ ...base, storedDigest: PLAIN as Hex })).toThrow(/differs from the digest stored/);
  });
});
