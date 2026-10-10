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
import { depositStateLabel, type DepositState } from "../../lib/vaultDepositState";

export interface ProportionPreviewProps {
  /**
   * Per-vault leg breakdown from `router.previewDeposit(amount)`.
   * When empty, a "no legs" placeholder is shown.
   */
  readonly legs: readonly LegPreview[];
  /**
   * Each leg vault's deposit state (lowercase vault address to state), from useDepositStates. The STATUS column
   * is `depositStateLabel` of this state; a vault with no entry reads as unknown. Never a hardcoded "Active".
   */
  readonly legStates?: ReadonlyMap<string, DepositState>;
}

function legStatus(
  leg: LegPreview,
  legStates: ReadonlyMap<string, DepositState> | undefined,
): string {
  const state: DepositState = (leg.vault && legStates?.get(leg.vault.toLowerCase())) || {
    kind: "unknown",
  };
  const label = depositStateLabel(state);
  if (!leg.unavailable) return label;
  return state.kind === "open" ? "⚠ UNAVAILABLE" : `⚠ UNAVAILABLE · ${label}`;
}

/**
 * ProportionPreview renders a table of vault legs with weight %, USDC split,
 * estimated shares, and an availability flag. Used on the deposit/withdraw
 * page and portfolio explorer.
 */
export function ProportionPreview({ legs, legStates }: ProportionPreviewProps) {
  if (legs.length === 0) {
    return (
      <p data-testid="proportion-preview-empty" className="hint">
        No vault split data available.
      </p>
    );
  }

  return (
    <div className="table-scroll">
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
          {legs.map((leg, i) => {
            // Null-safe vault rendering (issue #1036): a leg whose `vault` is
            // undefined (partial previewDeposit decode) must not crash the page.
            const vaultLabel = leg.vault ? `${leg.vault.slice(0, 8)}…${leg.vault.slice(-4)}` : "—";
            return (
              <tr
                key={leg.vault ?? `leg-${i}`}
                data-testid={`proportion-preview-row-${i}`}
                style={leg.unavailable ? { color: "red" } : undefined}
              >
                <td className="font-mono" data-testid={`proportion-preview-vault-${i}`}>
                  <code>{vaultLabel}</code>
                </td>
                <td data-testid={`proportion-preview-weight-${i}`}>
                  {formatPercent(leg.weightBps)}
                </td>
                <td data-testid={`proportion-preview-usdc-${i}`}>{formatUsdc(leg.legAmount)}</td>
                <td data-testid={`proportion-preview-shares-${i}`}>
                  {leg.unavailable ? "—" : formatShares(leg.estShares)}
                </td>
                <td data-testid={`proportion-preview-status-${i}`}>{legStatus(leg, legStates)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
