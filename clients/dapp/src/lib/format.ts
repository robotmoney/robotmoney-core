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
 *   - `formatUsdc`         — 6-decimal USDC bigint → "$NNN.NN USDC"
 *   - `formatShares`       — 6-decimal receipt-token bigint → "NNN.NNNNNN <symbol>"
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Divide a bigint into whole + fractional parts and return a decimal string.
 * The whole part includes thousands separators (e.g. 1000000 → "1,000,000").
 *
 * @param raw       - the raw value in smallest units
 * @param decimals  - number of decimal places in the token (e.g. 6 for USDC)
 * @param maxFrac   - maximum fractional digits to display (trailing zeros trimmed)
 */
function bigintToDecimalString(raw: bigint, decimals: number, maxFrac: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fracRaw = abs % scale;
  // Full-precision fractional part, then trim to maxFrac and strip trailing zeros.
  const fracFull = fracRaw.toString().padStart(decimals, "0");
  const fracTrimmed = fracFull.slice(0, maxFrac).replace(/0+$/, "");
  // Add thousands separators to the whole part.
  const wholeStr = whole.toLocaleString("en-US");
  const formatted = fracTrimmed.length > 0 ? `${wholeStr}.${fracTrimmed}` : `${wholeStr}`;
  return negative ? `−${formatted}` : formatted;
}

// ---------------------------------------------------------------------------
// Exported formatters
// ---------------------------------------------------------------------------

/**
 * Format a USDC amount (raw bigint, 6 decimals) for display.
 * Examples: 1_000_000n → "1 USDC", 1_500_000n → "1.5 USDC", 0n → "0 USDC".
 */
export function formatUsdc(raw: bigint | undefined): string {
  if (raw === undefined || raw === null) return PLACEHOLDER;
  const dec = bigintToDecimalString(raw, 6, 6);
  return `${dec} USDC`;
}

/**
 * Format a receipt-token (shares) amount (raw bigint, 6 decimals) for display.
 *
 * @param raw    - raw share count in 6-decimal units
 * @param symbol - receipt-token symbol, e.g. "rmUSDC". Defaults to "shares".
 */
export function formatShares(raw: bigint | undefined, symbol = "shares"): string {
  if (raw === undefined || raw === null) return PLACEHOLDER;
  const dec = bigintToDecimalString(raw, 6, 6);
  return `${dec} ${symbol}`;
}

/**
 * Format a native-ETH amount (raw bigint, 18 decimals) for display.
 * Displays up to 4 significant fractional digits (trailing zeros stripped).
 * Example: 1_500_000_000_000_000_000n → "1.5 ETH".
 */
export function formatEth(raw: bigint | undefined): string {
  if (raw === undefined || raw === null) return PLACEHOLDER;
  const dec = bigintToDecimalString(raw, 18, 4);
  return `${dec} ETH`;
}

/**
 * Format an arbitrary token balance using its declared decimal count.
 * Trailing zeros are stripped; up to `maxFrac` fractional digits shown.
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
