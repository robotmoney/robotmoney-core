// Canonical: docs/architecture.md §4.1 — Vault Family

/**
 * VaultCards — landing-page summary cards for the registered vault set.
 *
 * Renders one tile per registered vault, matching the four PRD §11 categories
 * once the demo seed has run (issue #479): the three Active router vaults plus
 * the RWA/Thematic placeholder. A tile is rendered in an inactive presentation
 * (Future / Coming soon, no deposit affordance, SPECULATIVE / Prototype label)
 * whenever its `status` is non-Active. That status is on-chain registry state
 * surfaced by the explorer `/v1/vaults` indexer read — it is NOT a hard-coded
 * per-vault flag, so the same code marks any non-Active vault inactive in
 * every environment (single-production-codebase,
 * docs/development/single-production-codebase.md).
 *
 * Data comes from ExplorerContext (shared polling loop in main.tsx), so this
 * component and VaultList always display the same block_number — no
 * mixed-block state. The pollInterval prop is forwarded to ExplorerProvider in
 * tests to control re-fetch timing without fake timers.
 *
 * Each vault card now includes a 'Details' link (issue #941) that navigates to
 * the Portfolio Explorer tab and opens VaultDetail for that vault.
 * onSelectVault is called with the vault address; onSwitchToExplorer switches
 * the enclosing Tabs to the portfolio-explorer panel. No wallet connection is
 * required.
 */
import { useExplorer } from "../lib/ExplorerContext";

const STATUS_LABEL: Record<number, string> = {
  0: "Active",
  1: "Paused",
  2: "Retired",
};

/**
 * Active is status 0 in `VaultRegistry.VaultStatus` (0=Active, 1=Paused,
 * 2=Retired). Any other value is an inactive vault that takes no deposits.
 */
const VAULT_STATUS_ACTIVE = 0;

interface VaultCardsProps {
  /** Called with the vault address when the user clicks 'Details'. */
  onSelectVault?: (address: string) => void;
  /** Called (after onSelectVault) to switch the enclosing Tabs to Portfolio Explorer. */
  onSwitchToExplorer?: () => void;
}

export function VaultCards({ onSelectVault, onSwitchToExplorer }: VaultCardsProps = {}) {
  const { vaults, blockNumber, vaultsLoading, vaultsError } = useExplorer();

  if (vaultsLoading) {
    return (
      <section className="landing-vaults" data-testid="landing-vault-cards">
        <h2>Vaults</h2>
        <p data-testid="landing-vault-cards-loading">Loading vaults…</p>
      </section>
    );
  }

  if (vaultsError) {
    return (
      <section className="landing-vaults" data-testid="landing-vault-cards">
        <h2>Vaults</h2>
        <p data-testid="landing-vault-cards-error">{vaultsError}</p>
      </section>
    );
  }

  function handleDetails(address: string) {
    onSelectVault?.(address);
    onSwitchToExplorer?.();
  }

  return (
    <section className="landing-vaults" data-testid="landing-vault-cards">
      <div className="section-heading-row">
        <h2>Vaults</h2>
        {blockNumber != null && (
          <p data-testid="landing-vault-cards-freshness">Block {blockNumber}</p>
        )}
      </div>
      {vaults.length === 0 ? (
        <p data-testid="landing-vault-cards-empty">No vaults registered yet.</p>
      ) : (
        <div className="vault-card-grid">
          {vaults.map((vault) => {
            // Inactive presentation is driven by the on-chain registry status
            // surfaced through the indexer — not a per-vault constant.
            const isActive = vault.status === VAULT_STATUS_ACTIVE;
            return (
              <article
                key={vault.address}
                className={isActive ? "vault-card" : "vault-card vault-card-inactive"}
                data-testid="landing-vault-card"
                data-vault-active={isActive ? "true" : "false"}
              >
                <div>
                  <p className="vault-card-kicker" data-testid="landing-vault-card-risk">
                    {vault.risk_label}
                  </p>
                  <h3 data-testid="landing-vault-card-name">{vault.name}</h3>
                </div>
                {isActive ? (
                  <dl>
                    <div>
                      <dt>Status</dt>
                      <dd data-testid="landing-vault-card-status">
                        {STATUS_LABEL[vault.status] ?? String(vault.status)}
                      </dd>
                    </div>
                    <div>
                      <dt>TVL</dt>
                      <dd data-testid="landing-vault-card-tvl">{vault.total_assets ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Exit Fee</dt>
                      <dd data-testid="landing-vault-card-fee">
                        {vault.exit_fee_bps == null ? "—" : `${vault.exit_fee_bps} bps`}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  // No deposit affordance and no live stats for an inactive
                  // vault — only a Future / Coming-soon notice (issue #479).
                  <p className="vault-card-future" data-testid="landing-vault-card-future">
                    Future — coming soon
                  </p>
                )}
                <button
                  type="button"
                  data-testid="landing-vault-card-details"
                  className="vault-card-details-link"
                  onClick={() => handleDetails(vault.address)}
                >
                  Details
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
