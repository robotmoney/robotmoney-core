// Core 1795 (QA plan X8, findings E8 and F4): a position is shown at what a redeem pays, with the PRD's NAV
// disclaimer next to it.
//
// `convertToAssets` is the gross share of NAV and ignores exit costs; on rmAGENT it read about 3% above what
// a redeem paid. The card shows `vault.previewRedeem(shares)`, read on chain through the real wagmi hooks
// (a fake EIP-1193 transport here). Before this, no caller passed `usdcValues`, so every value was "—".
//
// The explorer rows below are in the API's own shape (`vault`, no name), which PortfolioPosition used to
// read as `vault_address` and crash on (the #1038 shape bug).
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import { PortfolioPosition } from "../../src/components/PortfolioPosition";
import { NAV_DISCLOSURE_TEXT, NavDisclosure, VaultPositionCard } from "../../src/components/shared";
import type { FetchLike } from "../../src/lib/explorerApi";
import { makeFakeChain, renderOnFakeChain } from "./helpers/fakeChain";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x00000000000000000000000000000000000000a3";
const PREVIEW_REDEEM = toFunctionSelector("previewRedeem(uint256)");
const CONVERT_TO_ASSETS = toFunctionSelector("convertToAssets(uint256)");
/** 50 shares at the 1e18 virtual offset. */
const SHARES = "50000000000000000000000000";

/** The PRD text, verbatim from docs/prd.md §9 "NAV disclosure in UIs". */
const PRD_NAV_DISCLAIMER =
  "NAV is the protocol's system-level valuation, used for growth limits and guards. Your share value = market price of underlying assets. See help for details.";

const word = (v: bigint) => encodeAbiParameters([{ type: "uint256" }], [v]);

/** An rmAGENT-like vault: gross 50.00 USDC, previewRedeem 47.50 USDC after the 5% slippage floor. */
function rmAgentChain() {
  const fake = makeFakeChain();
  fake.respond = (to, data) => {
    if (to !== VAULT) return undefined;
    if (data.startsWith(PREVIEW_REDEEM)) return word(47_500_000n);
    if (data.startsWith(CONVERT_TO_ASSETS)) return word(50_000_000n);
    return undefined; // symbol() and exclusionLedger() revert: neutral unit, no claim row
  };
  return fake;
}

/** `/v1/accounts/:address/positions` as the explorer API serialises it. */
function explorer(usdcValue: string | null): FetchLike {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      address: OWNER,
      positions: [
        {
          vault: VAULT,
          shares: SHARES,
          usdc_value: usdcValue,
          block_number: 10,
          indexed_at: "2026-10-14T00:00:00Z",
        },
      ],
      block_number: 10,
      indexed_at: "2026-10-14T00:00:00Z",
    }),
  })) as unknown as FetchLike;
}

describe("PortfolioPosition prices a position at previewRedeem", () => {
  it("position card renders previewRedeem value and the NAV disclaimer", async () => {
    const fake = rmAgentChain();
    // The explorer's snapshot value is older; the live previewRedeem read wins.
    const out = await renderOnFakeChain(
      <PortfolioPosition address={OWNER} apiUrl="http://api" fetchImpl={explorer("48000000")} />,
      fake,
    );
    await out.findByTestId("vault-position-card");
    await waitFor(() =>
      expect(out.getByTestId("vault-position-card-usdc").textContent).toBe("47.50 USDC"),
    );
    expect(out.getByTestId("portfolio-position-row-usdc").textContent).toBe("47.50 USDC");
    expect(out.getByTestId("portfolio-position-total").textContent).toContain("47.50 USDC");
    // The card and the table each carry the PRD disclaimer, word for word.
    expect(out.getByTestId("vault-position-card-nav-disclosure").textContent).toBe(
      PRD_NAV_DISCLAIMER,
    );
    expect(out.getByTestId("portfolio-position-nav-disclosure").textContent).toBe(
      PRD_NAV_DISCLAIMER,
    );
    // previewRedeem was read for the indexed shares; convertToAssets never was.
    const calls = fake.calls.filter(
      (c) => c.method === "eth_call" && c.to?.toLowerCase() === VAULT,
    );
    expect(calls.some((c) => c.data?.startsWith(PREVIEW_REDEEM))).toBe(true);
    expect(calls.some((c) => c.data?.startsWith(CONVERT_TO_ASSETS))).toBe(false);
    // The API row's `vault` key became the card's address (no #1038 crash).
    expect(out.getByTestId("vault-position-card-address").textContent).toBe(VAULT);
  });

  it("falls back to the explorer's previewRedeem value when the chain read fails", async () => {
    const fake = makeFakeChain(); // every eth_call reverts
    const out = await renderOnFakeChain(
      <PortfolioPosition address={OWNER} apiUrl="http://api" fetchImpl={explorer("47400000")} />,
      fake,
    );
    await out.findByTestId("vault-position-card");
    await waitFor(() =>
      expect(out.getByTestId("vault-position-card-usdc").textContent).toBe("47.40 USDC"),
    );
    expect(out.getByTestId("vault-position-card-nav-disclosure").textContent).toBe(
      PRD_NAV_DISCLAIMER,
    );
  });

  it("shows a dash and no card disclaimer when no source has a value", async () => {
    const out = await renderOnFakeChain(
      <PortfolioPosition address={OWNER} apiUrl="http://api" fetchImpl={explorer(null)} />,
      makeFakeChain(),
    );
    await out.findByTestId("vault-position-card");
    // Give the failing previewRedeem read time to settle.
    await new Promise((r) => setTimeout(r, 200));
    expect(out.getByTestId("vault-position-card-usdc").textContent).toBe("—");
    expect(out.queryByTestId("vault-position-card-nav-disclosure")).toBeNull();
  });
});

describe("NavDisclosure", () => {
  it("renders the PRD disclaimer verbatim", () => {
    expect(NAV_DISCLOSURE_TEXT).toBe(PRD_NAV_DISCLAIMER);
    const { getByTestId } = render(<NavDisclosure />);
    expect(getByTestId("nav-disclosure").textContent).toBe(PRD_NAV_DISCLAIMER);
  });

  it("the position card shows it only next to a value", () => {
    const props = { vaultAddress: VAULT, vaultName: "rmAGENT", shares: "50.00 rmAGENT" };
    const withValue = render(<VaultPositionCard {...props} usdcValue="47.50 USDC" />);
    expect(withValue.getByTestId("vault-position-card-nav-disclosure").textContent).toBe(
      PRD_NAV_DISCLAIMER,
    );
    withValue.unmount();
    const without = render(<VaultPositionCard {...props} />);
    expect(without.queryByTestId("vault-position-card-nav-disclosure")).toBeNull();
  });
});
