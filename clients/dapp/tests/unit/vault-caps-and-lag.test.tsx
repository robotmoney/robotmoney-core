/**
 * Issue 1741: caps and headroom are the vault's real `tvlCap()` / `perDepositCap()` (or "unknown"), and the
 * indexer-behind line measures the INDEX block, not the block of the vault's last snapshot.
 *
 * Rehearsal numbers: USDC vault TVL cap 1000 USDC, per-deposit cap 100 USDC, 1.000045 USDC deposited, so the
 * headroom is 998.999955 USDC. The explorer used to send deposit_cap "0" and the dapp showed 0.00 USDC.
 */
import { describe, expect, it, vi } from "vitest";
import { VaultDetail } from "../../src/components/VaultDetail";
import { VaultList } from "../../src/components/VaultList";
import { ExplorerProvider } from "../../src/lib/ExplorerContext";
import { formatUsdcCapString } from "../../src/lib/format";
import type {
  FetchLike,
  VaultDetailResponse,
  VaultDetailRow,
  VaultRow,
  VaultsResponse,
} from "../../src/lib/explorerApi";
import { makeFakeChain, renderOnFakeChain } from "./helpers/fakeChain";

const ADDR = "0xde5cce7ccfc4ce1997bd93ec7bbd7085ce55f574";

const detailRow = (over: Partial<VaultDetailRow> = {}): VaultDetailRow => ({
  chain_id: 8453,
  address: ADDR,
  name: "Robot Money USDC",
  risk_label: "STABLE_YIELD",
  status: 0,
  deposits_paused: false,
  tvl_cap: "1000000000",
  per_deposit_cap: "100000000",
  headroom: "998999955",
  snapshot_block: 52401831,
  tvl_history: [
    {
      block_number: 52401831,
      total_assets: "1000045",
      total_supply: "1000000000000000000000000",
      indexed_at: "2026-10-10T12:48:17Z",
    },
  ],
  indexed_at: "2026-10-10T12:48:14Z",
  ...over,
});

const detailFetch = (res: VaultDetailResponse): FetchLike =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => res })) as unknown as FetchLike;

const detailRes = (
  vault: VaultDetailRow,
  block: number,
  head: number | null,
): VaultDetailResponse => ({
  vault,
  block_number: block,
  chain_head_block: head,
  indexed_at: "2026-10-10T12:48:17Z",
});

async function renderDetail(res: VaultDetailResponse) {
  const out = await renderOnFakeChain(
    <VaultDetail apiUrl="http://api" address={ADDR} fetchImpl={detailFetch(res)} />,
    makeFakeChain(),
  );
  await out.findByTestId("vault-detail-name");
  return out;
}

describe("formatUsdcCapString", () => {
  it("formats a real cap with the shared USDC formatter", () => {
    expect(formatUsdcCapString("1000000000")).toBe("1,000.00 USDC");
    expect(formatUsdcCapString("15000000")).toBe("15.00 USDC");
    expect(formatUsdcCapString("998999955")).toBe("998.999955 USDC");
  });
  it("null, absent and junk are 'unknown', never 0.00 USDC", () => {
    for (const v of [null, undefined, "", "abc", "-1", "1.5"]) {
      expect(formatUsdcCapString(v)).toBe("unknown");
    }
  });
  it("a real zero stays 0.00 USDC", () => {
    expect(formatUsdcCapString("0")).toBe("0.00 USDC");
  });
  it("the contract's no-cap value (2^256-1) reads unlimited", () => {
    expect(formatUsdcCapString((2n ** 256n - 1n).toString())).toBe("unlimited");
  });
});

describe("VaultDetail caps", () => {
  it("shows the TVL cap, the per-deposit cap and the headroom", async () => {
    const { getByTestId } = await renderDetail(detailRes(detailRow(), 52424271, 52424276));
    expect(getByTestId("vault-detail-cap").textContent).toBe("1,000.00 USDC");
    expect(getByTestId("vault-detail-per-deposit-cap").textContent).toBe("100.00 USDC");
    expect(getByTestId("vault-detail-headroom").textContent).toBe("998.999955 USDC");
  });

  it("Agent Tokens: 100 USDC TVL cap and 15 USDC per-deposit cap", async () => {
    const { getByTestId } = await renderDetail(
      detailRes(
        detailRow({ tvl_cap: "100000000", per_deposit_cap: "15000000", headroom: "100000000" }),
        52424271,
        52424276,
      ),
    );
    expect(getByTestId("vault-detail-cap").textContent).toBe("100.00 USDC");
    expect(getByTestId("vault-detail-per-deposit-cap").textContent).toBe("15.00 USDC");
  });

  it("unknown caps (null) read 'unknown', not 0.00 USDC", async () => {
    const { getByTestId } = await renderDetail(
      detailRes(
        detailRow({ tvl_cap: null, per_deposit_cap: null, headroom: null }),
        52424271,
        52424276,
      ),
    );
    for (const id of [
      "vault-detail-cap",
      "vault-detail-per-deposit-cap",
      "vault-detail-headroom",
    ]) {
      expect(getByTestId(id).textContent).toBe("unknown");
    }
  });

  it("an explorer that does not send the cap fields reads 'unknown'", async () => {
    const { getByTestId } = await renderDetail(
      detailRes(
        detailRow({
          tvl_cap: undefined,
          per_deposit_cap: undefined,
          headroom: undefined,
        }),
        52424271,
        52424276,
      ),
    );
    expect(getByTestId("vault-detail-cap").textContent).toBe("unknown");
  });
});

describe("VaultDetail indexer lag line", () => {
  it("a healthy index with an old snapshot is not 'behind': the line uses the index block", async () => {
    // Index block 52424271, head 52424276 (5 behind). The last snapshot is 22k blocks older.
    const { getByTestId } = await renderDetail(detailRes(detailRow(), 52424271, 52424276));
    const line = getByTestId("vault-detail-freshness");
    expect(line.textContent).toBe("Block 52424271");
    expect(line.getAttribute("data-index-stale")).toBe("false");
    expect(line.textContent).not.toContain("behind");
    // The snapshot block is labelled separately.
    expect(getByTestId("vault-detail-freshness-snapshot").textContent).toBe(
      "Latest snapshot block 52401831",
    );
  });

  it("a really stale index still says how far behind it is", async () => {
    const { getByTestId } = await renderDetail(detailRes(detailRow(), 52418776, 52424276));
    const line = getByTestId("vault-detail-freshness");
    expect(line.textContent).toBe("Block 52418776 · indexer 5500 blocks behind (head 52424276)");
    expect(line.getAttribute("data-index-stale")).toBe("true");
  });
});

describe("VaultList caps", () => {
  const row = (over: Partial<VaultRow>): VaultRow => ({
    chain_id: 8453,
    address: ADDR,
    name: "Robot Money USDC",
    risk_label: "STABLE_YIELD",
    status: 0,
    deposits_paused: false,
    tvl_cap: "1000000000",
    per_deposit_cap: "100000000",
    headroom: "998999955",
    snapshot_block: 52401831,
    total_assets: "1000045",
    exit_fee_bps: 0,
    indexed_at: "2026-10-10T12:48:14Z",
    ...over,
  });
  const listFetch = (vaults: VaultRow[]): FetchLike => {
    const body: VaultsResponse = {
      vaults,
      block_number: 52424271,
      chain_head_block: 52424276,
      indexed_at: "2026-10-10T12:48:17Z",
    };
    return vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/v1/stats")
          ? { total_tvl: "0", unique_depositors: 0, activity_feed: [], ...body }
          : body,
    })) as unknown as FetchLike;
  };

  it("shows both caps and the headroom, and 'unknown' (not 0.00 USDC) for a cap that could not be read", async () => {
    const other = "0x323dc47ea32a3203f0418dda0ae6a8bacd885c7a";
    const { findAllByTestId } = await renderOnFakeChain(
      <ExplorerProvider
        apiUrl="http://api"
        fetchImpl={listFetch([
          row({}),
          row({
            address: other,
            name: "Robot Money Agent Tokens",
            tvl_cap: null,
            per_deposit_cap: "15000000",
            headroom: null,
          }),
        ])}
      >
        <VaultList />
      </ExplorerProvider>,
      makeFakeChain(),
    );
    const cell = async (id: string) => (await findAllByTestId(id)).map((n) => n.textContent);
    expect(await cell("vault-list-row-tvl-cap")).toEqual(["1,000.00 USDC", "unknown"]);
    expect(await cell("vault-list-row-per-deposit-cap")).toEqual(["100.00 USDC", "15.00 USDC"]);
    expect(await cell("vault-list-row-headroom")).toEqual(["998.999955 USDC", "unknown"]);
  });

  describe("headroom is a number only when deposits are open", () => {
    const cases: [string, Partial<VaultRow>, string][] = [
      ["open (fresh index, not paused)", {}, "998.999955 USDC"],
      ["paused flag from the index", { deposits_paused: true }, "n/a (deposits closed)"],
      ["registry says deposits paused", { status: 1 }, "n/a (deposits closed)"],
      ["registry says retired", { status: 2 }, "n/a (deposits closed)"],
      ["deposit state unknown (no flag)", { deposits_paused: null }, "unknown"],
      ["open but headroom unknown", { headroom: null }, "unknown"],
    ];
    for (const [name, over, want] of cases) {
      it(`${name}: ${want}`, async () => {
        const { findByTestId } = await renderOnFakeChain(
          <ExplorerProvider apiUrl="http://api" fetchImpl={listFetch([row(over)])}>
            <VaultList />
          </ExplorerProvider>,
          makeFakeChain(),
        );
        expect((await findByTestId("vault-list-row-headroom")).textContent).toBe(want);
      });
    }

    it("the column is labelled as a TVL snapshot figure", async () => {
      const { findByText } = await renderOnFakeChain(
        <ExplorerProvider apiUrl="http://api" fetchImpl={listFetch([row({})])}>
          <VaultList />
        </ExplorerProvider>,
        makeFakeChain(),
      );
      expect(await findByText("TVL headroom (snapshot)")).toBeTruthy();
    });
  });
});

describe("VaultDetail headroom by deposit state", () => {
  const states: [string, Partial<VaultDetailRow>, string][] = [
    ["open", {}, "998.999955 USDC"],
    ["paused", { deposits_paused: true }, "n/a (deposits closed)"],
    ["registry paused", { status: 1 }, "n/a (deposits closed)"],
    ["retired", { status: 2 }, "n/a (deposits closed)"],
    ["unknown deposit state", { deposits_paused: null }, "unknown"],
  ];
  for (const [name, over, want] of states) {
    it(`${name}: ${want}`, async () => {
      const { getByTestId, getByText } = await renderDetail(
        detailRes(detailRow(over), 52424271, 52424276),
      );
      expect(getByTestId("vault-detail-headroom").textContent).toBe(want);
      expect(getByText("TVL headroom (snapshot)")).toBeTruthy();
    });
  }
});
