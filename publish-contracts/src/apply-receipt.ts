// The govern row `apply-receipt` (issue 1696, issue 1698): the Safe, through the timelock, applies one consensus receipt as ONE call.
// The Safe multisig through the timelock is the only body that changes Robot Money contract configuration, router weights included. There is no vote.
// The call is RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps), gated by the weight setter's WEIGHT_SETTER_ROLE (held by the timelock). It checks the
// receipt is recorded, unreleased and that the named digest is the stored one, then releases the receipt and sets the router's active vector in the same call:
// partial state is impossible. Canonical: docs/technical/governance-decisions.md §3.2 and §3.7 (the payload-digest binding).
// This module is pure: it reads no chain and sends nothing. govern.ts reads the chain, calls `planApply` and sends the batch.
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { receiptPayloadDigest } from "./receipt-digest.ts";
import { PublishError } from "./errors.ts";
import type { VaultKey } from "./sheet.ts";

export const APPLY_ROW = "apply-receipt";

/** Receipt payload bucket to basket vault. The same table as rmpc governance draft-proposal (clients/rust-payment-client governance_draft.rs). */
export const BUCKET_VAULT: Readonly<Record<string, VaultKey>> = {
  conservative_defi_yield: "USDC", protocol_tokens: "PROTO", agent_tokens: "AGENT", real_world_assets: "RWA",
};

export const GOVERNANCE_APPLY_ABI = parseAbi(["function applyReceipt(bytes32 receiptId, bytes32 payloadDigest, address[] vaults, uint256[] bps)"]);
/** The router reads govern needs: the ACTIVE vector applyReceipt sets, the DEFAULT vector, the EFFECTIVE vector deposits route by, and whether the active vector is in effect (issue 1743). */
export const ROUTER_WEIGHTS_ABI = parseAbi([
  "function getWeights() view returns (address[] vaults, uint256[] bps)",
  "function getDefaultWeights() view returns (address[] vaults, uint256[] bps)",
  "function getEffectiveWeights() view returns (address[] vaults, uint256[] bps)",
  "function votedWeightsActive() view returns (bool)",
]);
export const REGISTRY_ELIGIBLE_ABI = parseAbi([
  "function listVaults() view returns (address[])",
  "function isRouterEligible(address vault) view returns (bool)",
]);
export const RECEIPT_RECORD_ABI = parseAbi([
  "function getReceiptById(bytes32 receiptId) view returns ((bytes32 receiptId, bytes32 payloadDigest, string payloadUri, address submitter, uint64 recordedAt, uint64 releasedAt, bool released))",
]);
export const BPS_TOTAL = 10_000;

/** The run-manifest key and salt input of one receipt's apply round. One receipt id is one operation (a cancelled one is scheduled again, newer seq). */
export const applyRecordKey = (receiptId: Hex): string => `${APPLY_ROW}-${receiptId.toLowerCase()}`;

export interface WeightVector { vaults: Address[]; bps: number[] }

/** Everything planApply needs, already read from the chain and the payload file. */
export interface ApplyInputs {
  receiptId: Hex;
  /** The raw bytes of the `--payload` file. The on-chain digest commits to exactly these bytes. */
  payload: Uint8Array;
  recorded: boolean;
  released: boolean;
  /** The stored payloadDigest of the receipt (read only when recorded). */
  storedDigest?: Hex;
  /** The registry's router-eligible vaults, in registry order. */
  eligible: readonly Address[];
  /** Bucket to deployed vault address (the vault manifests). */
  vaultOf: Readonly<Record<VaultKey, Address>>;
  /** When an operation of this round is already on the timelock the receipt-state checks (recorded, not released) are not repeated: the round is in flight. */
  inFlight?: boolean;
}

const usage = (message: string, details: Record<string, unknown> = {}): never => { throw new PublishError("USAGE", message, details); };
const lc = (x: string): string => x.toLowerCase();

/**
 * The receipt payload's weight vector as the router vector. The payload lists `weights: [{ bucket, weight_bps }]`. A bucket maps to its basket vault.
 * A bucket at 0 bps whose vault is not router-eligible is dropped (the router wants exactly the eligible set). Every other entry stays, in payload order.
 */
export function payloadVector(payload: Uint8Array, vaultOf: Readonly<Record<VaultKey, Address>>, eligible: readonly Address[]): WeightVector {
  let doc: any;
  try { doc = JSON.parse(new TextDecoder().decode(payload)); } catch (e) { return usage(`--payload is not JSON: ${(e as Error).message}`); }
  const weights: unknown = doc?.weights;
  if (!Array.isArray(weights) || weights.length === 0) return usage("--payload has no weights list: a receipt without an allocation vector cannot be applied");
  const seen = new Set<string>();
  const entries: { vault: Address; bps: number; bucket: string }[] = [];
  for (const w of weights) {
    const bucket = String(w?.bucket);
    // Object.hasOwn (issue 1701): a bucket named constructor or __proto__ must be a USAGE error, not an inherited Object.prototype member.
    if (!Object.hasOwn(BUCKET_VAULT, bucket)) return usage(`--payload weights: bucket '${bucket}' is not one of ${Object.keys(BUCKET_VAULT).join(", ")}`);
    if (seen.has(bucket)) return usage(`--payload weights: bucket '${bucket}' is listed twice`);
    seen.add(bucket);
    const bps = w?.weight_bps;
    if (!Number.isInteger(bps) || bps < 0 || bps > BPS_TOTAL) return usage(`--payload weights: ${bucket} weight_bps ${String(bps)} is not an integer from 0 to ${BPS_TOTAL}`);
    entries.push({ vault: vaultOf[BUCKET_VAULT[bucket]!], bps, bucket });
  }
  const sum = entries.reduce((a, e) => a + e.bps, 0);
  if (sum !== BPS_TOTAL) return usage(`--payload weights sum to ${sum} bps, want ${BPS_TOTAL}`, { sum });
  const isEligible = (a: Address) => eligible.some((e) => lc(e) === lc(a));
  const kept = entries.filter((e) => e.bps > 0 || isEligible(e.vault));
  return { vaults: kept.map((e) => e.vault), bps: kept.map((e) => e.bps) };
}

/**
 * Pre-send validation. Throws USAGE (nothing was sent) unless: the receipt is recorded, its stored digest equals the receipt digest (receipt-digest.ts) of the payload bytes, the
 * vector sums to 10000 bps and lists exactly the registry's router-eligible vaults (it is arranged in registry order), and the receipt is not yet released.
 */
export function planApply(i: ApplyInputs): WeightVector {
  if (!i.inFlight) {
    if (!i.recorded) usage(`receipt ${i.receiptId} is not recorded on the receipt contract: nothing to apply`, { receipt_id: i.receiptId });
    if (i.released) usage(`receipt ${i.receiptId} is already released: nothing to apply`, { receipt_id: i.receiptId });
  }
  if (i.storedDigest === undefined) usage(`receipt ${i.receiptId} has no stored payload digest to compare`, { receipt_id: i.receiptId });
  const digest = receiptPayloadDigest(i.payload); // issue 1754: the protocol digest (domain line + canonical bytes), the same function record-receipt uses
  if (lc(digest) !== lc(i.storedDigest!)) usage(`--payload digest ${digest} differs from the digest stored for receipt ${i.receiptId} (${i.storedDigest}): the file is not the anchored payload`, { receipt_id: i.receiptId, digest, stored: i.storedDigest });
  const v = payloadVector(i.payload, i.vaultOf, i.eligible);
  const want = i.eligible.map(lc);
  const got = v.vaults.map(lc);
  if (got.length !== want.length || new Set(got).size !== got.length || !got.every((a) => want.includes(a))) {
    return usage(`--payload vault set [${got.join(", ")}] differs from the registry's router-eligible vaults [${want.join(", ")}]`, { got, want });
  }
  // Issue 1754: the signed payload lists the buckets in the receipt's canonical order (agent, conservative, protocol, rwa), which is not the registry order. The router wants the registry order, so the vector is arranged here.
  const at = (a: Address) => want.indexOf(lc(a));
  const order = v.vaults.map((_, k) => k).sort((x, y) => at(v.vaults[x]!) - at(v.vaults[y]!));
  return { vaults: order.map((k) => v.vaults[k]!), bps: order.map((k) => v.bps[k]!) };
}

export interface ApplyCall { label: string; target: Address; data: Hex }

/** The calldata of the one call: applyReceipt on the weight setter, naming the receipt, the digest the vector was derived from, and the vector. */
export const applyCalldata = (receiptId: Hex, payloadDigest: Hex, v: WeightVector): Hex =>
  encodeFunctionData({ abi: GOVERNANCE_APPLY_ABI, functionName: "applyReceipt", args: [receiptId, payloadDigest, v.vaults, v.bps.map(BigInt)] });

/** The one call of an application: the weight setter's applyReceipt, which releases the receipt and sets the router's active vector together. */
export function buildApplyCall(governance: Address, receiptId: Hex, payloadDigest: Hex, v: WeightVector): ApplyCall {
  return { label: `governance.applyReceipt(${receiptId},${payloadDigest},[${v.vaults.join(",")}],[${v.bps.join(",")}])`, target: governance, data: applyCalldata(receiptId, payloadDigest, v) };
}

/** The vector as the `addr:bps` string the read-backs compare. Addresses are lower-cased. */
export const vectorKey = (vaults: readonly string[], bps: readonly (bigint | number)[]): string => vaults.map((a, k) => `${lc(a)}:${bps[k]}`).join(",");

/** What the router reads back after the call executed. */
export interface RouterReadBack { activeVaults: readonly string[]; activeBps: readonly bigint[]; effectiveVaults: readonly string[]; effectiveBps: readonly bigint[]; votedWeightsActive: boolean }

/**
 * Read-back problems: the receipt must read released, the router's active weights must equal the vector and be in effect, and the EFFECTIVE weights
 * (what deposits route by, issue 1743) must equal the vector too. An empty list is a pass.
 */
export function applyReadBackProblems(receiptId: Hex, released: boolean, r: RouterReadBack, v: WeightVector): string[] {
  const bad: string[] = [];
  if (!released) bad.push(`receipt.isReleased(${receiptId}) is false`);
  const want = vectorKey(v.vaults, v.bps);
  const gotActive = vectorKey(r.activeVaults, r.activeBps);
  if (gotActive !== want) bad.push(`router.getWeights() is [${gotActive}], want [${want}]`);
  if (!r.votedWeightsActive) bad.push("router.votedWeightsActive() is false: the applied vector is not in effect, routing still uses the default");
  const gotEffective = vectorKey(r.effectiveVaults, r.effectiveBps);
  if (gotEffective !== want) bad.push(`router.getEffectiveWeights() is [${gotEffective}], want [${want}]`);
  return bad;
}
