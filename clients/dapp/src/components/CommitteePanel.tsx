// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §3
// Implements: issue #1054 — committee dapp surface (agents, tilts, track record, vote-submit flow)

/**
 * CommitteePanel — renders the Investment Committee protocol-layer surface:
 *   - Registered agents list (agent_id, address, registration date).
 *   - Aggregated per-vault committee tilts (GET /v1/committee/tilts).
 *   - Per-agent vote history with per-vault stance, target weight, confidence,
 *     and a link to the rationale URI.
 *
 * Signalling-only disclosure (docs/architecture.md §IC): committee votes are
 * advisory signals. Router weights are applied by admins after reviewing
 * signals — no vote automatically changes live allocation.
 *
 * Data flow:
 *   - Agents list: GET /v1/committee/agents (indexed explorer API).
 *   - Tilts aggregate: GET /v1/committee/tilts (indexed explorer API).
 *   - Votes: GET /v1/committee/votes (indexed explorer API).
 *   - CommitteeApiClient wraps all endpoints.
 *
 * Out of scope (v0):
 *   - Inter-agent deliberation / debate surfaces (v1+).
 *   - Retail conversion surface (v1+).
 *   - Permissionless agent registration (v1+).
 */
import { useEffect, useState } from "react";
import type {
  CommitteeAgent,
  CommitteeVote,
  CommitteeTilt,
  CommitteeAgentsResponse,
  CommitteeVotesResponse,
  CommitteeTiltsResponse,
  FetchLike,
  Stance,
} from "../lib/committeeApi";
import { CommitteeApiClient } from "../lib/committeeApi";

// ─── Props ────────────────────────────────────────────────────────────────────

export interface CommitteePanelProps {
  /** Base URL for the explorer-api service. */
  readonly explorerApiUrl: string;
  /** Optional fetch override for testing. */
  readonly fetch?: FetchLike;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stanceLabel(stance: Stance): string {
  switch (stance) {
    case "overweight":
      return "↑ Overweight";
    case "underweight":
      return "↓ Underweight";
    case "neutral":
      return "= Neutral";
    default:
      return stance;
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CommitteePanel(props: CommitteePanelProps) {
  const [agents, setAgents] = useState<readonly CommitteeAgent[]>([]);
  const [votes, setVotes] = useState<readonly CommitteeVote[]>([]);
  const [tilts, setTilts] = useState<readonly CommitteeTilt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const client = new CommitteeApiClient(props.explorerApiUrl, props.fetch);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        const [agentsRes, votesRes, tiltsRes]: [
          CommitteeAgentsResponse,
          CommitteeVotesResponse,
          CommitteeTiltsResponse,
        ] = await Promise.all([client.getAgents(), client.getVotes(50), client.getTilts()]);
        if (!cancelled) {
          setAgents(agentsRes.agents);
          setVotes(votesRes.votes);
          setTilts(tiltsRes.tilts);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unknown error loading committee data");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.explorerApiUrl]);

  const filteredVotes = selectedAgent
    ? votes.filter((v) => v.agent.toLowerCase() === selectedAgent.toLowerCase())
    : votes;

  return (
    <section data-testid="committee-panel">
      <h2>Investment Committee</h2>

      {/* Signalling-only disclosure */}
      <p data-testid="committee-signalling-disclosure">
        Committee votes are <strong>advisory signals only</strong>. Router weights are applied by
        admins after reviewing signals — no vote automatically changes live allocation.
      </p>

      {loading && <p data-testid="committee-loading">Loading committee data…</p>}
      {error && <p data-testid="committee-error">Error: {error}</p>}

      {!loading && !error && (
        <>
          {/* Registered agents */}
          <section data-testid="committee-agents-section">
            <h3>Registered Agents</h3>
            {agents.length === 0 ? (
              <p data-testid="committee-no-agents">No registered committee agents.</p>
            ) : (
              <table data-testid="committee-agents-table">
                <thead>
                  <tr>
                    <th>Agent ID</th>
                    <th>Address</th>
                    <th>Registered</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => (
                    <tr
                      key={agent.address}
                      data-testid={`committee-agent-row-${agent.address}`}
                      onClick={() =>
                        setSelectedAgent(selectedAgent === agent.address ? null : agent.address)
                      }
                      style={{ cursor: "pointer" }}
                    >
                      <td data-testid="committee-agent-id">{agent.agent_id}</td>
                      <td data-testid="committee-agent-address">
                        <code>{agent.address}</code>
                      </td>
                      <td data-testid="committee-agent-registered-at">
                        {formatTimestamp(agent.registered_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Per-vault tilt aggregate */}
          <section data-testid="committee-tilts-section">
            <h3>Per-Vault Committee Tilt Aggregate</h3>
            {tilts.length === 0 ? (
              <p data-testid="committee-no-tilts">No tilt data available yet.</p>
            ) : (
              <table data-testid="committee-tilts-table">
                <thead>
                  <tr>
                    <th>Vault</th>
                    <th>Aggregate Stance</th>
                    <th>Aggregate Weight (bps)</th>
                    <th>Contributing Agents</th>
                    <th>Last Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {tilts.map((tilt) => (
                    <tr key={tilt.vault} data-testid={`committee-tilt-row-${tilt.vault}`}>
                      <td data-testid="committee-tilt-vault">
                        <code>{tilt.vault.slice(0, 10)}…</code>
                      </td>
                      <td data-testid="committee-tilt-stance">
                        {stanceLabel(tilt.aggregate_stance)}
                      </td>
                      <td data-testid="committee-tilt-weight">{tilt.aggregate_weight_bps}</td>
                      <td data-testid="committee-tilt-agent-count">{tilt.agent_count}</td>
                      <td data-testid="committee-tilt-last-updated">
                        {formatTimestamp(tilt.last_updated)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Vote history */}
          <section data-testid="committee-votes-section">
            <h3>
              {selectedAgent
                ? `Votes by ${agents.find((a) => a.address === selectedAgent)?.agent_id ?? selectedAgent}`
                : "Recent Votes"}
            </h3>
            {selectedAgent && (
              <button
                type="button"
                data-testid="committee-votes-clear-filter"
                onClick={() => setSelectedAgent(null)}
              >
                Show all votes
              </button>
            )}
            {filteredVotes.length === 0 ? (
              <p data-testid="committee-no-votes">No votes to display.</p>
            ) : (
              <table data-testid="committee-votes-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Agent</th>
                    <th>Vault</th>
                    <th>Stance</th>
                    <th>Weight (bps)</th>
                    <th>Confidence</th>
                    <th>Rationale</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredVotes.map((vote) => (
                    <tr key={vote.vote_id} data-testid={`committee-vote-row-${vote.vote_id}`}>
                      <td data-testid="committee-vote-date">{formatTimestamp(vote.timestamp)}</td>
                      <td data-testid="committee-vote-agent">
                        {agents.find((a) => a.address.toLowerCase() === vote.agent.toLowerCase())
                          ?.agent_id ?? vote.agent.slice(0, 8)}
                      </td>
                      <td data-testid="committee-vote-vault">
                        <code>{vote.vault.slice(0, 10)}…</code>
                      </td>
                      <td data-testid="committee-vote-stance">{stanceLabel(vote.stance)}</td>
                      <td data-testid="committee-vote-weight">{vote.target_weight_bps}</td>
                      <td data-testid="committee-vote-confidence">{vote.confidence}%</td>
                      <td>
                        <a
                          data-testid="committee-vote-rationale-link"
                          href={vote.rationale_uri}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Rationale ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </section>
  );
}
