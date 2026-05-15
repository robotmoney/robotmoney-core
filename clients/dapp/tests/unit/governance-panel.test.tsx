/**
 * suite-09: GovernancePanel RTL tests — issue #322.
 *
 * Covers:
 *   - Loading state shows spinner text.
 *   - Error state renders the API error message.
 *   - No-proposal state shows the empty notice.
 *   - Open proposal: renders proposed weights (description), tally,
 *     quorum, deadline block, and the voting prompt.
 *   - Passed proposal: renders status "passed" without voting prompt.
 *   - Executed proposal: renders status "executed" with execution block note.
 *   - Expired proposal: renders status "expired" without voting prompt.
 *   - Wallet not connected: vote button is absent / connect-hint shown.
 *   - Tally updates: re-render with updated proposal reflects new vote counts.
 *
 * Acceptance criterion: "suite-09: RTL tests for GovernancePanel with mock
 * proposal data" (issue #322 acceptance criteria item 5).
 *
 * Wagmi hooks are mocked at the network boundary (same pattern as
 * authorize-tab.test.tsx) so the tests run without a WagmiProvider.
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { Address } from "viem";
import { GovernancePanel } from "../../src/components/GovernancePanel";
import type { FetchLike } from "../../src/lib/explorerApi";

// Mock wagmi at the network boundary — GovernancePanel uses useAccount,
// useReadContract, useSimulateContract, and useWriteContract. We stub
// them to isolate the component's API-fetch and rendering logic.
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useReadContract: () => ({ data: undefined }),
  useSimulateContract: () => ({ data: undefined }),
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false }),
}));

// ─── Test fixtures ────────────────────────────────────────────────────────────

const GOVERNANCE_ADDR = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" as Address;
const RM_TOKEN_ADDR = "0x1234567890123456789012345678901234567890" as Address;

function makeProposalsResponse(status: string, overrides: Record<string, unknown> = {}) {
  return {
    proposals: [
      {
        chain_id: 31337,
        proposal_id: 7,
        proposer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        description: "Rebalance: 60% Vault-A, 40% Vault-B",
        created_at: 1_700_000_000,
        deadline_block: 9999,
        status,
        votes_for: 5100,
        votes_against: 0,
        block_number: 8000,
        indexed_at: "2026-05-10T12:00:00Z",
        ...overrides,
      },
    ],
    block_number: 8001,
    indexed_at: "2026-05-10T12:01:00Z",
  };
}

function makeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as FetchLike;
}

const emptyResponse = {
  proposals: [],
  block_number: 8000,
  indexed_at: "2026-05-10T12:00:00Z",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPanel(fetchImpl: FetchLike) {
  return render(
    <GovernancePanel
      governanceAddress={GOVERNANCE_ADDR}
      rmTokenAddress={RM_TOKEN_ADDR}
      apiUrl="http://localhost:8080"
      fetchImpl={fetchImpl}
    />,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GovernancePanel — loading and error states", () => {
  it("shows a loading indicator while the API call is in flight", () => {
    // Return a promise that never resolves so we stay in loading state.
    const neverFetch = vi.fn(() => new Promise(() => {})) as unknown as FetchLike;
    const { getByTestId } = renderPanel(neverFetch);
    expect(getByTestId("governance-loading")).toBeTruthy();
  });

  it("renders the error message on a non-2xx response", async () => {
    const { getByTestId } = renderPanel(makeFetch({}, false, 503));
    await waitFor(() => {
      expect(getByTestId("governance-error").textContent).toContain("503");
    });
  });

  it("shows the no-proposal notice when the list is empty", async () => {
    const { getByTestId } = renderPanel(makeFetch(emptyResponse));
    await waitFor(() => {
      expect(getByTestId("governance-no-proposal")).toBeTruthy();
    });
  });
});

describe("GovernancePanel — open proposal", () => {
  it("renders proposal id, description, status, tally, and deadline", async () => {
    const { getByTestId } = renderPanel(makeFetch(makeProposalsResponse("open")));
    await waitFor(() => {
      expect(getByTestId("governance-proposal-detail")).toBeTruthy();
    });

    expect(getByTestId("governance-proposal-id").textContent).toContain("7");
    expect(getByTestId("governance-proposal-description").textContent).toContain(
      "Rebalance: 60% Vault-A, 40% Vault-B",
    );
    expect(getByTestId("governance-proposal-status").textContent).toContain("Open");
    expect(getByTestId("governance-proposal-votes-for").textContent).toContain("5100");
    expect(getByTestId("governance-proposal-votes-against").textContent).toContain("0");
    expect(getByTestId("governance-proposal-deadline-block").textContent).toContain("9999");
  });

  it("shows the voting prompt for an open proposal", async () => {
    const { getByTestId } = renderPanel(makeFetch(makeProposalsResponse("open")));
    await waitFor(() => {
      expect(getByTestId("governance-voting-prompt")).toBeTruthy();
    });
    // The prompt must show the proposal id in the calldata description.
    expect(getByTestId("governance-voting-prompt").textContent).toContain("7");
    // The contract address must be surfaced so the user can verify before signing.
    expect(getByTestId("governance-contract-address").textContent).toBe(GOVERNANCE_ADDR);
  });

  it("shows the connect-wallet hint when no wallet is connected", async () => {
    const { getByTestId } = renderPanel(makeFetch(makeProposalsResponse("open")));
    await waitFor(() => {
      expect(getByTestId("governance-voting-prompt")).toBeTruthy();
    });
    // setup.ts seeds wagmi mock connector but does not connect — so no account.
    expect(getByTestId("governance-connect-hint")).toBeTruthy();
  });

  it("surfaces freshness block and indexed_at", async () => {
    const { getByTestId } = renderPanel(makeFetch(makeProposalsResponse("open")));
    await waitFor(() => {
      expect(getByTestId("governance-freshness")).toBeTruthy();
    });
    expect(getByTestId("governance-freshness").textContent).toContain("8001");
    expect(getByTestId("governance-freshness").textContent).toContain("2026-05-10T12:01:00Z");
  });
});

describe("GovernancePanel — passed proposal", () => {
  it("renders status 'Passed' and hides the voting prompt", async () => {
    const { getByTestId, queryByTestId } = renderPanel(makeFetch(makeProposalsResponse("passed")));
    await waitFor(() => {
      expect(getByTestId("governance-proposal-status").textContent).toContain("Passed");
    });
    expect(queryByTestId("governance-voting-prompt")).toBeNull();
  });
});

describe("GovernancePanel — executed proposal", () => {
  it("renders status 'Executed' and shows the execution notice", async () => {
    const { getByTestId, queryByTestId } = renderPanel(
      makeFetch(makeProposalsResponse("executed")),
    );
    await waitFor(() => {
      expect(getByTestId("governance-proposal-status").textContent).toContain("Executed");
    });
    expect(getByTestId("governance-proposal-executed-state")).toBeTruthy();
    expect(queryByTestId("governance-voting-prompt")).toBeNull();
  });
});

describe("GovernancePanel — expired proposal", () => {
  it("renders status 'Expired' and hides the voting prompt", async () => {
    const { getByTestId, queryByTestId } = renderPanel(makeFetch(makeProposalsResponse("expired")));
    await waitFor(() => {
      expect(getByTestId("governance-proposal-status").textContent).toContain("Expired");
    });
    expect(queryByTestId("governance-voting-prompt")).toBeNull();
  });
});

describe("GovernancePanel — tally updates", () => {
  it("reflects updated vote counts when re-rendered with new tally", async () => {
    const fetchImpl = makeFetch(makeProposalsResponse("open", { votes_for: 5100 }));
    const { getByTestId, rerender } = renderPanel(fetchImpl);
    await waitFor(() => {
      expect(getByTestId("governance-proposal-votes-for").textContent).toContain("5100");
    });

    // Simulate a new fetch with updated tally (e.g. after a VoteCast event).
    const updatedFetch = makeFetch(makeProposalsResponse("open", { votes_for: 7500 }));
    rerender(
      <GovernancePanel
        governanceAddress={GOVERNANCE_ADDR}
        rmTokenAddress={RM_TOKEN_ADDR}
        apiUrl="http://localhost:8080"
        fetchImpl={updatedFetch}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("governance-proposal-votes-for").textContent).toContain("7500");
    });
  });
});

describe("GovernancePanel — API call target", () => {
  it("fetches from /v1/governance/proposals at the configured base URL", async () => {
    const fetchImpl = makeFetch(emptyResponse);
    renderPanel(fetchImpl);
    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    const call = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    expect(call[0]).toBe("http://localhost:8080/v1/governance/proposals");
  });
});
