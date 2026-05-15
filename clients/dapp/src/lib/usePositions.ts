/**
 * React hook — fetches the connected user's vault positions from
 * GET /v1/accounts/:address/positions (issue #321).
 *
 * The shape mirrors the explorer-api route that lists per-vault receipt
 * token balances. Only vaults with a non-zero balance are relevant for
 * the PositionSelector; the hook returns the full array so the component
 * can decide what to display.
 *
 * This is a thin fetch wrapper kept outside the component so it is
 * unit-testable without rendering DOM.
 */
import type { Address } from "viem";

export interface VaultPosition {
  /** The ERC-4626 vault contract address. */
  vault_addr: string;
  /** Human-readable vault name, if the API provides one. */
  vault_name?: string;
  /** Receipt-token (rmUSDC) balance as a decimal string (6 dp). */
  shares: string;
}

export interface PositionsResponse {
  readonly positions: readonly VaultPosition[];
}

/** Minimum fetch interface to allow test-injection without globals. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Fetch /v1/accounts/:address/positions. Returns only positions whose
 * shares balance is non-zero. On any non-2xx response, throws an Error
 * with the HTTP status in the message.
 */
export async function fetchPositions(
  baseUrl: string,
  account: Address,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<PositionsResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/accounts/${account}/positions`;
  const res = await fetchImpl(url, { signal: options.signal });
  if (!res.ok) {
    throw new Error(`positions API ${res.status}`);
  }
  const body = (await res.json()) as PositionsResponse;
  return body;
}
