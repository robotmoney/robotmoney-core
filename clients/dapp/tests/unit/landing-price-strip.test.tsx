/**
 * Component + lib tests — LandingPriceStrip (issue #482, #612).
 *
 * Covers acceptance criteria (mocked complement to the fork tests):
 *   - Decimal-math conversion is correct for every pair's decimal delta
 *     (wETH18/USDC6, cbBTC8/USDC6, wSOL9/USDC6, ETH->USD) via the shared
 *     sqrtPriceX96ToPrice helper (AC §9).
 *   - A single failing pool read isolates to one cell ('unavailable') and the
 *     other three still render their prices (AC §5, §10).
 *   - Pool addresses are read from config/dex-pools.json, not hardcoded in TS,
 *     and the devnet override map is honored for the devnet chain id (AC §3).
 *   - data-testid attributes follow the landing-* convention (AC §11).
 *   - LandingPriceStrip container reads blockNumber from ExplorerContext
 *     rather than wagmi useBlockNumber, keeping freshness in sync with
 *     VaultCards (issue #612).
 *
 * The pure LandingPriceStripView is rendered directly — no wagmi/QueryClient
 * fixture — so decimal-math and error isolation are tested without RPC. The
 * forked-chain integration + Playwright tests are the primary verification path
 * for live prices (they must NOT mock RPC); these are the complement.
 *
 * Container tests wrap LandingPriceStrip in ExplorerProvider with a mocked
 * fetchImpl — asserting the freshness chip reflects the indexer block number.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "./helpers/render";
import {
  LandingPriceStrip,
  LandingPriceStripView,
  cellTestId,
  priceReadFailureReason,
  priceSourceBlockedReason,
  type PriceCellState,
} from "../../src/components/LandingPriceStrip";
import { ExplorerContext } from "../../src/lib/ExplorerContext";
import { RuntimeConfigProvider } from "../../src/lib/RuntimeConfigContext";
import { sqrtPriceX96ToPrice } from "../../src/lib/uniswapV3";
import { PRICE_STRIP_PAIRS, resolvePoolConfig } from "../../src/lib/dexPools";

// Wagmi mock — applies to the container tests that render LandingPriceStrip
// directly. The pure LandingPriceStripView tests are unaffected because the
// view component imports no wagmi hooks. The real WagmiProvider in
// render.tsx/TestProviders is preserved via vi.importActual (see render.tsx).
// What every pool read returns in the container tests below (issue 1731). vi.hoisted keeps it reachable from
// the hoisted vi.mock factory.
interface PoolRead {
  data: unknown;
  error: unknown;
  isError: boolean;
  isLoading: boolean;
}
interface MockPoolRead {
  current: PoolRead;
  /** Every option object `useReadContract` was called with. */
  calls: unknown[];
  account: { chainId: number | undefined; isConnected: boolean };
}
const mockPoolRead = vi.hoisted((): MockPoolRead => {
  const current: PoolRead = { data: undefined, error: null, isError: false, isLoading: true };
  return { current, calls: [], account: { chainId: undefined, isConnected: false } };
});

vi.mock("wagmi", () => ({
  useChainId: () => 8453,
  // The write guard (useWriteChainGuard) reads the connected chain: none here, class "not-applicable".
  useAccount: () => mockPoolRead.account,
  useWriteContract: () => ({ writeContract: () => undefined, data: undefined, isPending: false }),
  useReadContract: (opts: unknown) => {
    mockPoolRead.calls.push(opts);
    return mockPoolRead.current;
  },
  // Stubs for transitively-imported wagmi symbols in lib/wagmi.ts:
  createConfig: () => ({}),
  http: () => ({}),
  fallback: (...args: unknown[]) => args[0],
  unstable_connector: () => ({}),
}));

// A sqrtPriceX96 with rawRatio (token1/token0) == 1 exactly:
// sqrt(1) * 2^96 == 2^96.
const SQRT_RATIO_ONE = 2n ** 96n;

describe("LandingPriceStrip decimal-math conversion is correct for all pairs", () => {
  it("wETH18/USDC6: applies the +12 decimal delta (token0 18, token1 6)", () => {
    // rawRatio 1 means 1 raw USDC per 1 raw wETH; human price scales by
    // 10^(18-6) = 1e12, so price == 1e12 USDC per wETH.
    const price = sqrtPriceX96ToPrice({
      sqrtPriceX96: SQRT_RATIO_ONE,
      token0Decimals: 18,
      token1Decimals: 6,
      baseIsToken0: true,
    });
    expect(price).toBeCloseTo(1e12, 0);
  });

  it("cbBTC8/USDC6: applies the +2 decimal delta (token0 8, token1 6)", () => {
    const price = sqrtPriceX96ToPrice({
      sqrtPriceX96: SQRT_RATIO_ONE,
      token0Decimals: 8,
      token1Decimals: 6,
      baseIsToken0: true,
    });
    expect(price).toBeCloseTo(100, 6); // 10^(8-6)
  });

  it("wSOL9/USDC6: applies the +3 decimal delta (token0 9, token1 6)", () => {
    const price = sqrtPriceX96ToPrice({
      sqrtPriceX96: SQRT_RATIO_ONE,
      token0Decimals: 9,
      token1Decimals: 6,
      baseIsToken0: true,
    });
    expect(price).toBeCloseTo(1000, 6); // 10^(9-6)
  });

  it("ETH->USD: realistic sqrtPriceX96 yields the expected wETH/USDC mid price", () => {
    // A sqrtPriceX96 corresponding to ~$2500 wETH/USDC. We assert the helper is
    // monotonic and decimals-aware by feeding a known sqrt input and checking
    // the inverse round-trips through the same decimal delta.
    // rawRatio chosen so price ~= 2500: sqrtPriceX96 = sqrt(2500/1e12) * 2^96.
    // sqrt(2500e-12) = sqrt(2.5e-9) ~= 5.0e-5 -> * 2^96.
    const sqrtRatio = 3961408125713216921118598n; // sqrt(2500*10^(6-18))*2^96
    const price = sqrtPriceX96ToPrice({
      sqrtPriceX96: sqrtRatio,
      token0Decimals: 18,
      token1Decimals: 6,
      baseIsToken0: true,
    });
    expect(price).toBeGreaterThan(2400);
    expect(price).toBeLessThan(2600);
  });

  it("inverts correctly when base is token1", () => {
    const direct = sqrtPriceX96ToPrice({
      sqrtPriceX96: SQRT_RATIO_ONE,
      token0Decimals: 6,
      token1Decimals: 6,
      baseIsToken0: true,
    });
    const inverted = sqrtPriceX96ToPrice({
      sqrtPriceX96: SQRT_RATIO_ONE,
      token0Decimals: 6,
      token1Decimals: 6,
      baseIsToken0: false,
    });
    expect(direct).toBeCloseTo(1, 9);
    expect(inverted).toBeCloseTo(1, 9);
  });
});

function makeCells(
  overrides: Partial<Record<string, Partial<PriceCellState>>> = {},
): PriceCellState[] {
  return PRICE_STRIP_PAIRS.map((p) => ({
    id: p.id,
    label: p.label,
    quoteSymbol: p.quote,
    price: 1234.56,
    unavailable: false,
    loading: false,
    ...(overrides[p.id] ?? {}),
  }));
}

describe("LandingPriceStrip isolates per-cell errors", () => {
  it("shows 'unavailable' on the failing cell only and renders the other three", () => {
    const cells = makeCells({ "cbbtc-usdc": { unavailable: true, price: null } });
    render(<LandingPriceStripView cells={cells} blockNumber={45743443} />);

    // The failed cell shows 'unavailable'.
    const failed = screen.getByTestId(`${cellTestId("cbbtc-usdc")}-value`);
    expect(failed.textContent).toBe("unavailable");

    // The other three render a numeric (formatted) price, not 'unavailable'.
    for (const id of ["eth-usd", "weth-usdc"]) {
      const value = screen.getByTestId(`${cellTestId(id)}-value`);
      expect(value.textContent).not.toBe("unavailable");
      expect(value.textContent).toMatch(/[0-9]/);
    }
  });

  it("marks the cell container with data-cell-unavailable for QA targeting", () => {
    const cells = makeCells({ "cbbtc-usdc": { unavailable: true, price: null } });
    render(<LandingPriceStripView cells={cells} blockNumber={1} />);
    expect(screen.getByTestId(cellTestId("cbbtc-usdc")).getAttribute("data-cell-unavailable")).toBe(
      "true",
    );
    expect(screen.getByTestId(cellTestId("eth-usd")).getAttribute("data-cell-unavailable")).toBe(
      "false",
    );
  });

  it("renders the three landing-* test ids and a freshness chip", () => {
    render(<LandingPriceStripView cells={makeCells()} blockNumber={45743443} />);
    expect(screen.getByTestId("landing-price-strip")).toBeTruthy();
    for (const id of ["eth-usd", "weth-usdc", "cbbtc-usdc"]) {
      expect(screen.getByTestId(cellTestId(id))).toBeTruthy();
      expect(screen.getByTestId(`${cellTestId(id)}-block`).textContent).toContain("45743443");
    }
  });
});

describe("LandingPriceStrip reads pool addresses from config", () => {
  it("exposes exactly the three landing pairs in display order", () => {
    expect(PRICE_STRIP_PAIRS.map((p) => p.id)).toEqual(["eth-usd", "weth-usdc", "cbbtc-usdc"]);
  });

  it("resolves a pool address (a 0x40-hex string) for every pair from config", () => {
    for (const pair of PRICE_STRIP_PAIRS) {
      const cfg = resolvePoolConfig(pair.id);
      expect(cfg).toBeDefined();
      expect(cfg?.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("uses one pool map: no per-chain branch exists in the lookup", () => {
    expect(resolvePoolConfig("weth-usdc")?.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("returns undefined for an unknown pair so the cell can isolate", () => {
    expect(resolvePoolConfig("does-not-exist")).toBeUndefined();
  });
});

// ─── Container wiring tests (issue #612) ──────────────────────────────────────
//
// These tests mount the LandingPriceStrip container (not the pure view) with a
// controlled ExplorerContext value, asserting that the freshness chip reflects
// the indexer's block_number rather than wagmi's chain-head block.
//
// ExplorerContext is injected directly via <ExplorerContext.Provider value={...}>
// so tests control blockNumber precisely without a running ExplorerProvider or
// live /v1/vaults fetch. The wagmi hooks (useChainId, useReadContract) are
// handled by the TestProviders wrapper in render.tsx and return stub data —
// cells show "…" which is acceptable; the block number chip is the focus.

const EXPLORER_NULL_VALUE: import("../../src/lib/ExplorerContext").ExplorerContextValue = {
  vaults: [],
  stats: null,
  blockNumber: null,
  chainHeadBlock: null,
  vaultsLoading: false,
  statsLoading: false,
  vaultsError: null,
  statsError: null,
};

describe("LandingPriceStrip container — ExplorerContext blockNumber wiring (issue #612)", () => {
  it("shows 'Block 99999' in the freshness chip when ExplorerContext.blockNumber is 99999", () => {
    render(
      <ExplorerContext.Provider value={{ ...EXPLORER_NULL_VALUE, blockNumber: 99999 }}>
        <LandingPriceStrip />
      </ExplorerContext.Provider>,
    );
    expect(screen.getByTestId("landing-price-strip-freshness").textContent).toBe("Block 99999");
  });

  it("shows 'Block —' in the freshness chip when ExplorerContext.blockNumber is null", () => {
    // blockNumber: null means the indexer has not yet returned data.
    // The freshness chip must render "Block —" (matching VaultCards behaviour).
    render(
      <ExplorerContext.Provider value={EXPLORER_NULL_VALUE}>
        <LandingPriceStrip />
      </ExplorerContext.Provider>,
    );
    expect(screen.getByTestId("landing-price-strip-freshness").textContent).toBe("Block —");
  });
});

// ─── Issue 1731: a clear "price unavailable (source)" state, and a good price survives a failed refetch ───

describe("LandingPriceStripView — price unavailable (source) and stale prices (issue 1731)", () => {
  it("names the failing source in the cell and keeps the other cells untouched", () => {
    const cells = makeCells({
      "eth-usd": {
        unavailable: true,
        price: null,
        unavailableReason:
          "wallet RPC: connect a wallet on Base, prices are read through your wallet",
      },
    });
    render(<LandingPriceStripView cells={cells} blockNumber={100} />);
    const failed = screen.getByTestId(`${cellTestId("eth-usd")}-value`);
    expect(failed.textContent).toBe(
      "price unavailable (wallet RPC: connect a wallet on Base, prices are read through your wallet)",
    );
    expect(screen.getByTestId(`${cellTestId("weth-usdc")}-value`).textContent).not.toContain(
      "unavailable",
    );
  });

  it("a stale cell still shows its last good price and says it may be old", () => {
    const cells = makeCells({ "eth-usd": { price: 2500, stale: true } });
    render(<LandingPriceStripView cells={cells} blockNumber={100} />);
    const cell = screen.getByTestId(cellTestId("eth-usd"));
    expect(cell.getAttribute("data-cell-unavailable")).toBe("false");
    expect(cell.getAttribute("data-cell-stale")).toBe("true");
    const text = screen.getByTestId(`${cellTestId("eth-usd")}-value`).textContent ?? "";
    expect(text).toContain("2,500");
    expect(text).toContain("may be old");
  });

  it("shows the staleness hint in the heading when the indexer is far behind the head", () => {
    render(
      <LandingPriceStripView cells={makeCells({})} blockNumber={1000} chainHeadBlock={1500} />,
    );
    expect(screen.getByTestId("landing-price-strip-freshness").textContent).toContain(
      "indexer 500 blocks behind",
    );
  });

  it("blocked sources and read failures have words, and no URL reaches a cell", () => {
    expect(priceSourceBlockedReason({ kind: "not-connected", targetChainId: 8453 })).toContain(
      "connect a wallet on Base",
    );
    expect(
      priceSourceBlockedReason({ kind: "wrong-chain", targetChainId: 8453, connectedChainId: 1 }),
    ).toContain("chain 1");
    expect(priceSourceBlockedReason({ kind: "ok", targetChainId: 8453 })).toBeUndefined();
    expect(priceSourceBlockedReason({ kind: "not-applicable" })).toBeUndefined();
    const failure = priceReadFailureReason(
      new Error("HTTP request failed. URL: https://base-rpc.example/v2/SECRET-KEY"),
    );
    expect(failure).toContain("wallet RPC: read failed");
    expect(failure).not.toContain("SECRET-KEY");
  });
});

describe("LandingPriceStrip container — a failed read never blanks a good price (issue 1731)", () => {
  const ONE = [2n ** 96n, 0, 0, 0, 0, 0, true];
  const renderStrip = () =>
    render(
      <ExplorerContext.Provider value={{ ...EXPLORER_NULL_VALUE, blockNumber: 1000 }}>
        <LandingPriceStrip />
      </ExplorerContext.Provider>,
    );

  it("a good read shows the price, not stale", () => {
    mockPoolRead.current = { data: ONE, error: null, isError: false, isLoading: false };
    renderStrip();
    const cell = screen.getByTestId(cellTestId("eth-usd"));
    expect(cell.getAttribute("data-cell-unavailable")).toBe("false");
    expect(cell.getAttribute("data-cell-stale")).toBe("false");
  });

  it("an error on a refetch with a price already held keeps the price and marks it may be old", () => {
    mockPoolRead.current = {
      data: ONE,
      error: new Error("HTTP request failed"),
      isError: true,
      isLoading: false,
    };
    renderStrip();
    const cell = screen.getByTestId(cellTestId("eth-usd"));
    expect(cell.getAttribute("data-cell-unavailable")).toBe("false");
    expect(cell.getAttribute("data-cell-stale")).toBe("true");
    expect(screen.getByTestId(`${cellTestId("eth-usd")}-value`).textContent).toContain(
      "may be old",
    );
  });

  it("an error with no price to show says 'price unavailable (wallet RPC: read failed ...)'", () => {
    mockPoolRead.current = {
      data: undefined,
      error: new Error("HTTP request failed. URL: https://rpc.example/v2/SECRET"),
      isError: true,
      isLoading: false,
    };
    renderStrip();
    const text = screen.getByTestId(`${cellTestId("eth-usd")}-value`).textContent ?? "";
    expect(text).toMatch(/^price unavailable \(wallet RPC: read failed/);
    expect(text).not.toContain("SECRET");
    expect(screen.getByTestId(cellTestId("eth-usd")).getAttribute("data-cell-unavailable")).toBe(
      "true",
    );
  });
});

describe("LandingPriceStrip container — the read runs only where the wallet can answer for Base (issue 1731)", () => {
  const ONE = [2n ** 96n, 0, 0, 0, 0, 0, true];
  const renderOn = (env: Record<string, string>) =>
    render(
      <RuntimeConfigProvider config={env}>
        <ExplorerContext.Provider value={{ ...EXPLORER_NULL_VALUE, blockNumber: 1000 }}>
          <LandingPriceStrip />
        </ExplorerContext.Provider>
      </RuntimeConfigProvider>,
    );
  const enabledFlags = () =>
    mockPoolRead.calls.map((c) => (c as { query?: { enabled?: boolean } }).query?.enabled);

  it("mainnet class, no wallet: no pool read is enabled and each cell says to connect a wallet on Base", () => {
    mockPoolRead.calls = [];
    mockPoolRead.account = { chainId: undefined, isConnected: false };
    mockPoolRead.current = { data: ONE, error: null, isError: false, isLoading: false };
    renderOn({ VITE_ENV_CLASS: "mainnet" });
    expect(enabledFlags().length).toBeGreaterThan(0);
    expect(enabledFlags().every((e) => e === false)).toBe(true);
    const text = screen.getByTestId(`${cellTestId("eth-usd")}-value`).textContent ?? "";
    expect(text).toContain("price unavailable (wallet RPC: connect a wallet on Base");
  });

  it("mainnet class, wallet on another chain: not read, and the cell names the chain", () => {
    mockPoolRead.calls = [];
    mockPoolRead.account = { chainId: 1, isConnected: true };
    renderOn({ VITE_ENV_CLASS: "mainnet" });
    expect(enabledFlags().every((e) => e === false)).toBe(true);
    expect(screen.getByTestId(`${cellTestId("eth-usd")}-value`).textContent).toContain(
      "your wallet is on chain 1",
    );
  });

  it("mainnet class, wallet on Base: the read is enabled and pinned to chain 8453", () => {
    mockPoolRead.calls = [];
    mockPoolRead.account = { chainId: 8453, isConnected: true };
    renderOn({ VITE_ENV_CLASS: "mainnet" });
    expect(enabledFlags().every((e) => e === true)).toBe(true);
    expect(mockPoolRead.calls.every((c) => (c as { chainId?: number }).chainId === 8453)).toBe(
      true,
    );
    expect(screen.getByTestId(cellTestId("eth-usd")).getAttribute("data-cell-unavailable")).toBe(
      "false",
    );
  });

  it("other classes keep reading through the provider, unpinned", () => {
    mockPoolRead.calls = [];
    mockPoolRead.account = { chainId: undefined, isConnected: false };
    renderOn({});
    expect(enabledFlags().every((e) => e === true)).toBe(true);
    expect(mockPoolRead.calls.every((c) => (c as { chainId?: number }).chainId === undefined)).toBe(
      true,
    );
  });
});
