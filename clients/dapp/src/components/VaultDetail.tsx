// Canonical: docs/architecture.md §4.1 — Vault Family

/**
 * VaultDetail — reads GET /v1/vaults/:address and renders a single vault.
 *
 * Shows adapter allocation (risk_label used as label), TVL chart (table
 * of tvl_history rows), fees, caps, event log freshness, and a Composition
 * section (issue #941) that answers "if I deposit here, what do I get back?".
 *
 * Composition section:
 *   - VOLATILE vault, or SPECULATIVE + Active (basket): fetches live
 *     shortlist() entries (address, active status, vault balance) via wagmi
 *     useReadContract. No wallet connection is required.
 *   - STABLE_YIELD vault: static label ("Deposit: USDC → Receipt: rmUSDC").
 *   - Inactive SPECULATIVE (RWA placeholder): static label
 *     ("Deposit: deSPXA → Receipt: vault receipt token").
 *
 * Works without a connected wallet.
 *
 * issue #318 — protocol layer.
 * issue #941 — composition view.
 */
import { useEffect, useState } from "react";
import { useReadContract } from "wagmi";
import type { FetchLike, VaultDetailRow } from "../lib/explorerApi";
import { fetchVaultDetail } from "../lib/explorerApi";
import { BASKET_VAULT_SHORTLIST_ABI, type ShortlistEntry } from "../lib/abi";
import { formatTokenBalance } from "../lib/format";

const STATUS_LABEL: Record<number, string> = {
  0: "Active",
  1: "Paused",
  2: "Retired",
};

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
    <li data-testid="vault-detail-composition-entry">
      <span data-testid="vault-detail-composition-address">{displayAddr}</span>
      {active != null && (
        <span data-testid="vault-detail-composition-active">{active ? "active" : "inactive"}</span>
      )}
      {balance != null && (
        <span data-testid="vault-detail-composition-balance">{formatTokenBalance(balance, 6)}</span>
      )}
    </li>
  );
}

/**
 * Inner component that calls shortlist() once per basket vault address.
 * Isolating the hook here keeps Rules of Hooks satisfied even when multiple
 * vault detail views might coexist (e.g. tests).
 */
function BasketShortlistPanel({ vaultAddress }: { vaultAddress: string }) {
  const { data, isError, isLoading } = useReadContract({
    abi: BASKET_VAULT_SHORTLIST_ABI,
    address: vaultAddress as `0x${string}`,
    functionName: "shortlist",
  });

  if (isLoading) {
    return (
      <ul data-testid="vault-detail-composition-list">
        <li data-testid="vault-detail-composition-loading">Loading…</li>
      </ul>
    );
  }
  if (isError || !data) {
    return (
      <ul data-testid="vault-detail-composition-list">
        <li data-testid="vault-detail-composition-error">unavailable</li>
      </ul>
    );
  }

  const entries = data as readonly ShortlistEntry[];
  return (
    <ul data-testid="vault-detail-composition-list">
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

interface CompositionSectionProps {
  vaultAddress: string;
  riskLabel: string;
  status: number;
}

/**
 * CompositionSection — renders the Composition block appropriate for the
 * vault type.
 *
 * Basket vaults (VOLATILE, or SPECULATIVE + Active): live shortlist() call.
 * STABLE_YIELD: static label.
 * Inactive SPECULATIVE (RWA placeholder): static label.
 */
function CompositionSection({ vaultAddress, riskLabel, status }: CompositionSectionProps) {
  const isActive = status === 0;
  const isBasket = riskLabel === "VOLATILE" || (riskLabel === "SPECULATIVE" && isActive);
  const isStableYield = riskLabel === "STABLE_YIELD";

  return (
    <div data-testid="vault-detail-composition" className="vault-detail-composition">
      <h3>Composition</h3>
      {isBasket ? (
        <BasketShortlistPanel vaultAddress={vaultAddress} />
      ) : isStableYield ? (
        <p data-testid="vault-detail-composition-label">
          Deposit: USDC → Receipt: rmUSDC
        </p>
      ) : (
        /* Inactive SPECULATIVE (RWA placeholder) */
        <p data-testid="vault-detail-composition-label">
          Deposit: deSPXA → Receipt: vault receipt token
        </p>
      )}
    </div>
  );
}

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

      <CompositionSection
        vaultAddress={vault.address}
        riskLabel={vault.risk_label}
        status={vault.status}
      />

      <h3>TVL History</h3>
      {vault.tvl_history.length === 0 ? (
        <p data-testid="vault-detail-tvl-empty">No TVL data yet.</p>
      ) : (
        <div className="table-scroll">
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
        </div>
      )}

      {vault.risk_label === "SPECULATIVE" && (
        <div
          data-testid="vault-detail-issuer-freeze-disclosure"
          className="risk-disclosure"
          role="alert"
          aria-label="Issuer freeze-control risk disclosure"
        >
          <strong>Issuer Freeze-Control Risk Disclosure</strong>
          <p>
            This vault holds deSPXA, which is subject to issuer controls by{" "}
            <strong>Centrifuge</strong> and <strong>Janus Henderson</strong>. The issuer may freeze
            or restrict transfers of the underlying token at any time, which would block vault entry
            and exit independently of Aerodrome liquidity. This is a known, accepted risk for this
            SPECULATIVE-category vault. Depositors should understand that a freeze event could
            prevent withdrawals until the issuer lifts the restriction.
          </p>
        </div>
      )}

      <p data-testid="vault-detail-freshness">Block {block_number}</p>
    </section>
  );
}
