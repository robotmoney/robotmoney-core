// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * ReceiptValueDisplay — shared display component for receipt-token to USD
 * value conversion.
 *
 * Renders a compact line showing a raw receipt-token (rmUSDC) amount
 * alongside its estimated USDC value. The conversion result is injected by
 * the parent after a live `vault.convertToAssets(shares)` call so this
 * component is side-effect-free and trivially unit-testable.
 *
 * Consumed by:
 *   - DepositWithdrawTab (deposit/withdraw page) — shows current share balance
 *     value next to the share balance hint.
 *   - AccountLayerView / PortfolioPosition — per-vault USDC value in the
 *     portfolio table.
 *
 * docs/architecture.md §5.3 — shared vault UI library.
 */

export interface ReceiptValueDisplayProps {
  /**
   * Receipt-token (rmUSDC) amount, already formatted for display by the parent through the shared
   * format module. This component never formats a raw integer itself.
   */
  readonly shares: string;
  /**
   * Optional estimated USDC value string (already formatted) produced
   * by `vault.convertToAssets(shares)`. When absent, "—" is displayed.
   */
  readonly usdcValue?: string;
  /**
   * Optional label to prefix the display. Defaults to "rmUSDC shares".
   */
  readonly label?: string;
}

/**
 * ReceiptValueDisplay renders a receipt-token amount alongside its USD
 * conversion. Purely presentational — no hooks, no fetching.
 */
export function ReceiptValueDisplay({
  shares,
  usdcValue,
  label = "rmUSDC shares",
}: ReceiptValueDisplayProps) {
  return (
    <p className="hint" data-testid="receipt-value-display">
      <span data-testid="receipt-value-display-label">{label}:</span>{" "}
      <span data-testid="receipt-value-display-shares">{shares}</span>
      {" → "}
      <span data-testid="receipt-value-display-usdc">
        {usdcValue !== undefined ? usdcValue : "—"}
      </span>{" "}
      <span data-testid="receipt-value-display-unit">USDC</span>
    </p>
  );
}
