// Canonical: docs/architecture.md §4.9 — Consensus Rebalance Receipt Contract
// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §2.1
// Implements: issue #1247 tasks 4.9 and 4.14 — receipt list, verification state,
//             released state, applied vs not-applied.

/**
 * Consensus rebalance receipt API client.
 *
 * Reads the anchored receipt commitments from the indexed explorer API, and
 * optionally the receipt payload itself from the public `payload_uri` the
 * commitment points at.
 *
 * What the chain proves, and what it does not: the commitment proves the
 * committee produced the recommendation and that **one submitter** attested to
 * it. It does **not** prove each named analyst signed. The analysts' ed25519
 * signatures ride inside the payload as data verified off-chain (ADR-0012 §5),
 * so this module deliberately names that count `payload_signature_count` and
 * every surface must label it as off-chain analyst signatures — never as
 * on-chain approvals.
 *
 * Endpoints:
 *   GET /v1/consensus-receipts?limit=N                → ConsensusReceiptsResponse
 *   GET /v1/consensus-receipts/:receipt_id            → ConsensusReceiptResponse
 *   GET /v1/accounts/:address/consensus-receipts      → ConsensusReceiptsResponse
 */
import type { FetchLike } from "./explorerApi";
export type { FetchLike };

// ─── Wire types ──────────────────────────────────────────────────────────────

/** An anchored receipt commitment, as indexed from `ReceiptRecorded`. */
export interface ConsensusReceipt {
  /** keccak256 of the receipt-id preimage (session + subject). */
  readonly receipt_id: string;
  /** Append index in the receipt contract. */
  readonly receipt_index: number;
  /** The single submitter EOA that attested for the committee. */
  readonly submitter: string;
  /** keccak256 of the receipt's canonical bytes. */
  readonly payload_digest: string;
  /** Public route serving those exact bytes. */
  readonly payload_uri: string;
  /** Unix seconds the commitment was recorded on chain. */
  readonly recorded_at: number;
  readonly block_number: number;
  readonly tx_hash: string;
  /**
   * Whether the indexer independently re-fetched `payload_uri` and confirmed
   * its keccak256 equals `payload_digest`. False also covers "could not fetch".
   */
  readonly verified: boolean;
  /** Whether an admin has released the receipt (a signalling-only act). */
  readonly released: boolean;
  /** Unix seconds of release, or null when never released. */
  readonly released_at: number | null;
}

export interface Freshness {
  readonly indexed_at?: string;
  readonly block_number?: number;
  readonly [key: string]: unknown;
}

export interface ConsensusReceiptsResponse {
  readonly receipts: readonly ConsensusReceipt[];
  readonly freshness?: Freshness;
}

export interface ConsensusReceiptResponse {
  readonly receipt: ConsensusReceipt;
  readonly freshness?: Freshness;
}

// ─── Payload types (fetched from payload_uri, not from the chain) ────────────

/** One bucket's recommended weight, in basis points. */
export interface ReceiptWeight {
  readonly bucket: string;
  readonly weight_bps: number;
}

/** One analyst's signature over their own canonical submission. */
export interface AnalystSignature {
  readonly member_id: string;
  readonly public_key: string;
  readonly canonical_submission: string;
  readonly signature: string;
}

/** The receipt payload served at `payload_uri`. Only the fields we render. */
export interface ReceiptPayload {
  readonly schema_version: string;
  readonly session_id: string;
  readonly subject_id: string;
  readonly created_at: string;
  readonly quorum?: {
    readonly active: number;
    readonly submitted: number;
    readonly absent: number;
    readonly participation_bps: number;
  };
  readonly analyst_signatures?: readonly AnalystSignature[];
  readonly weights?: readonly ReceiptWeight[];
}

// ─── Client ──────────────────────────────────────────────────────────────────

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export class ConsensusReceiptApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.baseUrl = trimBase(baseUrl);
    this.fetchImpl = fetchImpl;
  }

  /** Protocol scope: every anchored receipt, newest first. */
  async listReceipts(limit = 25): Promise<ConsensusReceiptsResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/consensus-receipts?limit=${limit}`);
    if (!res.ok) throw new Error(`consensus receipts request failed: ${res.status}`);
    return (await res.json()) as ConsensusReceiptsResponse;
  }

  /** Protocol scope: one receipt by id. */
  async getReceipt(receiptId: string): Promise<ConsensusReceiptResponse> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/consensus-receipts/${encodeURIComponent(receiptId)}`,
    );
    if (!res.ok) throw new Error(`consensus receipt request failed: ${res.status}`);
    return (await res.json()) as ConsensusReceiptResponse;
  }

  /** Account scope: receipts anchored by one submitter address. */
  async listReceiptsBySubmitter(address: string, limit = 25): Promise<ConsensusReceiptsResponse> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/accounts/${encodeURIComponent(address)}/consensus-receipts?limit=${limit}`,
    );
    if (!res.ok) throw new Error(`account consensus receipts request failed: ${res.status}`);
    return (await res.json()) as ConsensusReceiptsResponse;
  }

  /**
   * Fetch the receipt payload from its public URI.
   *
   * Returns `null` rather than throwing when the payload is unreachable — the
   * surface must then say the payload is unavailable, never substitute a zero
   * signature count or an empty weight vector.
   */
  async fetchPayload(payloadUri: string): Promise<ReceiptPayload | null> {
    try {
      const res = await this.fetchImpl(payloadUri);
      if (!res.ok) return null;
      return (await res.json()) as ReceiptPayload;
    } catch {
      return null;
    }
  }
}

// ─── Applied vs not-applied (issue #1247 task 4.14) ─────────────────────────

/**
 * Bucket → vault symbol, pinned by
 * `tests/fixtures/consensus-receipt.bucket-vault-map.json`. Kept here as a
 * literal because the dapp cannot read repo fixtures at runtime; the mapping is
 * schema 1.0 and changes only with a `schema_version` bump.
 */
export const BUCKET_VAULT_SYMBOL: Readonly<Record<string, string>> = {
  agent_tokens: "rmAGENT",
  conservative_defi_yield: "rmUSDC",
  protocol_tokens: "rmPROTO",
  real_world_assets: "rmRWA",
};

/**
 * Whether a receipt's recommendation is reflected in the live router weights.
 *
 * Deliberately three-valued. "Not applied" and "cannot tell" are different
 * claims, and collapsing them would make the surface misleading in exactly the
 * direction the product warns about: a public record of recommendations that
 * were mostly not followed is honest and valuable, or misleading and damaging,
 * and the difference is entirely presentation.
 */
export type AppliedState = "applied" | "not_applied" | "unknown";

/**
 * Compare a receipt's recommended bps vector with the live router weights.
 *
 * `routerWeights` is keyed by vault address, so the caller supplies the
 * symbol→address mapping for the deployment. Returns `"unknown"` whenever the
 * payload, its weights, or the mapping is missing — never a guess.
 */
export function computeAppliedState(
  payload: ReceiptPayload | null,
  routerWeights: readonly { readonly vault: string; readonly bps: number }[] | null,
  vaultAddressBySymbol: Readonly<Record<string, string>> | null,
): AppliedState {
  if (!payload || !payload.weights || payload.weights.length === 0) return "unknown";
  if (!routerWeights || routerWeights.length === 0) return "unknown";
  if (!vaultAddressBySymbol) return "unknown";

  const live = new Map<string, number>();
  for (const w of routerWeights) live.set(w.vault.toLowerCase(), w.bps);

  for (const w of payload.weights) {
    const symbol = BUCKET_VAULT_SYMBOL[w.bucket];
    if (!symbol) return "unknown";
    const address = vaultAddressBySymbol[symbol];
    if (!address) return "unknown";
    const liveBps = live.get(address.toLowerCase());
    if (liveBps === undefined) return "unknown";
    if (liveBps !== w.weight_bps) return "not_applied";
  }
  return "applied";
}

/** Number of off-chain analyst signatures carried in the payload. */
export function payloadSignatureCount(payload: ReceiptPayload | null): number | null {
  if (!payload || !payload.analyst_signatures) return null;
  return payload.analyst_signatures.length;
}

/**
 * Parse the per-deployment vault-symbol → address map from configuration.
 *
 * The shape follows `deployment_address_contract` in
 * `tests/fixtures/consensus-receipt.bucket-vault-map.json`: the four symbols
 * `rmUSDC`, `rmPROTO`, `rmAGENT`, `rmRWA` and a `^0x[0-9a-fA-F]{40}$` address
 * each. That fixture's `missing_address_policy` is explicit — *"the deployment
 * is not receipt-capable; never substitute a global or zero address"* — so an
 * absent, malformed, or incomplete map returns `undefined` and the surface
 * degrades to "cannot determine" rather than guessing.
 */
export function parseVaultAddressMap(
  raw: string | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const required = ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"];
  const addressPattern = /^0x[0-9a-fA-F]{40}$/;
  const out: Record<string, string> = {};
  for (const symbol of required) {
    const value = (parsed as Record<string, unknown>)[symbol];
    if (typeof value !== "string" || !addressPattern.test(value)) return undefined;
    out[symbol] = value;
  }
  return out;
}
