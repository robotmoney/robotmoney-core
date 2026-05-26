// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * PortfolioPosition — issue #319, account layer.
 *
 * Displays receipt-token balances per registered vault for a watched address.
 * Fetches indexed position data from `GET /v1/accounts/:address/positions`
 * (the explorer API). Live USDC conversion via `vault.convertToAssets` is the
 * caller's responsibility (the component accepts pre-computed `usdcValues` so
 * it stays pure and testable without RPC).
 *
 * Renders:
 *   - One row per vault with non-zero indexed share balance.
 *   - A composite portfolio total (sum of all per-vault USDC values when
 *     provided; otherwise just the share totals).
 *   - Loading, error, and empty states.
 *
 * No wallet or signature required — data flows from the explorer API index and
 * the optional `usdcValues` map from the parent's on-chain reads.
 *
 * docs/architecture.md §5.3.
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import {
  fetchAccountPositions,
  type AccountPosition,
  type AccountPositionsResponse,
  type FetchLike,
} from "../lib/explorerApi";
import { VaultPositionCard } from "./shared";

export interface PortfolioPositionProps {
  /** Address to inspect (watched-address or connected wallet). */
  readonly address: Address;
  /** Resolved explorer API base URL (no trailing slash required). */
  readonly apiUrl: string;
  /**
   * Optional map from vault_address (lower-case hex) to USDC value string
   * (decimal, 6-decimal units). Injected by the parent after live chain reads
   * (`vault.convertToAssets(shares)`). When absent a dash is shown.
   */
  readonly usdcValues?: Readonly<Record<string, string>>;
  /** Optional fetch implementation; tests inject a mock. */
  readonly fetchImpl?: FetchLike;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; positions: readonly AccountPosition[]; blockNumber: number }
  | { kind: "error"; message: string };

export function PortfolioPosition(props: PortfolioPositionProps) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    setState({ kind: "loading" });

    fetchAccountPositions(props.apiUrl, props.address, {
      fetchImpl: props.fetchImpl,
      signal: ac.signal,
    })
      .then((res: AccountPositionsResponse) => {
        if (cancelled) return;
        setState({
          kind: "ready",
          positions: res.positions,
          blockNumber: res.block_number,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [props.address, props.apiUrl, props.fetchImpl]);

  const usdcValues = props.usdcValues ?? {};

  /** Compute composite total when all vaults have a USDC value. */
  function compositeTotal(positions: readonly AccountPosition[]): string | null {
    if (positions.length === 0) return "0";
    let total = 0n;
    for (const p of positions) {
      const v = usdcValues[p.vault_address.toLowerCase()];
      if (v === undefined) return null;
      try {
        total += BigInt(v);
      } catch {
        return null;
      }
    }
    return total.toString();
  }

  return (
    <section data-testid="portfolio-position">
      <h2>Portfolio position</h2>
      <p data-testid="portfolio-position-address">
        Address: <code>{props.address}</code>
      </p>

      {state.kind === "loading" && (
        <p data-testid="portfolio-position-loading">Loading positions…</p>
      )}

      {state.kind === "error" && (
        <p data-testid="portfolio-position-error">Failed to load positions: {state.message}</p>
      )}

      {state.kind === "ready" && (
        <>
          <p data-testid="portfolio-position-freshness">
            Indexed at block <code>{state.blockNumber}</code>
          </p>

          {state.positions.length === 0 ? (
            <p data-testid="portfolio-position-empty">No positions indexed for this address.</p>
          ) : (
            <>
              <table data-testid="portfolio-position-table">
                <thead>
                  <tr>
                    <th>Vault</th>
                    <th>Risk</th>
                    <th>Shares</th>
                    <th>USDC value</th>
                  </tr>
                </thead>
                <tbody>
                  {state.positions.map((pos) => {
                    const usdc = usdcValues[pos.vault_address.toLowerCase()];
                    return (
                      <tr key={pos.vault_address} data-testid="portfolio-position-row">
                        <td data-testid="portfolio-position-row-vault">{pos.vault_name}</td>
                        <td data-testid="portfolio-position-row-risk">{pos.risk_label}</td>
                        <td data-testid="portfolio-position-row-shares">{pos.shares}</td>
                        <td data-testid="portfolio-position-row-usdc">
                          {usdc !== undefined ? usdc : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <p data-testid="portfolio-position-total">
                Composite total (USDC):{" "}
                <strong>
                  {compositeTotal(state.positions) !== null ? compositeTotal(state.positions) : "—"}
                </strong>
              </p>

              {/* Shared VaultPositionCard view — satisfies the shared-component
                  wiring requirement (issue #381). Each card is independently
                  visible and testable without the table. */}
              <div className="vault-card-grid" data-testid="portfolio-position-cards">
                {state.positions.map((pos) => {
                  const usdc = usdcValues[pos.vault_address.toLowerCase()];
                  return (
                    <VaultPositionCard
                      key={pos.vault_address}
                      vaultAddress={pos.vault_address}
                      vaultName={pos.vault_name}
                      shares={pos.shares}
                      riskLabel={pos.risk_label}
                      usdcValue={usdc}
                    />
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
