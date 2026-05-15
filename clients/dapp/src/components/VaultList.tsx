/**
 * VaultList — reads GET /v1/vaults and renders all registered vaults.
 *
 * Works without a connected wallet. Each row shows the vault name,
 * risk_label, status badge, TVL (total_assets), exit_fee_bps, and
 * deposit_cap_headroom (deposit_cap − total_assets when both are present).
 *
 * Accepts an optional `fetchImpl` for unit-test injection (same pattern
 * as HistoryPane). Accepts an optional `onSelectVault` callback so the
 * parent can route to VaultDetail.
 *
 * issue #318 — protocol layer.
 */
import { useEffect, useState } from "react";
import type { FetchLike, VaultRow } from "../lib/explorerApi";
import { fetchVaults } from "../lib/explorerApi";

const STATUS_LABEL: Record<number, string> = {
  0: "Active",
  1: "Paused",
  2: "Retired",
};

interface VaultListProps {
  apiUrl: string;
  fetchImpl?: FetchLike;
  onSelectVault?: (address: string) => void;
}

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ok"; vaults: readonly VaultRow[]; block_number: number };

function headroom(vault: VaultRow): string | null {
  if (vault.total_assets == null) return null;
  try {
    const cap = BigInt(vault.deposit_cap);
    const tvl = BigInt(vault.total_assets);
    if (cap < tvl) return "0";
    return String(cap - tvl);
  } catch {
    return null;
  }
}

export function VaultList({ apiUrl, fetchImpl, onSelectVault }: VaultListProps) {
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
      <section data-testid="vault-list">
        <p data-testid="vault-list-loading">Loading vaults…</p>
      </section>
    );
  }
  if (state.phase === "error") {
    return (
      <section data-testid="vault-list">
        <p data-testid="vault-list-error">{state.message}</p>
      </section>
    );
  }

  const { vaults, block_number } = state;

  return (
    <section data-testid="vault-list" className="vault-list">
      <h2>Registered Vaults</h2>
      {vaults.length === 0 ? (
        <p data-testid="vault-list-empty">No vaults registered yet.</p>
      ) : (
        <table data-testid="vault-list-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Risk</th>
              <th>Status</th>
              <th>TVL</th>
              <th>Exit Fee (bps)</th>
              <th>Headroom</th>
            </tr>
          </thead>
          <tbody>
            {vaults.map((v) => (
              <tr
                key={v.address}
                data-testid="vault-list-row"
                data-address={v.address}
                onClick={() => onSelectVault?.(v.address)}
                style={onSelectVault ? { cursor: "pointer" } : undefined}
              >
                <td data-testid="vault-list-row-name">{v.name}</td>
                <td data-testid="vault-list-row-risk">{v.risk_label}</td>
                <td data-testid="vault-list-row-status">
                  {STATUS_LABEL[v.status] ?? String(v.status)}
                </td>
                <td data-testid="vault-list-row-tvl">{v.total_assets ?? "—"}</td>
                <td data-testid="vault-list-row-fee">{v.exit_fee_bps ?? "—"}</td>
                <td data-testid="vault-list-row-headroom">{headroom(v) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p data-testid="vault-list-freshness">Block {block_number}</p>
    </section>
  );
}
