// Canonical: docs/architecture.md §4.2 — Portfolio Router

/**
 * RouterView — reads GET /v1/router/weights and GET /v1/governance/proposals.
 *
 * Shows current Portfolio Router weight vector, the pending governance
 * proposal (if any), and the full weight-change history.
 * Works without a connected wallet.
 *
 * issue #318 — protocol layer.
 */
import { useEffect, useState } from "react";
import type { FetchLike, RouterWeightsResponse, ProposalSummary } from "../lib/explorerApi";
import { fetchRouterWeights, fetchProposals } from "../lib/explorerApi";

interface RouterViewProps {
  apiUrl: string;
  fetchImpl?: FetchLike;
}

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ok";
      weights: RouterWeightsResponse;
      pendingProposal: ProposalSummary | null;
    };

export function RouterView({ apiUrl, fetchImpl }: RouterViewProps) {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    const ac = new AbortController();
    const opts = { fetchImpl, signal: ac.signal };

    Promise.all([fetchRouterWeights(apiUrl, opts), fetchProposals(apiUrl, opts)])
      .then(([weights, proposals]) => {
        const pendingProposal = proposals.proposals.find((p) => p.status === "open") ?? null;
        setState({ phase: "ok", weights, pendingProposal });
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setState({ phase: "error", message: String(err) });
      });
    return () => ac.abort();
  }, [apiUrl, fetchImpl]);

  if (state.phase === "loading") {
    return (
      <section data-testid="router-view">
        <p data-testid="router-view-loading">Loading router state…</p>
      </section>
    );
  }
  if (state.phase === "error") {
    return (
      <section data-testid="router-view">
        <p data-testid="router-view-error">{state.message}</p>
      </section>
    );
  }

  const { weights, pendingProposal } = state;

  return (
    <section data-testid="router-view" className="router-view">
      <h2>Portfolio Router</h2>

      <h3>Current Weights</h3>
      {weights.current_weights.length === 0 ? (
        <p data-testid="router-view-weights-empty">No weights set yet.</p>
      ) : (
        <table data-testid="router-view-weights-table">
          <thead>
            <tr>
              <th>Vault</th>
              <th>Weight (bps)</th>
            </tr>
          </thead>
          <tbody>
            {weights.current_weights.map((w) => (
              <tr key={w.vault} data-testid="router-view-weight-row">
                <td data-testid="router-view-weight-vault" className="font-mono">
                  {w.vault}
                </td>
                <td data-testid="router-view-weight-bps">{w.bps}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Pending Proposal</h3>
      {pendingProposal == null ? (
        <p data-testid="router-view-no-proposal">No pending proposal.</p>
      ) : (
        <div data-testid="router-view-pending-proposal" className="stat-card">
          <p>
            <strong>#{pendingProposal.proposal_id}</strong>:{" "}
            <span data-testid="router-view-proposal-description">
              {pendingProposal.description}
            </span>
          </p>
          <p>
            Status: <span data-testid="router-view-proposal-status">{pendingProposal.status}</span>
          </p>
          <p>Deadline block: {pendingProposal.deadline_block}</p>
        </div>
      )}

      <h3>Weight History</h3>
      {weights.history.length === 0 ? (
        <p data-testid="router-view-history-empty">No weight history.</p>
      ) : (
        <table data-testid="router-view-history-table">
          <thead>
            <tr>
              <th>Block</th>
              <th>Tx Hash</th>
              <th>Weights</th>
            </tr>
          </thead>
          <tbody>
            {weights.history.map((entry) => (
              <tr key={entry.block_number} data-testid="router-view-history-row">
                <td data-testid="router-view-history-block">{entry.block_number}</td>
                <td data-testid="router-view-history-tx" className="font-mono">
                  {entry.tx_hash}
                </td>
                <td>
                  {entry.weights.map((w) => `${w.vault.slice(0, 8)}…: ${w.bps}bps`).join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p data-testid="router-view-freshness">Block {weights.block_number}</p>
    </section>
  );
}
