/**
 * Thin client wrapper around the phase-5 explorer API
 * (`clients/explorer-api/src/routes.rs`). The dapp calls this only from
 * the optional history pane (issue #88, gated by `featureFlags.historyPane`);
 * live chain state still goes through RPC per implementation-plan.md §12.
 *
 * Wire shape mirrors `crate::model::DepositsResponse`. Address arguments
 * are not validated here — the caller (the history pane) renders the API
 * error response to the user verbatim, so a 400 from the server is a
 * UI-visible signal rather than a thrown exception.
 */
import type { Address } from "viem";

export interface DepositRow {
  readonly chain_id: number;
  readonly block_number: number;
  readonly log_index: number;
  readonly tx_hash: string;
  readonly payment_id: string;
  readonly agent: string;
  readonly share_receiver: string;
  readonly amount: string;
  readonly indexed_at: string;
}

interface Freshness {
  readonly block_number: number;
  readonly indexed_at: string;
}

export interface DepositsResponse {
  readonly deposits: readonly DepositRow[];
  readonly freshness: Freshness;
}

/**
 * Default base URL — matches the dev-time port used by
 * `clients/explorer-api/src/main.rs`. Production builds set
 * `VITE_EXPLORER_API_URL` per deployment.
 */
const DEFAULT_EXPLORER_API_URL = "http://localhost:8080";

export function resolveExplorerApiUrl(env: Record<string, string | undefined> = {}): string {
  const raw = env.VITE_EXPLORER_API_URL;
  if (raw && raw.length > 0) return raw.replace(/\/+$/, "");
  return DEFAULT_EXPLORER_API_URL;
}

/**
 * Minimum subset of `fetch` we depend on. Declaring it lets unit tests
 * inject a mock without touching the global `fetch`.
 */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * GET `/v1/agents/:address/deposits`. Returns the parsed
 * `DepositsResponse` on 2xx; throws an `Error` whose message includes
 * the HTTP status on any non-2xx response. The caller is expected to
 * surface the error message to the operator, not retry silently.
 */
export async function fetchAgentDeposits(
  baseUrl: string,
  agent: Address,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<DepositsResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/agents/${agent}/deposits`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) {
    throw new Error(`explorer API ${res.status}`);
  }
  const body = (await res.json()) as DepositsResponse;
  return body;
}

// ─── Vault registry types (issue #318) ─────────────────────────────────────

export interface VaultRow {
  readonly chain_id: number;
  readonly address: string;
  readonly name: string;
  readonly risk_label: string;
  /** 0 = Active, 1 = Paused, 2 = Retired */
  readonly status: number;
  readonly deposit_cap: string;
  readonly total_assets: string | null;
  readonly exit_fee_bps: number | null;
  readonly indexed_at: string;
}

export interface VaultsResponse {
  readonly vaults: readonly VaultRow[];
  readonly block_number: number;
  readonly indexed_at: string;
}

export interface VaultTvlPoint {
  readonly block_number: number;
  readonly total_assets: string;
  readonly total_supply: string;
  readonly indexed_at: string;
}

export interface VaultDetailRow {
  readonly chain_id: number;
  readonly address: string;
  readonly name: string;
  readonly risk_label: string;
  readonly status: number;
  readonly deposit_cap: string;
  readonly tvl_history: readonly VaultTvlPoint[];
  readonly indexed_at: string;
}

export interface VaultDetailResponse {
  readonly vault: VaultDetailRow;
  readonly block_number: number;
  readonly indexed_at: string;
}

// ─── Account layer types (issue #319) ───────────────────────────────────────

/**
 * Per-vault receipt-token balance entry from
 * `GET /v1/accounts/:address/positions`.
 */
export interface AccountPosition {
  readonly vault_address: string;
  readonly vault_name: string;
  readonly risk_label: string;
  /** Raw share balance as a decimal string (NUMERIC(78,0)). */
  readonly shares: string;
  readonly block_number: number;
}

export interface AccountPositionsResponse {
  readonly address: string;
  readonly positions: readonly AccountPosition[];
  readonly block_number: number;
  readonly indexed_at: string;
}

// ─── Router / governance types (issue #318) ─────────────────────────────────

export interface VaultWeight {
  readonly vault: string;
  readonly bps: number;
}

export interface WeightHistoryEntry {
  readonly block_number: number;
  readonly tx_hash: string;
  readonly weights: readonly VaultWeight[];
  readonly indexed_at: string;
}

export interface RouterWeightsResponse {
  readonly current_weights: readonly VaultWeight[];
  readonly history: readonly WeightHistoryEntry[];
  readonly block_number: number;
  readonly indexed_at: string;
}

/**
 * A single event in a watched address's history from
 * `GET /v1/accounts/:address/history`.
 */
export interface AccountEvent {
  /** "deposit" | "withdrawal" | "governance_vote" */
  readonly event_type: string;
  readonly block_number: number;
  readonly tx_hash: string;
  readonly vault_address: string | null;
  readonly amount: string | null;
  readonly indexed_at: string;
}

export interface AccountHistoryResponse {
  readonly address: string;
  readonly events: readonly AccountEvent[];
  readonly block_number: number;
  readonly indexed_at: string;
}

export interface ProposalSummary {
  readonly chain_id: number;
  readonly proposal_id: number;
  readonly proposer: string;
  readonly description: string;
  readonly created_at: number;
  readonly deadline_block: number;
  readonly status: string;
  readonly votes_for: number;
  readonly votes_against: number;
  readonly block_number: number;
  readonly indexed_at: string;
}

export interface ProposalsResponse {
  readonly proposals: readonly ProposalSummary[];
  readonly block_number: number;
  readonly indexed_at: string;
}

// ─── Protocol stats types (issue #318) ──────────────────────────────────────

/** One entry in the GET /v1/stats activity feed — always a deposit event. */
export interface ActivityEvent {
  readonly chain_id: number;
  readonly block_number: number;
  readonly log_index: number;
  readonly tx_hash: string;
  readonly vault: string;
  readonly agent: string;
  readonly share_receiver: string;
  readonly amount: string;
  readonly indexed_at: string;
}

export interface StatsResponse {
  readonly total_tvl: string;
  readonly unique_depositors: number;
  readonly activity_feed: readonly ActivityEvent[];
  readonly block_number: number;
  readonly indexed_at: string;
}

// ─── Fetch helpers (issue #318) ─────────────────────────────────────────────

/** GET /v1/vaults — list all registered vaults (no wallet required). */
export async function fetchVaults(
  baseUrl: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<VaultsResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/vaults`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) throw new Error(`explorer API ${res.status}`);
  return (await res.json()) as VaultsResponse;
}

/** GET /v1/vaults/:address — single vault detail with TVL history. */
export async function fetchVaultDetail(
  baseUrl: string,
  address: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<VaultDetailResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/vaults/${address}`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) throw new Error(`explorer API ${res.status}`);
  return (await res.json()) as VaultDetailResponse;
}

/** GET /v1/router/weights — current weight vector and history. */
export async function fetchRouterWeights(
  baseUrl: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<RouterWeightsResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/router/weights`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) throw new Error(`explorer API ${res.status}`);
  return (await res.json()) as RouterWeightsResponse;
}

/** GET /v1/governance/proposals — list governance proposals. */
export async function fetchProposals(
  baseUrl: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<ProposalsResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/governance/proposals`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) throw new Error(`explorer API ${res.status}`);
  return (await res.json()) as ProposalsResponse;
}

/** GET /v1/stats — aggregate protocol statistics. */
export async function fetchStats(
  baseUrl: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<StatsResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/stats`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) throw new Error(`explorer API ${res.status}`);
  return (await res.json()) as StatsResponse;
}

// ─── Fetch helpers (issue #319) ─────────────────────────────────────────────

/**
 * GET `/v1/accounts/:address/positions` — receipt-token balances per vault
 * for a watched address. Returns an empty `positions` array when the address
 * has no indexed positions.
 */
export async function fetchAccountPositions(
  baseUrl: string,
  address: Address,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<AccountPositionsResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/accounts/${address}/positions`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) {
    throw new Error(`explorer API ${res.status}`);
  }
  return (await res.json()) as AccountPositionsResponse;
}

/**
 * GET `/v1/accounts/:address/history` — paginated chronological event log
 * across all vaults for a watched address.
 */
export async function fetchAccountHistory(
  baseUrl: string,
  address: Address,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<AccountHistoryResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/accounts/${address}/history`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) {
    throw new Error(`explorer API ${res.status}`);
  }
  return (await res.json()) as AccountHistoryResponse;
}
