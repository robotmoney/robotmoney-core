// Canonical: docs/architecture.md §4.1 — Vault Family

/**
 * VaultCards — landing-page summary cards for the registered vault set.
 */
import { useEffect, useState } from "react";
import type { FetchLike, VaultRow } from "../lib/explorerApi";
import { fetchVaults } from "../lib/explorerApi";

const STATUS_LABEL: Record<number, string> = {
  0: "Active",
  1: "Paused",
  2: "Retired",
};

interface VaultCardsProps {
  readonly apiUrl: string;
  readonly fetchImpl?: FetchLike;
}

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ok"; vaults: readonly VaultRow[]; block_number: number };

export function VaultCards({ apiUrl, fetchImpl }: VaultCardsProps) {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    const ac = new AbortController();
    fetchVaults(apiUrl, { fetchImpl, signal: ac.signal })
      .then((res) => setState({ phase: "ok", vaults: res.vaults, block_number: res.block_number }))
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setState({ phase: "error", message: String(err) });
      });
    return () => ac.abort();
  }, [apiUrl, fetchImpl]);

  if (state.phase === "loading") {
    return (
      <section className="landing-vaults" data-testid="landing-vault-cards">
        <h2>Vaults</h2>
        <p data-testid="landing-vault-cards-loading">Loading vaults…</p>
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section className="landing-vaults" data-testid="landing-vault-cards">
        <h2>Vaults</h2>
        <p data-testid="landing-vault-cards-error">{state.message}</p>
      </section>
    );
  }

  return (
    <section className="landing-vaults" data-testid="landing-vault-cards">
      <div className="section-heading-row">
        <h2>Vaults</h2>
        <p data-testid="landing-vault-cards-freshness">Block {state.block_number}</p>
      </div>
      {state.vaults.length === 0 ? (
        <p data-testid="landing-vault-cards-empty">No vaults registered yet.</p>
      ) : (
        <div className="vault-card-grid">
          {state.vaults.slice(0, 3).map((vault) => (
            <article key={vault.address} className="vault-card" data-testid="landing-vault-card">
              <div>
                <p className="vault-card-kicker" data-testid="landing-vault-card-risk">
                  {vault.risk_label}
                </p>
                <h3 data-testid="landing-vault-card-name">{vault.name}</h3>
              </div>
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
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
