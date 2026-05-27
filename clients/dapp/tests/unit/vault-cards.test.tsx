/**
 * VaultCards — RTL unit tests for the landing-page vault tiles.
 *
 * Four-vault PRD conformance (issue #479): VaultCards renders one tile per
 * registered vault and renders any non-Active vault in its inactive
 * presentation (Future notice, no deposit/TVL stats). The inactive flag is
 * derived from each vault's on-chain `status` surfaced by the `/v1/vaults`
 * indexer read — not a hard-coded per-vault constant.
 *
 * All assertions use the `fetchImpl` injection point — no network or wallet.
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, within } from "@testing-library/react";
import { VaultCards } from "../../src/components/VaultCards";
import type { FetchLike, VaultsResponse } from "../../src/lib/explorerApi";

function makeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as FetchLike;
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

describe("VaultCards — four-vault layout (issue #479)", () => {
  it("renders one tile per registered vault", async () => {
    const { findAllByTestId } = render(
      <VaultCards apiUrl="http://api" fetchImpl={makeFetch(fourVaultFixture)} />,
    );
    const cards = await findAllByTestId("landing-vault-card");
    expect(cards).toHaveLength(4);
  });

  it("renders the non-Active RWA tile in its inactive presentation, sourced from status", async () => {
    const { findAllByTestId } = render(
      <VaultCards apiUrl="http://api" fetchImpl={makeFetch(fourVaultFixture)} />,
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
      <VaultCards apiUrl="http://api" fetchImpl={makeFetch(fourVaultFixture)} />,
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
      <VaultCards apiUrl="http://api" fetchImpl={makeFetch(empty)} />,
    );
    await waitFor(async () => {
      expect(await findByTestId("landing-vault-cards-empty")).toBeTruthy();
    });
  });
});
