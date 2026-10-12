// Dapp issue 1760: rmAGENT deposits need a fresh V4 price recorder, and a stale one is refreshable by anyone.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  VENUE_V4,
  recordersOf,
  staleRecorders,
  PRICE_RECORDER_ABI,
} from "../../src/lib/priceRecorder";
import {
  depositsBlocked,
  depositStateLabel,
  headroomCell,
  resolveDepositState,
} from "../../src/lib/vaultDepositState";

// Deploy 2 recorder on Base 8453.
const RECORDER = "0x0aDc14e6521aF213F9DCe5585D530f237831E934";
const TOKEN = "0x1111111111111111111111111111111111111111";
const V3_POOL = "0x2222222222222222222222222222222222222222";

describe("recordersOf", () => {
  it("returns only active V4 assets, lower-cased and unique", () => {
    const rows = [
      [TOKEN, RECORDER, 3000, true, TOKEN, VENUE_V4] as const,
      [TOKEN, RECORDER, 3000, true, TOKEN, VENUE_V4] as const,
      [TOKEN, V3_POOL, 3000, true, TOKEN, 0] as const,
      [TOKEN, "0x3333333333333333333333333333333333333333", 3000, false, TOKEN, VENUE_V4] as const,
      undefined,
    ];
    expect(recordersOf(rows)).toEqual([RECORDER.toLowerCase()]);
  });
  it("reads the object form too", () => {
    expect(recordersOf([{ pool: RECORDER, active: true, venue: 1 }])).toEqual([
      RECORDER.toLowerCase(),
    ]);
  });
});

describe("staleRecorders", () => {
  it("is the recorders whose isFresh() is false; an unreadable one is not stale", () => {
    expect(staleRecorders(["a", "b", "c"], [false, true, undefined])).toEqual(["a"]);
  });
});

describe("stale-price deposit state", () => {
  const open = { registryStatus: 0, chainPaused: false };
  it("an open vault with a stale recorder is stale-price, blocked, not Active", () => {
    const s = resolveDepositState({ ...open, staleRecorders: [RECORDER] });
    expect(s).toEqual({ kind: "stale-price", recorders: [RECORDER] });
    expect(depositsBlocked(s)).toBe(true);
    expect(depositStateLabel(s)).not.toMatch(/Active/);
    expect(headroomCell("1000000", s)).toBe("n/a (deposits closed)");
  });
  it("a fresh recorder leaves the vault open", () => {
    expect(resolveDepositState({ ...open, staleRecorders: [] }).kind).toBe("open");
    expect(resolveDepositState(open).kind).toBe("open");
  });
  it("paused and retired win over a stale price", () => {
    expect(
      resolveDepositState({ registryStatus: 0, chainPaused: true, staleRecorders: [RECORDER] })
        .kind,
    ).toBe("paused");
    expect(resolveDepositState({ registryStatus: 2, staleRecorders: [RECORDER] }).kind).toBe(
      "retired",
    );
  });
});

const writeContract = vi.fn();
vi.mock("../../src/lib/useGuardedWriteContract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/useGuardedWriteContract")>()),
  useGuardedWriteContract: () => ({
    writeContract,
    data: undefined,
    isPending: false,
    error: null,
  }),
}));
vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useWaitForTransactionReceipt: () => ({ isSuccess: false, isFetching: false }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

describe("DepositsClosedNotice on a stale price", () => {
  beforeEach(() => writeContract.mockClear());

  it("says the price is stale and calls record() on the recorder when refreshed", async () => {
    const { DepositsClosedNotice } = await import("../../src/components/DepositsClosedNotice");
    render(
      <DepositsClosedNotice
        state={{ kind: "stale-price", recorders: [RECORDER] }}
        scope="This vault"
      />,
    );
    const notice = screen.getByTestId("deposits-closed-notice");
    expect(notice).toHaveAttribute("data-deposit-state", "stale-price");
    expect(notice.textContent).toMatch(
      /Price stale, deposits to this vault are unavailable until the price is refreshed/,
    );
    fireEvent.click(screen.getByTestId("refresh-price"));
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith({
      address: RECORDER,
      abi: PRICE_RECORDER_ABI,
      functionName: "record",
    });
  });

  it("shows no refresh button for other closed states", async () => {
    const { DepositsClosedNotice } = await import("../../src/components/DepositsClosedNotice");
    render(<DepositsClosedNotice state={{ kind: "paused", source: "chain" }} />);
    expect(screen.queryByTestId("refresh-price")).toBeNull();
  });
});
