/**
 * TransactionHistory — issue #319, account layer.
 *
 * Displays a chronological event log across all vaults for a watched address.
 * Fetches from `GET /v1/accounts/:address/history` (explorer API). Events are
 * returned in chronological order (ascending block number) from the API.
 *
 * Renders:
 *   - One row per event with type, block, tx hash, vault, and amount.
 *   - Loading, error, and empty states.
 *
 * No wallet required — read-only view from the explorer index.
 *
 * docs/architecture.md §5.3.
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import {
  fetchAccountHistory,
  type AccountEvent,
  type AccountHistoryResponse,
  type FetchLike,
} from "../lib/explorerApi";

export interface TransactionHistoryProps {
  /** Address to inspect. */
  readonly address: Address;
  /** Resolved explorer API base URL (no trailing slash required). */
  readonly apiUrl: string;
  /** Optional fetch implementation; tests inject a mock. */
  readonly fetchImpl?: FetchLike;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; events: readonly AccountEvent[]; blockNumber: number }
  | { kind: "error"; message: string };

export function TransactionHistory(props: TransactionHistoryProps) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    setState({ kind: "loading" });

    fetchAccountHistory(props.apiUrl, props.address, {
      fetchImpl: props.fetchImpl,
      signal: ac.signal,
    })
      .then((res: AccountHistoryResponse) => {
        if (cancelled) return;
        setState({
          kind: "ready",
          events: res.events,
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

  return (
    <section data-testid="transaction-history">
      <h2>Transaction history</h2>
      <p data-testid="transaction-history-address">
        Address: <code>{props.address}</code>
      </p>

      {state.kind === "loading" && (
        <p data-testid="transaction-history-loading">Loading transaction history…</p>
      )}

      {state.kind === "error" && (
        <p data-testid="transaction-history-error">Failed to load history: {state.message}</p>
      )}

      {state.kind === "ready" && (
        <>
          <p data-testid="transaction-history-freshness">
            Indexed at block <code>{state.blockNumber}</code>
          </p>

          {state.events.length === 0 ? (
            <p data-testid="transaction-history-empty">No events indexed for this address.</p>
          ) : (
            <table data-testid="transaction-history-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Block</th>
                  <th>Tx hash</th>
                  <th>Vault</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {state.events.map((ev, i) => (
                  <tr
                    // eslint-disable-next-line react/no-array-index-key -- events have no stable unique id
                    key={`${ev.tx_hash}-${i}`}
                    data-testid="transaction-history-row"
                  >
                    <td data-testid="transaction-history-row-type">{ev.event_type}</td>
                    <td data-testid="transaction-history-row-block">{ev.block_number}</td>
                    <td data-testid="transaction-history-row-tx">{ev.tx_hash}</td>
                    <td data-testid="transaction-history-row-vault">{ev.vault_address ?? "—"}</td>
                    <td data-testid="transaction-history-row-amount">{ev.amount ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
