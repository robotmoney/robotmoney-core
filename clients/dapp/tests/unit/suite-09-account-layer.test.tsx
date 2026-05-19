/**
 * Suite-09 — RTL unit tests for the account layer components (issue #319).
 *
 * Components under test:
 *   - WatchedAddressInput
 *   - PortfolioPosition
 *   - TransactionHistory
 *   - AgentPoliciesPanel
 *
 * Acceptance criteria validated:
 *   - PortfolioPosition shows correct receipt balances and USDC values for a
 *     watched address with no wallet.
 *   - Composite portfolio total equals sum of per-vault USDC values.
 *   - TransactionHistory renders events in chronological order across all
 *     vaults for the address.
 *   - AgentPoliciesPanel shows withdrawal policy fields (assetRecipient,
 *     allowedSourceVaults) when set.
 */
import { describe, it, expect, vi } from "vitest";
import { act, render, waitFor, fireEvent } from "@testing-library/react";
import type { Address } from "viem";
import { WatchedAddressInput } from "../../src/components/WatchedAddressInput";
import { PortfolioPosition } from "../../src/components/PortfolioPosition";
import { TransactionHistory } from "../../src/components/TransactionHistory";
import { AgentPoliciesPanel } from "../../src/components/AgentPoliciesPanel";
import type {
  FetchLike,
  AccountPositionsResponse,
  AccountHistoryResponse,
} from "../../src/lib/explorerApi";

const WATCHED = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VAULT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as FetchLike;
}

// ─── WatchedAddressInput ────────────────────────────────────────────────────

describe("WatchedAddressInput", () => {
  it("renders the input form with submit button", () => {
    const { getByTestId } = render(<WatchedAddressInput onAddress={vi.fn()} />);
    expect(getByTestId("watched-address-form")).toBeTruthy();
    expect(getByTestId("watched-address-input")).toBeTruthy();
    expect(getByTestId("watched-address-submit")).toBeTruthy();
  });

  it("pre-fills the input with defaultAddress when provided", () => {
    const { getByTestId } = render(
      <WatchedAddressInput defaultAddress={WATCHED} onAddress={vi.fn()} />,
    );
    const input = getByTestId("watched-address-input") as HTMLInputElement;
    expect(input.value).toBe(WATCHED);
  });

  it("calls onAddress with the validated address on valid submit", () => {
    const onAddress = vi.fn();
    const { getByTestId } = render(<WatchedAddressInput onAddress={onAddress} />);
    const input = getByTestId("watched-address-input");
    fireEvent.change(input, { target: { value: WATCHED } });
    fireEvent.submit(getByTestId("watched-address-form"));
    expect(onAddress).toHaveBeenCalledWith(WATCHED.toLowerCase());
  });

  it("shows an error and does not call onAddress for an invalid address", () => {
    const onAddress = vi.fn();
    const { getByTestId, queryByTestId } = render(<WatchedAddressInput onAddress={onAddress} />);
    fireEvent.change(getByTestId("watched-address-input"), {
      target: { value: "not-an-address" },
    });
    fireEvent.submit(getByTestId("watched-address-form"));
    expect(onAddress).not.toHaveBeenCalled();
    expect(getByTestId("watched-address-error")).toBeTruthy();
    // No error for empty default.
    expect(queryByTestId("watched-address-error")?.textContent).toContain("valid");
  });

  it("clears the error after a subsequent valid submission", () => {
    const onAddress = vi.fn();
    const { getByTestId, queryByTestId } = render(<WatchedAddressInput onAddress={onAddress} />);
    // First: invalid.
    fireEvent.change(getByTestId("watched-address-input"), {
      target: { value: "bad" },
    });
    fireEvent.submit(getByTestId("watched-address-form"));
    expect(queryByTestId("watched-address-error")).toBeTruthy();
    // Then: valid.
    fireEvent.change(getByTestId("watched-address-input"), {
      target: { value: WATCHED },
    });
    fireEvent.submit(getByTestId("watched-address-form"));
    expect(queryByTestId("watched-address-error")).toBeNull();
    expect(onAddress).toHaveBeenCalledTimes(1);
  });
});

// ─── PortfolioPosition ──────────────────────────────────────────────────────

const positionsFixture: AccountPositionsResponse = {
  address: WATCHED,
  positions: [
    {
      vault_address: VAULT_A,
      vault_name: "Alpha Vault",
      risk_label: "stable-yield",
      shares: "500000",
      block_number: 1000,
    },
    {
      vault_address: VAULT_B,
      vault_name: "Beta Vault",
      risk_label: "growth",
      shares: "250000",
      block_number: 1000,
    },
  ],
  block_number: 1000,
  indexed_at: "2026-05-10T00:00:00Z",
};

describe("PortfolioPosition", () => {
  it("shows loading state initially", () => {
    // Never-resolving fetch so the component stays in loading state.
    const fetchImpl = vi.fn(() => new Promise(() => undefined)) as unknown as FetchLike;
    const { getByTestId } = render(
      <PortfolioPosition address={WATCHED} apiUrl="http://api" fetchImpl={fetchImpl} />,
    );
    expect(getByTestId("portfolio-position-loading")).toBeTruthy();
  });

  it("renders one row per vault and shows the address", async () => {
    const { getByTestId, getAllByTestId } = render(
      <PortfolioPosition
        address={WATCHED}
        apiUrl="http://api"
        fetchImpl={makeFetch(positionsFixture)}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("portfolio-position-table")).toBeTruthy();
    });

    const rows = getAllByTestId("portfolio-position-row");
    expect(rows).toHaveLength(2);

    const vaultNames = getAllByTestId("portfolio-position-row-vault").map((n) => n.textContent);
    expect(vaultNames).toEqual(["Alpha Vault", "Beta Vault"]);

    const shares = getAllByTestId("portfolio-position-row-shares").map((n) => n.textContent);
    expect(shares).toEqual(["500000", "250000"]);

    // Address is surfaced.
    expect(getByTestId("portfolio-position-address").textContent).toContain(WATCHED);
  });

  it("shows USDC values when usdcValues prop is provided", async () => {
    const usdcValues = {
      [VAULT_A]: "500000",
      [VAULT_B]: "250000",
    };
    const { getByTestId, getAllByTestId } = render(
      <PortfolioPosition
        address={WATCHED}
        apiUrl="http://api"
        fetchImpl={makeFetch(positionsFixture)}
        usdcValues={usdcValues}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("portfolio-position-table")).toBeTruthy();
    });

    const usdcCells = getAllByTestId("portfolio-position-row-usdc").map((n) => n.textContent);
    expect(usdcCells).toEqual(["500000", "250000"]);
  });

  it("composite total equals sum of per-vault USDC values", async () => {
    const usdcValues = {
      [VAULT_A]: "500000",
      [VAULT_B]: "250000",
    };
    const { getByTestId } = render(
      <PortfolioPosition
        address={WATCHED}
        apiUrl="http://api"
        fetchImpl={makeFetch(positionsFixture)}
        usdcValues={usdcValues}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("portfolio-position-total")).toBeTruthy();
    });
    // 500000 + 250000 = 750000
    expect(getByTestId("portfolio-position-total").textContent).toContain("750000");
  });

  it("shows dash for USDC values when usdcValues is not provided", async () => {
    const { getByTestId, getAllByTestId } = render(
      <PortfolioPosition
        address={WATCHED}
        apiUrl="http://api"
        fetchImpl={makeFetch(positionsFixture)}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("portfolio-position-table")).toBeTruthy();
    });

    const usdcCells = getAllByTestId("portfolio-position-row-usdc").map((n) => n.textContent);
    expect(usdcCells).toEqual(["—", "—"]);

    // Composite total is also a dash.
    expect(getByTestId("portfolio-position-total").textContent).toContain("—");
  });

  it("shows empty state when API returns no positions", async () => {
    const empty: AccountPositionsResponse = {
      address: WATCHED,
      positions: [],
      block_number: 1000,
      indexed_at: "2026-05-10T00:00:00Z",
    };
    const { getByTestId, queryByTestId } = render(
      <PortfolioPosition address={WATCHED} apiUrl="http://api" fetchImpl={makeFetch(empty)} />,
    );
    await waitFor(() => {
      expect(getByTestId("portfolio-position-empty")).toBeTruthy();
    });
    expect(queryByTestId("portfolio-position-table")).toBeNull();
  });

  it("surfaces a non-2xx API error as a visible message", async () => {
    const { getByTestId } = render(
      <PortfolioPosition
        address={WATCHED}
        apiUrl="http://api"
        fetchImpl={makeFetch({}, false, 503)}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("portfolio-position-error").textContent).toContain("503");
    });
  });

  it("makes exactly one request to the positions endpoint", async () => {
    const fetchImpl = makeFetch(positionsFixture);
    const { getByTestId } = render(
      <PortfolioPosition address={WATCHED} apiUrl="http://api" fetchImpl={fetchImpl} />,
    );
    await waitFor(() => {
      expect(getByTestId("portfolio-position-table")).toBeTruthy();
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    expect(call[0]).toBe(`http://api/v1/accounts/${WATCHED}/positions`);
  });

  it("act-wrapper smoke", () => {
    act(() => undefined);
  });
});

// ─── TransactionHistory ─────────────────────────────────────────────────────

const historyFixture: AccountHistoryResponse = {
  address: WATCHED,
  events: [
    {
      event_type: "deposit",
      block_number: 900,
      tx_hash: "0x" + "aa".repeat(32),
      vault_address: VAULT_A,
      amount: "1000000",
      indexed_at: "2026-05-01T00:00:00Z",
    },
    {
      event_type: "deposit",
      block_number: 950,
      tx_hash: "0x" + "bb".repeat(32),
      vault_address: VAULT_B,
      amount: "500000",
      indexed_at: "2026-05-05T00:00:00Z",
    },
  ],
  block_number: 950,
  indexed_at: "2026-05-05T00:00:00Z",
};

describe("TransactionHistory", () => {
  it("shows loading state initially", () => {
    const fetchImpl = vi.fn(() => new Promise(() => undefined)) as unknown as FetchLike;
    const { getByTestId } = render(
      <TransactionHistory address={WATCHED} apiUrl="http://api" fetchImpl={fetchImpl} />,
    );
    expect(getByTestId("transaction-history-loading")).toBeTruthy();
  });

  it("renders events in chronological order (ascending block)", async () => {
    const { getByTestId, getAllByTestId } = render(
      <TransactionHistory
        address={WATCHED}
        apiUrl="http://api"
        fetchImpl={makeFetch(historyFixture)}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("transaction-history-table")).toBeTruthy();
    });

    const rows = getAllByTestId("transaction-history-row");
    expect(rows).toHaveLength(2);

    const blocks = getAllByTestId("transaction-history-row-block").map((n) =>
      Number(n.textContent),
    );
    expect(blocks[0]).toBeLessThan(blocks[1]);
    expect(blocks).toEqual([900, 950]);
  });

  it("shows type, tx hash, vault, and amount for each event", async () => {
    const { getAllByTestId } = render(
      <TransactionHistory
        address={WATCHED}
        apiUrl="http://api"
        fetchImpl={makeFetch(historyFixture)}
      />,
    );
    await waitFor(() => {
      const rows = getAllByTestId("transaction-history-row");
      expect(rows).toHaveLength(2);
    });

    const types = getAllByTestId("transaction-history-row-type").map((n) => n.textContent);
    expect(types).toEqual(["deposit", "deposit"]);

    const vaults = getAllByTestId("transaction-history-row-vault").map((n) => n.textContent);
    expect(vaults).toEqual([VAULT_A, VAULT_B]);

    const amounts = getAllByTestId("transaction-history-row-amount").map((n) => n.textContent);
    expect(amounts).toEqual(["1000000", "500000"]);
  });

  it("shows empty state when no events", async () => {
    const empty: AccountHistoryResponse = {
      address: WATCHED,
      events: [],
      block_number: 1000,
      indexed_at: "2026-05-10T00:00:00Z",
    };
    const { getByTestId, queryByTestId } = render(
      <TransactionHistory address={WATCHED} apiUrl="http://api" fetchImpl={makeFetch(empty)} />,
    );
    await waitFor(() => {
      expect(getByTestId("transaction-history-empty")).toBeTruthy();
    });
    expect(queryByTestId("transaction-history-table")).toBeNull();
  });

  it("surfaces a non-2xx API error as a visible message", async () => {
    const { getByTestId } = render(
      <TransactionHistory
        address={WATCHED}
        apiUrl="http://api"
        fetchImpl={makeFetch({}, false, 502)}
      />,
    );
    await waitFor(() => {
      expect(getByTestId("transaction-history-error").textContent).toContain("502");
    });
  });

  it("makes exactly one request to the history endpoint", async () => {
    const fetchImpl = makeFetch(historyFixture);
    render(<TransactionHistory address={WATCHED} apiUrl="http://api" fetchImpl={fetchImpl} />);
    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    const call = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    expect(call[0]).toBe(`http://api/v1/accounts/${WATCHED}/history`);
  });
});

// ─── AgentPoliciesPanel ─────────────────────────────────────────────────────

const AGENT_1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const AGENT_2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;

describe("AgentPoliciesPanel", () => {
  it("shows loading state", () => {
    const { getByTestId } = render(
      <AgentPoliciesPanel ownerAddress={WATCHED} policies={[]} loading={true} />,
    );
    expect(getByTestId("agent-policies-loading")).toBeTruthy();
  });

  it("shows error state", () => {
    const { getByTestId } = render(
      <AgentPoliciesPanel ownerAddress={WATCHED} policies={[]} error="RPC failed" />,
    );
    expect(getByTestId("agent-policies-error").textContent).toContain("RPC failed");
  });

  it("shows empty state when no policies", () => {
    const { getByTestId } = render(<AgentPoliciesPanel ownerAddress={WATCHED} policies={[]} />);
    expect(getByTestId("agent-policies-empty")).toBeTruthy();
  });

  it("renders one entry per policy", () => {
    const policies = [
      { agent: AGENT_1, authorized: true },
      { agent: AGENT_2, authorized: false },
    ];
    const { getAllByTestId } = render(
      <AgentPoliciesPanel ownerAddress={WATCHED} policies={policies} />,
    );
    const entries = getAllByTestId("agent-policy-entry");
    expect(entries).toHaveLength(2);
  });

  it("shows active/revoked status badges", () => {
    const policies = [
      { agent: AGENT_1, authorized: true },
      { agent: AGENT_2, authorized: false },
    ];
    const { getByTestId } = render(
      <AgentPoliciesPanel ownerAddress={WATCHED} policies={policies} />,
    );
    // Both status spans should be present.
    expect(getByTestId("agent-policy-status-active")).toBeTruthy();
    expect(getByTestId("agent-policy-status-revoked")).toBeTruthy();
  });

  it("shows withdrawal policy fields (assetRecipient, allowedSourceVaults) when set", () => {
    const policies = [
      {
        agent: AGENT_1,
        authorized: true,
        assetRecipient: "0xdeadbeef00000000000000000000000000000001",
        allowedSourceVaults: [VAULT_A, VAULT_B],
      },
    ];
    const { getByTestId, getAllByTestId } = render(
      <AgentPoliciesPanel ownerAddress={WATCHED} policies={policies} />,
    );
    expect(getByTestId("agent-policy-asset-recipient").textContent).toContain(
      "0xdeadbeef00000000000000000000000000000001",
    );
    const sourceVaults = getAllByTestId("agent-policy-source-vault");
    expect(sourceVaults).toHaveLength(2);
    expect(sourceVaults[0].textContent).toContain(VAULT_A);
    expect(sourceVaults[1].textContent).toContain(VAULT_B);
  });

  it("does not render withdrawal fields when not provided", () => {
    const policies = [{ agent: AGENT_1, authorized: true }];
    const { queryByTestId } = render(
      <AgentPoliciesPanel ownerAddress={WATCHED} policies={policies} />,
    );
    expect(queryByTestId("agent-policy-asset-recipient")).toBeNull();
    expect(queryByTestId("agent-policy-allowed-source-vaults")).toBeNull();
  });

  it("shows the owner address", () => {
    const { getByTestId } = render(<AgentPoliciesPanel ownerAddress={WATCHED} policies={[]} />);
    expect(getByTestId("agent-policies-owner").textContent).toContain(WATCHED);
  });

  // Issue #429: withdrawal-enabled warning + stale-allowance hygiene.
  // Drives the dapp test_plan bullet "user can identify and revoke an
  // unnecessary gateway share allowance" and the regression bullet
  // "deposit-only policies do not show withdrawal exposure as enabled".
  describe("withdrawal-exposure surfacing (issue #429)", () => {
    it("renders a high-visibility warning when withdrawals are enabled", () => {
      const policies = [
        {
          agent: AGENT_1,
          authorized: true,
          withdrawalsEnabled: true,
          maxWithdrawPerWindow: "10000",
          assetRecipient: "0xdeadbeef00000000000000000000000000000001",
        },
      ];
      const { getByTestId } = render(
        <AgentPoliciesPanel ownerAddress={WATCHED} policies={policies} />,
      );
      const warn = getByTestId("agent-policy-withdrawal-warning");
      expect(warn.textContent).toMatch(/WARNING/);
      expect(warn.textContent).toMatch(/withdrawals enabled/i);
      expect(getByTestId("agent-policy-withdrawal-warning-cap").textContent).toContain("10000");
      expect(warn.textContent).toContain("0xdeadbeef00000000000000000000000000000001");
    });

    it("does NOT render the withdrawal warning for deposit-only policies", () => {
      // Regression: a deposit-only policy with maxWithdrawPerWindow set
      // (but withdrawalsEnabled = false) must not advertise exposure.
      const policies = [
        {
          agent: AGENT_1,
          authorized: true,
          withdrawalsEnabled: false,
          maxWithdrawPerWindow: "0",
        },
      ];
      const { queryByTestId } = render(
        <AgentPoliciesPanel ownerAddress={WATCHED} policies={policies} />,
      );
      expect(queryByTestId("agent-policy-withdrawal-warning")).toBeNull();
      expect(queryByTestId("agent-policy-stale-allowance")).toBeNull();
    });

    it("flags a stale share allowance and renders a revoke affordance", () => {
      const onRevoke = vi.fn();
      const policies = [
        {
          agent: AGENT_1,
          authorized: true,
          withdrawalsEnabled: false,
          shareAllowance: "12345",
        },
      ];
      const { getByTestId } = render(
        <AgentPoliciesPanel
          ownerAddress={WATCHED}
          policies={policies}
          onRevokeShareAllowance={onRevoke}
        />,
      );
      const block = getByTestId("agent-policy-stale-allowance");
      expect(block).toBeTruthy();
      expect(getByTestId("agent-policy-stale-allowance-amount").textContent).toContain("12345");
      const btn = getByTestId("agent-policy-revoke-allowance") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      btn.click();
      expect(onRevoke).toHaveBeenCalledWith(AGENT_1);
    });

    it("renders the revoke button disabled when no callback is provided", () => {
      const policies = [
        {
          agent: AGENT_1,
          authorized: true,
          withdrawalsEnabled: false,
          shareAllowance: "1",
        },
      ];
      const { getByTestId } = render(
        <AgentPoliciesPanel ownerAddress={WATCHED} policies={policies} />,
      );
      const btn = getByTestId("agent-policy-revoke-allowance") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it("does not flag stale allowance when shareAllowance is zero", () => {
      const policies = [
        {
          agent: AGENT_1,
          authorized: true,
          withdrawalsEnabled: false,
          shareAllowance: "0",
        },
      ];
      const { queryByTestId } = render(
        <AgentPoliciesPanel ownerAddress={WATCHED} policies={policies} />,
      );
      expect(queryByTestId("agent-policy-stale-allowance")).toBeNull();
    });
  });
});
