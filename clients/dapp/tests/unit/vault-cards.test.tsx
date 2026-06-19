/**
 * VaultCards — RTL unit tests for the landing-page vault tiles.
 *
 * Four-vault PRD conformance (issue #479): VaultCards renders one tile per
 * registered vault and renders any non-Active vault in its inactive
 * presentation (Future notice, no deposit/TVL stats). The inactive flag is
 * derived from each vault's on-chain `status` surfaced by the `/v1/vaults`
 * indexer read — not a hard-coded per-vault constant.
 *
 * VaultCards reads data from ExplorerContext (shared polling loop). Tests wrap
 * it in ExplorerProvider with a mocked fetchImpl that routes /v1/vaults and
 * /v1/stats separately — no network or wallet required.
 *
 * Details navigation tests (issue #941): each vault card has a 'Details'
 * button that fires onSelectVault with the vault address and onSwitchToExplorer
 * to navigate to the Portfolio Explorer tab.
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, within, fireEvent } from "./helpers/render";
import { VaultCards } from "../../src/components/VaultCards";
import { ExplorerProvider } from "../../src/lib/ExplorerContext";
import type { FetchLike, VaultsResponse, StatsResponse } from "../../src/lib/explorerApi";

/** URL-routing fetchImpl for ExplorerProvider: vaults → vaultsFixture, stats → statsFixture. */
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

// Four-vault demo set: three Active router vaults plus the non-Active
// RWA/Thematic placeholder (status 1 = Paused).
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
      status: 1, // non-Active (Paused) — the RWA/Thematic placeholder
      deposit_cap: "0",
      total_assets: null,
      exit_fee_bps: null,
      indexed_at: "2026-01-01T12:00:00Z",
    },
  ],
  block_number: 1000,
  indexed_at: "2026-01-01T12:00:00Z",
};

function makeVaultFixture(total_assets: string | null): VaultsResponse {
  return {
    vaults: [
      {
        chain_id: 8453,
        address: "0x1111111111111111111111111111111111111111",
        name: "Robot Money USDC",
        risk_label: "STABLE_YIELD",
        status: 0,
        deposit_cap: "10000000000000",
        total_assets,
        exit_fee_bps: 10,
        indexed_at: "2026-01-01T12:00:00Z",
      },
    ],
    block_number: 100,
    indexed_at: "2026-01-01T12:00:00Z",
  };
}

describe("VaultCards — four-vault layout (issue #479)", () => {
  it("renders one tile per registered vault", async () => {
    const { findAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    const cards = await findAllByTestId("landing-vault-card");
    expect(cards).toHaveLength(4);
  });

  it("renders the non-Active RWA tile in its inactive presentation, sourced from status", async () => {
    const { findAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    const cards = await findAllByTestId("landing-vault-card");

    const inactive = cards.filter((c) => c.getAttribute("data-vault-active") === "false");
    const active = cards.filter((c) => c.getAttribute("data-vault-active") === "true");
    expect(active).toHaveLength(3);
    expect(inactive).toHaveLength(1);

    // The inactive tile is the RWA placeholder and shows the Future notice
    // with no deposit/TVL affordance.
    const rwa = inactive[0];
    expect(within(rwa).getByTestId("landing-vault-card-name").textContent).toContain(
      "RWA / Thematic",
    );
    expect(within(rwa).getByTestId("landing-vault-card-future")).toBeTruthy();
    expect(within(rwa).queryByTestId("landing-vault-card-tvl")).toBeNull();
    expect(within(rwa).queryByTestId("landing-vault-card-status")).toBeNull();
  });

  it("keeps Active tiles showing their live status and TVL stats", async () => {
    const { findAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    const cards = await findAllByTestId("landing-vault-card");
    const active = cards.filter((c) => c.getAttribute("data-vault-active") === "true");
    for (const card of active) {
      expect(within(card).getByTestId("landing-vault-card-status").textContent).toBe("Active");
      expect(within(card).getByTestId("landing-vault-card-tvl")).toBeTruthy();
    }
  });

  it("renders the empty state when no vaults are registered", async () => {
    const empty: VaultsResponse = { vaults: [], block_number: 1, indexed_at: "x" };
    const { findByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(empty)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    await waitFor(async () => {
      expect(await findByTestId("landing-vault-cards-empty")).toBeTruthy();
    });
  });
});

describe("VaultCards — TVL display and polling", () => {
  it("renders total_assets null as —", async () => {
    const { findByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(makeVaultFixture(null))}>
        <VaultCards />
      </ExplorerProvider>,
    );
    await waitFor(async () => {
      expect((await findByTestId("landing-vault-card-tvl")).textContent).toBe("—");
    });
  });

  it("renders total_assets '0' as 0", async () => {
    const { findByTestId: findByTestId2 } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(makeVaultFixture("0"))}>
        <VaultCards />
      </ExplorerProvider>,
    );
    await waitFor(async () => {
      expect((await findByTestId2("landing-vault-card-tvl")).textContent).toBe("0");
    });
  });

  it("re-fetches on the poll interval and updates TVL from '0' to non-zero without a page reload", async () => {
    let callCount = 0;
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      const isStats = typeof url === "string" && url.includes("/v1/stats");
      if (isStats) {
        return {
          ok: true as const,
          status: 200,
          json: async () => ({
            total_tvl: "0",
            unique_depositors: 0,
            activity_feed: [],
            block_number: 1,
            indexed_at: "",
          }),
        };
      }
      const vaults = callCount++ === 0 ? makeVaultFixture("0") : makeVaultFixture("5000000000");
      return { ok: true as const, status: 200, json: async () => vaults };
    }) as unknown as FetchLike;

    // Use a short real interval so the test completes quickly without fake
    // timers (fake timers block RTL's waitFor polling in browser mode).
    const { findByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={fetchImpl} pollInterval={50}>
        <VaultCards />
      </ExplorerProvider>,
    );

    // Initial fetch shows "0".
    await waitFor(async () => {
      expect((await findByTestId("landing-vault-card-tvl")).textContent).toBe("0");
    });

    // After one poll interval the context re-fetches and VaultCards displays the non-zero TVL.
    await waitFor(
      async () => {
        expect((await findByTestId("landing-vault-card-tvl")).textContent).toBe("5000000000");
      },
      { timeout: 2_000 },
    );
  });
});

// ─── Details navigation tests (issue #941) ────────────────────────────────────

describe("VaultCards — Details navigation (issue #941)", () => {
  it("each vault card has a Details button", async () => {
    const { findAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    const detailsButtons = await findAllByTestId("landing-vault-card-details");
    expect(detailsButtons).toHaveLength(4);
  });

  it("clicking Details on a vault card calls onSelectVault with the vault address", async () => {
    const onSelectVault = vi.fn();
    const onSwitchToExplorer = vi.fn();
    const { findAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards onSelectVault={onSelectVault} onSwitchToExplorer={onSwitchToExplorer} />
      </ExplorerProvider>,
    );

    const cards = await findAllByTestId("landing-vault-card");
    // Click the Details button on the first card (STABLE_YIELD / USDC)
    const firstCard = cards[0];
    const detailsButton = within(firstCard).getByTestId("landing-vault-card-details");
    fireEvent.click(detailsButton);

    expect(onSelectVault).toHaveBeenCalledWith("0x1111111111111111111111111111111111111111");
    expect(onSwitchToExplorer).toHaveBeenCalledTimes(1);
  });

  it("clicking Details on the RWA vault card calls onSelectVault with the RWA vault address", async () => {
    const onSelectVault = vi.fn();
    const onSwitchToExplorer = vi.fn();
    const { findAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards onSelectVault={onSelectVault} onSwitchToExplorer={onSwitchToExplorer} />
      </ExplorerProvider>,
    );

    const cards = await findAllByTestId("landing-vault-card");
    const rwaCard = cards.find((c) => c.getAttribute("data-vault-active") === "false");
    expect(rwaCard).toBeDefined();

    const detailsButton = within(rwaCard!).getByTestId("landing-vault-card-details");
    fireEvent.click(detailsButton);

    expect(onSelectVault).toHaveBeenCalledWith("0x4444444444444444444444444444444444444444");
    expect(onSwitchToExplorer).toHaveBeenCalledTimes(1);
  });

  it("clicking Details on each card calls onSelectVault with each vault's address", async () => {
    const onSelectVault = vi.fn();
    const { findAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards onSelectVault={onSelectVault} />
      </ExplorerProvider>,
    );

    const cards = await findAllByTestId("landing-vault-card");
    const expectedAddresses = fourVaultFixture.vaults.map((v) => v.address);

    for (let i = 0; i < cards.length; i++) {
      const detailsButton = within(cards[i]).getByTestId("landing-vault-card-details");
      fireEvent.click(detailsButton);
      expect(onSelectVault).toHaveBeenNthCalledWith(i + 1, expectedAddresses[i]);
    }
  });

  it("no Assets toggle button is present (VaultCardAssets retired in #941)", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    // Wait for cards to render
    await findAllByTestId("landing-vault-card");
    expect(queryAllByTestId("landing-vault-card-assets-toggle")).toHaveLength(0);
  });
});
