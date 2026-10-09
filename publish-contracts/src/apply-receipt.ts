// The govern row `apply-receipt` (issue 1696): the Safe, through the timelock, applies one consensus receipt as ONE batch.
// The Safe multisig through the timelock is the only body that changes Robot Money contract configuration, router weights included. There is no vote.
// The batch is releaseReceipt(receiptId) on the ConsensusRecommendationReceipt and the router weight change for the receipt's vector (on today's bytecode
// RouterGovernance.setDefaultWeights(vaults, bps), the ADMIN call the timelock holds). Release and weights are one operation: partial state is impossible.
// When the contract issue lands the weight-setter applyReceipt call replaces the weights call, and `buildApplyCalls` is the only function that changes.
// This module is pure: it reads no chain and sends nothing. govern.ts reads the chain, calls `planApply` and sends the batch.
import { encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import type { VaultKey } from "./sheet.ts";

export const APPLY_ROW = "apply-receipt";

/** Receipt payload bucket to basket vault. The same table as rmpc governance draft-proposal (clients/rust-payment-client governance_draft.rs). */
export const BUCKET_VAULT: Readonly<Record<string, VaultKey>> = {
  conservative_defi_yield: "USDC", protocol_tokens: "PROTO", agent_tokens: "AGENT", real_world_assets: "RWA",
};

export const GOVERNANCE_WEIGHTS_ABI = parseAbi(["function setDefaultWeights(address[] vaults, uint256[] bps)"]);
export const ROUTER_WEIGHTS_ABI = parseAbi(["function getDefaultWeights() view returns (address[] vaults, uint256[] bps)"]);
export const REGISTRY_ELIGIBLE_ABI = parseAbi([
  "function listVaults() view returns (address[])",
  "function isRouterEligible(address vault) view returns (bool)",
]);
export const RECEIPT_RECORD_ABI = parseAbi([
  "function getReceiptById(bytes32 receiptId) view returns ((bytes32 receiptId, bytes32 payloadDigest, string payloadUri, address submitter, uint64 recordedAt, uint64 releasedAt, bool released))",
]);
const RELEASE_ABI = parseAbi(["function releaseReceipt(bytes32 receiptId)"]);

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
    const key = BUCKET_VAULT[bucket];
    if (key === undefined) return usage(`--payload weights: bucket '${bucket}' is not one of ${Object.keys(BUCKET_VAULT).join(", ")}`);
    if (seen.has(bucket)) return usage(`--payload weights: bucket '${bucket}' is listed twice`);
    seen.add(bucket);
    const bps = w?.weight_bps;
    if (!Number.isInteger(bps) || bps < 0 || bps > BPS_TOTAL) return usage(`--payload weights: ${bucket} weight_bps ${String(bps)} is not an integer from 0 to ${BPS_TOTAL}`);
    entries.push({ vault: vaultOf[key], bps, bucket });
  }
  const sum = entries.reduce((a, e) => a + e.bps, 0);
  if (sum !== BPS_TOTAL) return usage(`--payload weights sum to ${sum} bps, want ${BPS_TOTAL}`, { sum });
  const isEligible = (a: Address) => eligible.some((e) => lc(e) === lc(a));
  const kept = entries.filter((e) => e.bps > 0 || isEligible(e.vault));
  return { vaults: kept.map((e) => e.vault), bps: kept.map((e) => e.bps) };
}

/**
 * Pre-send validation. Throws USAGE (nothing was sent) unless: the receipt is recorded, its stored digest equals keccak256 of the payload bytes, the
 * vector sums to 10000 bps and lists exactly the registry's router-eligible vaults in registry order, and the receipt is not yet released.
 */
export function planApply(i: ApplyInputs): WeightVector {
  if (!i.inFlight) {
    if (!i.recorded) usage(`receipt ${i.receiptId} is not recorded on the receipt contract: nothing to apply`, { receipt_id: i.receiptId });
    if (i.released) usage(`receipt ${i.receiptId} is already released: nothing to apply`, { receipt_id: i.receiptId });
  }
  if (i.storedDigest === undefined) usage(`receipt ${i.receiptId} has no stored payload digest to compare`, { receipt_id: i.receiptId });
  const digest = keccak256(i.payload);
  if (lc(digest) !== lc(i.storedDigest!)) usage(`--payload digest ${digest} differs from the digest stored for receipt ${i.receiptId} (${i.storedDigest}): the file is not the anchored payload`, { receipt_id: i.receiptId, digest, stored: i.storedDigest });
  const v = payloadVector(i.payload, i.vaultOf, i.eligible);
  const want = i.eligible.map(lc);
  const got = v.vaults.map(lc);
  if (got.length !== want.length || new Set(got).size !== got.length || !got.every((a) => want.includes(a))) {
    return usage(`--payload vault set [${got.join(", ")}] differs from the registry's router-eligible vaults [${want.join(", ")}]`, { got, want });
  }
  if (got.some((a, k) => a !== want[k])) return usage(`--payload vault order [${got.join(", ")}] differs from the registry order [${want.join(", ")}]`, { got, want });
  return v;
}

export interface ApplyCall { label: string; target: Address; data: Hex }

/** The two calls of the one batch, in order: release, then the weight change. The only function that changes when the weight-setter applyReceipt lands. */
export function buildApplyCalls(receipt: Address, governance: Address, receiptId: Hex, v: WeightVector): ApplyCall[] {
  return [
    { label: `receipt.releaseReceipt(${receiptId})`, target: receipt, data: encodeFunctionData({ abi: RELEASE_ABI, functionName: "releaseReceipt", args: [receiptId] }) },
    { label: `governance.setDefaultWeights([${v.vaults.join(",")}],[${v.bps.join(",")}])`, target: governance, data: encodeFunctionData({ abi: GOVERNANCE_WEIGHTS_ABI, functionName: "setDefaultWeights", args: [v.vaults, v.bps.map(BigInt)] }) },
  ];
}

/** Read-back problems: the receipt must read released and the router's default weights must equal the vector. An empty list is a pass. */
export function applyReadBackProblems(receiptId: Hex, released: boolean, routerVaults: readonly string[], routerBps: readonly bigint[], v: WeightVector): string[] {
  const bad: string[] = [];
  if (!released) bad.push(`receipt.isReleased(${receiptId}) is false`);
  const got = routerVaults.map((a, k) => `${lc(a)}:${routerBps[k]}`).join(",");
  const want = v.vaults.map((a, k) => `${lc(a)}:${v.bps[k]}`).join(",");
  if (got !== want) bad.push(`router.getDefaultWeights() is [${got}], want [${want}]`);
  return bad;
}
