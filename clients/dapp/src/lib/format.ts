// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * format.ts — single shared number-formatting module for the dapp.
 *
 * All numeric renders (USD/USDC amounts, ETH amounts, percentages, basis
 * points, token balances, prices) must flow through this module so the same
 * value displays identically wherever it appears (wallet-balance row, vault
 * tiles, allocation page, router-weights view, etc.).
 *
 * Categories:
 *   - `formatUsdc`         — 6-decimal USDC bigint → "NNN.NN USDC"
 *   - `formatShares`       — 24-decimal receipt-token bigint → "NNN.NN <symbol>"
 *   - `parseTokenAmount`   — typed amount → exact base-unit bigint
 *   - `formatEth`          — 18-decimal ETH bigint → "N.NNNN ETH"
 *   - `formatTokenBalance` — arbitrary decimal bigint → human string
 *   - `formatPercent`      — bps bigint → "NN.NN%"
 *   - `formatBps`          — raw bps number → "NNbps"
 *   - `formatPrice`        — number → "$N.NNNN"
 *
 * Edge cases handled uniformly:
 *   - undefined / null → "—"
 *   - 0n             → "0"
 *   - negative        → formatted with leading "−"
 *
 * No imports from wagmi, viem, or React.  Pure TypeScript.
 */

/** Sentinel for a missing / loading value. */
export const PLACEHOLDER = "—";

/** USDC has 6 decimals. */
export const USDC_DECIMALS = 6;
/** The RM token has 18 decimals. */
export const RM_DECIMALS = 18;
/**
 * Vault share (rmUSDC) display scale. A vault's `decimals()` is 6, and its ERC-4626 `_decimalsOffset()` is
 * 18 (RobotMoneyVault.sol, BasketVault.sol), so a fresh vault mints about 1e24 raw shares for 1e6 USDC. The
 * raw count only reads as roughly 1 share per USDC at 6 + 18 = 24 decimals. Rendering it at 6 decimals shows
 * "999,949,002,651,862,103 shares" for 1 USDC.
 */
export const VIRTUAL_SHARE_OFFSET = 18;
export const SHARE_DECIMALS = USDC_DECIMALS + VIRTUAL_SHARE_OFFSET;

/** Display scale of a vault's raw shares, from the vault's own `decimals()` read. */
export const shareDisplayDecimals = (vaultDecimals: number): number =>
  vaultDecimals + VIRTUAL_SHARE_OFFSET;

const UINT256_MAX = 2n ** 256n - 1n;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Divide a bigint into whole + fractional parts and return a decimal string.
 * The whole part includes thousands separators (e.g. 1000000 -> "1,000,000").
 * The fraction is truncated (never rounded up) to `maxFrac` digits and padded to at least `minFrac` digits.
 * A non-zero amount that truncates to zero reads "<0.000001", never "0".
 *
 * @param raw       - the raw value in smallest units
 * @param decimals  - number of decimal places in the token (e.g. 6 for USDC)
 * @param maxFrac   - maximum fractional digits to display
 * @param minFrac   - minimum fractional digits to display
 */
function bigintToDecimalString(
  raw: bigint,
  decimals: number,
  maxFrac: number,
  minFrac = 2,
): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fracRaw = abs % scale;
  const cap = Math.min(maxFrac, decimals);
  const floor = Math.min(minFrac, cap);
  const fracFull = fracRaw.toString().padStart(decimals, "0");
  const fracCut = fracFull.slice(0, cap);
  let frac = fracCut.replace(/0+$/, "");
  if (frac.length < floor) frac = frac.padEnd(floor, "0");
  const wholeStr = whole.toLocaleString("en-US");
  if (abs !== 0n && whole === 0n && /^0*$/.test(fracCut)) {
    const tiny = `<0.${"0".repeat(Math.max(cap - 1, 0))}1`;
    return negative ? `−${tiny}` : tiny;
  }
  const formatted = frac.length > 0 ? `${wholeStr}.${frac}` : wholeStr;
  return negative ? `−${formatted}` : formatted;
}

/** A base-10 integer string from the explorer API (NUMERIC columns) as a bigint, else undefined. */
function rawStringToBigint(raw: string | null | undefined): bigint | undefined {
  if (raw == null || !/^\d+$/.test(raw.trim())) return undefined;
  return BigInt(raw.trim());
}

// ---------------------------------------------------------------------------
// Exported formatters
// ---------------------------------------------------------------------------

/**
 * Format a USDC amount (raw bigint, 6 decimals) for display.
 * Examples: 1_000_000n -> "1.00 USDC", 1_500_000n -> "1.50 USDC", 0n -> "0.00 USDC".
 */
export function formatUsdc(raw: bigint | undefined): string {
  if (raw === undefined || raw === null) return PLACEHOLDER;
  return `${bigintToDecimalString(raw, USDC_DECIMALS, 6)} USDC`;
}

/** Format an explorer-API raw USDC integer string; a missing or non-integer value is the placeholder. */
export function formatUsdcString(raw: string | null | undefined): string {
  return formatUsdc(rawStringToBigint(raw));
}

/**
 * Format a vault-share (rmUSDC) amount (raw bigint at SHARE_DECIMALS) for display.
 *
 * @param raw      - raw share count
 * @param symbol   - receipt-token symbol, e.g. "rmUSDC". Defaults to "shares".
 * @param decimals - share scale; defaults to SHARE_DECIMALS (vault decimals() 6 + virtual offset 18)
 */
export function formatShares(
  raw: bigint | undefined,
  symbol = "shares",
  decimals = SHARE_DECIMALS,
): string {
  if (raw === undefined || raw === null) return PLACEHOLDER;
  return `${bigintToDecimalString(raw, decimals, 6)} ${symbol}`;
}

/** Format an explorer-API raw share integer string. */
export function formatSharesString(raw: string | null | undefined, symbol = "shares"): string {
  return formatShares(rawStringToBigint(raw), symbol);
}

/**
 * Format a native-ETH amount (raw bigint, 18 decimals) for display.
 * Displays up to 4 fractional digits.
 * Example: 1_500_000_000_000_000_000n -> "1.50 ETH".
 */
export function formatEth(raw: bigint | undefined): string {
  if (raw === undefined || raw === null) return PLACEHOLDER;
  const dec = bigintToDecimalString(raw, 18, 4);
  return `${dec} ETH`;
}

/**
 * Format an arbitrary token balance using its declared decimal count.
 * Up to `maxFrac` fractional digits shown, at least two.
 *
 * @param raw      - raw token amount
 * @param decimals - token decimal places
 * @param symbol   - token symbol appended with a space (omitted when empty)
 * @param maxFrac  - max fractional digits (default 6)
 */
export function formatTokenBalance(
  raw: bigint | undefined,
  decimals: number,
  symbol = "",
  maxFrac = 6,
): string {
  if (raw === undefined || raw === null) return PLACEHOLDER;
  const dec = bigintToDecimalString(raw, decimals, maxFrac);
  return symbol ? `${dec} ${symbol}` : dec;
}

/**
 * A raw amount as a plain decimal string with no separators and no suffix ("1.5"), for filling an input.
 * `parseTokenAmount(formatInputAmount(x, d), d) === x` for every positive x.
 */
export function formatInputAmount(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const frac = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const whole = (raw / scale).toString();
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

/**
 * Parse a human-typed amount ("1.5", "1,000.25") into base units, exactly, with BigInt (no float).
 * Returns null for anything that is not a positive amount: empty, non-numeric, negative, zero, more
 * fractional digits than `decimals`, a bad thousands grouping, or above uint256 max.
 */
export function parseTokenAmount(input: string, decimals: number): bigint | null {
  let t = input.trim();
  if (t === "") return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (value === 0n || value > UINT256_MAX) return null;
  return value;
}

/** Parse a typed USDC amount into 6-decimal base units. */
export const parseUsdcAmount = (input: string): bigint | null =>
  parseTokenAmount(input, USDC_DECIMALS);

/** Parse a typed vault-share amount into raw shares (SHARE_DECIMALS). */
export const parseSharesAmount = (input: string): bigint | null =>
  parseTokenAmount(input, SHARE_DECIMALS);

/**
 * Format a basis-points value (bigint) as a human-readable percentage.
 * 10_000 bps = 100.00%.
 * Example: 2_500n → "25.00%".
 */
export function formatPercent(bps: bigint | undefined): string {
  if (bps === undefined || bps === null) return PLACEHOLDER;
  // Multiply by 100 before dividing to retain two decimal places.
  const negative = bps < 0n;
  const abs = negative ? -bps : bps;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const formatted = `${whole}.${frac.toString().padStart(2, "0")}%`;
  return negative ? `−${formatted}` : formatted;
}

/**
 * Format a raw basis-points number for display.
 * Example: 150 → "150bps".
 */
export function formatBps(bps: number | undefined): string {
  if (bps === undefined || bps === null) return PLACEHOLDER;
  return `${bps}bps`;
}

/**
 * Format a numeric price value (USD or similar) for display.
 * Sub-$10 prices use 4 decimal places; $10+ prices use 2 decimal places.
 * Whole-number parts include thousands separators.
 * Example: 1.5 → "$1.5000", 1234.5678 → "$1,234.5678", 0 → "$0.0000".
 */
export function formatPrice(value: number | undefined): string {
  if (value === undefined || value === null) return PLACEHOLDER;
  const fractionDigits = Math.abs(value) >= 10 ? 2 : 4;
  const formatted = value.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  return `$${formatted}`;
}

/**
 * Format a basis-points number as a human-readable percentage string.
 * 10 000 bps = 100.00%.
 * Example: 3334 → "33.34%", 100 → "1.00%".
 *
 * @param bps - integer basis-points value (0–10 000 for 0–100%)
 */
export function formatPercentFromNumber(bps: number | undefined): string {
  if (bps === undefined || bps === null) return PLACEHOLDER;
  return (bps / 100).toFixed(2) + "%";
}
