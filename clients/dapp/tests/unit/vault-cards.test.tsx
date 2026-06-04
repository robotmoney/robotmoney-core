/**
 * VaultCards — RTL unit tests for the landing-page vault tiles.
 *
 * Real four-vault demo (issue #593): all four PRD §11 vault categories ship
 * Active and carry real, non-zero TVL once the RWA/Thematic vault is
 * registered Active (#595) and DappStack::boot seeds real depositors into
 * every vault (#597). VaultCards must render four Active tiles, each showing
 * a non-null TVL value, with NO Future/coming-soon placeholder tile present.
 *
 * The earlier #479 model (three Active router vaults plus a Paused RWA
 * placeholder) is superseded. A regression test below still proves the
 * status-driven inactive presentation works for any non-Active vault, so the
 * `status`-sourced logic in VaultCards.tsx is not silently broken — but the
 * production demo set no longer contains a non-Active vault.
 *
 * All assertions use the `fetchImpl` injection point — no network or wallet.
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, within } from "./helpers/render";
import { VaultCards } from "../../src/components/VaultCards";
import type { FetchLike, VaultsResponse } from "../../src/lib/explorerApi";

function makeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as FetchLike;
}

// Real four-vault demo set: all four PRD §11 categories Active (status 0),
// each carrying a real, non-zero TVL produced by seeded depositors (#597).
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
      status: 0, // Active — the RWA/Thematic vault is registered Active (#595)
      deposit_cap: "10000000000000",
      total_assets: "750000000",
      exit_fee_bps: 25,
      indexed_at: "2026-01-01T12:00:00Z",
    },
  ],
  block_number: 1000,
  indexed_at: "2026-01-01T12:00:00Z",
};

describe("VaultCards — real four-vault layout (issue #593)", () => {
  it("renders four Active vault cards, one per registered vault", async () => {
    const { findAllByTestId } = render(
      <VaultCards apiUrl="http://api" fetchImpl={makeFetch(fourVaultFixture)} />,
    );
    const cards = await findAllByTestId("landing-vault-card");
    expect(cards).toHaveLength(4);

    const active = cards.filter((c) => c.getAttribute("data-vault-active") === "true");
    expect(active).toHaveLength(4);
  });

  it("renders NO Future / coming-soon placeholder tile", async () => {
    const { findAllByTestId, queryAllByTestId } = render(
      <VaultCards apiUrl="http://api" fetchImpl={makeFetch(fourVaultFixture)} />,
    );
    // Wait for the cards to render before asserting the negative.
    await findAllByTestId("landing-vault-card");

    expect(queryAllByTestId("landing-vault-card-future")).toHaveLength(0);
  });

  it("shows every Active tile with Active status and a real, non-zero TVL", async () => {
    const { findAllByTestId } = render(
      <VaultCards apiUrl="http://api" fetchImpl={makeFetch(fourVaultFixture)} />,
    );
    const cards = await findAllByTestId("landing-vault-card");
    expect(cards).toHaveLength(4);

    for (const card of cards) {
      expect(card.getAttribute("data-vault-active")).toBe("true");
      expect(within(card).getByTestId("landing-vault-card-status").textContent).toBe("Active");

      // Real TVL: present, not the null sentinel, and strictly non-zero.
      const tvl = within(card).getByTestId("landing-vault-card-tvl");
      const text = (tvl.textContent ?? "").trim();
      expect(text).not.toBe("");
      expect(text).not.toBe("—");
      expect(text).not.toBe("0");
      expect(BigInt(text) > 0n).toBe(true);
    }
  });

  it("renders any non-Active vault in its inactive presentation, sourced from status (status-driven regression)", async () => {
    // Regression guard: although the production demo set is all-Active, the
    // status-driven inactive presentation must still work if a vault is
    // Paused. Drive one vault to status 1 and assert the Future notice.
    const withPaused: VaultsResponse = {
      ...fourVaultFixture,
      vaults: fourVaultFixture.vaults.map((v, i) =>
        i === 3 ? { ...v, status: 1, total_assets: null, exit_fee_bps: null } : v,
      ),
    };
    const { findAllByTestId } = render(
      <VaultCards apiUrl="http://api" fetchImpl={makeFetch(withPaused)} />,
    );
    const cards = await findAllByTestId("landing-vault-card");
    const inactive = cards.filter((c) => c.getAttribute("data-vault-active") === "false");
    expect(inactive).toHaveLength(1);

    const rwa = inactive[0];
    expect(within(rwa).getByTestId("landing-vault-card-future")).toBeTruthy();
    expect(within(rwa).queryByTestId("landing-vault-card-tvl")).toBeNull();
    expect(within(rwa).queryByTestId("landing-vault-card-status")).toBeNull();
  });

  it("renders the empty state when no vaults are registered", async () => {
    const empty: VaultsResponse = { vaults: [], block_number: 1, indexed_at: "x" };
    const { findByTestId } = render(
      <VaultCards apiUrl="http://api" fetchImpl={makeFetch(empty)} />,
    );
    await waitFor(async () => {
      expect(await findByTestId("landing-vault-cards-empty")).toBeTruthy();
    });
  });
});

// Minimal single-vault fixture helpers for TVL rendering / polling tests.
function makeVault(total_assets: string | null): VaultsResponse {
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

describe("VaultCards — TVL display and polling", () => {
  it("renders total_assets null as — and total_assets '0' as 0", async () => {
    const { findByTestId, rerender } = render(
      <VaultCards apiUrl="http://api" fetchImpl={makeFetch(makeVault(null))} />,
    );
    await waitFor(async () => {
      expect((await findByTestId("landing-vault-card-tvl")).textContent).toBe("—");
    });

    rerender(<VaultCards apiUrl="http://api" fetchImpl={makeFetch(makeVault("0"))} />);
    await waitFor(async () => {
      expect((await findByTestId("landing-vault-card-tvl")).textContent).toBe("0");
    });
  });

  it("re-fetches on the poll interval and updates TVL from '0' to non-zero without a page reload", async () => {
    let callCount = 0;
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      json: async () => (callCount++ === 0 ? makeVault("0") : makeVault("5000000000")),
    })) as unknown as FetchLike;

    // Use a short real interval so the test completes quickly without fake timers
    // (fake timers block RTL's waitFor polling in browser mode).
    const { findByTestId } = render(
      <VaultCards apiUrl="http://api" fetchImpl={fetchImpl} pollInterval={50} />,
    );

    // Initial fetch shows "0".
    await waitFor(async () => {
      expect((await findByTestId("landing-vault-card-tvl")).textContent).toBe("0");
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After one poll interval the component re-fetches and displays the non-zero TVL.
    await waitFor(
      async () => {
        expect((await findByTestId("landing-vault-card-tvl")).textContent).toBe("5000000000");
      },
      { timeout: 2_000 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
