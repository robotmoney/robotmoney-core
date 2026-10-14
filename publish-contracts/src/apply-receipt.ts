// The govern row `apply-receipt` (issue 1696, issue 1698): the Safe, through the timelock, applies one consensus receipt as ONE timelock call.
// The Safe multisig through the timelock is the only body that changes Robot Money contract configuration, router weights included. There is no vote.
// The call is RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps) (ADMIN_ROLE, held by the timelock): the weight setter releases the receipt
// on the ConsensusRecommendationReceipt and writes the receipt's vector to the router (PortfolioRouter.setWeights) in the same transaction. Release and weights
// are one call on one contract: a released receipt whose weights were not applied, or applied weights whose receipt is unreleased, cannot exist
// (governance-decisions.md 3.2). The chain checks the receipt is recorded and unreleased and that the digest the call names is the digest the register stored
// (ReceiptDigestMismatch); the vector-to-payload equality is checked HERE before anything is scheduled, and attested by the Safe signatures over the calldata.
// The applied vector is the router's ACTIVE vector: `getEffectiveWeights()` reads it and `votedWeightsActive()` reads true (the storage keeps its pre-1698 name for
// ABI stability). The DEFAULT vector (`setDefaultWeights`) stays the fallback and is not touched by an application. A later receipt replaces the active vector;
// the clear row (clear-voted-weights.ts) drops it so routing falls back to the default.
// Before anything is scheduled, and again before the execute, the row also checks the stage 11 wiring the call needs (applyWiringProblems): RouterGovernance
// releases from the register this row read and holds its ADMIN_ROLE. A miss would only show as a revert one full timelock delay later.
// This module is pure: it reads no chain and sends nothing. govern.ts reads the chain, calls `planApply` and sends the call.
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { receiptPayloadDigest } from "./receipt-digest.ts";
import { PublishError } from "./errors.ts";
import type { VaultKey } from "./sheet.ts";

export const APPLY_ROW = "apply-receipt";

/** Receipt payload bucket to basket vault. The same table as the committee payload schema (schemas/consensus-receipt). */
export const BUCKET_VAULT: Readonly<Record<string, VaultKey>> = {
  conservative_defi_yield: "USDC", protocol_tokens: "PROTO", agent_tokens: "AGENT", real_world_assets: "RWA",
};

/** The one call of an application (issue 1698): the weight setter releases the receipt and sets the router weights. */
export const GOVERNANCE_APPLY_ABI = parseAbi(["function applyReceipt(bytes32 receiptId, bytes32 payloadDigest, address[] vaults, uint256[] bps)"]);
/** The router reads govern needs: the DEFAULT vector (the fallback), the EFFECTIVE vector deposits route by, and whether an applied vector is active over the default. */
export const ROUTER_WEIGHTS_ABI = parseAbi([
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
/** The stage 11 wiring the one call depends on (issue 1698): the register RouterGovernance releases from, and the register role that gates `releaseReceipt`. */
export const GOVERNANCE_WIRING_ABI = parseAbi(["function receiptContract() view returns (address)"]);
export const RECEIPT_ROLE_ABI = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]);

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
    // issue 1701: an own-property lookup, so a bucket named `constructor` or `__proto__` is an unknown bucket (USAGE), never a prototype member
    const key = Object.hasOwn(BUCKET_VAULT, bucket) ? BUCKET_VAULT[bucket] : undefined;
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
 * Pre-send validation. Throws USAGE (nothing was sent) unless: the receipt is recorded, its stored digest equals the receipt digest (receipt-digest.ts) of the payload bytes, the
 * vector sums to 10000 bps and lists exactly the registry's router-eligible vaults (it is arranged in registry order), and the receipt is not yet released.
 * An applied vector already active on the router is no refusal (issue 1698): `applyReceipt` writes the ACTIVE vector, so the new receipt replaces it.
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

/** What the chain says about the weight setter's wiring. `receiptContract` is undefined when the read failed: a pre-1698 RouterGovernance has neither it nor `applyReceipt`. */
export interface ApplyWiring { receiptContract: Address | undefined; governanceIsReceiptAdmin: boolean }

/**
 * Pre-send wiring problems (issue 1698). The one call only works when RouterGovernance releases from the register this row read (stage 11 `setReceiptContract`) and holds
 * that register's ADMIN_ROLE (the `releaseReceipt` gate). Without either, the call the Safe schedules reverts at the execute, one full timelock delay later
 * (ReceiptContractNotSet, AccessControlUnauthorizedAccount), or releases from a register whose receipt state and digest this row never checked. An empty list is a pass.
 */
export function applyWiringProblems(receipt: Address, governance: Address, w: ApplyWiring): string[] {
  const bad: string[] = [];
  if (w.receiptContract === undefined) bad.push(`governance ${governance} does not answer receiptContract(): it is not a RouterGovernance with applyReceipt (issue 1698), so the call would revert`);
  else if (lc(w.receiptContract) !== lc(receipt)) bad.push(`governance.receiptContract() is ${w.receiptContract}, not the consensus receipt ${receipt} this row read: the call would release from another register`);
  if (!w.governanceIsReceiptAdmin) bad.push(`receipt ${receipt}: ADMIN_ROLE is not held by governance ${governance}, so its releaseReceipt inside applyReceipt would revert`);
  return bad;
}

export interface ApplyCall { label: string; target: Address; data: Hex }

/** The calldata of `RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps)`: the one call of an application. evidence-check rebuilds it from the evidence entry. */
export const applyCalldata = (receiptId: Hex | string, payloadDigest: Hex | string, vaults: readonly string[], bps: readonly (bigint | number)[]): Hex =>
  encodeFunctionData({ abi: GOVERNANCE_APPLY_ABI, functionName: "applyReceipt", args: [receiptId as Hex, payloadDigest as Hex, vaults as Address[], bps.map(BigInt)] });

/**
 * The ONE call of an application (issue 1698): `governance.applyReceipt(receiptId, payloadDigest, vaults, bps)`. The list has exactly one entry: the row schedules it
 * with `schedule`, never `scheduleBatch`. `payloadDigest` is the receipt digest of the payload bytes, which planApply proved equal to the stored one; the chain checks it again.
 */
export function buildApplyCalls(governance: Address, receiptId: Hex, payloadDigest: Hex, v: WeightVector): ApplyCall[] {
  return [
    { label: `governance.applyReceipt(${receiptId}, ${payloadDigest}, [${v.vaults.join(",")}], [${v.bps.join(",")}])`, target: governance, data: applyCalldata(receiptId, payloadDigest, v.vaults, v.bps) },
  ];
}

/** The vector as the `addr:bps` string the read-backs compare. Addresses are lower-cased. */
export const vectorKey = (vaults: readonly string[], bps: readonly (bigint | number)[]): string => vaults.map((a, k) => `${lc(a)}:${bps[k]}`).join(",");

/** What the router reads back after the call executed: the EFFECTIVE vector, what deposits route by. */
export interface RouterReadBack { effectiveVaults: readonly string[]; effectiveBps: readonly bigint[] }

/**
 * Read-back problems: the receipt must read released and the router's EFFECTIVE weights (`getEffectiveWeights()`, what deposits route by, issue 1743) must equal
 * the applied vector. The default vector is not read: an application does not touch it. An empty list is a pass.
 */
export function applyReadBackProblems(receiptId: Hex, released: boolean, r: RouterReadBack, v: WeightVector): string[] {
  const bad: string[] = [];
  if (!released) bad.push(`receipt.isReleased(${receiptId}) is false`);
  const want = vectorKey(v.vaults, v.bps);
  const gotEffective = vectorKey(r.effectiveVaults, r.effectiveBps);
  if (gotEffective !== want) bad.push(`router.getEffectiveWeights() is [${gotEffective}], want [${want}]: the applied vector is not what deposits route by`);
  return bad;
}
