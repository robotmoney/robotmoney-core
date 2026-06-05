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
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, within, fireEvent } from "./helpers/render";
import { VaultCards } from "../../src/components/VaultCards";
import { ExplorerProvider } from "../../src/lib/ExplorerContext";
import type { FetchLike, VaultsResponse, StatsResponse } from "../../src/lib/explorerApi";

// Wagmi mock — VaultCardAssets calls useReadContract for basket vaults.
// We return isLoading:true to test the loading path; static-entry vaults
// (USDC, deSPXA) never call useReadContract regardless. render.tsx bypasses
// this mock via vi.importActual so WagmiProvider is still real.
vi.mock("wagmi", () => ({
  useReadContract: () => ({ data: undefined, isError: false, isLoading: true }),
  createConfig: () => ({}),
  http: () => ({}),
  fallback: (...args: unknown[]) => args[0],
  unstable_connector: () => ({}),
}));

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

// ─── Asset affordance tests (issue #620) ──────────────────────────────────────

describe("VaultCards — asset affordance (issue #620)", () => {
  it("each vault card has an assets toggle button", async () => {
    const { findAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    const toggles = await findAllByTestId("landing-vault-card-assets-toggle");
    expect(toggles).toHaveLength(4);
  });

  it("STABLE_YIELD vault: assets panel shows static USDC entry", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    const cards = await findAllByTestId("landing-vault-card");
    const usdcCard = cards.find(
      (c) => within(c).getByTestId("landing-vault-card-risk").textContent === "STABLE_YIELD",
    );
    expect(usdcCard).toBeDefined();

    const toggle = within(usdcCard!).getByTestId("landing-vault-card-assets-toggle");

    // Panel not visible before toggle
    expect(queryAllByTestId("vault-card-assets-panel")).toHaveLength(0);

    fireEvent.click(toggle);

    await waitFor(() => {
      const panels = queryAllByTestId("vault-card-assets-panel");
      expect(panels).toHaveLength(1);
      expect(within(panels[0]).getByTestId("vault-card-asset-address").textContent).toBe("USDC");
    });
  });

  it("inactive SPECULATIVE (RWA) vault: assets panel shows static deSPXA entry", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    const cards = await findAllByTestId("landing-vault-card");
    const rwaCard = cards.find((c) => c.getAttribute("data-vault-active") === "false");
    expect(rwaCard).toBeDefined();

    const toggle = within(rwaCard!).getByTestId("landing-vault-card-assets-toggle");
    fireEvent.click(toggle);

    await waitFor(() => {
      const panels = queryAllByTestId("vault-card-assets-panel");
      expect(panels).toHaveLength(1);
      expect(within(panels[0]).getByTestId("vault-card-asset-address").textContent).toBe("deSPXA");
    });
  });

  it("VOLATILE basket vault: assets panel shows basket shortlist loading state", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    const cards = await findAllByTestId("landing-vault-card");
    const volatileCard = cards.find(
      (c) => within(c).getByTestId("landing-vault-card-risk").textContent === "VOLATILE",
    );
    expect(volatileCard).toBeDefined();

    const toggle = within(volatileCard!).getByTestId("landing-vault-card-assets-toggle");
    fireEvent.click(toggle);

    await waitFor(() => {
      const panels = queryAllByTestId("vault-card-assets-panel");
      expect(panels).toHaveLength(1);
      // wagmi mock returns isLoading:true → basket panel shows Loading…
      expect(within(panels[0]).getByTestId("vault-card-assets-loading")).toBeTruthy();
    });
  });

  it("active SPECULATIVE basket vault: assets panel shows basket shortlist loading state", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    const cards = await findAllByTestId("landing-vault-card");

    // Active SPECULATIVE is the Agent Tokens vault (SPECULATIVE + status=0)
    const activeSpecCards = cards.filter(
      (c) =>
        within(c).getByTestId("landing-vault-card-risk").textContent === "SPECULATIVE" &&
        c.getAttribute("data-vault-active") === "true",
    );
    expect(activeSpecCards).toHaveLength(1);

    const toggle = within(activeSpecCards[0]).getByTestId("landing-vault-card-assets-toggle");
    fireEvent.click(toggle);

    await waitFor(() => {
      const panels = queryAllByTestId("vault-card-assets-panel");
      expect(panels).toHaveLength(1);
      expect(within(panels[0]).getByTestId("vault-card-assets-loading")).toBeTruthy();
    });
  });

  it("toggle collapses the panel on second click", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <ExplorerProvider apiUrl="http://api" fetchImpl={makeExplorerFetch(fourVaultFixture)}>
        <VaultCards />
      </ExplorerProvider>,
    );
    const cards = await findAllByTestId("landing-vault-card");
    const usdcCard = cards.find(
      (c) => within(c).getByTestId("landing-vault-card-risk").textContent === "STABLE_YIELD",
    );
    const toggle = within(usdcCard!).getByTestId("landing-vault-card-assets-toggle");

    fireEvent.click(toggle);
    await waitFor(() => expect(queryAllByTestId("vault-card-assets-panel")).toHaveLength(1));

    fireEvent.click(toggle);
    await waitFor(() => expect(queryAllByTestId("vault-card-assets-panel")).toHaveLength(0));
  });
});
