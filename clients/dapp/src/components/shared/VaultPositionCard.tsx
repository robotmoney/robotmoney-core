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
 * All data is passed as props — no fetching, no RPC. The parent resolves what
 * the shares pay at exit, `vault.previewRedeem(shares)` (never the gross
 * `convertToAssets`, which ignores exit costs; core 1795, QA plan X8), and
 * passes it in as `usdcValue`. When absent a dash is shown, keeping the
 * component pure and trivially unit-testable. A shown value carries the PRD
 * NAV disclaimer (`NavDisclosure`, prd.md §9).
 *
 * Exclusion claim (core 1820, QA plan U5): when the vault excluded a funded
 * adapter and has since recovered USDC from it, that USDC is owed pro rata to
 * the holders at the moment of exclusion, including holders who exited since.
 * The parent reads `ExclusionLedger.claimableTotal(holder)` on chain
 * (`useExclusionClaims`) and passes it formatted as `exclusionClaim`. The row
 * is shown only when a claim exists.
 *
 * docs/architecture.md §5.3 — shared vault UI library.
 */
import { NavDisclosure } from "./NavDisclosure";

export interface VaultPositionCardProps {
  /** On-chain or indexed vault address (used as React key externally). */
  readonly vaultAddress: string;
  /** Human-readable vault name from the registry / indexer. */
  readonly vaultName: string;
  /**
   * Receipt-token balance in the vault's own unit, already formatted for display by the parent through
   * the shared format module (formatSharesString). This component never formats a raw integer itself.
   */
  readonly shares: string;
  /**
   * Risk classification label returned by the vault registry
   * (e.g. "stable-yield", "growth").
   */
  readonly riskLabel?: string;
  /**
   * Optional USDC the shares pay at redeem, already formatted for display (formatUsdcString).
   * The parent passes `vault.previewRedeem(shares)` (net of exit costs, core 1795).
   * When absent or undefined, displays "—" and no NAV disclaimer.
   */
  readonly usdcValue?: string;
  /**
   * Optional USDC this holder can claim from the vault's exclusion records, already formatted
   * (formatUsdc). Absent: no claim row.
   */
  readonly exclusionClaim?: string;
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
  exclusionClaim,
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
          <dt>Shares</dt>
          <dd data-testid="vault-position-card-shares">{shares}</dd>
        </div>
        <div>
          <dt>Est. USDC at redeem</dt>
          <dd data-testid="vault-position-card-usdc">
            {usdcValue !== undefined ? usdcValue : "—"}
          </dd>
        </div>
        {exclusionClaim !== undefined && (
          <div data-testid="vault-position-card-exclusion">
            <dt>Exclusion claim</dt>
            <dd data-testid="vault-position-card-exclusion-claim">{exclusionClaim}</dd>
            <dd className="hint" data-testid="vault-position-card-exclusion-note">
              USDC recovered from an adapter this vault excluded, owed to this address as a holder
              at the moment of exclusion. It stays claimable even after a full redeem.
            </dd>
          </div>
        )}
      </dl>
      {usdcValue !== undefined && <NavDisclosure testId="vault-position-card-nav-disclosure" />}
    </article>
  );
}
