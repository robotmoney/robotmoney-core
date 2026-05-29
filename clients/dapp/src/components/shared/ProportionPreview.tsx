// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * ProportionPreview — shared display component for router deposit split.
 *
 * Renders the per-vault weight breakdown that the PortfolioRouter would apply
 * to a given deposit amount. Data comes from `router.previewDeposit(amount)`,
 * which the parent resolves and passes in as the `legs` prop.
 *
 * Consumed by:
 *   - RouterDepositTab (deposit/withdraw page) — shows the split before
 *     the user signs the router deposit tx.
 *   - RouterView / portfolio explorer — can show hypothetical split for the
 *     current weight vector without a pending tx.
 *
 * No wagmi hooks, no RPC calls — pure display.
 *
 * docs/architecture.md §5.3 — shared vault UI library.
 */
import type { LegPreview } from "../../lib/routerPreview";
import { formatPercent, formatUsdc, formatShares } from "../../lib/format";

export interface ProportionPreviewProps {
  /**
   * Per-vault leg breakdown from `router.previewDeposit(amount)`.
   * When empty, a "no legs" placeholder is shown.
   */
  readonly legs: readonly LegPreview[];
}

/**
 * ProportionPreview renders a table of vault legs with weight %, USDC split,
 * estimated shares, and an availability flag. Used on the deposit/withdraw
 * page and portfolio explorer.
 */
export function ProportionPreview({ legs }: ProportionPreviewProps) {
  if (legs.length === 0) {
    return (
      <p data-testid="proportion-preview-empty" className="hint">
        No vault split data available.
      </p>
    );
  }

  return (
    <table data-testid="proportion-preview-table">
      <thead>
        <tr>
          <th>Vault</th>
          <th>Weight</th>
          <th>USDC leg</th>
          <th>Est. shares</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {legs.map((leg, i) => (
          <tr
            key={leg.vault}
            data-testid={`proportion-preview-row-${i}`}
            style={leg.unavailable ? { color: "red" } : undefined}
          >
            <td className="font-mono" data-testid={`proportion-preview-vault-${i}`}>
              <code>
                {leg.vault.slice(0, 8)}…{leg.vault.slice(-4)}
              </code>
            </td>
            <td data-testid={`proportion-preview-weight-${i}`}>{formatPercent(leg.weightBps)}</td>
            <td data-testid={`proportion-preview-usdc-${i}`}>{formatUsdc(leg.legAmount)}</td>
            <td data-testid={`proportion-preview-shares-${i}`}>
              {leg.unavailable ? "—" : formatShares(leg.estShares)}
            </td>
            <td data-testid={`proportion-preview-status-${i}`}>
              {leg.unavailable ? "⚠ UNAVAILABLE" : "Active"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
