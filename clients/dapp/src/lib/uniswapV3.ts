// Canonical: docs/prd.md#112-protocol-asset-vault

/**
 * Uniswap V3 slot0 read helper for the landing-page price strip (issue #482).
 *
 * Encapsulates the sqrtPriceX96 -> human price conversion in a single,
 * decimals-aware place so every price cell (ETH/USD, wETH/USDC, cbBTC/USDC,
 * wSOL/USDC) shares one tested code path. No off-chain price source is used —
 * the only input is a pool's `slot0().sqrtPriceX96`, read on-chain via
 * wagmi/useReadContract (see LandingPriceStrip). Pool addresses come from
 * `config/dex-pools.json`, never hardcoded here.
 *
 * Math: Uniswap V3 stores `sqrtPriceX96 = sqrt(token1/token0) * 2^96`, where
 * `token1/token0` is the ratio of raw (smallest-unit) amounts. The human price
 * of `base` quoted in `quote` therefore is:
 *
 *   rawRatio   = (sqrtPriceX96 / 2^96)^2                  # token1 per token0 (raw)
 *   priceT1perT0 = rawRatio * 10^(token0Decimals - token1Decimals)
 *
 * When `base` is token0 the strip wants token1-per-token0 (e.g. USDC per wETH),
 * which is `priceT1perT0` directly. When `base` is token1 we invert.
 */

/** Minimal ABI fragment for `slot0()` — only the field we read. */
export const UNISWAP_V3_POOL_SLOT0_ABI = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

const Q96 = 2n ** 96n;

/** Decimals-aware conversion inputs for one pool. */
export interface PoolPriceParams {
  /** `slot0().sqrtPriceX96`, as returned on-chain. */
  readonly sqrtPriceX96: bigint;
  /** ERC-20 decimals of the pool's token0. */
  readonly token0Decimals: number;
  /** ERC-20 decimals of the pool's token1. */
  readonly token1Decimals: number;
  /**
   * Whether the price strip's `base` asset is token0. When true the result is
   * token1-per-token0 (the natural Uniswap orientation); when false the result
   * is inverted to token0-per-token1.
   */
  readonly baseIsToken0: boolean;
}

/**
 * Convert a pool's `sqrtPriceX96` into the human-readable mid price of the
 * `base` asset quoted in the `quote` asset.
 *
 * Uses 18 decimals of fixed-point precision internally (bigint only — never
 * floats in the chain-math path) and returns a JS number at the end for
 * display. Tolerance assertions in the fork test compare against the
 * expected-prices fixture with this same conversion, so any rounding here is
 * shared by both producer and verifier.
 */
export function sqrtPriceX96ToPrice(params: PoolPriceParams): number {
  const { sqrtPriceX96, token0Decimals, token1Decimals, baseIsToken0 } = params;
  if (sqrtPriceX96 <= 0n) {
    throw new Error("sqrtPriceX96 must be positive");
  }

  // rawRatio = (sqrtPriceX96^2 / 2^192) = token1 per token0 in raw units.
  // Scale by 1e36 before the divide so we keep 18+ digits of precision as a
  // bigint, then apply the decimal delta, then render once at the end.
  const SCALE = 10n ** 36n;
  // numerator = sqrtPriceX96^2 * SCALE ; denominator = 2^192
  const numerator = sqrtPriceX96 * sqrtPriceX96 * SCALE;
  const denominator = Q96 * Q96;
  let scaledT1PerT0 = numerator / denominator; // raw token1/token0 * 1e36

  // Apply decimal delta: multiply by 10^(token0Decimals - token1Decimals).
  const decimalDelta = token0Decimals - token1Decimals;
  if (decimalDelta >= 0) {
    scaledT1PerT0 *= 10n ** BigInt(decimalDelta);
  } else {
    scaledT1PerT0 /= 10n ** BigInt(-decimalDelta);
  }

  // scaledT1PerT0 is now (token1 per token0) * 1e36, decimals-adjusted.
  if (baseIsToken0) {
    return Number(scaledT1PerT0) / 1e36;
  }
  // Invert: token0 per token1 = 1 / (token1 per token0).
  // Re-scale to keep precision through the reciprocal.
  if (scaledT1PerT0 === 0n) {
    throw new Error("price underflow: cannot invert zero ratio");
  }
  const inverted = (SCALE * SCALE) / scaledT1PerT0; // (1 / ratio) * 1e36
  return Number(inverted) / 1e36;
}
