// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §3
// Implements: issue #1044 — committee dapp surface

/**
 * Investment Committee API client — wraps explorer-api endpoints for the
 * committee surface and regime-feed surface.
 *
 * Wire shapes mirror the on-chain InvestmentCommitteePolicy contract:
 *   CommitteeAgent  → registered agent metadata
 *   CommitteeVote   → on-chain vote record
 *   RegimeFeed      → daily regime snapshot
 *
 * All data is read from the indexed explorer API — no live chain RPC calls.
 * The committee acts as signalling-only (docs/architecture.md §IC); these
 * views display signals, not live weights.
 */
import type { FetchLike } from "./explorerApi";
export type { FetchLike };

// ─── Wire types ──────────────────────────────────────────────────────────────

/** Allocation stance. Maps to InvestmentCommitteePolicy.Stance enum. */
export type Stance = "overweight" | "neutral" | "underweight";

/** A registered committee agent. */
export interface CommitteeAgent {
  readonly address: string;
  readonly agent_id: string;
  readonly registered_at: number;
  readonly block_number: number;
}

/** A single on-chain vote record. */
export interface CommitteeVote {
  readonly vote_id: number;
  readonly agent: string;
  readonly agent_id: string;
  readonly vault: string;
  readonly stance: Stance;
  readonly target_weight_bps: number;
  readonly confidence: number;
  readonly rationale_uri: string;
  readonly vote_json_hash: string;
  readonly timestamp: number;
  readonly submitted_at: number;
  readonly block_number: number;
  readonly tx_hash: string;
}

/** Daily regime snapshot produced by the analyst feed. */
export interface RegimeFeed {
  readonly date: string;
  readonly regime: string;
  readonly description: string;
  readonly published_at: number;
  readonly source_uri: string;
}

export interface CommitteeAgentsResponse {
  readonly agents: readonly CommitteeAgent[];
  readonly block_number: number;
  readonly indexed_at: string;
}

export interface CommitteeVotesResponse {
  readonly votes: readonly CommitteeVote[];
  readonly block_number: number;
  readonly indexed_at: string;
}

export interface RegimeFeedResponse {
  readonly feeds: readonly RegimeFeed[];
  readonly indexed_at: string;
}

// ─── API client ──────────────────────────────────────────────────────────────

export class CommitteeApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetch: FetchLike = globalThis.fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetch(url);
    if (!res.ok) {
      throw new Error(`CommitteeApiClient: GET ${path} returned ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  /** List all registered committee agents. */
  async getAgents(): Promise<CommitteeAgentsResponse> {
    return this.get<CommitteeAgentsResponse>("/v1/committee/agents");
  }

  /** List recent committee votes (latest first). */
  async getVotes(limit = 50): Promise<CommitteeVotesResponse> {
    return this.get<CommitteeVotesResponse>(`/v1/committee/votes?limit=${limit}`);
  }

  /** Get votes for a specific agent. */
  async getVotesByAgent(agentAddress: string): Promise<CommitteeVotesResponse> {
    return this.get<CommitteeVotesResponse>(`/v1/committee/agents/${agentAddress}/votes`);
  }

  /** Get the latest regime feed entries. */
  async getRegimeFeed(limit = 7): Promise<RegimeFeedResponse> {
    return this.get<RegimeFeedResponse>(`/v1/regime-feed?limit=${limit}`);
  }
}
