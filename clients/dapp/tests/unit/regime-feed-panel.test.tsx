/**
 * RegimeFeedPanel — RTL unit tests (issue #1054 AC5).
 *
 * AC5: clients/dapp Vitest suite exits 0 with a test asserting RegimeFeed
 * page renders the regime snapshot from a mocked /v1/regime/feed response.
 *
 * Covers:
 *   - Loading state shows loading text.
 *   - Error state renders the API error message.
 *   - Empty state shows empty notice.
 *   - Feed renders regime date, label, description, and source link (AC5).
 *   - Description text is always visible.
 *   - Fetch URL uses /v1/regime/feed (not /v1/regime-feed) (AC5).
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, screen } from "./helpers/render";
import { RegimeFeedPanel } from "../../src/components/RegimeFeedPanel";
import type { RegimeFeedResponse, FetchLike } from "../../src/lib/committeeApi";

const BASE_URL = "http://localhost:4001";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const twoFeeds: RegimeFeedResponse = {
  feeds: [
    {
      date: "2026-06-23",
      regime: "Risk-On",
      description: "Broad risk appetite elevated; equities and crypto trending higher.",
      published_at: 1750000000,
      source_uri: "https://gist.github.com/robotmoney/regime-2026-06-23",
    },
    {
      date: "2026-06-22",
      regime: "Neutral",
      description: "Mixed signals; no clear directional bias across asset classes.",
      published_at: 1749913600,
      source_uri: "https://gist.github.com/robotmoney/regime-2026-06-22",
    },
  ],
  indexed_at: "2026-06-23T00:00:00Z",
};

const emptyFeed: RegimeFeedResponse = {
  feeds: [],
  indexed_at: "2026-06-23T00:00:00Z",
};

// ─── Fetch mock factory ───────────────────────────────────────────────────────

function makeFetch(data: RegimeFeedResponse): FetchLike {
  return vi.fn(async (_url: string) => ({
    ok: true as const,
    status: 200,
    json: async () => data,
  })) as unknown as FetchLike;
}

function makeErrorFetch(): FetchLike {
  return vi.fn(async () => {
    throw new Error("Regime feed unavailable");
  }) as unknown as FetchLike;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RegimeFeedPanel", () => {
  it("shows loading state initially", async () => {
    // Use a fetch that never resolves so the loading state stays visible throughout.
    const neverFetch: FetchLike = vi.fn(() => new Promise(() => undefined)) as unknown as FetchLike;
    render(<RegimeFeedPanel explorerApiUrl={BASE_URL} fetch={neverFetch} />);
    expect(screen.getByTestId("regime-feed-loading")).toBeDefined();
  });

  it("shows advisory description text after load", async () => {
    render(<RegimeFeedPanel explorerApiUrl={BASE_URL} fetch={makeFetch(twoFeeds)} />);
    await waitFor(() => {
      expect(screen.queryByTestId("regime-feed-loading")).toBeNull();
    });
    expect(screen.getByTestId("regime-feed-description")).toBeDefined();
    expect(screen.getByTestId("regime-feed-description").textContent).toContain("optional");
  });

  it("renders error when fetch fails", async () => {
    render(<RegimeFeedPanel explorerApiUrl={BASE_URL} fetch={makeErrorFetch()} />);
    await waitFor(() => {
      expect(screen.queryByTestId("regime-feed-loading")).toBeNull();
    });
    const err = screen.getByTestId("regime-feed-error");
    expect(err.textContent).toContain("Regime feed unavailable");
  });

  it("shows empty notice when feed is empty", async () => {
    render(<RegimeFeedPanel explorerApiUrl={BASE_URL} fetch={makeFetch(emptyFeed)} />);
    await waitFor(() => {
      expect(screen.queryByTestId("regime-feed-loading")).toBeNull();
    });
    expect(screen.getByTestId("regime-feed-empty")).toBeDefined();
  });

  it("renders regime entries with date, label, and description", async () => {
    render(<RegimeFeedPanel explorerApiUrl={BASE_URL} fetch={makeFetch(twoFeeds)} />);
    await waitFor(() => {
      expect(screen.queryByTestId("regime-feed-loading")).toBeNull();
    });

    const dates = screen.getAllByTestId("regime-feed-date");
    expect(dates.length).toBe(2);
    expect(dates[0].textContent).toBe("2026-06-23");
    expect(dates[1].textContent).toBe("2026-06-22");

    const regimes = screen.getAllByTestId("regime-feed-regime");
    expect(regimes[0].textContent).toBe("Risk-On");
    expect(regimes[1].textContent).toBe("Neutral");

    const descs = screen.getAllByTestId("regime-feed-description-text");
    expect(descs[0].textContent).toContain("elevated");
  });

  it("renders source links for entries with source_uri", async () => {
    render(<RegimeFeedPanel explorerApiUrl={BASE_URL} fetch={makeFetch(twoFeeds)} />);
    await waitFor(() => {
      expect(screen.queryByTestId("regime-feed-loading")).toBeNull();
    });

    const links = screen.getAllByTestId("regime-feed-source-link") as HTMLAnchorElement[];
    expect(links.length).toBe(2);
    expect(links[0].href).toBe("https://gist.github.com/robotmoney/regime-2026-06-23");
    expect(links[0].target).toBe("_blank");
  });

  // ── AC5: regime snapshot from /v1/regime/feed ─────────────────────────────

  it("renders regime snapshot from mocked /v1/regime/feed response (AC5)", async () => {
    const fetchFn = makeFetch(twoFeeds);
    render(<RegimeFeedPanel explorerApiUrl={BASE_URL} fetch={fetchFn} />);
    await waitFor(() => {
      expect(screen.queryByTestId("regime-feed-loading")).toBeNull();
    });

    // Regime list present
    expect(screen.getByTestId("regime-feed-list")).toBeDefined();

    // Entries rendered
    const dates = screen.getAllByTestId("regime-feed-date");
    expect(dates[0].textContent).toBe("2026-06-23");

    const regimes = screen.getAllByTestId("regime-feed-regime");
    expect(regimes[0].textContent).toBe("Risk-On");

    const descs = screen.getAllByTestId("regime-feed-description-text");
    expect(descs[0].textContent).toContain("elevated");
  });

  it("fetches from /v1/regime/feed endpoint (not /v1/regime-feed) (AC5)", async () => {
    const fetchFn = makeFetch(twoFeeds);
    render(<RegimeFeedPanel explorerApiUrl={BASE_URL} fetch={fetchFn} />);
    await waitFor(() => {
      expect(screen.queryByTestId("regime-feed-loading")).toBeNull();
    });

    const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls as [string][];
    expect(calls.length).toBeGreaterThan(0);
    const calledUrl = calls[0][0];
    expect(calledUrl).toContain("/v1/regime/feed");
    expect(calledUrl).not.toContain("/v1/regime-feed");
  });
});
