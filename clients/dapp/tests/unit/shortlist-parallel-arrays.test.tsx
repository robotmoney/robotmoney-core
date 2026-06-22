/**
 * Tests — basket shortlist() parallel-array decode (issue #992, scan finding
 * DAPP-5).
 *
 * The on-chain AgentTokenVault.shortlist() (via BasketViews.sol) returns FIVE
 * parallel arrays — (address[] tokens, address[] pools, uint24[] fees,
 * bool[] active, uint256[] balances) — not an array of structs. The dapp ABI
 * previously declared a tuple[] of structs, so viem decoded garbage / threw on
 * shortAddr(undefined) and the composition view broke for every basket vault.
 *
 * These tests cover:
 *   - decodeShortlist zips the five arrays by index into ShortlistEntry rows.
 *   - VaultDetail renders one composition row per asset with correct
 *     token/active/balance from a five-parallel-array result and does not throw.
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "./helpers/render";
import { decodeShortlist, type ShortlistResult } from "../../src/lib/abi";
import { VaultDetail } from "../../src/components/VaultDetail";
import type { FetchLike, VaultDetailResponse } from "../../src/lib/explorerApi";

const TOKEN_A = "0xaa11111111111111111111111111111111111111" as `0x${string}`;
const TOKEN_B = "0xbb22222222222222222222222222222222222222" as `0x${string}`;
const POOL_A = "0xcc33333333333333333333333333333333333333" as `0x${string}`;
const POOL_B = "0xdd44444444444444444444444444444444444444" as `0x${string}`;
const VAULT_ADDR = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0";

// Five-parallel-array result as viem decodes a multi-return: a positional
// tuple of arrays.
const SHORTLIST: ShortlistResult = [
  [TOKEN_A, TOKEN_B],
  [POOL_A, POOL_B],
  [500, 3000],
  [true, false],
  [1_000_000n, 2_500_000n],
];

// ─── decodeShortlist (pure) ───────────────────────────────────────────────────

describe("decodeShortlist — five parallel arrays zipped by index", () => {
  it("maps each token to its active flag and vault balance by index", () => {
    const entries = decodeShortlist(SHORTLIST);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ token: TOKEN_A, active: true, vaultBalance: 1_000_000n });
    expect(entries[1]).toEqual({ token: TOKEN_B, active: false, vaultBalance: 2_500_000n });
  });

  it("returns an empty array for non-array / empty input (no throw)", () => {
    expect(decodeShortlist(undefined)).toEqual([]);
    expect(decodeShortlist(null)).toEqual([]);
    expect(decodeShortlist([[], [], [], [], []])).toEqual([]);
  });

  it("does not throw and defaults safely when parallel arrays are short", () => {
    const short = [[TOKEN_A, TOKEN_B], [], [], [true], []] as unknown;
    const entries = decodeShortlist(short);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ token: TOKEN_A, active: true, vaultBalance: 0n });
    expect(entries[1]).toEqual({ token: TOKEN_B, active: false, vaultBalance: 0n });
  });
});

// ─── VaultDetail composition rows from a parallel-array result ─────────────────

vi.mock("wagmi", () => ({
  useReadContract: (opts: { functionName?: string }) => {
    if (opts.functionName === "shortlist") {
      return { data: SHORTLIST, isError: false, isLoading: false };
    }
    return { data: undefined, isError: false, isLoading: false };
  },
  createConfig: () => ({}),
  http: () => ({}),
  fallback: (...args: unknown[]) => args[0],
  unstable_connector: () => ({}),
}));

function makeFetch(body: unknown): FetchLike {
  return vi.fn(async () => ({
    ok: true as const,
    status: 200,
    json: async () => body,
  })) as unknown as FetchLike;
}

function fixture(): VaultDetailResponse {
  return {
    vault: {
      chain_id: 8453,
      address: VAULT_ADDR,
      name: "Agent Tokens",
      risk_label: "VOLATILE",
      status: 0,
      deposit_cap: "1000000000",
      tvl_history: [],
      indexed_at: "2026-01-01T12:00:00Z",
    },
    block_number: 1000,
    indexed_at: "2026-01-01T12:00:00Z",
  };
}

describe("VaultDetail — composition decodes shortlist() parallel arrays (DAPP-5)", () => {
  it("renders one composition row per asset with token/active/balance and does not throw", async () => {
    const { getByTestId, getAllByTestId, queryByTestId } = render(
      <VaultDetail apiUrl="http://api" address={VAULT_ADDR} fetchImpl={makeFetch(fixture())} />,
    );
    await waitFor(() => expect(getByTestId("vault-detail-composition")).toBeTruthy());

    // No error/loading fallback — the five-array result decodes cleanly.
    expect(queryByTestId("vault-detail-composition-error")).toBeNull();
    expect(queryByTestId("vault-detail-composition-loading")).toBeNull();

    const rows = getAllByTestId("vault-detail-composition-entry");
    expect(rows).toHaveLength(2);

    const addrs = getAllByTestId("vault-detail-composition-address").map((n) => n.textContent);
    // shortAddr renders 0x...<last 6 chars, uppercased>.
    expect(addrs[0]).toContain(TOKEN_A.slice(-6).toUpperCase());
    expect(addrs[1]).toContain(TOKEN_B.slice(-6).toUpperCase());

    const actives = getAllByTestId("vault-detail-composition-active").map((n) => n.textContent);
    expect(actives[0]).toBe("active");
    expect(actives[1]).toBe("inactive");

    const balances = getAllByTestId("vault-detail-composition-balance").map((n) => n.textContent);
    expect(balances.length).toBe(2);
  });
});
