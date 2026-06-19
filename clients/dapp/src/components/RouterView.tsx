// Canonical: docs/architecture.md §4.2 — Portfolio Router

/**
 * RouterView — reads GET /v1/router/weights, GET /v1/governance/proposals,
 * and GET /v1/vaults.
 *
 * Shows current Portfolio Router weight vector, the pending governance
 * proposal (if any), and the full weight-change history.
 * Works without a connected wallet.
 *
 * Enhancements (issue #615):
 * - Resolves vault hex addresses to human-readable names via /v1/vaults.
 * - Displays bps as both raw value and percentage (bps / 100).
 * - Renders a proportional bar for each weight entry.
 * - Labels the weight source: "Effective (default)" when no governance
 *   proposal is active, "Effective (voted)" when a passed vote is in effect.
 *
 * issue #318 — protocol layer.
 */
import { useEffect, useState } from "react";
import type {
  FetchLike,
  RouterWeightsResponse,
  ProposalSummary,
  ProposalsResponse,
  VaultsResponse,
} from "../lib/explorerApi";
import { fetchRouterWeights, fetchProposals, fetchVaults } from "../lib/explorerApi";
import { formatPercentFromNumber } from "../lib/format";

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
      vaultNames: Record<string, string>;
    };

export function RouterView({ apiUrl, fetchImpl }: RouterViewProps) {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    const ac = new AbortController();
    const opts = { fetchImpl, signal: ac.signal };

    Promise.all([
      fetchRouterWeights(apiUrl, opts),
      fetchProposals(apiUrl, opts),
      fetchVaults(apiUrl, opts),
    ])
      .then(
        ([weights, proposals, vaultsResp]: [
          RouterWeightsResponse,
          ProposalsResponse,
          VaultsResponse,
        ]) => {
          const pendingProposal = proposals.proposals.find((p) => p.status === "open") ?? null;
          // Build a map from lower-cased vault address → display name.
          const vaultNames: Record<string, string> = {};
          for (const v of vaultsResp.vaults) {
            vaultNames[v.address.toLowerCase()] = v.name;
          }
          setState({ phase: "ok", weights, pendingProposal, vaultNames });
        },
      )
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

  const { weights, pendingProposal, vaultNames } = state;

  /**
   * Resolve a vault address to its human-readable name.
   * Falls back to the raw hex address when the vault is not in the registry.
   */
  function resolveVaultName(address: string): string {
    return vaultNames[address.toLowerCase()] ?? address;
  }

  /**
   * Weight source label: "Effective (voted)" when a governance proposal
   * is active (status == "open"); "Effective (default)" otherwise.
   */
  const weightSourceLabel = pendingProposal != null ? "Effective (voted)" : "Effective (default)";

  return (
    <section data-testid="router-view" className="router-view">
      <h2>Portfolio Router</h2>

      <h3>Current Weights</h3>
      {weights.current_weights.length === 0 ? (
        <p data-testid="router-view-weights-empty">No weights set yet.</p>
      ) : (
        <>
          <p data-testid="router-view-weight-source" className="weight-source-label">
            {weightSourceLabel}
          </p>
          <table data-testid="router-view-weights-table">
            <thead>
              <tr>
                <th>Vault</th>
                <th>Weight (bps)</th>
                <th>Allocation</th>
              </tr>
            </thead>
            <tbody>
              {weights.current_weights.map((w) => (
                <tr key={w.vault} data-testid="router-view-weight-row">
                  <td data-testid="router-view-weight-vault">{resolveVaultName(w.vault)}</td>
                  <td data-testid="router-view-weight-bps">
                    <span data-testid="router-view-weight-bps-raw">{w.bps}</span>
                    {" bps ("}
                    <span data-testid="router-view-weight-bps-pct">
                      {formatPercentFromNumber(w.bps)}
                    </span>
                    {")"}
                  </td>
                  <td data-testid="router-view-weight-bar-cell">
                    <div
                      data-testid="router-view-weight-bar"
                      className="weight-bar"
                      style={{
                        width: formatPercentFromNumber(w.bps),
                        background: "var(--accent, #4f8ef7)",
                        height: "0.75em",
                        borderRadius: "2px",
                        minWidth: "2px",
                      }}
                      title={`${formatPercentFromNumber(w.bps)}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
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
                  {entry.weights
                    .map(
                      (w) =>
                        `${resolveVaultName(w.vault)}: ${w.bps}bps (${formatPercentFromNumber(w.bps)})`,
                    )
                    .join(", ")}
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
