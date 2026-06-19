// Canonical: docs/prd.md §11.2 — ProtocolAssetVault, §11.3 — AgentTokenVault, §11.4 — RWA vault

/**
 * VaultListRowAssets — expand/collapse affordance for a vault row in the
 * Portfolio Explorer > Registered Vaults table.
 *
 * Follows the same sub-component pattern as VaultCardAssets: the wagmi
 * useReadContract call for basket vaults lives here so React rules-of-hooks
 * are satisfied per-row. No wallet connection is required.
 */

import { useState } from "react";
import { useReadContract } from "wagmi";
import { BASKET_VAULT_SHORTLIST_ABI, type ShortlistEntry } from "../lib/abi";
import { formatTokenBalance } from "../lib/format";

/** Render the last 6 hex chars of an address as 0x...XXXXXX. */
function shortAddr(addr: string): string {
  return `0x...${addr.slice(-6).toUpperCase()}`;
}

interface AssetRowProps {
  token: string;
  active?: boolean | null;
  balance?: bigint | null;
  label?: string;
}

function AssetRow({ token, active, balance, label }: AssetRowProps) {
  const displayAddr = label ?? shortAddr(token);
  return (
    <li data-testid="vault-list-asset-entry">
      <span data-testid="vault-list-asset-address">{displayAddr}</span>
      {active != null && (
        <span data-testid="vault-list-asset-active">{active ? "active" : "inactive"}</span>
      )}
      {balance != null && (
        <span data-testid="vault-list-asset-balance">{formatTokenBalance(balance, 6)}</span>
      )}
    </li>
  );
}

interface VaultListRowAssetsProps {
  /** Vault contract address for the shortlist() call. */
  vaultAddress: string;
  /** risk_label from the indexer (STABLE_YIELD | VOLATILE | SPECULATIVE). */
  riskLabel: string;
  /** On-chain status: 0 = Active. Non-zero = inactive (Paused/Retired). */
  status: number;
}

/** Inner component that issues the live shortlist() call for basket vaults. */
function BasketShortlistPanel({ vaultAddress }: { vaultAddress: string }) {
  const { data, isError, isLoading } = useReadContract({
    abi: BASKET_VAULT_SHORTLIST_ABI,
    address: vaultAddress as `0x${string}`,
    functionName: "shortlist",
  });

  if (isLoading) {
    return (
      <ul data-testid="vault-list-row-assets-panel">
        <li data-testid="vault-list-assets-loading">Loading…</li>
      </ul>
    );
  }
  if (isError || !data) {
    return (
      <ul data-testid="vault-list-row-assets-panel">
        <li data-testid="vault-list-assets-error">unavailable</li>
      </ul>
    );
  }

  const entries = data as readonly ShortlistEntry[];
  return (
    <ul data-testid="vault-list-row-assets-panel">
      {entries.map((entry) => (
        <AssetRow
          key={entry.token}
          token={entry.token}
          active={entry.active}
          balance={entry.vaultBalance}
        />
      ))}
    </ul>
  );
}

/**
 * VaultListRowAssets — expand/collapse affordance for a vault table row.
 *
 * Renders a toggle button labelled 'Assets'. When expanded, shows the asset
 * panel appropriate for the vault type (same logic as VaultCardAssets).
 */
export function VaultListRowAssets({ vaultAddress, riskLabel, status }: VaultListRowAssetsProps) {
  const [expanded, setExpanded] = useState(false);

  const isActive = status === 0;
  const isBasket = riskLabel === "VOLATILE" || (riskLabel === "SPECULATIVE" && isActive);
  const isStableYield = riskLabel === "STABLE_YIELD";

  return (
    <>
      <button
        data-testid="vault-list-row-assets-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        type="button"
      >
        Assets
      </button>
      {expanded &&
        (isBasket ? (
          <BasketShortlistPanel vaultAddress={vaultAddress} />
        ) : isStableYield ? (
          <ul data-testid="vault-list-row-assets-panel">
            <AssetRow token="0x0000000000000000000000000000000000000000" label="USDC" />
          </ul>
        ) : (
          /* Inactive SPECULATIVE (RWA placeholder) */
          <ul data-testid="vault-list-row-assets-panel">
            <AssetRow token="0x0000000000000000000000000000000000000000" label="deSPXA" />
          </ul>
        ))}
    </>
  );
}
