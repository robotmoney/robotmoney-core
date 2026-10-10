// Canonical: docs/architecture.md §4.1 — Vault Family

/**
 * VaultList — reads GET /v1/vaults and renders all registered vaults.
 *
 * Works without a connected wallet. Each row shows the vault name,
 * risk_label, status badge, TVL (total_assets), exit_fee_bps, the TVL cap,
 * the per-deposit cap, and the headroom the explorer computed from the vault's own
 * `tvlCap()` and `perDepositCap()` (issue 1741). A cap the explorer could not read
 * shows "unknown", never 0.
 *
 * Data comes from ExplorerContext (shared polling loop in main.tsx), so this
 * component always displays the same block_number as VaultCards — no
 * mixed-block state between the landing page and the Portfolio Explorer tab.
 *
 * issue #318 — protocol layer.
 */
import { useExplorer } from "../lib/ExplorerContext";
import { formatUsdcCapString, formatUsdcString } from "../lib/format";
import { useVaultsDepositsPaused } from "../lib/useVaultsDepositsPaused";
import { depositStateAttr, depositStateLabel, resolveDepositState } from "../lib/vaultDepositState";
import { IndexFreshness } from "./IndexFreshness";

interface VaultListProps {
  onSelectVault?: (address: string) => void;
}

export function VaultList({ onSelectVault }: VaultListProps) {
  const { vaults, blockNumber, chainHeadBlock, vaultsLoading, vaultsError } = useExplorer();
  const { byAddress: chainPaused } = useVaultsDepositsPaused(vaults.map((v) => v.address));

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
                <th>TVL Cap</th>
                <th>Per-deposit Cap</th>
                <th>Headroom</th>
              </tr>
            </thead>
            <tbody>
              {vaults.map((v) => {
                const deposit = resolveDepositState({
                  registryStatus: v.status,
                  explorerPaused: v.deposits_paused,
                  explorerBlock: blockNumber,
                  explorerHead: chainHeadBlock,
                  chainPaused: chainPaused.get(v.address.toLowerCase()),
                });
                return (
                  <tr
                    key={v.address}
                    data-testid={`vault-list-row-${v.address.toLowerCase()}`}
                    data-vault-addr={v.address.toLowerCase()}
                    data-deposit-state={depositStateAttr(deposit)}
                    onClick={() => onSelectVault?.(v.address)}
                    style={onSelectVault ? { cursor: "pointer" } : undefined}
                  >
                    <td data-testid="vault-list-row-name">{v.name}</td>
                    <td data-testid="vault-list-row-risk">{v.risk_label}</td>
                    <td data-testid="vault-list-row-status">{depositStateLabel(deposit)}</td>
                    <td data-testid="vault-list-row-tvl">{formatUsdcString(v.total_assets)}</td>
                    <td data-testid="vault-list-row-fee">{v.exit_fee_bps ?? "—"}</td>
                    <td data-testid="vault-list-row-tvl-cap">{formatUsdcCapString(v.tvl_cap)}</td>
                    <td data-testid="vault-list-row-per-deposit-cap">
                      {formatUsdcCapString(v.per_deposit_cap)}
                    </td>
                    <td data-testid="vault-list-row-headroom">{formatUsdcCapString(v.headroom)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {blockNumber != null && (
        <IndexFreshness
          blockNumber={blockNumber}
          chainHeadBlock={chainHeadBlock}
          testId="vault-list-freshness"
        />
      )}
    </section>
  );
}
