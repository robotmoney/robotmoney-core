// Canonical: docs/architecture.md §4.1 — Vault Family

/**
 * VaultList — reads GET /v1/vaults and renders all registered vaults.
 *
 * Works without a connected wallet. Each row shows the vault name,
 * risk_label, status badge, TVL (total_assets), exit_fee_bps, and
 * deposit_cap_headroom (deposit_cap − total_assets when both are present).
 *
 * Data comes from ExplorerContext (shared polling loop in main.tsx), so this
 * component always displays the same block_number as VaultCards — no
 * mixed-block state between the landing page and the Portfolio Explorer tab.
 *
 * issue #318 — protocol layer.
 */
import type { VaultRow } from "../lib/explorerApi";
import { useExplorer } from "../lib/ExplorerContext";
import { VaultListRowAssets } from "./VaultListRowAssets";

const STATUS_LABEL: Record<number, string> = {
  0: "Active",
  1: "Paused",
  2: "Retired",
};

interface VaultListProps {
  onSelectVault?: (address: string) => void;
}

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

export function VaultList({ onSelectVault }: VaultListProps) {
  const { vaults, blockNumber, vaultsLoading, vaultsError } = useExplorer();

  if (vaultsLoading) {
    return (
      <section data-testid="vault-list">
        <p data-testid="vault-list-loading">Loading vaults…</p>
      </section>
    );
  }
  if (vaultsError) {
    return (
      <section data-testid="vault-list">
        <p data-testid="vault-list-error">{vaultsError}</p>
      </section>
    );
  }

  return (
    <section data-testid="vault-list" className="vault-list">
      <h2>Registered Vaults</h2>
      {vaults.length === 0 ? (
        <p data-testid="vault-list-empty">No vaults registered yet.</p>
      ) : (
        <div className="table-scroll">
          <table data-testid="vault-list-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Risk</th>
                <th>Status</th>
                <th>TVL</th>
                <th>Exit Fee (bps)</th>
                <th>Headroom</th>
                <th>Assets</th>
              </tr>
            </thead>
            <tbody>
              {vaults.map((v) => (
                <tr
                  key={v.address}
                  data-testid={`vault-list-row-${v.address.toLowerCase()}`}
                  data-vault-addr={v.address.toLowerCase()}
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
                  <td>
                    <VaultListRowAssets
                      vaultAddress={v.address}
                      riskLabel={v.risk_label}
                      status={v.status}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {blockNumber != null && <p data-testid="vault-list-freshness">Block {blockNumber}</p>}
    </section>
  );
}
