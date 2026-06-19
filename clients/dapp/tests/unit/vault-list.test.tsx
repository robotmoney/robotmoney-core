/**
 * VaultList — RTL unit tests for Portfolio Explorer > Registered Vaults.
 *
 * VaultListRowAssets was retired in issue #941 (composition moved to
 * VaultDetail). This test verifies that the VaultList table renders correctly
 * without an Assets toggle column, and that row click navigation still works.
 */
import { describe, it, expect, vi } from "vitest";
import { render, within, fireEvent } from "./helpers/render";
import { VaultList } from "../../src/components/VaultList";
import { ExplorerProvider } from "../../src/lib/ExplorerContext";
import type { FetchLike, VaultsResponse, StatsResponse } from "../../src/lib/explorerApi";

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

describe("VaultList — table rendering", () => {
  it("renders one row per vault", async () => {
    const { findAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultList />
      </ExplorerProvider>,
    );
    const rows = await findAllByTestId("vault-list-row-name");
    expect(rows).toHaveLength(4);
  });

  it("renders vault names, risk labels, and statuses in rows", async () => {
    const { findAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultList />
      </ExplorerProvider>,
    );
    const nameEls = await findAllByTestId("vault-list-row-name");
    const riskEls = await findAllByTestId("vault-list-row-risk");
    const statusEls = await findAllByTestId("vault-list-row-status");

    expect(nameEls[0].textContent).toBe("Robot Money USDC");
    expect(riskEls[0].textContent).toBe("STABLE_YIELD");
    expect(statusEls[0].textContent).toBe("Active");
    expect(statusEls[3].textContent).toBe("Paused");
  });

  it("no Assets toggle button is present (VaultListRowAssets retired in #941)", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultList />
      </ExplorerProvider>,
    );
    // Wait for rows to render
    await findAllByTestId("vault-list-row-name");
    expect(queryAllByTestId("vault-list-row-assets-toggle")).toHaveLength(0);
  });
});

describe("VaultList — row click navigation", () => {
  it("clicking a row calls onSelectVault with the vault address", async () => {
    const onSelectVault = vi.fn();
    const { findByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultList onSelectVault={onSelectVault} />
      </ExplorerProvider>,
    );

    const table = await findByTestId("vault-list-table");
    const rows = within(table).getAllByRole("row");
    // rows[0] is the header; rows[1] is the first data row (USDC vault)
    fireEvent.click(rows[1]);

    expect(onSelectVault).toHaveBeenCalledWith("0x1111111111111111111111111111111111111111");
  });

  it("clicking the RWA row calls onSelectVault with its address", async () => {
    const onSelectVault = vi.fn();
    const { findByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultList onSelectVault={onSelectVault} />
      </ExplorerProvider>,
    );

    const table = await findByTestId("vault-list-table");
    const rows = within(table).getAllByRole("row");
    // rows[4] is the RWA vault (index 3 in data, +1 for header)
    fireEvent.click(rows[4]);

    expect(onSelectVault).toHaveBeenCalledWith("0x4444444444444444444444444444444444444444");
  });
});
