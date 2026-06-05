/**
 * VaultList — RTL unit tests for Portfolio Explorer > Registered Vaults.
 *
 * Covers acceptance criteria for issue #620:
 *   - Each row has an expand affordance (data-testid='vault-list-row-assets-toggle')
 *   - Clicking it reveals the asset panel (data-testid='vault-list-row-assets-panel')
 *   - STABLE_YIELD vault shows static 'USDC' entry
 *   - Inactive SPECULATIVE (RWA) vault shows static 'deSPXA' entry
 *   - VOLATILE basket vault shows shortlist panel (loading state in unit tests
 *     since the wagmi mock returns isLoading=true; live integration tests
 *     confirm real data).
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, within, fireEvent } from "./helpers/render";
import { VaultList } from "../../src/components/VaultList";
import { ExplorerProvider } from "../../src/lib/ExplorerContext";
import type { FetchLike, VaultsResponse, StatsResponse } from "../../src/lib/explorerApi";

// Wagmi mock — VaultListRowAssets calls useReadContract for basket vaults.
// We control the returned state here (isLoading: true) to test the loading
// path without a live RPC. The pure static-entry paths (USDC, deSPXA) are
// unaffected since they never call useReadContract.
vi.mock("wagmi", () => ({
  useReadContract: () => ({ data: undefined, isError: false, isLoading: true }),
  createConfig: () => ({}),
  http: () => ({}),
  fallback: (...args: unknown[]) => args[0],
  unstable_connector: () => ({}),
}));

function makeExplorerFetch(vaults: VaultsResponse, stats: StatsResponse | null = null): FetchLike {
  return vi.fn(async (url: string) => {
    const isStats = typeof url === "string" && url.includes("/v1/stats");
    const body = isStats
      ? (stats ?? {
          total_tvl: "0",
          unique_depositors: 0,
          activity_feed: [],
          block_number: 1,
          indexed_at: "",
        })
      : vaults;
    return { ok: true as const, status: 200, json: async () => body };
  }) as unknown as FetchLike;
}

// Four-vault fixture matching the four PRD §11 vaults.
const fourVaultFixture: VaultsResponse = {
  vaults: [
    {
      chain_id: 8453,
      address: "0x1111111111111111111111111111111111111111",
      name: "Robot Money USDC",
      risk_label: "STABLE_YIELD",
      status: 0,
      deposit_cap: "10000000000000",
      total_assets: "5000000000",
      exit_fee_bps: 10,
      indexed_at: "2026-01-01T12:00:00Z",
    },
    {
      chain_id: 8453,
      address: "0x2222222222222222222222222222222222222222",
      name: "Robot Money Protocol",
      risk_label: "VOLATILE",
      status: 0,
      deposit_cap: "10000000000000",
      total_assets: "2000000000",
      exit_fee_bps: 25,
      indexed_at: "2026-01-01T12:00:00Z",
    },
    {
      chain_id: 8453,
      address: "0x3333333333333333333333333333333333333333",
      name: "Robot Money Agent Tokens",
      risk_label: "SPECULATIVE",
      status: 0,
      deposit_cap: "10000000000000",
      total_assets: "1000000000",
      exit_fee_bps: 25,
      indexed_at: "2026-01-01T12:00:00Z",
    },
    {
      chain_id: 8453,
      address: "0x4444444444444444444444444444444444444444",
      name: "Robot Money RWA / Thematic",
      risk_label: "SPECULATIVE",
      status: 1, // non-Active (Paused)
      deposit_cap: "0",
      total_assets: null,
      exit_fee_bps: null,
      indexed_at: "2026-01-01T12:00:00Z",
    },
  ],
  block_number: 1000,
  indexed_at: "2026-01-01T12:00:00Z",
};

describe("VaultList — asset toggle affordance (issue #620)", () => {
  it("renders an asset toggle button for each vault row", async () => {
    const { findAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultList />
      </ExplorerProvider>,
    );
    const toggles = await findAllByTestId("vault-list-row-assets-toggle");
    expect(toggles).toHaveLength(4);
  });

  it("STABLE_YIELD vault: toggle reveals static USDC entry", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultList />
      </ExplorerProvider>,
    );
    const toggles = await findAllByTestId("vault-list-row-assets-toggle");
    // STABLE_YIELD is the first vault (index 0)
    const usdcToggle = toggles[0];

    // Panel is not visible before toggle
    expect(queryAllByTestId("vault-list-row-assets-panel")).toHaveLength(0);

    fireEvent.click(usdcToggle);

    await waitFor(() => {
      const panels = queryAllByTestId("vault-list-row-assets-panel");
      expect(panels).toHaveLength(1);
      expect(within(panels[0]).getByTestId("vault-list-asset-address").textContent).toBe("USDC");
    });
  });

  it("inactive SPECULATIVE (RWA) vault: toggle reveals static deSPXA entry", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultList />
      </ExplorerProvider>,
    );
    const toggles = await findAllByTestId("vault-list-row-assets-toggle");
    // RWA vault is the last vault (index 3, status=1 = non-Active SPECULATIVE)
    const rwaToggle = toggles[3];

    fireEvent.click(rwaToggle);

    await waitFor(() => {
      const panels = queryAllByTestId("vault-list-row-assets-panel");
      expect(panels).toHaveLength(1);
      expect(within(panels[0]).getByTestId("vault-list-asset-address").textContent).toBe("deSPXA");
    });
  });

  it("VOLATILE basket vault: toggle reveals loading state (basket shortlist call in flight)", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultList />
      </ExplorerProvider>,
    );
    const toggles = await findAllByTestId("vault-list-row-assets-toggle");
    // VOLATILE vault is at index 1
    const volatileToggle = toggles[1];

    fireEvent.click(volatileToggle);

    await waitFor(() => {
      const panels = queryAllByTestId("vault-list-row-assets-panel");
      expect(panels).toHaveLength(1);
      // wagmi mock returns isLoading:true, so the basket panel shows Loading…
      expect(within(panels[0]).getByTestId("vault-list-assets-loading")).toBeTruthy();
    });
  });

  it("active SPECULATIVE basket vault: toggle reveals loading state (basket shortlist call in flight)", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultList />
      </ExplorerProvider>,
    );
    const toggles = await findAllByTestId("vault-list-row-assets-toggle");
    // Active SPECULATIVE is at index 2 (status=0, SPECULATIVE → basket)
    const agentTokenToggle = toggles[2];

    fireEvent.click(agentTokenToggle);

    await waitFor(() => {
      const panels = queryAllByTestId("vault-list-row-assets-panel");
      expect(panels).toHaveLength(1);
      expect(within(panels[0]).getByTestId("vault-list-assets-loading")).toBeTruthy();
    });
  });

  it("only one panel open at a time per click; second click closes it", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultList />
      </ExplorerProvider>,
    );
    const toggles = await findAllByTestId("vault-list-row-assets-toggle");
    const usdcToggle = toggles[0];

    fireEvent.click(usdcToggle);
    await waitFor(() => expect(queryAllByTestId("vault-list-row-assets-panel")).toHaveLength(1));

    fireEvent.click(usdcToggle);
    await waitFor(() => expect(queryAllByTestId("vault-list-row-assets-panel")).toHaveLength(0));
  });
});
