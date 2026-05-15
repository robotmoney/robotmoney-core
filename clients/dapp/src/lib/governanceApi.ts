/**
 * Governance API client — wraps GET /v1/governance/proposals and
 * GET /v1/governance/proposals/:id from the explorer-api service.
 *
 * Wire shapes mirror `clients/explorer-api/src/model.rs`:
 *   ProposalSummary  → list endpoint
 *   ProposalDetail   → detail endpoint (includes per-voter votes)
 *
 * Used exclusively by GovernancePanel (issue #322). The client never
 * issues on-chain RPC calls — live proposal state is fetched from the
 * indexed API, consistent with §12 of docs/implementation-plan.md.
 */
import type { FetchLike } from "./explorerApi";
export type { FetchLike };

// ─── Wire types ──────────────────────────────────────────────────────────────

export interface ProposalSummary {
  readonly chain_id: number;
  readonly proposal_id: number;
  readonly proposer: string;
  readonly description: string;
  /** Timestamp (Unix seconds) when the proposal was created. */
  readonly created_at: number;
  /** Block number after which voting closes. */
  readonly deadline_block: number;
  /** "open" | "passed" | "executed" | "expired" */
  readonly status: string;
  /** Aggregate weighted votes for the proposal. */
  readonly votes_for: number;
  /** Aggregate weighted votes against the proposal. */
  readonly votes_against: number;
  readonly block_number: number;
  readonly indexed_at: string;
}

export interface Freshness {
  readonly block_number: number;
  readonly indexed_at: string;
}

export interface ProposalsResponse {
  readonly proposals: readonly ProposalSummary[];
  readonly block_number: number;
  readonly indexed_at: string;
}

export interface VoteEntry {
  readonly voter: string;
  /** true = For, false = Against. */
  readonly support: boolean;
  readonly weight: string;
  readonly block_number: number;
  readonly tx_hash: string;
}

export interface ProposalDetail {
  readonly chain_id: number;
  readonly proposal_id: number;
  readonly proposer: string;
  readonly description: string;
  readonly created_at: number;
  readonly deadline_block: number;
  readonly status: string;
  readonly votes_for: number;
  readonly votes_against: number;
  /** Block at which the proposal was executed; null when not yet executed. */
  readonly executed_block: number | null;
  readonly block_number: number;
  readonly indexed_at: string;
  readonly votes: readonly VoteEntry[];
}

export interface ProposalDetailResponse {
  readonly proposal: ProposalDetail;
  readonly block_number: number;
  readonly indexed_at: string;
}

// ─── Client functions ─────────────────────────────────────────────────────────

/**
 * GET /v1/governance/proposals
 *
 * Returns all proposals (most recent first, limit 500). Throws on any
 * non-2xx response.
 */
export async function fetchProposals(
  baseUrl: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<ProposalsResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/governance/proposals`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) {
    throw new Error(`governance API ${res.status}`);
  }
  return (await res.json()) as ProposalsResponse;
}

/**
 * GET /v1/governance/proposals/:id
 *
 * Returns the full proposal detail including per-voter vote entries.
 * Throws on any non-2xx response (404 when the id is unknown).
 */
export async function fetchProposal(
  baseUrl: string,
  proposalId: number,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<ProposalDetailResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/governance/proposals/${proposalId}`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) {
    throw new Error(`governance API ${res.status}`);
  }
  return (await res.json()) as ProposalDetailResponse;
}
