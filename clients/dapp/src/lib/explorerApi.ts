// Canonical: docs/architecture.md §5.4 — Explorer Indexer and API

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
  /** 0 = Active, 1 = DepositsPaused (deposits stopped; withdrawals stay open), 2 = Retired */
  readonly status: number;
  /**
   * `tvlCap()` as of the vault's latest snapshot, raw USDC; null/absent when the indexer could not read it.
   * Unknown is not 0 (issue 1741). Older explorers sent a registry `deposit_cap` that was always 0: it is gone.
   */
  readonly tvl_cap?: string | null;
  /** `perDepositCap()` as of the latest snapshot; null/absent when unknown. */
  readonly per_deposit_cap?: string | null;
  /** `max(tvl_cap - total_assets, 0)` computed by the explorer; null/absent when either side is unknown. */
  readonly headroom?: string | null;
  /** Block of the snapshot the TVL, caps and pause flag come from. NOT the index block. */
  readonly snapshot_block?: number | null;
  readonly total_assets: string | null;
  readonly exit_fee_bps: number | null;
  /**
   * The vault's own `depositsPaused()` as of the indexer's latest snapshot; null when it has none. The registry
   * `status` above does not follow `pauseDeposits()`, so a vault can be status 0 with this true (issue 1731).
   * Optional so an older explorer that does not send it reads as "unknown", never as "open".
   */
  readonly deposits_paused?: boolean | null;
  readonly indexed_at: string;
}

export interface VaultsResponse {
  readonly vaults: readonly VaultRow[];
  /** The last block the indexer committed; 0 when it has indexed nothing yet. */
  readonly block_number: number;
  /** The chain head the indexer last saw; null/absent until a tick has read it (issue 1731). */
  readonly chain_head_block?: number | null;
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
  /** `tvlCap()` at the latest snapshot; null/absent when unknown (issue 1741). */
  readonly tvl_cap?: string | null;
  /** `perDepositCap()` at the latest snapshot; null/absent when unknown. */
  readonly per_deposit_cap?: string | null;
  /** `max(tvl_cap - total_assets, 0)`; null/absent when either side is unknown. */
  readonly headroom?: string | null;
  /** Block of the latest vault snapshot; null/absent when there is none. NOT the index block. */
  readonly snapshot_block?: number | null;
  /** The vault's `depositsPaused()` at its latest snapshot; null/absent when unknown (issue 1731). */
  readonly deposits_paused?: boolean | null;
  readonly tvl_history: readonly VaultTvlPoint[];
  readonly indexed_at: string;
}

export interface VaultDetailResponse {
  readonly vault: VaultDetailRow;
  /** The index block: the last block the indexer committed (issue 1741). Not the snapshot block. */
  readonly block_number: number;
  /** The chain head the indexer last saw; null/absent until a tick has read it. */
  readonly chain_head_block?: number | null;
  readonly indexed_at: string;
}

// ─── Account layer types (issue #319) ───────────────────────────────────────

/**
 * Per-vault receipt-token balance entry from
 * `GET /v1/accounts/:address/positions`, in the dapp's shape.
 *
 * The API serialises the vault address as `vault` and sends no name or risk label
 * (clients/explorer-api/src/model.rs `VaultPosition`); `fetchAccountPositions` maps it here,
 * the same fix as `usePositions.ts` (issue #1038). A row without a name shows its address.
 */
export interface AccountPosition {
  readonly vault_address: string;
  readonly vault_name: string;
  readonly risk_label: string;
  /** Raw share balance as a decimal string (NUMERIC(78,0)). */
  readonly shares: string;
  readonly block_number: number;
  /**
   * USDC a redeem of `shares` pays at the explorer's latest snapshot (`previewRedeem` semantics,
   * net of exit costs; core 1795), raw 6-decimal integer string. `null` or absent: unknown.
   */
  readonly usdc_value?: string | null;
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
 * The kinds of event in the per-account history feed, as the API serializes
 * `EventKind` (clients/explorer-api/src/model.rs). There is no governance-vote
 * kind: issue 1698 deleted RouterGovernance voting and its indexed rows.
 */
export type AccountEventKind = "deposit" | "withdrawal" | "fee_charged" | "policy_change";

/**
 * A single event in a watched address's history from
 * `GET /v1/accounts/:address/history`. The field names are the API's
 * `AccountHistoryEntry` (clients/explorer-api/src/model.rs).
 */
export interface AccountEvent {
  readonly kind: AccountEventKind;
  readonly chain_id: number;
  readonly block_number: number;
  readonly log_index: number;
  readonly tx_hash: string;
  /** Vault for deposit, withdrawal and fee_charged events; null for policy_change. */
  readonly vault: string | null;
  /** Agent for deposit and policy_change events; null for withdrawal and fee_charged. */
  readonly agent: string | null;
  /** USDC base units for deposit, withdrawal and fee_charged; null for policy_change. */
  readonly amount: string | null;
  readonly indexed_at: string;
}

export interface AccountHistoryResponse {
  readonly address: string;
  readonly events: readonly AccountEvent[];
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
  /** The chain head the indexer last saw; null/absent until a tick has read it (issue 1731). */
  readonly chain_head_block?: number | null;
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

/**
 * One contract from GET /v1/chains/:chain_id/contracts. `implementation`,
 * `upgrade_state` and `frozen_at_block` come from the indexed proxy
 * `Upgraded` / `UpgradesFrozen` events (issue 1810). Disclosure only: the
 * index never authorizes a write.
 */
export interface ContractRow {
  readonly chain_id: number;
  readonly address: string;
  readonly kind: string;
  readonly implementation?: string | null;
  readonly upgrade_state?: "frozen" | "upgradeable" | "unknown";
  readonly frozen_at_block?: number | null;
}

export interface ContractsResponse {
  readonly chain_id: number;
  readonly contracts: readonly ContractRow[];
  readonly block_number: number;
  readonly indexed_at: string;
}

/** GET /v1/chains/:chain_id/contracts — the indexed contracts and their upgrade state. */
export async function fetchContracts(
  baseUrl: string,
  chainId: number,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<ContractsResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/chains/${chainId}/contracts`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) throw new Error(`explorer API ${res.status}`);
  return (await res.json()) as ContractsResponse;
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
  const body = (await res.json()) as Omit<AccountPositionsResponse, "positions"> & {
    positions?: readonly RawAccountPosition[];
  };
  const raw = Array.isArray(body.positions) ? body.positions : [];
  return {
    ...body,
    positions: raw.map(normaliseAccountPosition).filter((p): p is AccountPosition => p !== null),
  };
}

/** A position row as the API sends it (`vault`), or in the dapp's own shape (`vault_address`). */
interface RawAccountPosition {
  readonly vault?: unknown;
  readonly vault_address?: unknown;
  readonly vault_name?: unknown;
  readonly risk_label?: unknown;
  readonly shares?: unknown;
  readonly block_number?: unknown;
  readonly usdc_value?: unknown;
}

/**
 * Map one API row onto `AccountPosition`. The API's `vault` key wins; `vault_address` is accepted
 * so fixtures in the dapp shape keep working. A row with no address or share string is dropped, so
 * no render calls `.toLowerCase()` on `undefined` (the #1038 crash, here in PortfolioPosition).
 */
function normaliseAccountPosition(raw: RawAccountPosition): AccountPosition | null {
  const address = typeof raw.vault === "string" ? raw.vault : raw.vault_address;
  if (typeof address !== "string" || address.length === 0) return null;
  if (typeof raw.shares !== "string") return null;
  return {
    vault_address: address,
    vault_name: typeof raw.vault_name === "string" ? raw.vault_name : address,
    risk_label: typeof raw.risk_label === "string" ? raw.risk_label : "",
    shares: raw.shares,
    block_number: typeof raw.block_number === "number" ? raw.block_number : 0,
    usdc_value: typeof raw.usdc_value === "string" ? raw.usdc_value : null,
  };
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
