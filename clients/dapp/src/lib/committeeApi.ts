// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §3
// Implements: issue #1054 — committee dapp surface (agents, tilts, track record, vote-submit flow)

/**
 * Investment Committee API client — wraps explorer-api endpoints for the
 * committee surface and regime-feed surface.
 *
 * Wire shapes mirror the on-chain InvestmentCommitteePolicy contract:
 *   CommitteeAgent  → registered agent metadata
 *   CommitteeVote   → on-chain vote record
 *   CommitteeTilt   → aggregated per-vault tilt from /v1/committee/tilts
 *   RegimeFeed      → daily regime snapshot from /v1/regime/feed
 *
 * All data is read from the indexed explorer API — no live chain RPC calls.
 * The committee acts as signalling-only (docs/architecture.md §IC); these
 * views display signals, not live weights.
 *
 * Endpoints:
 *   GET /v1/committee/agents                          → CommitteeAgentsResponse
 *   GET /v1/committee/tilts                           → CommitteeTiltsResponse
 *   GET /v1/committee/votes?limit=N                   → CommitteeVotesResponse
 *   GET /v1/committee/agents/:address/votes           → CommitteeVotesResponse
 *   GET /v1/accounts/:address/committee-votes         → AccountCommitteeVotesResponse
 *   GET /v1/regime/feed?limit=N                       → RegimeFeedResponse
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

/**
 * Aggregated per-vault tilt from the committee.
 * Sourced from /v1/committee/tilts — computed by the indexer as a
 * weighted aggregate of recent VoteSubmitted events per vault.
 */
export interface CommitteeTilt {
  readonly vault: string;
  /** Aggregated stance label across registered agents. */
  readonly aggregate_stance: Stance;
  /** Weighted average target weight in basis points. */
  readonly aggregate_weight_bps: number;
  /** Count of agents contributing to this tilt. */
  readonly agent_count: number;
  /** Timestamp of the most recent vote that contributed to this tilt. */
  readonly last_updated: number;
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

export interface CommitteeTiltsResponse {
  readonly tilts: readonly CommitteeTilt[];
  readonly block_number: number;
  readonly indexed_at: string;
}

/**
 * Account-scoped committee votes response.
 * Returned by GET /v1/accounts/:address/committee-votes.
 */
export interface AccountCommitteeVotesResponse {
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

  /** List all registered committee agents. GET /v1/committee/agents */
  async getAgents(): Promise<CommitteeAgentsResponse> {
    return this.get<CommitteeAgentsResponse>("/v1/committee/agents");
  }

  /**
   * Get aggregated per-vault tilt from registered committee agents.
   * GET /v1/committee/tilts
   */
  async getTilts(): Promise<CommitteeTiltsResponse> {
    return this.get<CommitteeTiltsResponse>("/v1/committee/tilts");
  }

  /** List recent committee votes (latest first). GET /v1/committee/votes?limit=N */
  async getVotes(limit = 50): Promise<CommitteeVotesResponse> {
    return this.get<CommitteeVotesResponse>(`/v1/committee/votes?limit=${limit}`);
  }

  /** Get votes submitted by a specific agent. GET /v1/committee/agents/:address/votes */
  async getVotesByAgent(agentAddress: string): Promise<CommitteeVotesResponse> {
    return this.get<CommitteeVotesResponse>(`/v1/committee/agents/${agentAddress}/votes`);
  }

  /**
   * Get the committee votes submitted by a specific wallet address.
   * Account-scope endpoint: GET /v1/accounts/:address/committee-votes
   */
  async getAccountCommitteeVotes(address: string): Promise<AccountCommitteeVotesResponse> {
    return this.get<AccountCommitteeVotesResponse>(`/v1/accounts/${address}/committee-votes`);
  }

  /**
   * Get the latest regime feed entries.
   * GET /v1/regime/feed?limit=N
   */
  async getRegimeFeed(limit = 7): Promise<RegimeFeedResponse> {
    return this.get<RegimeFeedResponse>(`/v1/regime/feed?limit=${limit}`);
  }
}
