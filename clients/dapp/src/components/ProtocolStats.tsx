// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * ProtocolStats — renders the protocol stats bar from ExplorerContext.
 *
 * Shows aggregate TVL, depositor count, and the most recent activity events.
 * Works without a connected wallet.
 *
 * Data comes from ExplorerContext (shared polling loop in main.tsx), keeping
 * the displayed block_number in sync with VaultCards and VaultList.
 *
 * issue #318 — protocol layer.
 */
import { useExplorer } from "../lib/ExplorerContext";

export function ProtocolStats() {
  const { stats, statsLoading, statsError } = useExplorer();

  if (statsLoading) {
    return (
      <section data-testid="protocol-stats">
        <p data-testid="protocol-stats-loading">Loading stats…</p>
      </section>
    );
  }
  if (statsError || stats == null) {
    return (
      <section data-testid="protocol-stats">
        <p data-testid="protocol-stats-error">{statsError ?? "No stats available."}</p>
      </section>
    );
  }

  return (
    <section data-testid="protocol-stats" className="protocol-stats">
      <div className="stat-grid">
        <div className="stat-card">
          <p className="stat-label">Aggregate TVL</p>
          <p data-testid="protocol-stats-tvl" className="stat-value font-mono">
            {stats.total_tvl}
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Depositors</p>
          <p data-testid="protocol-stats-depositors" className="stat-value">
            {stats.unique_depositors}
          </p>
        </div>
      </div>

      {stats.activity_feed.length > 0 && (
        <div data-testid="protocol-stats-activity">
          <h3>Recent Activity</h3>
          <ul>
            {stats.activity_feed.map((event) => (
              <li
                key={`${event.tx_hash}-${event.log_index}`}
                data-testid="protocol-stats-activity-item"
              >
                <span data-testid="protocol-stats-activity-kind">deposit</span>
                {" @ block "}
                <span data-testid="protocol-stats-activity-block">{event.block_number}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p data-testid="protocol-stats-freshness">Block {stats.block_number}</p>
    </section>
  );
}
