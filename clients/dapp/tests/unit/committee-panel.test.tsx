/**
 * CommitteePanel — RTL unit tests (issue #1044 AC-5 / Test plan item 4).
 *
 * Covers:
 *   - Loading state shows loading text.
 *   - Error state renders the API error message.
 *   - Empty state (no agents, no votes) shows empty notices.
 *   - Agents table renders agent_id, address, and registration date.
 *   - Votes table renders stance, weight, confidence, and a rationale link.
 *   - Signalling-only disclosure is always visible.
 *   - Agent click filters votes by agent.
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, screen, fireEvent } from "./helpers/render";
import { CommitteePanel } from "../../src/components/CommitteePanel";
import type {
  CommitteeAgentsResponse,
  CommitteeVotesResponse,
  FetchLike,
} from "../../src/lib/committeeApi";

const BASE_URL = "http://localhost:4001";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const twoAgents: CommitteeAgentsResponse = {
  agents: [
    {
      address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA01",
      agent_id: "athena-v1",
      registered_at: 1750000000,
      block_number: 100,
    },
    {
      address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA02",
      agent_id: "robot-money",
      registered_at: 1750001000,
      block_number: 101,
    },
  ],
  block_number: 200,
  indexed_at: "2026-06-23T00:00:00Z",
};

const twoVotes: CommitteeVotesResponse = {
  votes: [
    {
      vote_id: 0,
      agent: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA01",
      agent_id: "athena-v1",
      vault: "0x1111111111111111111111111111111111111111",
      stance: "overweight",
      target_weight_bps: 6000,
      confidence: 85,
      rationale_uri: "https://gist.github.com/athena/memo1",
      vote_json_hash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      timestamp: 1750000100,
      submitted_at: 1750000110,
      block_number: 105,
      tx_hash: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
    },
    {
      vote_id: 1,
      agent: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA02",
      agent_id: "robot-money",
      vault: "0x2222222222222222222222222222222222222222",
      stance: "neutral",
      target_weight_bps: 5000,
      confidence: 70,
      rationale_uri: "https://gist.github.com/rm/memo2",
      vote_json_hash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      timestamp: 1750001100,
      submitted_at: 1750001110,
      block_number: 106,
      tx_hash: "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
    },
  ],
  block_number: 200,
  indexed_at: "2026-06-23T00:00:00Z",
};

const emptyAgents: CommitteeAgentsResponse = {
  agents: [],
  block_number: 1,
  indexed_at: "2026-06-23T00:00:00Z",
};

const emptyVotes: CommitteeVotesResponse = {
  votes: [],
  block_number: 1,
  indexed_at: "2026-06-23T00:00:00Z",
};

// ─── Fetch mock factory ───────────────────────────────────────────────────────

function makeFetch(agents: CommitteeAgentsResponse, votes: CommitteeVotesResponse): FetchLike {
  return vi.fn(async (url: string) => {
    const body: CommitteeAgentsResponse | CommitteeVotesResponse = url.includes("/agents")
      ? agents
      : votes;
    return { ok: true as const, status: 200, json: async () => body };
  }) as unknown as FetchLike;
}

function makeErrorFetch(): FetchLike {
  return vi.fn(async () => {
    throw new Error("Network error");
  }) as unknown as FetchLike;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CommitteePanel", () => {
  it("shows loading state initially", () => {
    // Use a fetch that never resolves so the loading state stays visible throughout.
    const neverFetch: FetchLike = vi.fn(() => new Promise(() => undefined)) as unknown as FetchLike;
    render(<CommitteePanel explorerApiUrl={BASE_URL} fetch={neverFetch} />);
    expect(screen.getByTestId("committee-loading")).toBeDefined();
  });

  it("shows signalling-only disclosure after load", async () => {
    const fetchFn = makeFetch(twoAgents, twoVotes);
    render(<CommitteePanel explorerApiUrl={BASE_URL} fetch={fetchFn} />);
    await waitFor(() => {
      expect(screen.queryByTestId("committee-loading")).toBeNull();
    });
    expect(screen.getByTestId("committee-signalling-disclosure")).toBeDefined();
  });

  it("renders error message when fetch fails", async () => {
    render(<CommitteePanel explorerApiUrl={BASE_URL} fetch={makeErrorFetch()} />);
    await waitFor(() => {
      expect(screen.queryByTestId("committee-loading")).toBeNull();
    });
    const err = screen.getByTestId("committee-error");
    expect(err.textContent).toContain("Network error");
  });

  it("shows empty agent notice when no agents registered", async () => {
    const fetchFn = makeFetch(emptyAgents, emptyVotes);
    render(<CommitteePanel explorerApiUrl={BASE_URL} fetch={fetchFn} />);
    await waitFor(() => {
      expect(screen.queryByTestId("committee-loading")).toBeNull();
    });
    expect(screen.getByTestId("committee-no-agents")).toBeDefined();
  });

  it("renders agents table with agent_id and address", async () => {
    const fetchFn = makeFetch(twoAgents, twoVotes);
    render(<CommitteePanel explorerApiUrl={BASE_URL} fetch={fetchFn} />);
    await waitFor(() => {
      expect(screen.queryByTestId("committee-loading")).toBeNull();
    });

    const agentIds = screen.getAllByTestId("committee-agent-id");
    expect(agentIds.length).toBe(2);
    expect(agentIds[0].textContent).toBe("athena-v1");
    expect(agentIds[1].textContent).toBe("robot-money");

    const addresses = screen.getAllByTestId("committee-agent-address");
    expect(addresses[0].textContent).toContain("0xAAAA");
  });

  it("renders votes table with stance, weight, confidence, rationale link", async () => {
    const fetchFn = makeFetch(twoAgents, twoVotes);
    render(<CommitteePanel explorerApiUrl={BASE_URL} fetch={fetchFn} />);
    await waitFor(() => {
      expect(screen.queryByTestId("committee-loading")).toBeNull();
    });

    const stances = screen.getAllByTestId("committee-vote-stance");
    expect(stances[0].textContent).toContain("Overweight");
    expect(stances[1].textContent).toContain("Neutral");

    const weights = screen.getAllByTestId("committee-vote-weight");
    expect(weights[0].textContent).toBe("6000");
    expect(weights[1].textContent).toBe("5000");

    const confidences = screen.getAllByTestId("committee-vote-confidence");
    expect(confidences[0].textContent).toBe("85%");

    const links = screen.getAllByTestId("committee-vote-rationale-link") as HTMLAnchorElement[];
    expect(links[0].href).toBe("https://gist.github.com/athena/memo1");
  });

  it("shows empty votes notice when no votes", async () => {
    const fetchFn = makeFetch(twoAgents, emptyVotes);
    render(<CommitteePanel explorerApiUrl={BASE_URL} fetch={fetchFn} />);
    await waitFor(() => {
      expect(screen.queryByTestId("committee-loading")).toBeNull();
    });
    expect(screen.getByTestId("committee-no-votes")).toBeDefined();
  });

  it("filters votes by agent when agent row is clicked", async () => {
    const fetchFn = makeFetch(twoAgents, twoVotes);
    render(<CommitteePanel explorerApiUrl={BASE_URL} fetch={fetchFn} />);
    await waitFor(() => {
      expect(screen.queryByTestId("committee-loading")).toBeNull();
    });

    // Before filter: two votes
    expect(screen.getAllByTestId("committee-vote-stance").length).toBe(2);

    // Click the first agent row
    const agentRow = screen.getByTestId(`committee-agent-row-${twoAgents.agents[0].address}`);
    fireEvent.click(agentRow);

    // After filter: one vote (athena-v1 only)
    expect(screen.getAllByTestId("committee-vote-stance").length).toBe(1);
    expect(screen.getAllByTestId("committee-vote-stance")[0].textContent).toContain("Overweight");

    // Clear filter
    const clearBtn = screen.getByTestId("committee-votes-clear-filter");
    fireEvent.click(clearBtn);
    expect(screen.getAllByTestId("committee-vote-stance").length).toBe(2);
  });
});
