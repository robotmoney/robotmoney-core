// The ONE definition of the consensus receipt digest scheme for every TypeScript path (record-receipt, apply-receipt, govern, the Twin script, evidence tests).
//
// Protocol (normative): payloadDigest = keccak256("robotmoney:consensus-receipt:v1\n" || compactJson || "\n"), receipt_id = keccak256("robotmoney:consensus-receipt-id:v1\n" || session_id || "\n" || subject_id).
// The domain line is part of the hashed preimage. The public canonical route (/api/swarm/sessions/<id>/consensus-receipt/canonical) serves compactJson || "\n" WITHOUT the domain line,
// so a plain keccak256 of the served bytes is NOT the anchored digest (issue 1754).
// Sources: clients/rust-payment-client/src/consensus_receipt.rs DOMAIN_SEPARATOR (line 77), RECEIPT_ID_DOMAIN_SEPARATOR (line 81), canonical_bytes (lines 574-596), derive_receipt_id (lines 417-428);
// the frontend twin is robotmoney-frontend contract/src/consensus-receipt.js (not available in this checkout: the oracle here is the real production receipt, session 5015526d-27f6-478a-86e9-ac768e310af1,
// pinned in tests/fixtures/real-consensus-receipt.canonical.json, whose rmpc payload_digest is 0x2aebf2b3...bacb and receipt_id 0xdcf4108e...ca81).
import { keccak256, toBytes, type Hex } from "viem";
import { PublishError } from "./errors.ts";

export const RECEIPT_DOMAIN = "robotmoney:consensus-receipt:v1\n";
export const RECEIPT_ID_DOMAIN = "robotmoney:consensus-receipt-id:v1\n";
const DOMAIN_BYTES = new TextEncoder().encode(RECEIPT_DOMAIN);

const startsWithDomain = (b: Uint8Array): boolean => b.length >= DOMAIN_BYTES.length && DOMAIN_BYTES.every((x, k) => b[k] === x);

/**
 * The hashed preimage of a receipt file. A file is either the served canonical bytes (compact JSON + "\n", which always starts with "{") or the full preimage (starting with the domain line).
 * The two cannot be confused. Anything else is hashed as served with the domain line prepended, exactly as rmpc would.
 */
export function receiptPreimage(bytes: Uint8Array): Uint8Array {
  if (startsWithDomain(bytes)) return bytes;
  const out = new Uint8Array(DOMAIN_BYTES.length + bytes.length);
  out.set(DOMAIN_BYTES, 0);
  out.set(bytes, DOMAIN_BYTES.length);
  return out;
}

/** The anchored payloadDigest of a receipt file (served canonical bytes or full preimage). */
export const receiptPayloadDigest = (bytes: Uint8Array): Hex => keccak256(receiptPreimage(bytes));

/** The receipt_id of a (session, subject) pair. */
export const deriveReceiptId = (sessionId: string, subjectId: string): Hex => keccak256(toBytes(`${RECEIPT_ID_DOMAIN}${sessionId}\n${subjectId}`));

/** The receipt_id named by the session_id and subject_id inside the receipt bytes, or undefined when the bytes carry no such strings. */
export function receiptIdOfBytes(bytes: Uint8Array): Hex | undefined {
  try {
    const doc = JSON.parse(new TextDecoder().decode(startsWithDomain(bytes) ? bytes.subarray(DOMAIN_BYTES.length) : bytes));
    return typeof doc?.session_id === "string" && typeof doc?.subject_id === "string" ? deriveReceiptId(doc.session_id, doc.subject_id) : undefined;
  } catch { return undefined; }
}

/** Throws USAGE (nothing sent) unless the digest is the protocol digest of the bytes. `what` names the digest source in the message. */
export function assertDigestMatchesBytes(bytes: Uint8Array, digest: string, what: string): void {
  const want = receiptPayloadDigest(bytes);
  if (want.toLowerCase() !== digest.toLowerCase()) {
    throw new PublishError("USAGE", `${what} ${digest} is not the receipt digest of the payload bytes ${want}: the digest is keccak256("${RECEIPT_DOMAIN.trim()}\\n" + the canonical receipt bytes), not a plain keccak256 of the file (plain keccak256 of these bytes is ${keccak256(bytes)})`, { digest, computed: want });
  }
}

/** The only `schema_version` the digest and id derivation here supports (clients/rust-payment-client/src/consensus_receipt.rs SCHEMA_VERSION). */
export const SUPPORTED_RECEIPT_SCHEMA_VERSION = "1.0";

export interface SupportedPayload { digest: Hex; receiptId: Hex; sessionId: string; subjectId: string }

/**
 * Issue 1888: the MANDATORY payload check of record-receipt. The served canonical bytes (or the full preimage) must be present, strict UTF-8, one compact JSON object
 * followed by exactly one newline, of the supported schema_version, with a non-empty session_id and subject_id. The protocol digest and the receipt id are recomputed from
 * the bytes. Throws USAGE (nothing sent, no signer built) for anything else. It does not verify analyst signatures: that is `rmpc receipt verify` on the same bytes.
 */
export function supportedReceiptPayload(bytes: Uint8Array | undefined): SupportedPayload {
  if (bytes === undefined || bytes.length === 0) throw new PublishError("USAGE", "the receipt payload bytes are required (--payload FILE: the exact bytes the canonical route served, already verified with `rmpc receipt verify`). Nothing sent.");
  const body = startsWithDomain(bytes) ? bytes.subarray(DOMAIN_BYTES.length) : bytes;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { throw new PublishError("USAGE", "the receipt payload is not valid UTF-8: it is not a canonical consensus receipt. Nothing sent."); }
  if (!text.startsWith("{") || !text.endsWith("}\n") || text.endsWith("\n\n")) throw new PublishError("USAGE", "the receipt payload is not the canonical form (one compact JSON object followed by exactly one newline). Nothing sent.");
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw new PublishError("USAGE", "the receipt payload is not valid JSON: it is not a canonical consensus receipt. Nothing sent."); }
  const o = doc as Record<string, unknown>;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new PublishError("USAGE", "the receipt payload is not a JSON object. Nothing sent.");
  if (o.schema_version !== SUPPORTED_RECEIPT_SCHEMA_VERSION) throw new PublishError("USAGE", `the receipt payload schema_version is ${JSON.stringify(o.schema_version)}: only ${JSON.stringify(SUPPORTED_RECEIPT_SCHEMA_VERSION)} is supported. Nothing sent.`, { schema_version: o.schema_version });
  if (typeof o.session_id !== "string" || o.session_id === "" || typeof o.subject_id !== "string" || o.subject_id === "") throw new PublishError("USAGE", "the receipt payload has no session_id and subject_id: the receipt id cannot be derived. Nothing sent.");
  return { digest: receiptPayloadDigest(bytes), receiptId: deriveReceiptId(o.session_id, o.subject_id), sessionId: o.session_id, subjectId: o.subject_id };
}
