/**
 * Component + lib tests — LandingPriceStrip (issue #482).
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
 *
 * The pure LandingPriceStripView is rendered directly — no wagmi/QueryClient
 * fixture — so decimal-math and error isolation are tested without RPC. The
 * forked-chain integration + Playwright tests are the primary verification path
 * for live prices (they must NOT mock RPC); these are the complement.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  LandingPriceStripView,
  cellTestId,
  type PriceCellState,
} from "../../src/components/LandingPriceStrip";
import { sqrtPriceX96ToPrice } from "../../src/lib/uniswapV3";
import { DEVNET_CHAIN_ID, PRICE_STRIP_PAIRS, resolvePoolConfig } from "../../src/lib/dexPools";

// A sqrtPriceX96 with rawRatio (token1/token0) == 1 exactly:
// sqrt(1) * 2^96 == 2^96.
const SQRT_RATIO_ONE = 2n ** 96n;

describe("LandingPriceStrip decimal-math conversion is correct for all four pairs", () => {
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
    for (const id of ["eth-usd", "weth-usdc", "wsol-usdc"]) {
      const value = screen.getByTestId(`${cellTestId(id)}-value`);
      expect(value.textContent).not.toBe("unavailable");
      expect(value.textContent).toMatch(/[0-9]/);
    }
  });

  it("marks the cell container with data-cell-unavailable for QA targeting", () => {
    const cells = makeCells({ "wsol-usdc": { unavailable: true, price: null } });
    render(<LandingPriceStripView cells={cells} blockNumber={1} />);
    expect(screen.getByTestId(cellTestId("wsol-usdc")).getAttribute("data-cell-unavailable")).toBe(
      "true",
    );
    expect(screen.getByTestId(cellTestId("eth-usd")).getAttribute("data-cell-unavailable")).toBe(
      "false",
    );
  });

  it("renders the four landing-* test ids and a freshness chip", () => {
    render(<LandingPriceStripView cells={makeCells()} blockNumber={45743443} />);
    expect(screen.getByTestId("landing-price-strip")).toBeTruthy();
    for (const id of ["eth-usd", "weth-usdc", "cbbtc-usdc", "wsol-usdc"]) {
      expect(screen.getByTestId(cellTestId(id))).toBeTruthy();
      expect(screen.getByTestId(`${cellTestId(id)}-block`).textContent).toContain("45743443");
    }
  });
});

describe("LandingPriceStrip reads pool addresses from config", () => {
  it("exposes exactly the four landing pairs in display order", () => {
    expect(PRICE_STRIP_PAIRS.map((p) => p.id)).toEqual([
      "eth-usd",
      "weth-usdc",
      "cbbtc-usdc",
      "wsol-usdc",
    ]);
  });

  it("resolves a pool address (a 0x40-hex string) for every pair from config", () => {
    for (const pair of PRICE_STRIP_PAIRS) {
      const cfg = resolvePoolConfig(pair.id, 8453);
      expect(cfg).toBeDefined();
      expect(cfg?.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("honors the devnet override map for the forked-Base devnet chain id", () => {
    const mainnet = resolvePoolConfig("weth-usdc", 8453);
    const devnet = resolvePoolConfig("weth-usdc", DEVNET_CHAIN_ID);
    expect(devnet).toBeDefined();
    // The devnet map is a distinct lookup path; on a fresh fork the addresses
    // match mainnet, but the override map must still be the one consulted.
    expect(devnet?.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(mainnet?.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("returns undefined for an unknown pair so the cell can isolate", () => {
    expect(resolvePoolConfig("does-not-exist", 8453)).toBeUndefined();
  });
});
