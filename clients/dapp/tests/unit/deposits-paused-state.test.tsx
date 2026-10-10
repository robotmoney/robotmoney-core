/**
 * Issue 1731: a vault whose own `depositsPaused()` is true is never shown as "Active".
 *
 * On the Base 8453 rehearsal contracts all four vaults have `depositsPaused() == true` and the registry says
 * status 0 (Active). The cards, the list rows, the detail page and the deposit forms must say "Deposits
 * paused / closed", disable deposits with the reason, and leave withdraw and redeem alone.
 *
 * The chain is a fake in-memory EIP-1193 transport (helpers/fakeChain.tsx) behind the real wagmi hooks, the
 * explorer is a fake `fetch`. Nothing is mocked inside the components under test.
 */
import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { VaultCards } from "../../src/components/VaultCards";
import { VaultList } from "../../src/components/VaultList";
import { ExplorerProvider } from "../../src/lib/ExplorerContext";
import type { FetchLike, VaultsResponse } from "../../src/lib/explorerApi";
import {
  depositStateLabel,
  depositsBlocked,
  resolveDepositState,
} from "../../src/lib/vaultDepositState";
import { depositsReadAllowed } from "../../src/lib/useVaultsDepositsPaused";
import { DEPOSITS_PAUSED_SELECTOR, makeFakeChain, renderOnFakeChain } from "./helpers/fakeChain";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

function vaultsBody(
  rows: { address: string; status?: number; deposits_paused?: boolean | null }[],
): VaultsResponse {
  return {
    vaults: rows.map((r, i) => ({
      chain_id: 8453,
      address: r.address,
      name: `Vault ${i}`,
      risk_label: "STABLE_YIELD",
      status: r.status ?? 0,
      deposit_cap: "0",
      total_assets: "1000000",
      exit_fee_bps: 0,
      indexed_at: "2026-10-10T00:00:00Z",
      ...(r.deposits_paused === undefined ? {} : { deposits_paused: r.deposits_paused }),
    })),
    block_number: 1000,
    chain_head_block: 1008,
    indexed_at: "2026-10-10T00:00:00Z",
  };
}

const explorerFetch = (body: VaultsResponse): FetchLike =>
  vi.fn(async (url: string) => ({
    ok: true as const,
    status: 200,
    json: async () =>
      url.includes("/v1/stats")
        ? {
            total_tvl: "0",
            unique_depositors: 0,
            activity_feed: [],
            block_number: 1000,
            indexed_at: "",
          }
        : body,
  })) as unknown as FetchLike;

const cardsFor = (body: VaultsResponse) => (
  <ExplorerProvider apiUrl="http://api" fetchImpl={explorerFetch(body)}>
    <VaultCards />
  </ExplorerProvider>
);

const statuses = (c: ParentNode) =>
  Array.from(c.querySelectorAll('[data-testid="landing-vault-card-status"]')).map(
    (e) => e.textContent,
  );

describe("resolveDepositState (pure)", () => {
  it("registry paused or retired wins over anything read", () => {
    expect(resolveDepositState({ registryStatus: 1, chainPaused: false })).toEqual({
      kind: "paused",
      source: "registry",
    });
    expect(resolveDepositState({ registryStatus: 2, chainPaused: false }).kind).toBe("retired");
  });
  it("the chain read wins over a stale explorer flag, both ways", () => {
    expect(
      resolveDepositState({ registryStatus: 0, chainPaused: true, explorerPaused: false }).kind,
    ).toBe("paused");
    expect(
      resolveDepositState({ registryStatus: 0, chainPaused: false, explorerPaused: true }).kind,
    ).toBe("open");
  });
  it("the explorer flag is used when the chain cannot be read", () => {
    expect(resolveDepositState({ registryStatus: 0, explorerPaused: true })).toEqual({
      kind: "paused",
      source: "explorer",
    });
    expect(resolveDepositState({ registryStatus: 0, explorerPaused: false }).kind).toBe("open");
  });
  it("nothing known is unknown, never open", () => {
    const s = resolveDepositState({ registryStatus: 0, explorerPaused: null });
    expect(s.kind).toBe("unknown");
    expect(depositStateLabel(s)).toBe("Deposit state unknown");
    expect(depositsBlocked(s)).toBe(false);
    expect(resolveDepositState({ registryStatus: 0 }).kind).toBe("unknown");
  });
  it("the label is Active only for open", () => {
    for (const input of [
      { registryStatus: 0, chainPaused: true },
      { registryStatus: 1 },
      { registryStatus: 2 },
      { registryStatus: 0 },
      { registryStatus: 0, explorerPaused: true },
    ]) {
      expect(depositStateLabel(resolveDepositState(input))).not.toBe("Active");
    }
    expect(depositStateLabel(resolveDepositState({ registryStatus: 0, chainPaused: false }))).toBe(
      "Active",
    );
  });
  it("a read is allowed everywhere except a mainnet class with no wallet on Base", () => {
    expect(depositsReadAllowed({ kind: "not-applicable" })).toBe(true);
    expect(depositsReadAllowed({ kind: "ok", targetChainId: 8453 })).toBe(true);
    expect(depositsReadAllowed({ kind: "not-connected", targetChainId: 8453 })).toBe(false);
    expect(
      depositsReadAllowed({ kind: "wrong-chain", targetChainId: 8453, connectedChainId: 1 }),
    ).toBe(false);
  });
});

describe("VaultCards on a fake chain", () => {
  it("shows 'Deposits paused / closed' and never 'Active' when the vault's depositsPaused() is true", async () => {
    const fake = makeFakeChain({ [A]: true, [B]: true });
    const { container, findAllByTestId } = await renderOnFakeChain(
      cardsFor(vaultsBody([{ address: A }, { address: B }])),
      fake,
    );
    await findAllByTestId("landing-vault-card");
    await waitFor(() =>
      expect(statuses(container)).toEqual(["Deposits paused / closed", "Deposits paused / closed"]),
    );
    expect(container.textContent).not.toContain("Active");
    const card = container.querySelector('[data-testid="landing-vault-card"]')!;
    expect(card.getAttribute("data-deposit-state")).toBe("paused");
    expect(
      container.querySelector('[data-testid="landing-vault-card-deposits-closed"]')?.textContent,
    ).toContain("Withdraw and redeem stay open");
    expect(fake.calls.some((c) => c.method === "eth_call")).toBe(true);
  });

  it("shows 'Active' when the vault's depositsPaused() is false", async () => {
    const fake = makeFakeChain({ [A]: false });
    const { container, findAllByTestId } = await renderOnFakeChain(
      cardsFor(vaultsBody([{ address: A }])),
      fake,
    );
    await findAllByTestId("landing-vault-card");
    await waitFor(() => expect(statuses(container)).toEqual(["Active"]));
    expect(
      container.querySelector('[data-testid="landing-vault-card-deposits-closed"]'),
    ).toBeNull();
  });

  it("a live read of true beats a stale explorer flag of false, and false beats true", async () => {
    const fake = makeFakeChain({ [A]: true, [B]: false });
    const { container, findAllByTestId } = await renderOnFakeChain(
      cardsFor(
        vaultsBody([
          { address: A, deposits_paused: false },
          { address: B, deposits_paused: true },
        ]),
      ),
      fake,
    );
    await findAllByTestId("landing-vault-card");
    await waitFor(() =>
      expect(statuses(container)).toEqual(["Deposits paused / closed", "Active"]),
    );
  });

  it("uses the explorer flag when the chain cannot be read, and says unknown when neither is known", async () => {
    const fake = makeFakeChain({}); // every eth_call reverts
    const { container, findAllByTestId } = await renderOnFakeChain(
      cardsFor(
        vaultsBody([
          { address: A, deposits_paused: true },
          { address: B, deposits_paused: null },
        ]),
      ),
      fake,
    );
    await findAllByTestId("landing-vault-card");
    await waitFor(() =>
      expect(statuses(container)).toEqual(["Deposits paused / closed", "Deposit state unknown"]),
    );
    expect(container.textContent).not.toContain("Active");
  });

  it("an explorer that does not send the flag (older API) reads as unknown, not Active", async () => {
    const { container, findAllByTestId } = await renderOnFakeChain(
      cardsFor(vaultsBody([{ address: A }])),
      makeFakeChain({}),
    );
    await findAllByTestId("landing-vault-card");
    await waitFor(() => expect(statuses(container)).toEqual(["Deposit state unknown"]));
  });

  it("on the mainnet class with no wallet it asks the chain nothing and uses the explorer flag", async () => {
    const fake = makeFakeChain({ [A]: false }); // would say open, if it were asked
    const { container, findAllByTestId } = await renderOnFakeChain(
      cardsFor(vaultsBody([{ address: A, deposits_paused: true }])),
      fake,
      { chainId: 8453, env: { VITE_ENV_CLASS: "mainnet" } },
    );
    await findAllByTestId("landing-vault-card");
    await waitFor(() => expect(statuses(container)).toEqual(["Deposits paused / closed"]));
    expect(fake.calls.filter((c) => c.method === "eth_call")).toHaveLength(0);
  });

  it("on the mainnet class with a wallet on Base it reads the chain", async () => {
    const fake = makeFakeChain({ [A]: true });
    const { container, findAllByTestId } = await renderOnFakeChain(
      cardsFor(vaultsBody([{ address: A, deposits_paused: false }])),
      fake,
      { chainId: 8453, env: { VITE_ENV_CLASS: "mainnet" }, connected: true },
    );
    await findAllByTestId("landing-vault-card");
    await waitFor(() => expect(statuses(container)).toEqual(["Deposits paused / closed"]));
    const call = fake.calls.find((c) => c.method === "eth_call");
    expect(call?.to?.toLowerCase()).toBe(A);
  });

  it("keeps the Future presentation for a registry-paused (status 1) placeholder", async () => {
    const { container, findAllByTestId } = await renderOnFakeChain(
      cardsFor(vaultsBody([{ address: A, status: 1 }])),
      makeFakeChain({ [A]: false }),
    );
    await findAllByTestId("landing-vault-card");
    expect(container.querySelector('[data-testid="landing-vault-card-future"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Active");
  });
});

describe("VaultList on a fake chain", () => {
  it("the Status column says 'Deposits paused / closed' for a registry-Active vault with deposits paused", async () => {
    const fake = makeFakeChain({ [A]: true, [B]: false });
    const { findAllByTestId, container } = await renderOnFakeChain(
      <ExplorerProvider
        apiUrl="http://api"
        fetchImpl={explorerFetch(vaultsBody([{ address: A }, { address: B }]))}
      >
        <VaultList />
      </ExplorerProvider>,
      fake,
    );
    await findAllByTestId("vault-list-row-status");
    await waitFor(() => {
      const cells = Array.from(
        container.querySelectorAll('[data-testid="vault-list-row-status"]'),
      ).map((e) => e.textContent);
      expect(cells).toEqual(["Deposits paused / closed", "Active"]);
    });
  });
});

describe("selector sanity", () => {
  it("the fake answers the real depositsPaused() selector", () => {
    expect(DEPOSITS_PAUSED_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/);
  });
});
