/**
 * TimelockPanel unit tests — issue #647.
 *
 * Covers:
 *   - Loading state while RPC calls are in flight.
 *   - Error/missing-config state when timelockAddress is undefined.
 *   - Error state when RPC call fails.
 *   - Ready state: all six data fields rendered correctly:
 *       address, minDelay, proposers, cancellers, executorPolicy, pendingOps.
 *   - Open executor policy rendering.
 *   - Restricted executor policy with executor addresses.
 *   - Pending operations table with ETA and status.
 *   - No-pending-ops message when list is empty.
 *
 * wagmi hooks are mocked at the network boundary so tests run without a
 * live RPC. The pattern follows governance-panel.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "./helpers/render";
import type { Address } from "viem";
import { TimelockPanel } from "../../src/components/TimelockPanel";

// ─── Mock wagmi ───────────────────────────────────────────────────────────────

// useReadContracts is used for the scalar reads (minDelay, role hashes).
// usePublicClient provides getLogs and readContract for role members /
// pending ops.

const mockGetLogs = vi.fn();
const mockReadContract = vi.fn();

vi.mock("wagmi", () => ({
  useReadContracts: vi.fn(),
  // Return a stable object so the useEffect dep array doesn't fire on every render.
  usePublicClient: vi.fn(),
}));

import { useReadContracts, usePublicClient } from "wagmi";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TIMELOCK_ADDR = "0x1111111111111111111111111111111111111111" as Address;
const PROPOSER_ADDR = "0x2222222222222222222222222222222222222222" as Address;
const CANCELLER_ADDR = "0x3333333333333333333333333333333333333333" as Address;

const MIN_DELAY = 172800n; // 2 days

/** Stable clock value for deterministic tests. */
const FAKE_NOW = 1_700_000_000_000;

/** Scalar results: [minDelay, PROPOSER_ROLE hash, CANCELLER_ROLE hash, EXECUTOR_ROLE hash]. */
function makeScalars(minDelay: bigint = MIN_DELAY) {
  return [
    { status: "success", result: minDelay },
    {
      status: "success",
      result: "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1",
    },
    {
      status: "success",
      result: "0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783",
    },
    {
      status: "success",
      result: "0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63",
    },
  ];
}

/** Set up the mocks for the happy path. */
function setupHappyPath({
  minDelay = MIN_DELAY,
  proposers = [PROPOSER_ADDR],
  cancellers = [CANCELLER_ADDR],
  isOpenExecutor = true,
  pendingOps = [] as Array<{ id: `0x${string}`; ts: bigint }>,
} = {}) {
  (useReadContracts as ReturnType<typeof vi.fn>).mockReturnValue({
    data: makeScalars(minDelay),
    error: null,
  });

  // getLogs: return events for role members and scheduled ops.
  mockGetLogs.mockImplementation(
    async (params: { args?: { role?: string }; event?: { name?: string } }) => {
      const eventName = params.event?.name;

      if (eventName === "RoleGranted") {
        const role = params.args?.role;
        // PROPOSER_ROLE grants.
        if (role === "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1") {
          return proposers.map((addr) => ({ args: { role, account: addr } }));
        }
        // CANCELLER_ROLE grants.
        if (role === "0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783") {
          return cancellers.map((addr) => ({ args: { role, account: addr } }));
        }
        // EXECUTOR_ROLE grants (none for open policy).
        return [];
      }

      if (eventName === "RoleRevoked") {
        return [];
      }

      if (eventName === "CallScheduled") {
        return pendingOps.map((op) => ({ args: { id: op.id } }));
      }

      return [];
    },
  );

  // readContract: hasRole(EXECUTOR_ROLE, address(0)) → isOpenExecutor.
  // getTimestamp(id) → op.ts.
  mockReadContract.mockImplementation(
    async (params: { functionName?: string; args?: unknown[] }) => {
      if (params.functionName === "hasRole") {
        return isOpenExecutor;
      }
      if (params.functionName === "getTimestamp") {
        const id = (params.args as [`0x${string}`])[0];
        const op = pendingOps.find((o) => o.id === id);
        return op ? op.ts : 0n;
      }
      return null;
    },
  );
}

// ─── Test suite ───────────────────────────────────────────────────────────────

// Stable public client reference — same object across renders so the
// useEffect dep array doesn't re-fire on every render cycle.
const stablePublicClient = { getLogs: mockGetLogs, readContract: mockReadContract };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: return loading state (no data yet).
  (useReadContracts as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, error: null });
  (usePublicClient as ReturnType<typeof vi.fn>).mockReturnValue(stablePublicClient);
  mockGetLogs.mockResolvedValue([]);
  mockReadContract.mockResolvedValue(null);
});

describe("TimelockPanel — loading state", () => {
  it("shows loading indicator while scalars are pending", () => {
    (useReadContracts as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      error: null,
    });
    const { getByTestId } = render(
      <TimelockPanel timelockAddress={TIMELOCK_ADDR} now={FAKE_NOW} />,
    );
    expect(getByTestId("timelock-loading")).toBeTruthy();
  });
});

describe("TimelockPanel — error / missing-config state", () => {
  it("renders error when timelockAddress is undefined", async () => {
    (useReadContracts as ReturnType<typeof vi.fn>).mockReturnValue({ data: [], error: null });
    const { getByTestId } = render(<TimelockPanel now={FAKE_NOW} />);
    await waitFor(() => {
      expect(getByTestId("timelock-error")).toBeTruthy();
    });
    expect(getByTestId("timelock-error-message").textContent).toContain("VITE_TIMELOCK_ADDRESS");
  });

  it("renders error when useReadContracts returns an error", async () => {
    (useReadContracts as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      error: new Error("RPC connection refused"),
    });
    const { getByTestId } = render(
      <TimelockPanel timelockAddress={TIMELOCK_ADDR} now={FAKE_NOW} />,
    );
    await waitFor(() => {
      expect(getByTestId("timelock-error")).toBeTruthy();
    });
    expect(getByTestId("timelock-error-message").textContent).toContain("RPC");
  });

  it("renders error when minDelay call fails", async () => {
    (useReadContracts as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [
        { status: "failure", error: new Error("call failed") },
        { status: "success", result: "0xabc" },
        { status: "success", result: "0xabc" },
        { status: "success", result: "0xabc" },
      ],
      error: null,
    });
    const { getByTestId } = render(
      <TimelockPanel timelockAddress={TIMELOCK_ADDR} now={FAKE_NOW} />,
    );
    await waitFor(() => {
      expect(getByTestId("timelock-error")).toBeTruthy();
    });
    expect(getByTestId("timelock-error-message").textContent).toContain("minDelay");
  });
});

describe("TimelockPanel — ready state: all six data fields", () => {
  it("renders the contract address", async () => {
    setupHappyPath();
    const { getByTestId } = render(
      <TimelockPanel timelockAddress={TIMELOCK_ADDR} now={FAKE_NOW} />,
    );
    await waitFor(() => {
      expect(getByTestId("timelock-panel")).toBeTruthy();
    });
    expect(getByTestId("timelock-address").textContent).toContain(TIMELOCK_ADDR);
  });

  it("renders the minimum delay in seconds and human-readable form", async () => {
    setupHappyPath({ minDelay: 172800n }); // 2 days
    const { getByTestId } = render(
      <TimelockPanel timelockAddress={TIMELOCK_ADDR} now={FAKE_NOW} />,
    );
    await waitFor(() => {
      expect(getByTestId("timelock-panel")).toBeTruthy();
    });
    const delayEl = getByTestId("timelock-min-delay");
    expect(delayEl.textContent).toContain("172800");
    expect(delayEl.textContent).toContain("2d");
  });

  it("renders proposer addresses", async () => {
    setupHappyPath({ proposers: [PROPOSER_ADDR] });
    const { getByTestId } = render(
      <TimelockPanel timelockAddress={TIMELOCK_ADDR} now={FAKE_NOW} />,
    );
    await waitFor(() => {
      expect(getByTestId("timelock-panel")).toBeTruthy();
    });
    expect(getByTestId("timelock-proposers").textContent).toContain(PROPOSER_ADDR);
  });

  it("renders canceller addresses", async () => {
    setupHappyPath({ cancellers: [CANCELLER_ADDR] });
    const { getByTestId } = render(
      <TimelockPanel timelockAddress={TIMELOCK_ADDR} now={FAKE_NOW} />,
    );
    await waitFor(() => {
      expect(getByTestId("timelock-panel")).toBeTruthy();
    });
    expect(getByTestId("timelock-cancellers").textContent).toContain(CANCELLER_ADDR);
  });

  it("renders open executor policy", async () => {
    setupHappyPath({ isOpenExecutor: true });
    const { getByTestId } = render(
      <TimelockPanel timelockAddress={TIMELOCK_ADDR} now={FAKE_NOW} />,
    );
    await waitFor(() => {
      expect(getByTestId("timelock-panel")).toBeTruthy();
    });
    expect(getByTestId("timelock-executor-policy").textContent).toContain("Open");
    expect(getByTestId("timelock-executor-policy").textContent).toContain("address(0)");
  });

  it("renders restricted executor policy with executor addresses", async () => {
    const EXECUTOR_ADDR = "0x4444444444444444444444444444444444444444" as Address;
    setupHappyPath({ isOpenExecutor: false });

    // Override getLogs to also return EXECUTOR_ROLE grants for restricted policy.
    mockGetLogs.mockImplementation(
      async (params: { args?: { role?: string }; event?: { name?: string } }) => {
        const eventName = params.event?.name;
        if (eventName === "RoleGranted") {
          const role = params.args?.role;
          if (role === "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1") {
            return [{ args: { role, account: PROPOSER_ADDR } }];
          }
          if (role === "0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783") {
            return [{ args: { role, account: CANCELLER_ADDR } }];
          }
          // EXECUTOR_ROLE.
          if (role === "0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63") {
            return [{ args: { role, account: EXECUTOR_ADDR } }];
          }
          return [];
        }
        if (eventName === "RoleRevoked") return [];
        if (eventName === "CallScheduled") return [];
        return [];
      },
    );

    const { getByTestId } = render(
      <TimelockPanel timelockAddress={TIMELOCK_ADDR} now={FAKE_NOW} />,
    );
    await waitFor(() => {
      expect(getByTestId("timelock-panel")).toBeTruthy();
    });
    const policyEl = getByTestId("timelock-executor-policy");
    expect(policyEl.textContent).toContain("Restricted");
    expect(policyEl.textContent).toContain(EXECUTOR_ADDR);
  });

  it("shows no-pending-ops message when there are none", async () => {
    setupHappyPath({ pendingOps: [] });
    const { getByTestId } = render(
      <TimelockPanel timelockAddress={TIMELOCK_ADDR} now={FAKE_NOW} />,
    );
    await waitFor(() => {
      expect(getByTestId("timelock-panel")).toBeTruthy();
    });
    expect(getByTestId("timelock-no-pending-ops")).toBeTruthy();
  });

  it("renders pending operations with operation id, ETA, and status", async () => {
    const nowSecs = BigInt(Math.floor(FAKE_NOW / 1000));
    const futureTs = nowSecs + 3600n; // 1 hour in the future → "waiting"
    const pastTs = nowSecs - 60n; // 1 minute in the past → "ready"
    const OP_ID_1 =
      "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;
    const OP_ID_2 =
      "0x2222222222222222222222222222222222222222222222222222222222222222" as `0x${string}`;

    setupHappyPath({
      pendingOps: [
        { id: OP_ID_1, ts: futureTs },
        { id: OP_ID_2, ts: pastTs },
      ],
    });

    const { getByTestId } = render(
      <TimelockPanel timelockAddress={TIMELOCK_ADDR} now={FAKE_NOW} />,
    );
    await waitFor(() => {
      expect(getByTestId("timelock-pending-ops")).toBeTruthy();
    });

    const table = getByTestId("timelock-pending-ops");
    expect(table.textContent).toContain(OP_ID_1);
    expect(table.textContent).toContain(OP_ID_2);
    expect(table.textContent).toContain("Waiting for delay");
    expect(table.textContent).toContain("Ready to execute");
  });
});
