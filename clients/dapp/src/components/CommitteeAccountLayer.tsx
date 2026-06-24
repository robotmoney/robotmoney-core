// Canonical: docs/architecture.md §5.3 — Committee account layer
// Implements: issue #1054 — committee account layer (wallet-connected vote history)

/**
 * CommitteeAccountLayer — renders the account-layer surface for the
 * Investment Committee page.
 *
 * When a wallet address is present, this component fetches and displays
 * the agent's own committee vote history from the account-scoped endpoint:
 *   GET /v1/accounts/:address/committee-votes
 *
 * No wallet, no data — the component renders a prompt to connect a wallet
 * when `walletAddress` is undefined.
 *
 * Signalling-only: votes are advisory signals; no vote moves funds or
 * sets weights automatically (docs/architecture.md §IC).
 */
import { useEffect, useState } from "react";
import type {
  CommitteeVote,
  AccountCommitteeVotesResponse,
  FetchLike,
  Stance,
} from "../lib/committeeApi";
import { CommitteeApiClient } from "../lib/committeeApi";

// ─── Props ────────────────────────────────────────────────────────────────────

export interface CommitteeAccountLayerProps {
  /** Base URL for the explorer-api service. */
  readonly explorerApiUrl: string;
  /** Connected wallet address. When undefined, the component shows a connect prompt. */
  readonly walletAddress?: string;
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

export function CommitteeAccountLayer(props: CommitteeAccountLayerProps) {
  const [votes, setVotes] = useState<readonly CommitteeVote[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const client = new CommitteeApiClient(props.explorerApiUrl, props.fetch);

  useEffect(() => {
    if (!props.walletAddress) {
      setVotes([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        const res: AccountCommitteeVotesResponse = await client.getAccountCommitteeVotes(
          props.walletAddress as string,
        );
        if (!cancelled) {
          setVotes(res.votes);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unknown error loading vote history");
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
  }, [props.explorerApiUrl, props.walletAddress]);

  return (
    <section data-testid="committee-account-layer">
      <h3>My Vote History</h3>

      {!props.walletAddress && (
        <p data-testid="committee-account-no-wallet">
          Connect a wallet to view your committee vote history.
        </p>
      )}

      {props.walletAddress && loading && (
        <p data-testid="committee-account-loading">Loading vote history…</p>
      )}

      {props.walletAddress && error && <p data-testid="committee-account-error">Error: {error}</p>}

      {props.walletAddress && !loading && !error && votes.length === 0 && (
        <p data-testid="committee-account-no-votes">No committee votes found for this address.</p>
      )}

      {props.walletAddress && !loading && !error && votes.length > 0 && (
        <table data-testid="committee-account-votes-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Vault</th>
              <th>Stance</th>
              <th>Weight (bps)</th>
              <th>Confidence</th>
              <th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            {votes.map((vote) => (
              <tr key={vote.vote_id} data-testid={`committee-account-vote-row-${vote.vote_id}`}>
                <td data-testid="committee-account-vote-date">{formatTimestamp(vote.timestamp)}</td>
                <td data-testid="committee-account-vote-vault">
                  <code>{vote.vault.slice(0, 10)}…</code>
                </td>
                <td data-testid="committee-account-vote-stance">{stanceLabel(vote.stance)}</td>
                <td data-testid="committee-account-vote-weight">{vote.target_weight_bps}</td>
                <td data-testid="committee-account-vote-confidence">{vote.confidence}%</td>
                <td>
                  <a
                    data-testid="committee-account-vote-rationale-link"
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
  );
}
