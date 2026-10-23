/**
 * Core 1912 (ADR-0017, ADR-0009): a Retired rmAGENT is withdraw-only in the dapp.
 *
 * The chosen presentation (recorded in docs/code-review/20261022-code-review-internal-claude-retire-rmagent.md):
 *   - the vault detail page labels the vault "Retired" (data-deposit-state="retired") with the reason
 *     "takes no deposits. Withdraw and redeem stay open." and renders NO deposit control;
 *   - the portfolio keeps the holder's position and its redeem value, with NO deposit control;
 *   - `vaultDepositState` and `useDepositStates` return a non-depositable state whatever the chain says
 *     (a live `depositsPaused() == false` does not reopen a registry-Retired vault).
 *
 * The chain is the fake EIP-1193 transport (helpers/fakeChain.tsx) behind the real wagmi hooks. Nothing is
 * mocked inside the components under test.
 */
import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import { VaultDetail } from "../../src/components/VaultDetail";
import { PortfolioPosition } from "../../src/components/PortfolioPosition";
import { ExplorerProvider } from "../../src/lib/ExplorerContext";
import { useDepositStates } from "../../src/lib/useDepositStates";
import type { FetchLike, VaultDetailResponse, VaultsResponse } from "../../src/lib/explorerApi";
import {
  depositStateLabel,
  depositStateReason,
  depositsBlocked,
  depositsOpen,
  resolveDepositState,
} from "../../src/lib/vaultDepositState";
import { makeFakeChain, renderOnFakeChain } from "./helpers/fakeChain";

const RMAGENT = "0x00000000000000000000000000000000000000a9";
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const PREVIEW_REDEEM = toFunctionSelector("previewRedeem(uint256)");
const word = (v: bigint) => encodeAbiParameters([{ type: "uint256" }], [v]);

const RETIRED = 2;

function vaultsBody(): VaultsResponse {
  return {
    vaults: [
      {
        chain_id: 8453,
        address: RMAGENT,
        name: "rmAGENT",
        risk_label: "VOLATILE",
        status: RETIRED,
        tvl_cap: "0",
        total_assets: "1000000",
        exit_fee_bps: 0,
        indexed_at: "2026-10-23T00:00:00Z",
        deposits_paused: false,
      },
    ],
    block_number: 1000,
    chain_head_block: 1005,
    indexed_at: "2026-10-23T00:00:00Z",
  };
}

const jsonFetch = (route: (url: string) => unknown): FetchLike =>
  vi.fn(async (url: string) => ({
    ok: true as const,
    status: 200,
    json: async () => route(url),
  })) as unknown as FetchLike;

function detailBody(): VaultDetailResponse {
  const v = vaultsBody().vaults[0]!;
  return {
    vault: { ...v, per_deposit_cap: "0", tvl_history: [] },
    block_number: 1000,
    indexed_at: "2026-10-23T00:00:00Z",
  } as unknown as VaultDetailResponse;
}

function depositControls(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll("button"))
    .map((b) => (b.textContent ?? "") + " " + (b.getAttribute("data-testid") ?? ""))
    .filter((t) => /deposit|approve/i.test(t));
}

describe("vaultDepositState: a Retired vault is not depositable", () => {
  it("registry Retired is retired, blocked and never Active, whatever the chain and index say", () => {
    for (const extra of [
      {},
      { chainPaused: false },
      { chainPaused: true },
      { explorerPaused: false, explorerBlock: 1000, explorerHead: 1000 },
    ]) {
      const s = resolveDepositState({ registryStatus: RETIRED, ...extra });
      expect(s.kind).toBe("retired");
      expect(depositsOpen(s)).toBe(false);
      expect(depositsBlocked(s)).toBe(true);
      expect(depositStateLabel(s)).toBe("Retired");
      expect(depositStateReason(s)).toContain("takes no deposits");
      expect(depositStateReason(s)).toContain("Withdraw and redeem stay open");
    }
  });
});

describe("useDepositStates: a Retired rmAGENT is non-depositable", () => {
  function Probe() {
    const states = useDepositStates([RMAGENT]);
    const s = states.get(RMAGENT);
    return (
      <p
        data-testid="probe"
        data-kind={s?.kind ?? "none"}
        data-blocked={String(!s || depositsBlocked(s))}
      />
    );
  }

  it("stays retired and blocked while the vault's own depositsPaused() reads false", async () => {
    const fake = makeFakeChain({ [RMAGENT]: false });
    const out = await renderOnFakeChain(
      <ExplorerProvider apiUrl="http://api" fetchImpl={jsonFetch(() => vaultsBody())}>
        <Probe />
      </ExplorerProvider>,
      fake,
    );
    await waitFor(() => expect(out.getByTestId("probe").getAttribute("data-kind")).toBe("retired"));
    expect(out.getByTestId("probe").getAttribute("data-blocked")).toBe("true");
  });
});

describe("VaultDetail: a Retired rmAGENT renders withdraw-only", () => {
  it("labels the vault Retired, says withdraw and redeem stay open, and has no deposit control", async () => {
    const out = await renderOnFakeChain(
      <ExplorerProvider apiUrl="http://api" fetchImpl={jsonFetch(() => vaultsBody())}>
        <VaultDetail
          apiUrl="http://api"
          address={RMAGENT}
          fetchImpl={jsonFetch(() => detailBody())}
        />
      </ExplorerProvider>,
      makeFakeChain({ [RMAGENT]: false }),
    );
    const status = await out.findByTestId("vault-detail-status");
    await waitFor(() => expect(status.textContent).toBe("Retired"));
    expect(status.getAttribute("data-deposit-state")).toBe("retired");
    expect(out.getByTestId("vault-detail-deposits-closed").textContent).toContain(
      "Withdraw and redeem stay open",
    );
    expect(out.container.textContent).not.toContain("Active");
    expect(out.container.querySelector("form, input")).toBeNull();
    expect(depositControls(out.container)).toEqual([]);
  });
});

describe("PortfolioPosition: a holder of a Retired rmAGENT keeps the position, with no deposit control", () => {
  it("shows the position at its redeem value with no deposit or approve control", async () => {
    const fake = makeFakeChain();
    fake.respond = (to, data) => {
      if (to !== RMAGENT) return undefined;
      if (data.startsWith(PREVIEW_REDEEM)) return word(47_500_000n);
      return undefined;
    };
    const fetchImpl = jsonFetch(() => ({
      address: OWNER,
      positions: [
        {
          vault: RMAGENT,
          shares: "50000000000000000000000000",
          usdc_value: "47500000",
          block_number: 10,
          indexed_at: "2026-10-23T00:00:00Z",
        },
      ],
      block_number: 10,
      indexed_at: "2026-10-23T00:00:00Z",
    }));
    const out = await renderOnFakeChain(
      <PortfolioPosition address={OWNER} apiUrl="http://api" fetchImpl={fetchImpl} />,
      fake,
    );
    await out.findByTestId("vault-position-card");
    await waitFor(() =>
      expect(out.getByTestId("vault-position-card-usdc").textContent).toBe("47.50 USDC"),
    );
    expect(out.container.querySelector("form, input")).toBeNull();
    expect(depositControls(out.container)).toEqual([]);
  });
});
