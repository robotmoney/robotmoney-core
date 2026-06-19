/**
 * VaultDetail — composition section tests (issue #941).
 *
 * Verifies that VaultDetail renders the data-testid='vault-detail-composition'
 * section below the stat grid with behaviour appropriate to vault type:
 *
 *   - VOLATILE vault: BasketShortlistPanel is rendered (loading state in unit
 *     tests since wagmi useReadContract cannot reach a live RPC).
 *   - STABLE_YIELD vault: static label "Deposit: USDC → Receipt: rmUSDC".
 *   - Inactive SPECULATIVE (RWA placeholder): static label with deSPXA.
 *   - Loading state: composition section is absent (vault-detail shows loading).
 *
 * The wagmi mock is scoped here to isolate these tests from the real RPC
 * (useReadContract returns isLoading:true). render.tsx uses vi.importActual to
 * provide a real WagmiProvider, so the mock only affects useReadContract calls
 * in the VaultDetail component source — same pattern as vault-cards.test.tsx.
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "./helpers/render";
import { VaultDetail } from "../../src/components/VaultDetail";
import type { FetchLike, VaultDetailResponse } from "../../src/lib/explorerApi";

// Wagmi mock — useReadContract for basket vaults returns isLoading:true so
// composition tests assert on the loading state without a live RPC.
vi.mock("wagmi", () => ({
  useReadContract: () => ({ data: undefined, isError: false, isLoading: true }),
  createConfig: () => ({}),
  http: () => ({}),
  fallback: (...args: unknown[]) => args[0],
  unstable_connector: () => ({}),
}));

const VAULT_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return vi.fn(async () => ({
    ok: ok as true,
    status,
    json: async () => body,
  })) as unknown as FetchLike;
}

function makeVaultDetailFixture(overrides: {
  risk_label: string;
  status?: number;
  name?: string;
}): VaultDetailResponse {
  return {
    vault: {
      chain_id: 8453,
      address: VAULT_ADDR,
      name: overrides.name ?? "Test Vault",
      risk_label: overrides.risk_label,
      status: overrides.status ?? 0,
      deposit_cap: "1000000000",
      tvl_history: [],
      indexed_at: "2026-01-01T12:00:00Z",
    },
    block_number: 1000,
    indexed_at: "2026-01-01T12:00:00Z",
  };
}

describe("VaultDetail — composition section (issue #941)", () => {
  it("VOLATILE vault renders vault-detail-composition section", async () => {
    const { getByTestId } = render(
      <VaultDetail
        apiUrl="http://api"
        address={VAULT_ADDR}
        fetchImpl={makeFetch(makeVaultDetailFixture({ risk_label: "VOLATILE" }))}
      />,
    );
    await waitFor(() => expect(getByTestId("vault-detail-name")).toBeTruthy());
    expect(getByTestId("vault-detail-composition")).toBeTruthy();
  });

  it("VOLATILE vault composition section shows basket shortlist loading state", async () => {
    const { getByTestId } = render(
      <VaultDetail
        apiUrl="http://api"
        address={VAULT_ADDR}
        fetchImpl={makeFetch(makeVaultDetailFixture({ risk_label: "VOLATILE" }))}
      />,
    );
    await waitFor(() => expect(getByTestId("vault-detail-composition")).toBeTruthy());
    // wagmi mock returns isLoading:true — basket panel shows Loading…
    expect(getByTestId("vault-detail-composition-loading")).toBeTruthy();
  });

  it("STABLE_YIELD vault renders static composition label (not shortlist loading state)", async () => {
    const { getByTestId, queryByTestId } = render(
      <VaultDetail
        apiUrl="http://api"
        address={VAULT_ADDR}
        fetchImpl={makeFetch(makeVaultDetailFixture({ risk_label: "STABLE_YIELD" }))}
      />,
    );
    await waitFor(() => expect(getByTestId("vault-detail-composition")).toBeTruthy());

    const label = getByTestId("vault-detail-composition-label");
    expect(label.textContent).toContain("USDC");
    expect(label.textContent).toContain("rmUSDC");

    // No loading indicator for STABLE_YIELD — it uses a static label
    expect(queryByTestId("vault-detail-composition-loading")).toBeNull();
  });

  it("inactive SPECULATIVE vault renders static deSPXA composition label", async () => {
    const { getByTestId, queryByTestId } = render(
      <VaultDetail
        apiUrl="http://api"
        address={VAULT_ADDR}
        fetchImpl={makeFetch(
          makeVaultDetailFixture({ risk_label: "SPECULATIVE", status: 1, name: "RWA Vault" }),
        )}
      />,
    );
    await waitFor(() => expect(getByTestId("vault-detail-composition")).toBeTruthy());

    const label = getByTestId("vault-detail-composition-label");
    expect(label.textContent).toContain("deSPXA");

    // No loading indicator for inactive SPECULATIVE — it uses a static label
    expect(queryByTestId("vault-detail-composition-loading")).toBeNull();
  });

  it("active SPECULATIVE vault composition section shows basket shortlist loading state", async () => {
    const { getByTestId } = render(
      <VaultDetail
        apiUrl="http://api"
        address={VAULT_ADDR}
        fetchImpl={makeFetch(
          makeVaultDetailFixture({ risk_label: "SPECULATIVE", status: 0, name: "Agent Tokens" }),
        )}
      />,
    );
    await waitFor(() => expect(getByTestId("vault-detail-composition")).toBeTruthy());
    // Active SPECULATIVE is a basket vault → loading state
    expect(getByTestId("vault-detail-composition-loading")).toBeTruthy();
  });

  it("composition section does not crash when vault data is in loading state", async () => {
    // Use a never-resolving fetch to keep the component in loading phase.
    const neverFetch: FetchLike = vi.fn(
      () => new Promise<never>(() => undefined),
    ) as unknown as FetchLike;

    const { getByTestId, queryByTestId } = render(
      <VaultDetail apiUrl="http://api" address={VAULT_ADDR} fetchImpl={neverFetch} />,
    );

    // Component stays in loading state — no crash, no composition section yet
    await waitFor(() => expect(getByTestId("vault-detail-loading")).toBeTruthy());
    expect(queryByTestId("vault-detail-composition")).toBeNull();
  });
});
