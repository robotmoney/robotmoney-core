// Core 1820 (QA plan U5 with D3): the position card shows the holder's exclusion claim.
//
// USDC recovered from an adapter a RobotMoneyVault excluded is owed pro rata to the holders at the moment
// of exclusion, including holders who exited since. The card reads `vault.exclusionLedger()` and then
// `ledger.claimableTotal(holder)` on chain (a fake EIP-1193 transport here, real wagmi hooks), never from
// the explorer, and shows the amount only when there is one.
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import { PortfolioPosition } from "../../src/components/PortfolioPosition";
import { VaultPositionCard } from "../../src/components/shared";
import type { FetchLike } from "../../src/lib/explorerApi";
import { makeFakeChain, renderOnFakeChain } from "./helpers/fakeChain";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x9999999999999999999999999999999999999999" as const;
const VAULT = "0x00000000000000000000000000000000000000a1";
const BASKET = "0x00000000000000000000000000000000000000a2";
const LEDGER = "0x00000000000000000000000000000000000000c1";
const LEDGER_SELECTOR = toFunctionSelector("exclusionLedger()");
const CLAIMABLE_SELECTOR = toFunctionSelector("claimableTotal(address)");

/** A chain where VAULT has a ledger owing `claim` USDC to OWNER, and BASKET has none. */
function chainOwing(claim: bigint) {
  const fake = makeFakeChain();
  fake.respond = (to, data) => {
    if (to === VAULT && data.startsWith(LEDGER_SELECTOR)) {
      return encodeAbiParameters([{ type: "address" }], [LEDGER]);
    }
    if (to === LEDGER && data.startsWith(CLAIMABLE_SELECTOR)) {
      const holder = `0x${data.slice(-40)}`.toLowerCase();
      return encodeAbiParameters([{ type: "uint256" }], [holder === OWNER ? claim : 0n]);
    }
    return undefined; // a basket vault's exclusionLedger() reverts; symbol() reverts too
  };
  return fake;
}

const positions = (rows: { vault: string; shares: string }[]): FetchLike =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      positions: rows.map((r) => ({
        vault_address: r.vault,
        vault_name: `Vault ${r.vault.slice(-2)}`,
        risk_label: "STABLE_YIELD",
        shares: r.shares,
      })),
      block_number: 10,
    }),
  })) as unknown as FetchLike;

const ONE_SHARE = "1000000000000000000000000";

describe("PortfolioPosition shows the exclusion claim on the position card", () => {
  it("shows the USDC a holder can claim on its vault's card", async () => {
    const fake = chainOwing(1_500_000n);
    const out = await renderOnFakeChain(
      <PortfolioPosition
        address={OWNER}
        apiUrl="http://api"
        fetchImpl={positions([{ vault: VAULT, shares: ONE_SHARE }])}
      />,
      fake,
    );
    const claim = await out.findByTestId("vault-position-card-exclusion-claim");
    expect(claim.textContent).toMatch(/^1\.50 USDC$/);
    expect(out.getByTestId("vault-position-card-exclusion-note").textContent).toMatch(
      /stays claimable even after a full redeem/,
    );
    // The two reads went to the vault and then to its ledger, on chain.
    const calls = fake.calls.filter((c) => c.method === "eth_call");
    expect(
      calls.some((c) => c.to?.toLowerCase() === VAULT && c.data?.startsWith(LEDGER_SELECTOR)),
    ).toBe(true);
    expect(
      calls.some((c) => c.to?.toLowerCase() === LEDGER && c.data?.startsWith(CLAIMABLE_SELECTOR)),
    ).toBe(true);
  });

  it("shows no claim row for a basket vault (no ledger) or a zero claim", async () => {
    const out = await renderOnFakeChain(
      <PortfolioPosition
        address={OTHER}
        apiUrl="http://api"
        fetchImpl={positions([
          { vault: VAULT, shares: ONE_SHARE },
          { vault: BASKET, shares: ONE_SHARE },
        ])}
      />,
      chainOwing(1_500_000n),
    );
    await out.findAllByTestId("vault-position-card");
    // Give the two-stage read time to land; OTHER is owed nothing and BASKET has no ledger.
    await new Promise((r) => setTimeout(r, 200));
    expect(out.queryByTestId("vault-position-card-exclusion")).toBeNull();
  });

  it("an exiter with no indexed position still sees the claim on the deployment's vault", async () => {
    const out = await renderOnFakeChain(
      <PortfolioPosition address={OWNER} apiUrl="http://api" fetchImpl={positions([])} />,
      chainOwing(2_000_000n),
      { env: { VITE_VAULT_ADDRESS: VAULT } },
    );
    await out.findByTestId("portfolio-position-empty");
    const row = await out.findByTestId("portfolio-position-exclusion-only-row");
    expect(row.textContent).toContain(VAULT);
    expect(row.textContent).toMatch(/2\.00 USDC/);
    expect(row.textContent).toMatch(/stays claimable after a full exit/);
  });
});

describe("VaultPositionCard exclusion row", () => {
  const props = { vaultAddress: VAULT, vaultName: "rm vault", shares: "1.00 rmUSDC" };

  it("renders the claim when the parent passes one", () => {
    const { getByTestId } = render(<VaultPositionCard {...props} exclusionClaim="3.25 USDC" />);
    expect(getByTestId("vault-position-card-exclusion-claim").textContent).toBe("3.25 USDC");
  });

  it("renders no claim row otherwise", () => {
    const { queryByTestId } = render(<VaultPositionCard {...props} />);
    expect(queryByTestId("vault-position-card-exclusion")).toBeNull();
  });
});
