/**
 * Issue 1796: a redeploy leaves two generations of one vault (rmPROTO) in the registry. A holder of both keeps two address-specific positions.
 * The selector must list both, keyed and selectable by vault address, never merged by name, so old shares stay redeemable at the retired address.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "./helpers/render";
import { PositionSelector } from "../../src/components/PositionSelector";
import { fetchPositions } from "../../src/lib/usePositions";

vi.mock("wagmi", () => ({
  useReadContracts: () => ({ data: undefined }),
  useAccount: () => ({ address: undefined, isConnected: false }),
  useSimulateContract: () => ({ data: undefined, error: null }),
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false, data: undefined }),
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isFetching: false, isSuccess: false }),
}));

const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const OLD_PROTO = "0x28C5ca4DF0107679bFcc9b0ad4c2f3F209b8f797";
const NEW_PROTO = "0x9999999999999999999999999999999999999999";
const API_URL = "http://localhost:8080";
const body = {
  positions: [
    { vault: OLD_PROTO, shares: "50000000" },
    { vault: NEW_PROTO, shares: "30000000" },
  ],
};

describe("two generations of one vault", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetchPositions keeps one row per vault address", async () => {
    const r = await fetchPositions(API_URL, ACCOUNT);
    expect(r.positions.map((p) => p.vault_addr)).toEqual([OLD_PROTO, NEW_PROTO]);
    expect(r.positions.map((p) => p.shares)).toEqual(["50000000", "30000000"]);
  });

  it("the selector lists both addresses and selects the retired one by its own address and balance", async () => {
    const onSelect = vi.fn();
    render(<PositionSelector account={ACCOUNT} explorerApiUrl={API_URL} onSelect={onSelect} />);
    await waitFor(() =>
      expect(screen.getByTestId(`position-option-${OLD_PROTO}`)).toBeInTheDocument(),
    );
    expect(screen.getByTestId(`position-option-${NEW_PROTO}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`position-option-${OLD_PROTO}`).querySelector("input")!);
    expect(onSelect).toHaveBeenCalledWith(OLD_PROTO, "50000000");
  });
});
