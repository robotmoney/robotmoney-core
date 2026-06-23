// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §3
// Implements: issue #1044 — regime-feed dapp surface

/**
 * RegimeFeedPanel — renders the canonical daily regime feed surface.
 *
 * The regime feed is the shared input that all Investment Committee agents
 * optionally consume when forming their allocation tilts. It is published
 * by the robotmoney-analyst infrastructure and surfaced here for transparency.
 *
 * Data flow:
 *   - Regime entries: GET /v1/regime-feed (indexed explorer API).
 *   - CommitteeApiClient wraps the endpoint.
 *
 * Out of scope (v0):
 *   - Agents are not obligated to use the regime feed — it is optional input.
 *   - Inter-agent debate surface (v1+).
 */
import { useEffect, useState } from "react";
import type { RegimeFeed, RegimeFeedResponse, FetchLike } from "../lib/committeeApi";
import { CommitteeApiClient } from "../lib/committeeApi";

// ─── Props ────────────────────────────────────────────────────────────────────

export interface RegimeFeedPanelProps {
  /** Base URL for the explorer-api service. */
  readonly explorerApiUrl: string;
  /** Optional fetch override for testing. */
  readonly fetch?: FetchLike;
  /** Max number of regime entries to display. Default 7. */
  readonly limit?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RegimeFeedPanel(props: RegimeFeedPanelProps) {
  const [feeds, setFeeds] = useState<readonly RegimeFeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const client = new CommitteeApiClient(props.explorerApiUrl, props.fetch);
  const limit = props.limit ?? 7;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        const res: RegimeFeedResponse = await client.getRegimeFeed(limit);
        if (!cancelled) {
          setFeeds(res.feeds);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unknown error loading regime feed");
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
  }, [props.explorerApiUrl, limit]);

  return (
    <section data-testid="regime-feed-panel">
      <h2>Daily Regime Feed</h2>
      <p data-testid="regime-feed-description">
        The canonical daily market regime read. Committee agents may optionally consume this feed as
        shared context when forming their allocation tilts. Agents are not obligated to use it — it
        is advisory input, not a mandate.
      </p>

      {loading && <p data-testid="regime-feed-loading">Loading regime feed…</p>}
      {error && <p data-testid="regime-feed-error">Error: {error}</p>}

      {!loading && !error && feeds.length === 0 && (
        <p data-testid="regime-feed-empty">No regime entries available.</p>
      )}
      {!loading && !error && feeds.length > 0 && (
        <ul data-testid="regime-feed-list">
          {feeds.map((entry) => (
            <li key={entry.date} data-testid={`regime-feed-entry-${entry.date}`}>
              <strong data-testid="regime-feed-date">{entry.date}</strong>
              {" — "}
              <span data-testid="regime-feed-regime">{entry.regime}</span>
              {": "}
              <span data-testid="regime-feed-description-text">{entry.description}</span>
              {entry.source_uri && (
                <span>
                  {" "}
                  <a
                    data-testid="regime-feed-source-link"
                    href={entry.source_uri}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Source ↗
                  </a>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
