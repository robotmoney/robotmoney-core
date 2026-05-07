/**
 * HistoryPane — issue #88 / docs/implementation-plan.md §12.
 *
 * Optional pane that fetches recent agent deposits from the phase-5
 * explorer API (`/v1/agents/:address/deposits`) and renders them as a
 * read-only table. Hidden by default; the parent only mounts this
 * component when `featureFlags.historyPane` is true. The pane never
 * issues an RPC call — live chain state stays on the wagmi/RPC path.
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import {
  fetchAgentDeposits,
  type DepositRow,
  type DepositsResponse,
  type FetchLike,
} from "../lib/explorerApi";

export interface HistoryPaneProps {
  /** 0x-prefixed agent address whose deposits to fetch. */
  readonly agent: Address;
  /** Resolved explorer API base URL (no trailing slash required). */
  readonly apiUrl: string;
  /**
   * Optional fetch implementation. Tests inject a mock; production code
   * uses the global `fetch`.
   */
  readonly fetchImpl?: FetchLike;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; rows: readonly DepositRow[]; latestBlock: number; indexedAt: string }
  | { kind: "error"; message: string };

export function HistoryPane(props: HistoryPaneProps) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    setState({ kind: "loading" });
    fetchAgentDeposits(props.apiUrl, props.agent, {
      fetchImpl: props.fetchImpl,
      signal: ac.signal,
    })
      .then((res: DepositsResponse) => {
        if (cancelled) return;
        setState({
          kind: "ready",
          rows: res.deposits,
          latestBlock: res.freshness.block_number,
          indexedAt: res.freshness.indexed_at,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [props.agent, props.apiUrl, props.fetchImpl]);

  return (
    <section data-testid="history-pane">
      <h2>Deposit history</h2>
      <p>
        Read-only view sourced from the explorer API at{" "}
        <code data-testid="history-pane-api-url">{props.apiUrl}</code>. Not used for live state.
      </p>
      {state.kind === "loading" && (
        <p data-testid="history-pane-loading">Loading deposit history…</p>
      )}
      {state.kind === "error" && (
        <p data-testid="history-pane-error">Failed to load history: {state.message}</p>
      )}
      {state.kind === "ready" && (
        <>
          <p data-testid="history-pane-freshness">
            Latest indexed block <code>{state.latestBlock}</code> at <code>{state.indexedAt}</code>
          </p>
          {state.rows.length === 0 ? (
            <p data-testid="history-pane-empty">No deposits indexed for this agent.</p>
          ) : (
            <table data-testid="history-pane-table">
              <thead>
                <tr>
                  <th>Block</th>
                  <th>Indexed at</th>
                  <th>Tx hash</th>
                  <th>Payment id</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((row) => (
                  <tr key={`${row.tx_hash}-${row.log_index}`} data-testid="history-pane-row">
                    <td data-testid="history-pane-row-block">{row.block_number}</td>
                    <td data-testid="history-pane-row-indexed-at">{row.indexed_at}</td>
                    <td data-testid="history-pane-row-tx">{row.tx_hash}</td>
                    <td data-testid="history-pane-row-payment-id">{row.payment_id}</td>
                    <td data-testid="history-pane-row-amount">{row.amount}</td>
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
