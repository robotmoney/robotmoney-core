// Canonical: docs/prd.md#112-protocol-asset-vault

/**
 * Typed accessor for the canonical Uniswap V3 pool registry at
 * `config/dex-pools.json` (issue #482). Pool addresses are NEVER hardcoded in
 * TypeScript — this module is the single seam that pulls them from the shared
 * config file and exposes a chain-aware lookup. When the dapp targets the
 * forked-Base devnet (chain id 918453) the `devnet` override map is honored;
 * every other chain id falls back to the `mainnet` map.
 *
 * The JSON is imported at build time (resolveJsonModule). Keeping the import in
 * this one module means the rest of the dapp depends only on the typed
 * `PoolConfig` shape, not on the file layout.
 */
import rawPools from "../../../../config/dex-pools.json";

/** A single Uniswap V3 pool entry, decimals-aware for price conversion. */
export interface PoolConfig {
  readonly pool: `0x${string}`;
  readonly token0: `0x${string}`;
  readonly token1: `0x${string}`;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  /** Whether the displayed `base` asset is the pool's token0. */
  readonly baseIsToken0: boolean;
}

/** Display metadata for one price-strip cell. */
export interface PairMeta {
  readonly id: string;
  readonly label: string;
  readonly base: string;
  readonly quote: string;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
}

interface ChainPools {
  readonly chainId: number;
  readonly pools: Record<string, PoolConfig>;
}

interface DexPoolsFile {
  readonly pairs: readonly PairMeta[];
  readonly mainnet: ChainPools;
  readonly devnet: ChainPools;
}

const pools = rawPools as unknown as DexPoolsFile;

/** Ordered list of the four price-strip pairs (display order). */
export const PRICE_STRIP_PAIRS: readonly PairMeta[] = pools.pairs;

/** Chain id of the forked-Base devnet — selects the devnet override map. */
export const DEVNET_CHAIN_ID = pools.devnet.chainId;

/**
 * Resolve the pool config for `pairId` on `chainId`. The devnet override map
 * is used only for the devnet chain id; all other chains (mainnet, fork via
 * mainnet fork, etc.) use the mainnet map. Returns `undefined` if the pair is
 * unknown.
 */
export function resolvePoolConfig(
  pairId: string,
  chainId: number | undefined,
): PoolConfig | undefined {
  const map = chainId === DEVNET_CHAIN_ID ? pools.devnet.pools : pools.mainnet.pools;
  return map[pairId];
}
