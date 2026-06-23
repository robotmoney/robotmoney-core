// Canonical: docs/architecture.md §5.3 — Human Dapp

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

/**
 * Raw position object as the explorer-api actually serialises it
 * (clients/explorer-api/src/model.rs `VaultPosition`): the vault address
 * field is `vault`, not `vault_addr`, and there is no `vault_name`. We accept
 * the legacy `vault_addr`/`vault_name` keys too so a future API shape change
 * (or a fixture using the old names) keeps working.
 *
 * Issue #1038 root cause: `fetchPositions` previously cast the API body
 * straight to `PositionsResponse`, leaving `p.vault_addr` undefined for every
 * row. The first non-zero position then crashed `PositionSelector`'s render
 * map at `p.vault_addr.toLowerCase()`. This shape-mapping is the fix.
 */
interface RawVaultPosition {
  vault?: unknown;
  vault_addr?: unknown;
  vault_name?: unknown;
  shares?: unknown;
}

/**
 * Normalise one raw API position into a `VaultPosition`. Returns `null` when
 * the row has no usable vault address or share string so callers never see a
 * position with an `undefined` address (which would crash any `.toLowerCase()`
 * keyed render).
 */
function normalisePosition(raw: RawVaultPosition): VaultPosition | null {
  const addr = typeof raw.vault === "string" ? raw.vault : raw.vault_addr;
  if (typeof addr !== "string" || addr.length === 0) return null;
  if (typeof raw.shares !== "string") return null;
  return {
    vault_addr: addr,
    vault_name: typeof raw.vault_name === "string" ? raw.vault_name : undefined,
    shares: raw.shares,
  };
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
  const body = (await res.json()) as { positions?: readonly RawVaultPosition[] };
  const rawPositions = Array.isArray(body.positions) ? body.positions : [];
  // Map the API's `vault` field onto the dapp's `vault_addr` shape and drop any
  // row without a usable address — see normalisePosition (issue #1038).
  const positions = rawPositions
    .map(normalisePosition)
    .filter((p): p is VaultPosition => p !== null);
  return { positions };
}
