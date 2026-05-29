// Canonical: docs/prd.md#112-protocol-asset-vault

/**
 * LandingPriceStrip — compact four-cell live DEX price strip rendered above
 * VaultCards on the landing page (issue #482).
 *
 * Cells: ETH/USD, wETH/USDC, cbBTC/USDC, wSOL/USDC. Each price is the current
 * Uniswap V3 mid price read from the pool's `slot0().sqrtPriceX96` via
 * wagmi/useReadContract on the dapp's configured RPC — no off-chain price
 * source. Pool addresses come from `config/dex-pools.json` (chain-aware: the
 * devnet override map is used when the dapp targets the forked-Base devnet).
 *
 * Each cell shows the block number the price was read at (matching the
 * VaultCards freshness-chip pattern) and a small freshness indicator. Errors
 * are isolated per-cell: a single failing pool read renders 'unavailable' on
 * that cell only and leaves the other three untouched.
 *
 * Split into a pure presentational `LandingPriceStripView` (decimal-math and
 * error-isolation are unit-tested against it directly, no wagmi fixture) and a
 * `LandingPriceStrip` container that wires `useReadContract` per pool. This
 * mirrors the BalancesPanelView pattern (docs/development/react-guide.md
 * §Layout).
 */
import { useBlockNumber, useChainId, useReadContract } from "wagmi";
import {
  PRICE_STRIP_PAIRS,
  resolvePoolConfig,
  type PairMeta,
  type PoolConfig,
} from "../lib/dexPools";
import { UNISWAP_V3_POOL_SLOT0_ABI, sqrtPriceX96ToPrice } from "../lib/uniswapV3";

/** One cell's resolved state for the pure view. */
export interface PriceCellState {
  readonly id: string;
  readonly label: string;
  readonly quoteSymbol: string;
  /** Converted mid price, or null when this cell could not be read. */
  readonly price: number | null;
  /** True when this cell's pool read failed (renders 'unavailable'). */
  readonly unavailable: boolean;
  /** True while this cell's read is in flight. */
  readonly loading: boolean;
}

/** data-testid suffix for a pair, e.g. landing-price-cell-eth-usd. */
export function cellTestId(pairId: string): string {
  return `landing-price-cell-${pairId}`;
}

/** Locale-aware price formatting; sub-$10 prices keep more precision. */
function formatPrice(price: number, quoteSymbol: string): string {
  const fractionDigits = price >= 10 ? 2 : price >= 0.01 ? 4 : 6;
  const formatted = price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: fractionDigits,
  });
  return quoteSymbol === "USD" || quoteSymbol === "USDC" ? `$${formatted}` : formatted;
}

interface LandingPriceStripViewProps {
  readonly cells: readonly PriceCellState[];
  /** Block the prices were read at, or null while unknown. */
  readonly blockNumber: number | null;
}

/**
 * Pure presentational strip. Receives fully-resolved cell states so unit tests
 * can assert decimal-math output and per-cell error isolation without any
 * wagmi/RPC fixture.
 */
export function LandingPriceStripView({ cells, blockNumber }: LandingPriceStripViewProps) {
  return (
    <section className="landing-price-strip" data-testid="landing-price-strip">
      <div className="section-heading-row">
        <h2>Live prices</h2>
        <p data-testid="landing-price-strip-freshness">
          {blockNumber == null ? "Block —" : `Block ${blockNumber}`}
        </p>
      </div>
      <div className="price-cell-grid">
        {cells.map((cell) => (
          <article
            key={cell.id}
            className="price-cell"
            data-testid={cellTestId(cell.id)}
            data-cell-unavailable={cell.unavailable ? "true" : "false"}
          >
            <p className="price-cell-label" data-testid={`${cellTestId(cell.id)}-label`}>
              {cell.label}
            </p>
            {cell.unavailable ? (
              <p
                className="price-cell-value price-cell-unavailable"
                data-testid={`${cellTestId(cell.id)}-value`}
              >
                unavailable
              </p>
            ) : cell.loading || cell.price == null ? (
              <p className="price-cell-value" data-testid={`${cellTestId(cell.id)}-value`}>
                …
              </p>
            ) : (
              <p className="price-cell-value" data-testid={`${cellTestId(cell.id)}-value`}>
                {formatPrice(cell.price, cell.quoteSymbol)}
              </p>
            )}
            <p className="price-cell-block" data-testid={`${cellTestId(cell.id)}-block`}>
              {blockNumber == null ? "Block —" : `Block ${blockNumber}`}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

/** One container hook instance per pool — keeps reads independent per cell. */
function usePoolPrice(pair: PairMeta, config: PoolConfig | undefined): PriceCellState {
  const enabled = config != null;
  const { data, isError, isLoading } = useReadContract({
    abi: UNISWAP_V3_POOL_SLOT0_ABI,
    address: config?.pool,
    functionName: "slot0",
    query: { enabled },
  });

  let price: number | null = null;
  let convertError = false;
  if (enabled && Array.isArray(data) && data.length > 0) {
    try {
      const sqrtPriceX96 = data[0] as bigint;
      price = sqrtPriceX96ToPrice({
        sqrtPriceX96,
        token0Decimals: config.token0Decimals,
        token1Decimals: config.token1Decimals,
        baseIsToken0: config.baseIsToken0,
      });
    } catch {
      convertError = true;
    }
  }

  return {
    id: pair.id,
    label: pair.label,
    quoteSymbol: pair.quote,
    price,
    // A missing config, an RPC read error, or a conversion failure isolates to
    // this cell only — the other cells are independent hook instances.
    unavailable: !enabled || isError || convertError,
    loading: enabled && isLoading,
  };
}

/**
 * Container: wires one independent `useReadContract` per configured pool on the
 * dapp's current chain and renders the pure view. Hook calls over the static
 * `PRICE_STRIP_PAIRS` array keep call order stable (Rules of Hooks).
 */
export function LandingPriceStrip() {
  const chainId = useChainId();
  const { data: blockData } = useBlockNumber({ watch: true });

  const cells = PRICE_STRIP_PAIRS.map((pair) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks -- PRICE_STRIP_PAIRS is a static, fixed-length config array; iteration order never changes.
    usePoolPrice(pair, resolvePoolConfig(pair.id, chainId)),
  );

  const blockNumber = blockData != null ? Number(blockData) : null;
  return <LandingPriceStripView cells={cells} blockNumber={blockNumber} />;
}
