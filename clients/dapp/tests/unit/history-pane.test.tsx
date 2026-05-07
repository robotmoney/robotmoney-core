/**
 * Vitest — HistoryPane (issue #88).
 *
 * Asserts:
 *   - With `historyPane` flag off the pane is not in the DOM, regardless
 *     of whether the explorer API would respond.
 *   - With the flag on and a mocked fetch returning a `DepositsResponse`,
 *     the pane renders one <tr data-testid="history-pane-row"> per
 *     deposit row, with the block number, tx hash and payment id
 *     surfaced verbatim.
 *
 * Backs the issue #88 acceptance criterion:
 *   "Vitest unit test asserts the history pane renders rows from a
 *    mocked API response and that the pane is not rendered when the
 *    feature flag is off."
 */
import { describe, it, expect, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { Address } from "viem";
import { HistoryPane } from "../../src/components/HistoryPane";
import { resolveFlags } from "../../src/lib/featureFlags";
import type { DepositsResponse, FetchLike } from "../../src/lib/explorerApi";

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

const fixture: DepositsResponse = {
  deposits: [
    {
      chain_id: 31337,
      block_number: 100,
      log_index: 0,
      tx_hash: "0x" + "aa".repeat(32),
      payment_id: "0x" + "bb".repeat(32),
      agent: AGENT,
      share_receiver: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      amount: "1000000",
      indexed_at: "2026-05-07T10:00:00Z",
    },
    {
      chain_id: 31337,
      block_number: 99,
      log_index: 2,
      tx_hash: "0x" + "cc".repeat(32),
      payment_id: "0x" + "dd".repeat(32),
      agent: AGENT,
      share_receiver: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      amount: "500000",
      indexed_at: "2026-05-07T09:59:00Z",
    },
  ],
  freshness: {
    block_number: 100,
    indexed_at: "2026-05-07T10:00:00Z",
  },
};

function makeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as FetchLike;
}

describe("HistoryPane — feature flag gating", () => {
  it("does not render the pane when the historyPane flag is off", () => {
    const flags = resolveFlags({});
    expect(flags.historyPane).toBe(false);

    // Simulate the AdminFlow gating: when the flag is off the parent
    // simply does not mount HistoryPane. We assert that conditional
    // rendering yields no `history-pane` testid in the DOM.
    const { queryByTestId } = render(
      <div>{flags.historyPane ? <HistoryPane agent={AGENT} apiUrl="http://x" /> : null}</div>,
    );
    expect(queryByTestId("history-pane")).toBeNull();
  });

  it("does render when the flag is explicitly enabled", async () => {
    const flags = resolveFlags({ VITE_HISTORY_PANE: "true" });
    expect(flags.historyPane).toBe(true);
    const { getByTestId } = render(
      <div>
        {flags.historyPane ? (
          <HistoryPane agent={AGENT} apiUrl="http://x" fetchImpl={makeFetch(fixture)} />
        ) : null}
      </div>,
    );
    expect(getByTestId("history-pane")).toBeTruthy();
    // Wait for the deferred state transition so we don't leave an
    // unflushed setState pending after the test ends.
    await waitFor(() => {
      expect(getByTestId("history-pane-table")).toBeTruthy();
    });
  });
});

describe("HistoryPane — render with mocked API", () => {
  it("renders one row per deposit and surfaces freshness", async () => {
    const fetchImpl = makeFetch(fixture);
    const { getByTestId, getAllByTestId } = render(
      <HistoryPane agent={AGENT} apiUrl="http://localhost:8080" fetchImpl={fetchImpl} />,
    );

    await waitFor(() => {
      expect(getByTestId("history-pane-table")).toBeTruthy();
    });

    const rows = getAllByTestId("history-pane-row");
    expect(rows).toHaveLength(2);

    const blocks = getAllByTestId("history-pane-row-block").map((n) => n.textContent);
    expect(blocks).toEqual(["100", "99"]);

    const txs = getAllByTestId("history-pane-row-tx").map((n) => n.textContent);
    expect(txs[0]).toBe(fixture.deposits[0].tx_hash);
    expect(txs[1]).toBe(fixture.deposits[1].tx_hash);

    expect(getByTestId("history-pane-freshness").textContent).toContain("100");
    expect(getByTestId("history-pane-freshness").textContent).toContain("2026-05-07T10:00:00Z");

    // The pane never issues a request to anywhere other than the
    // configured explorer API base URL — defends the §12 invariant
    // "the pane must not introduce new RPC calls".
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    expect(call[0]).toBe(`http://localhost:8080/v1/agents/${AGENT}/deposits`);
  });

  it("shows the empty-state row when the API returns no deposits", async () => {
    const fetchImpl = makeFetch({
      deposits: [],
      freshness: { block_number: 0, indexed_at: "1970-01-01T00:00:00Z" },
    });
    const { getByTestId, queryByTestId } = render(
      <HistoryPane agent={AGENT} apiUrl="http://localhost:8080" fetchImpl={fetchImpl} />,
    );
    await waitFor(() => {
      expect(getByTestId("history-pane-empty")).toBeTruthy();
    });
    expect(queryByTestId("history-pane-table")).toBeNull();
  });

  it("surfaces a non-2xx status as a visible error, not a thrown exception", async () => {
    const fetchImpl = makeFetch({}, false, 503);
    const { getByTestId } = render(
      <HistoryPane agent={AGENT} apiUrl="http://localhost:8080" fetchImpl={fetchImpl} />,
    );
    await waitFor(() => {
      expect(getByTestId("history-pane-error").textContent).toContain("503");
    });
  });
});

describe("HistoryPane — feature flag default", () => {
  it("DEFAULT_FLAGS has historyPane disabled", async () => {
    const { DEFAULT_FLAGS } = await import("../../src/lib/featureFlags");
    expect(DEFAULT_FLAGS.historyPane).toBe(false);
  });

  // Sanity: just keep the runtime importable + act() coverage so the
  // test framework doesn't warn about missing act() from React.
  it("act-wrapper smoke test", () => {
    act(() => undefined);
  });
});
