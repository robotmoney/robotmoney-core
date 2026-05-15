/**
 * Suite-09 — RTL unit tests for protocol-layer components.
 *
 * Covers: VaultList, VaultDetail, RouterView, ProtocolStats.
 * All components are tested with mocked API responses via the `fetchImpl`
 * injection point — no real network or wallet required.
 *
 * Backs issue #318 acceptance criterion:
 *   "suite-09: RTL unit tests for VaultList, VaultDetail, RouterView,
 *    ProtocolStats with mocked API responses"
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { VaultList } from "../../src/components/VaultList";
import { VaultDetail } from "../../src/components/VaultDetail";
import { RouterView } from "../../src/components/RouterView";
import { ProtocolStats } from "../../src/components/ProtocolStats";
import type {
  FetchLike,
  VaultsResponse,
  VaultDetailResponse,
  RouterWeightsResponse,
  ProposalsResponse,
  StatsResponse,
} from "../../src/lib/explorerApi";

// ─── fixtures ────────────────────────────────────────────────────────────────

const VAULT_A_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT_B_ADDR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const vaultsFixture: VaultsResponse = {
  vaults: [
    {
      chain_id: 8453,
      address: VAULT_A_ADDR,
      name: "Alpha Vault",
      risk_label: "stable-yield",
      status: 0,
      deposit_cap: "1000000000",
      total_assets: "99999999",
      exit_fee_bps: 25,
      indexed_at: "2026-01-01T12:00:00Z",
    },
    {
      chain_id: 8453,
      address: VAULT_B_ADDR,
      name: "Beta Vault",
      risk_label: "growth",
      status: 1,
      deposit_cap: "500000000",
      total_assets: null,
      exit_fee_bps: null,
      indexed_at: "2026-01-01T12:00:00Z",
    },
  ],
  block_number: 1000,
  indexed_at: "2026-01-01T12:00:00Z",
};

const vaultDetailFixture: VaultDetailResponse = {
  vault: {
    chain_id: 8453,
    address: VAULT_A_ADDR,
    name: "Alpha Vault",
    risk_label: "stable-yield",
    status: 0,
    deposit_cap: "1000000000",
    tvl_history: [
      {
        block_number: 500,
        total_assets: "99999999",
        total_supply: "99999999",
        indexed_at: "2026-01-01T12:00:00Z",
      },
    ],
    indexed_at: "2026-01-01T12:00:00Z",
  },
  block_number: 1000,
  indexed_at: "2026-01-01T12:00:00Z",
};

const routerWeightsFixture: RouterWeightsResponse = {
  current_weights: [
    { vault: VAULT_A_ADDR, bps: 5000 },
    { vault: VAULT_B_ADDR, bps: 5000 },
  ],
  history: [
    {
      block_number: 800,
      tx_hash: "0x" + "ab".repeat(32),
      weights: [
        { vault: VAULT_A_ADDR, bps: 5000 },
        { vault: VAULT_B_ADDR, bps: 5000 },
      ],
      indexed_at: "2026-01-01T12:00:00Z",
    },
  ],
  block_number: 800,
  indexed_at: "2026-01-01T12:00:00Z",
};

const proposalsFixture: ProposalsResponse = {
  proposals: [
    {
      chain_id: 8453,
      proposal_id: 1,
      proposer: "0x" + "33".repeat(20),
      description: "Increase vault-a weight to 60%",
      created_at: 1748000000,
      deadline_block: 900,
      status: "open",
      votes_for: 0,
      votes_against: 0,
      block_number: 850,
      indexed_at: "2026-01-01T12:00:00Z",
    },
  ],
  block_number: 850,
  indexed_at: "2026-01-01T12:00:00Z",
};

const statsFixture: StatsResponse = {
  total_tvl: "99999999",
  unique_depositors: 1,
  activity_feed: [
    {
      chain_id: 1,
      block_number: 1000,
      log_index: 0,
      tx_hash: "0xaaaa",
      vault: "0x" + "1".repeat(40),
      agent: "0x" + "2".repeat(40),
      share_receiver: "0x" + "3".repeat(40),
      amount: "1000",
      indexed_at: "2026-01-01T12:00:00Z",
    },
    {
      chain_id: 1,
      block_number: 900,
      log_index: 1,
      tx_hash: "0xbbbb",
      vault: "0x" + "1".repeat(40),
      agent: "0x" + "2".repeat(40),
      share_receiver: "0x" + "3".repeat(40),
      amount: "500",
      indexed_at: "2026-01-01T12:00:00Z",
    },
  ],
  block_number: 1000,
  indexed_at: "2026-01-01T12:00:00Z",
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as FetchLike;
}

/**
 * RouterView calls two URLs (/v1/router/weights and /v1/governance/proposals).
 * Return different fixtures depending on which URL is called.
 */
function makeRouterFetch(): FetchLike {
  return vi.fn(async (url: string) => {
    if (url.includes("/v1/router/weights")) {
      return { ok: true, status: 200, json: async () => routerWeightsFixture };
    }
    return { ok: true, status: 200, json: async () => proposalsFixture };
  }) as unknown as FetchLike;
}

// ─── VaultList ────────────────────────────────────────────────────────────────

describe("VaultList", () => {
  it("renders a row per vault with correct fields", async () => {
    const { getByTestId, getAllByTestId } = render(
      <VaultList apiUrl="http://api" fetchImpl={makeFetch(vaultsFixture)} />,
    );

    await waitFor(() => {
      expect(getByTestId("vault-list-table")).toBeTruthy();
    });

    const rows = getAllByTestId("vault-list-row");
    expect(rows).toHaveLength(2);

    const names = getAllByTestId("vault-list-row-name").map((n) => n.textContent);
    expect(names).toContain("Alpha Vault");
    expect(names).toContain("Beta Vault");

    const statuses = getAllByTestId("vault-list-row-status").map((n) => n.textContent);
    expect(statuses).toContain("Active");
    expect(statuses).toContain("Paused");
  });

  it("renders without a connected wallet — no wagmi hooks used", async () => {
    // VaultList must not import useAccount or useConnect; this is a
    // structural assertion via rendering — if it mounted wagmi hooks
    // without a WagmiProvider it would throw.
    const { getByTestId } = render(
      <VaultList apiUrl="http://api" fetchImpl={makeFetch(vaultsFixture)} />,
    );
    await waitFor(() => expect(getByTestId("vault-list-table")).toBeTruthy());
  });

  it("renders headroom for vault with total_assets", async () => {
    const { getAllByTestId } = render(
      <VaultList apiUrl="http://api" fetchImpl={makeFetch(vaultsFixture)} />,
    );
    await waitFor(() => getAllByTestId("vault-list-row-headroom"));

    const headrooms = getAllByTestId("vault-list-row-headroom").map((n) => n.textContent);
    // Alpha: 1000000000 - 99999999 = 900000001
    expect(headrooms[0]).toBe("900000001");
    // Beta: no total_assets → —
    expect(headrooms[1]).toBe("—");
  });

  it("shows risk_label per vault", async () => {
    const { getAllByTestId } = render(
      <VaultList apiUrl="http://api" fetchImpl={makeFetch(vaultsFixture)} />,
    );
    await waitFor(() => getAllByTestId("vault-list-row-risk"));

    const risks = getAllByTestId("vault-list-row-risk").map((n) => n.textContent);
    expect(risks[0]).toBe("stable-yield");
    expect(risks[1]).toBe("growth");
  });

  it("shows empty state when no vaults", async () => {
    const empty: VaultsResponse = {
      vaults: [],
      block_number: 0,
      indexed_at: "2026-01-01T00:00:00Z",
    };
    const { getByTestId } = render(<VaultList apiUrl="http://api" fetchImpl={makeFetch(empty)} />);
    await waitFor(() => expect(getByTestId("vault-list-empty")).toBeTruthy());
  });

  it("shows error on non-2xx response", async () => {
    const { getByTestId } = render(
      <VaultList apiUrl="http://api" fetchImpl={makeFetch({}, false, 503)} />,
    );
    await waitFor(() => expect(getByTestId("vault-list-error").textContent).toContain("503"));
  });

  it("shows freshness block number", async () => {
    const { getByTestId } = render(
      <VaultList apiUrl="http://api" fetchImpl={makeFetch(vaultsFixture)} />,
    );
    await waitFor(() => {
      expect(getByTestId("vault-list-freshness").textContent).toContain("1000");
    });
  });
});

// ─── VaultDetail ─────────────────────────────────────────────────────────────

describe("VaultDetail", () => {
  it("renders vault name, risk, status, and cap", async () => {
    const { getByTestId } = render(
      <VaultDetail
        apiUrl="http://api"
        address={VAULT_A_ADDR}
        fetchImpl={makeFetch(vaultDetailFixture)}
      />,
    );
    await waitFor(() => expect(getByTestId("vault-detail-name").textContent).toBe("Alpha Vault"));
    expect(getByTestId("vault-detail-risk").textContent).toBe("stable-yield");
    expect(getByTestId("vault-detail-status").textContent).toBe("Active");
    expect(getByTestId("vault-detail-cap").textContent).toBe("1000000000");
  });

  it("renders TVL history rows from explorer API", async () => {
    const { getByTestId, getAllByTestId } = render(
      <VaultDetail
        apiUrl="http://api"
        address={VAULT_A_ADDR}
        fetchImpl={makeFetch(vaultDetailFixture)}
      />,
    );
    await waitFor(() => expect(getByTestId("vault-detail-tvl-table")).toBeTruthy());

    const rows = getAllByTestId("vault-detail-tvl-row");
    expect(rows).toHaveLength(1);
    expect(getAllByTestId("vault-detail-tvl-assets")[0].textContent).toBe("99999999");
    expect(getAllByTestId("vault-detail-tvl-block")[0].textContent).toBe("500");
  });

  it("shows error on 404", async () => {
    const deadAddr = ("0x" + "de".repeat(20)) as string;
    const { getByTestId } = render(
      <VaultDetail
        apiUrl="http://api"
        address={deadAddr}
        fetchImpl={makeFetch({ error: "not_found" }, false, 404)}
      />,
    );
    await waitFor(() => expect(getByTestId("vault-detail-error").textContent).toContain("404"));
  });

  it("shows freshness block number", async () => {
    const { getByTestId } = render(
      <VaultDetail
        apiUrl="http://api"
        address={VAULT_A_ADDR}
        fetchImpl={makeFetch(vaultDetailFixture)}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("vault-detail-freshness").textContent).toContain("1000");
    });
  });
});

// ─── RouterView ───────────────────────────────────────────────────────────────

describe("RouterView", () => {
  it("renders current weights table with bps", async () => {
    const { getByTestId, getAllByTestId } = render(
      <RouterView apiUrl="http://api" fetchImpl={makeRouterFetch()} />,
    );
    await waitFor(() => expect(getByTestId("router-view-weights-table")).toBeTruthy());

    const rows = getAllByTestId("router-view-weight-row");
    expect(rows).toHaveLength(2);
    const bps = getAllByTestId("router-view-weight-bps").map((n) => n.textContent);
    expect(bps).toEqual(["5000", "5000"]);
  });

  it("renders pending open proposal description", async () => {
    const { getByTestId } = render(
      <RouterView apiUrl="http://api" fetchImpl={makeRouterFetch()} />,
    );
    await waitFor(() => expect(getByTestId("router-view-pending-proposal")).toBeTruthy());
    expect(getByTestId("router-view-proposal-description").textContent).toBe(
      "Increase vault-a weight to 60%",
    );
    expect(getByTestId("router-view-proposal-status").textContent).toBe("open");
  });

  it("shows no pending proposal when all proposals are executed", async () => {
    const noOpenFetch = vi.fn(async (url: string) => {
      if (url.includes("/v1/router/weights")) {
        return { ok: true, status: 200, json: async () => routerWeightsFixture };
      }
      const noOpen: ProposalsResponse = {
        proposals: [{ ...proposalsFixture.proposals[0], status: "executed" }],
        block_number: 850,
        indexed_at: "2026-01-01T12:00:00Z",
      };
      return { ok: true, status: 200, json: async () => noOpen };
    }) as unknown as FetchLike;

    const { getByTestId } = render(<RouterView apiUrl="http://api" fetchImpl={noOpenFetch} />);
    await waitFor(() => expect(getByTestId("router-view-no-proposal")).toBeTruthy());
  });

  it("renders weight history rows", async () => {
    const { getByTestId, getAllByTestId } = render(
      <RouterView apiUrl="http://api" fetchImpl={makeRouterFetch()} />,
    );
    await waitFor(() => expect(getByTestId("router-view-history-table")).toBeTruthy());

    const rows = getAllByTestId("router-view-history-row");
    expect(rows).toHaveLength(1);
    expect(getAllByTestId("router-view-history-block")[0].textContent).toBe("800");
  });

  it("shows freshness block number", async () => {
    const { getByTestId } = render(
      <RouterView apiUrl="http://api" fetchImpl={makeRouterFetch()} />,
    );
    await waitFor(() => {
      expect(getByTestId("router-view-freshness").textContent).toContain("800");
    });
  });
});

// ─── ProtocolStats ────────────────────────────────────────────────────────────

describe("ProtocolStats", () => {
  it("renders aggregate TVL and depositor count", async () => {
    const { getByTestId } = render(
      <ProtocolStats apiUrl="http://api" fetchImpl={makeFetch(statsFixture)} />,
    );
    await waitFor(() => {
      expect(getByTestId("protocol-stats-tvl").textContent).toBe("99999999");
      expect(getByTestId("protocol-stats-depositors").textContent).toBe("1");
    });
  });

  it("renders recent activity event list", async () => {
    const { getAllByTestId } = render(
      <ProtocolStats apiUrl="http://api" fetchImpl={makeFetch(statsFixture)} />,
    );
    await waitFor(() => getAllByTestId("protocol-stats-activity-item"));

    const items = getAllByTestId("protocol-stats-activity-item");
    expect(items).toHaveLength(2);

    const kinds = getAllByTestId("protocol-stats-activity-kind").map((n) => n.textContent);
    expect(kinds).toHaveLength(2);
    expect(kinds.every((k) => k === "deposit")).toBe(true);
  });

  it("shows error on non-2xx response", async () => {
    const { getByTestId } = render(
      <ProtocolStats apiUrl="http://api" fetchImpl={makeFetch({}, false, 500)} />,
    );
    await waitFor(() => expect(getByTestId("protocol-stats-error").textContent).toContain("500"));
  });

  it("renders without a connected wallet", async () => {
    // ProtocolStats must not use wagmi — if it did, it would throw without
    // WagmiProvider. A clean mount is the assertion.
    const { getByTestId } = render(
      <ProtocolStats apiUrl="http://api" fetchImpl={makeFetch(statsFixture)} />,
    );
    await waitFor(() => expect(getByTestId("protocol-stats-tvl")).toBeTruthy());
  });

  it("shows freshness block number", async () => {
    const { getByTestId } = render(
      <ProtocolStats apiUrl="http://api" fetchImpl={makeFetch(statsFixture)} />,
    );
    await waitFor(() => {
      expect(getByTestId("protocol-stats-freshness").textContent).toContain("1000");
    });
  });
});
