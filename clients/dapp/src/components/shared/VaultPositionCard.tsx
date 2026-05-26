// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * VaultPositionCard — shared display component for a single vault position.
 *
 * Shows vault name, receipt-token (rmUSDC) share count, and estimated USDC
 * value for one vault. Consumed by the deposit/withdraw page (to surface the
 * user's current position alongside the form) and the portfolio explorer
 * (AccountLayerView / PortfolioPosition) where the same card renders for
 * every vault that has a non-zero balance.
 *
 * All data is passed as props — no fetching, no RPC. The parent resolves the
 * on-chain `vault.convertToAssets(shares)` value and passes it in as
 * `usdcValue`. When absent a dash is shown, keeping the component pure and
 * trivially unit-testable.
 *
 * docs/architecture.md §5.3 — shared vault UI library.
 */

export interface VaultPositionCardProps {
  /** On-chain or indexed vault address (used as React key externally). */
  readonly vaultAddress: string;
  /** Human-readable vault name from the registry / indexer. */
  readonly vaultName: string;
  /**
   * Raw receipt-token (rmUSDC) balance as a decimal string.
   * Uses 6-decimal fixed-point, e.g. "1000000" = 1 rmUSDC.
   */
  readonly shares: string;
  /**
   * Risk classification label returned by the vault registry
   * (e.g. "stable-yield", "growth").
   */
  readonly riskLabel?: string;
  /**
   * Optional estimated USDC value string (decimal, 6-decimal units).
   * Injected by the parent after a live `vault.convertToAssets(shares)` call.
   * When absent or undefined, displays "—".
   */
  readonly usdcValue?: string;
}

/**
 * VaultPositionCard renders a compact card for one vault position.
 * Used on both the deposit/withdraw page and the portfolio explorer.
 */
export function VaultPositionCard({
  vaultAddress,
  vaultName,
  shares,
  riskLabel,
  usdcValue,
}: VaultPositionCardProps) {
  return (
    <article className="vault-position-card" data-testid="vault-position-card">
      <header>
        {riskLabel && (
          <p className="vault-card-kicker" data-testid="vault-position-card-risk">
            {riskLabel}
          </p>
        )}
        <h3 data-testid="vault-position-card-name">{vaultName}</h3>
        <p className="font-mono hint" data-testid="vault-position-card-address">
          {vaultAddress}
        </p>
      </header>
      <dl>
        <div>
          <dt>rmUSDC shares</dt>
          <dd data-testid="vault-position-card-shares">{shares}</dd>
        </div>
        <div>
          <dt>Est. USDC value</dt>
          <dd data-testid="vault-position-card-usdc">
            {usdcValue !== undefined ? usdcValue : "—"}
          </dd>
        </div>
      </dl>
    </article>
  );
}
