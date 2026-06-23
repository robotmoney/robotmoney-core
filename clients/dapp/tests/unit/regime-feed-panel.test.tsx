/**
 * RegimeFeedPanel — RTL unit tests (issue #1044 AC-5 / Test plan item 4).
 *
 * Covers:
 *   - Loading state shows loading text.
 *   - Error state renders the API error message.
 *   - Empty state shows empty notice.
 *   - Feed renders regime date, label, description, and source link.
 *   - Description text is always visible.
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
  return vi.fn(async () => ({
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
  it("shows loading state initially", () => {
    render(<RegimeFeedPanel explorerApiUrl={BASE_URL} fetch={makeFetch(twoFeeds)} />);
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
});
