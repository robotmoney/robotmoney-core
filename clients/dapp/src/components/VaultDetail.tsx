/**
 * VaultDetail — reads GET /v1/vaults/:address and renders a single vault.
 *
 * Shows adapter allocation (risk_label used as label), TVL chart (table
 * of tvl_history rows), fees, caps, and event log freshness.
 * Works without a connected wallet.
 *
 * issue #318 — protocol layer.
 */
import { useEffect, useState } from "react";
import type { FetchLike, VaultDetailRow } from "../lib/explorerApi";
import { fetchVaultDetail } from "../lib/explorerApi";

const STATUS_LABEL: Record<number, string> = {
  0: "Active",
  1: "Paused",
  2: "Retired",
};

interface VaultDetailProps {
  apiUrl: string;
  address: string;
  fetchImpl?: FetchLike;
  onBack?: () => void;
}

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ok"; vault: VaultDetailRow; block_number: number };

export function VaultDetail({ apiUrl, address, fetchImpl, onBack }: VaultDetailProps) {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    setState({ phase: "loading" });
    const ac = new AbortController();
    fetchVaultDetail(apiUrl, address, { fetchImpl, signal: ac.signal })
      .then((res) => setState({ phase: "ok", vault: res.vault, block_number: res.block_number }))
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setState({ phase: "error", message: String(err) });
      });
    return () => ac.abort();
  }, [apiUrl, address, fetchImpl]);

  if (state.phase === "loading") {
    return (
      <section data-testid="vault-detail">
        <p data-testid="vault-detail-loading">Loading vault…</p>
      </section>
    );
  }
  if (state.phase === "error") {
    return (
      <section data-testid="vault-detail">
        <p data-testid="vault-detail-error">{state.message}</p>
      </section>
    );
  }

  const { vault, block_number } = state;

  return (
    <section data-testid="vault-detail" className="vault-detail">
      {onBack && (
        <button type="button" data-testid="vault-detail-back" onClick={onBack}>
          ← Back
        </button>
      )}
      <h2 data-testid="vault-detail-name">{vault.name}</h2>
      <div className="stat-grid">
        <div className="stat-card">
          <p className="stat-label">Risk</p>
          <p data-testid="vault-detail-risk" className="stat-value">
            {vault.risk_label}
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Status</p>
          <p data-testid="vault-detail-status" className="stat-value">
            {STATUS_LABEL[vault.status] ?? String(vault.status)}
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Deposit Cap</p>
          <p data-testid="vault-detail-cap" className="stat-value font-mono">
            {vault.deposit_cap}
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Address</p>
          <p data-testid="vault-detail-address" className="stat-value font-mono">
            {vault.address}
          </p>
        </div>
      </div>

      <h3>TVL History</h3>
      {vault.tvl_history.length === 0 ? (
        <p data-testid="vault-detail-tvl-empty">No TVL data yet.</p>
      ) : (
        <table data-testid="vault-detail-tvl-table">
          <thead>
            <tr>
              <th>Block</th>
              <th>Total Assets</th>
              <th>Total Supply</th>
            </tr>
          </thead>
          <tbody>
            {vault.tvl_history.map((pt) => (
              <tr key={pt.block_number} data-testid="vault-detail-tvl-row">
                <td data-testid="vault-detail-tvl-block">{pt.block_number}</td>
                <td data-testid="vault-detail-tvl-assets">{pt.total_assets}</td>
                <td data-testid="vault-detail-tvl-supply">{pt.total_supply}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p data-testid="vault-detail-freshness">Block {block_number}</p>
    </section>
  );
}
