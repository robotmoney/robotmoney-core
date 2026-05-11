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
