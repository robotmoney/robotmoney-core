/**
 * CommitteeAccountLayer — RTL unit tests (issue #1054 AC3).
 *
 * AC3: clients/dapp Vitest suite exits 0 with a test asserting the
 * Committee account layer renders the agent's own vote history when a
 * wallet address is present.
 *
 * Covers:
 *   - No-wallet state shows a connect prompt.
 *   - With wallet address: loads and renders vote history from
 *     GET /v1/accounts/:address/committee-votes.
 *   - Loading state shown while fetch is in progress.
 *   - Error state renders the API error.
 *   - Empty vote history shows empty notice.
 *   - Vote rows render date, vault, stance, weight, confidence, rationale link.
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, screen } from "./helpers/render";
import { CommitteeAccountLayer } from "../../src/components/CommitteeAccountLayer";
import type { AccountCommitteeVotesResponse, FetchLike } from "../../src/lib/committeeApi";

const BASE_URL = "http://localhost:4001";
const WALLET = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA01";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const twoVotes: AccountCommitteeVotesResponse = {
  votes: [
    {
      vote_id: 10,
      agent: WALLET,
      agent_id: "athena-v1",
      vault: "0x1111111111111111111111111111111111111111",
      stance: "overweight",
      target_weight_bps: 6500,
      confidence: 90,
      rationale_uri: "https://gist.github.com/athena/vote10",
      vote_json_hash: "0xabcdef0000000000000000000000000000000000000000000000000000000001",
      timestamp: 1750000000,
      submitted_at: 1750000010,
      block_number: 110,
      tx_hash: "0xdeadbeef00000000000000000000000000000000000000000000000000000010",
    },
    {
      vote_id: 11,
      agent: WALLET,
      agent_id: "athena-v1",
      vault: "0x2222222222222222222222222222222222222222",
      stance: "neutral",
      target_weight_bps: 5000,
      confidence: 75,
      rationale_uri: "https://gist.github.com/athena/vote11",
      vote_json_hash: "0xabcdef0000000000000000000000000000000000000000000000000000000002",
      timestamp: 1750001000,
      submitted_at: 1750001010,
      block_number: 111,
      tx_hash: "0xdeadbeef00000000000000000000000000000000000000000000000000000011",
    },
  ],
  block_number: 200,
  indexed_at: "2026-06-23T00:00:00Z",
};

const emptyVotes: AccountCommitteeVotesResponse = {
  votes: [],
  block_number: 200,
  indexed_at: "2026-06-23T00:00:00Z",
};

// ─── Fetch mock factory ───────────────────────────────────────────────────────

function makeFetch(data: AccountCommitteeVotesResponse): FetchLike {
  return vi.fn(async () => ({
    ok: true as const,
    status: 200,
    json: async () => data,
  })) as unknown as FetchLike;
}

function makeErrorFetch(): FetchLike {
  return vi.fn(async () => {
    throw new Error("Account votes unavailable");
  }) as unknown as FetchLike;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CommitteeAccountLayer", () => {
  it("shows connect-wallet prompt when no wallet address is provided", () => {
    render(<CommitteeAccountLayer explorerApiUrl={BASE_URL} />);
    expect(screen.getByTestId("committee-account-no-wallet")).toBeDefined();
  });

  it("does not show connect prompt when wallet address is present", async () => {
    render(
      <CommitteeAccountLayer
        explorerApiUrl={BASE_URL}
        walletAddress={WALLET}
        fetch={makeFetch(twoVotes)}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("committee-account-loading")).toBeNull();
    });
    expect(screen.queryByTestId("committee-account-no-wallet")).toBeNull();
  });

  it("shows loading state while fetch is in progress", () => {
    const neverFetch: FetchLike = vi.fn(() => new Promise(() => undefined)) as unknown as FetchLike;
    render(
      <CommitteeAccountLayer explorerApiUrl={BASE_URL} walletAddress={WALLET} fetch={neverFetch} />,
    );
    expect(screen.getByTestId("committee-account-loading")).toBeDefined();
  });

  it("renders error when fetch fails", async () => {
    render(
      <CommitteeAccountLayer
        explorerApiUrl={BASE_URL}
        walletAddress={WALLET}
        fetch={makeErrorFetch()}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("committee-account-loading")).toBeNull();
    });
    const err = screen.getByTestId("committee-account-error");
    expect(err.textContent).toContain("Account votes unavailable");
  });

  it("shows empty notice when wallet has no committee votes", async () => {
    render(
      <CommitteeAccountLayer
        explorerApiUrl={BASE_URL}
        walletAddress={WALLET}
        fetch={makeFetch(emptyVotes)}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("committee-account-loading")).toBeNull();
    });
    expect(screen.getByTestId("committee-account-no-votes")).toBeDefined();
  });

  // ── AC3: account layer renders vote history when wallet address is present ──

  it("renders agent own vote history from /v1/accounts/:address/committee-votes when wallet is connected (AC3)", async () => {
    const fetchFn = makeFetch(twoVotes);
    render(
      <CommitteeAccountLayer explorerApiUrl={BASE_URL} walletAddress={WALLET} fetch={fetchFn} />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("committee-account-loading")).toBeNull();
    });

    // Table must be present
    expect(screen.getByTestId("committee-account-votes-table")).toBeDefined();

    // Vote rows
    const stances = screen.getAllByTestId("committee-account-vote-stance");
    expect(stances.length).toBe(2);
    expect(stances[0].textContent).toContain("Overweight");
    expect(stances[1].textContent).toContain("Neutral");

    const weights = screen.getAllByTestId("committee-account-vote-weight");
    expect(weights[0].textContent).toBe("6500");
    expect(weights[1].textContent).toBe("5000");

    const confidences = screen.getAllByTestId("committee-account-vote-confidence");
    expect(confidences[0].textContent).toBe("90%");

    const links = screen.getAllByTestId(
      "committee-account-vote-rationale-link",
    ) as HTMLAnchorElement[];
    expect(links[0].href).toBe("https://gist.github.com/athena/vote10");
    expect(links[0].target).toBe("_blank");
  });

  it("fetches from /v1/accounts/:address/committee-votes endpoint", async () => {
    const fetchFn = makeFetch(twoVotes);
    render(
      <CommitteeAccountLayer explorerApiUrl={BASE_URL} walletAddress={WALLET} fetch={fetchFn} />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("committee-account-loading")).toBeNull();
    });

    const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls as [string][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toContain(`/v1/accounts/${WALLET}/committee-votes`);
  });
});
