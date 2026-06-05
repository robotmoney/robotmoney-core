// Canonical: docs/prd.md §11.2 — ProtocolAssetVault, §11.3 — AgentTokenVault, §11.4 — RWA vault

/**
 * VaultCardAssets — inline asset panel for a single vault card on the landing
 * page. Follows the LandingPriceStrip/usePoolPrice sub-component pattern: the
 * wagmi useReadContract call lives here so React rules-of-hooks are satisfied
 * (each card instance renders an independent hook).
 *
 * Basket vaults (VOLATILE risk_label, or SPECULATIVE + Active status) call
 * AgentTokenVault.shortlist() / ProtocolAssetVault.shortlist() live. Single-
 * asset USDC vault (STABLE_YIELD) and inactive RWA vault (SPECULATIVE +
 * non-Active) use static entries without any shortlist() call.
 *
 * No wallet connection is required — wagmi useReadContract works without a
 * signer.
 */

import { useState } from "react";
import { useReadContract } from "wagmi";
import { BASKET_VAULT_SHORTLIST_ABI, type ShortlistEntry } from "../lib/abi";

/** Render the last 6 hex chars of an address as 0x...XXXXXX. */
function shortAddr(addr: string): string {
  return `0x...${addr.slice(-6).toUpperCase()}`;
}

/** Format a raw uint256 balance as a decimal string (no unit conversion). */
function formatBalance(balance: bigint): string {
  return balance.toString();
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
    <li data-testid="vault-card-asset-entry">
      <span data-testid="vault-card-asset-address">{displayAddr}</span>
      {active != null && (
        <span data-testid="vault-card-asset-active">{active ? "active" : "inactive"}</span>
      )}
      {balance != null && (
        <span data-testid="vault-card-asset-balance">{formatBalance(balance)}</span>
      )}
    </li>
  );
}

interface VaultCardAssetsProps {
  /** Vault contract address for the shortlist() call. */
  vaultAddress: string;
  /** risk_label from the indexer (STABLE_YIELD | VOLATILE | SPECULATIVE). */
  riskLabel: string;
  /** On-chain status: 0 = Active. Non-zero = inactive (Paused/Retired). */
  status: number;
}

/**
 * Inner component that calls shortlist() once per basket vault address.
 * Isolating the hook here keeps Rules of Hooks satisfied even when multiple
 * vault cards are rendered in a list.
 */
function BasketShortlistPanel({ vaultAddress }: { vaultAddress: string }) {
  const { data, isError, isLoading } = useReadContract({
    abi: BASKET_VAULT_SHORTLIST_ABI,
    address: vaultAddress as `0x${string}`,
    functionName: "shortlist",
  });

  if (isLoading) {
    return (
      <ul data-testid="vault-card-assets-panel">
        <li data-testid="vault-card-assets-loading">Loading…</li>
      </ul>
    );
  }
  if (isError || !data) {
    return (
      <ul data-testid="vault-card-assets-panel">
        <li data-testid="vault-card-assets-error">unavailable</li>
      </ul>
    );
  }

  const entries = data as readonly ShortlistEntry[];
  return (
    <ul data-testid="vault-card-assets-panel">
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
 * VaultCardAssets — expand/collapse affordance for a single vault card.
 *
 * Renders a toggle button labelled 'Assets'. When expanded, shows the asset
 * panel appropriate for the vault type:
 *   - Basket vault (VOLATILE, or SPECULATIVE + Active): live shortlist() call.
 *   - STABLE_YIELD: static single 'USDC' entry.
 *   - SPECULATIVE + non-Active (RWA placeholder): static 'deSPXA' entry.
 */
export function VaultCardAssets({ vaultAddress, riskLabel, status }: VaultCardAssetsProps) {
  const [expanded, setExpanded] = useState(false);

  const isActive = status === 0;
  const isBasket = riskLabel === "VOLATILE" || (riskLabel === "SPECULATIVE" && isActive);
  const isStableYield = riskLabel === "STABLE_YIELD";

  return (
    <div className="vault-card-assets">
      <button
        data-testid="landing-vault-card-assets-toggle"
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
          <ul data-testid="vault-card-assets-panel">
            <AssetRow token="0x0000000000000000000000000000000000000000" label="USDC" />
          </ul>
        ) : (
          /* Inactive SPECULATIVE (RWA placeholder) */
          <ul data-testid="vault-card-assets-panel">
            <AssetRow token="0x0000000000000000000000000000000000000000" label="deSPXA" />
          </ul>
        ))}
    </div>
  );
}
