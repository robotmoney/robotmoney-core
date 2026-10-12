/**
 * Issue 1767: share counts print the vault's own symbol(), never a hardcoded "rmUSDC".
 * The explorer sends only name and risk_label, so the symbol is read from the vault contract itself.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import { VaultDetail } from "../../src/components/VaultDetail";
import { PortfolioPosition } from "../../src/components/PortfolioPosition";
import { AgentPoliciesPanel } from "../../src/components/AgentPoliciesPanel";
import { shareSymbolOrNeutral } from "../../src/lib/format";
import type { FetchLike, VaultDetailRow } from "../../src/lib/explorerApi";
import { makeFakeChain, renderOnFakeChain } from "./helpers/fakeChain";

const SYMBOL_SELECTOR = toFunctionSelector("symbol()");

const VAULTS = [
  {
    name: "Robot Money USDC",
    risk: "STABLE_YIELD",
    symbol: "rmUSDC",
    addr: "0x00000000000000000000000000000000000000a1",
  },
  {
    name: "Robot Money Protocol",
    risk: "VOLATILE",
    symbol: "rmPROTO",
    addr: "0x00000000000000000000000000000000000000a2",
  },
  {
    name: "Robot Money Agent Tokens",
    risk: "SPECULATIVE",
    symbol: "rmAGENT",
    addr: "0x00000000000000000000000000000000000000a3",
  },
  {
    name: "Robot Money RWA",
    risk: "SPECULATIVE",
    symbol: "rmRWA",
    addr: "0x00000000000000000000000000000000000000a4",
  },
] as const;

const row = (v: { name: string; risk: string; addr: string }): VaultDetailRow => ({
  chain_id: 8453,
  address: v.addr,
  name: v.name,
  risk_label: v.risk,
  status: 0,
  deposits_paused: false,
  tvl_cap: "1000000000",
  per_deposit_cap: "100000000",
  headroom: "998999955",
  snapshot_block: 10,
  tvl_history: [
    {
      block_number: 10,
      total_assets: "1000045",
      total_supply: "1000000000000000000000000",
      indexed_at: "2026-10-10T12:48:17Z",
    },
  ],
  indexed_at: "2026-10-10T12:48:14Z",
});

const fetchFor = (v: (typeof VAULTS)[number]): FetchLike =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      vault: row(v),
      block_number: 10,
      chain_head_block: 10,
      indexed_at: "2026-10-10T12:48:17Z",
    }),
  })) as unknown as FetchLike;

async function supplyCell(v: (typeof VAULTS)[number], symbol: string | undefined) {
  const fake = makeFakeChain();
  fake.respond = (to, data) =>
    symbol !== undefined && to === v.addr && data.startsWith(SYMBOL_SELECTOR)
      ? encodeAbiParameters([{ type: "string" }], [symbol])
      : undefined;
  const out = await renderOnFakeChain(
    <VaultDetail apiUrl="http://api" address={v.addr} fetchImpl={fetchFor(v)} />,
    fake,
  );
  await out.findByTestId("vault-detail-name");
  return out;
}

describe("VaultDetail TVL history total supply unit", () => {
  for (const v of VAULTS) {
    it(`${v.name} prints ${v.symbol}`, async () => {
      const out = await supplyCell(v, v.symbol);
      await vi.waitFor(() =>
        expect(out.getByTestId("vault-detail-tvl-supply").textContent).toBe(`1.00 ${v.symbol}`),
      );
    });

    it(`${v.name} falls back to the neutral label when symbol() is unreadable`, async () => {
      const out = await supplyCell(v, undefined);
      expect(out.getByTestId("vault-detail-tvl-supply").textContent).toBe("1.00 shares");
    });
  }
});

describe("shareSymbolOrNeutral", () => {
  it("accepts a plain ticker and rejects anything else", () => {
    expect(shareSymbolOrNeutral("rmAGENT")).toBe("rmAGENT");
    for (const bad of [undefined, null, "", 5, "a b", "<b>x</b>", "x".repeat(40)]) {
      expect(shareSymbolOrNeutral(bad)).toBe("shares");
    }
  });
});

describe("AgentPoliciesPanel share unit", () => {
  const policy = {
    agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
    authorized: true,
    withdrawalsEnabled: false,
    shareAllowance: "5000000000000000000000000",
  };
  const owner = "0x1111111111111111111111111111111111111111" as const;

  for (const v of VAULTS) {
    it(`prints ${v.symbol} when the vault is known`, () => {
      const { getByTestId } = render(
        <AgentPoliciesPanel
          ownerAddress={owner}
          policies={[{ ...policy, shareSymbol: v.symbol }]}
        />,
      );
      expect(getByTestId("agent-policy-stale-allowance-amount").textContent).toBe(
        `5.00 ${v.symbol}`,
      );
    });
  }

  it("prints the neutral label when no vault is known", () => {
    const { getByTestId } = render(<AgentPoliciesPanel ownerAddress={owner} policies={[policy]} />);
    expect(getByTestId("agent-policy-stale-allowance-amount").textContent).toBe("5.00 shares");
  });
});

describe("PortfolioPosition share unit", () => {
  const OWNER = "0x1111111111111111111111111111111111111111" as const;
  for (const v of VAULTS) {
    it(`${v.name} position prints ${v.symbol}`, async () => {
      const fake = makeFakeChain();
      fake.respond = (to, data) =>
        to === v.addr && data.startsWith(SYMBOL_SELECTOR)
          ? encodeAbiParameters([{ type: "string" }], [v.symbol])
          : undefined;
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          positions: [
            {
              vault_address: v.addr,
              vault_name: v.name,
              risk_label: v.risk,
              shares: "500000000000000000000000",
            },
          ],
          block_number: 10,
        }),
      })) as unknown as FetchLike;
      const out = await renderOnFakeChain(
        <PortfolioPosition address={OWNER} apiUrl="http://api" fetchImpl={fetchImpl} />,
        fake,
      );
      await out.findByTestId("portfolio-position-row-shares");
      await out.findAllByText(`0.50 ${v.symbol}`);
      await vi.waitFor(() =>
        expect(out.getByTestId("portfolio-position-row-shares").textContent).toBe(
          `0.50 ${v.symbol}`,
        ),
      );
    });
  }
});
