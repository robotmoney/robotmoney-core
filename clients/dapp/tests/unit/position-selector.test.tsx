/**
 * suite-09: RTL unit tests — PositionSelector component and withdrawal
 * preview rendering (issue #321).
 *
 * Tests:
 *   - PositionSelector renders loading state while the API is in flight.
 *   - PositionSelector renders empty state when no positions are returned.
 *   - PositionSelector renders non-zero positions and calls onSelect on click.
 *   - PositionSelector filters out zero-balance positions.
 *   - PositionSelector renders an error when the API call fails.
 *   - DepositWithdrawTab shows insufficient-balance error before signing.
 *   - DepositWithdrawTab hides signing prompt when balance is exceeded.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PositionSelector } from "../../src/components/PositionSelector";
import { DepositWithdrawTab } from "../../src/components/DepositWithdrawTab";
import type { VaultPreviewContext } from "../../src/lib/vaultPreview";

// ---- wagmi mock (disconnected state, no chain data) ----
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useSimulateContract: () => ({ data: undefined, error: null }),
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false, data: undefined }),
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isFetching: false, isSuccess: false }),
}));

const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDC = "0x4444444444444444444444444444444444444444" as const;
const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const API_URL = "http://localhost:8080";

const ctx: VaultPreviewContext = {
  gateway: "0x3333333333333333333333333333333333333333",
  vault: VAULT,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

// ---- PositionSelector tests ----

describe("PositionSelector — loading state", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Return a never-resolving promise to keep the loading state.
    fetchSpy = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows loading while the API call is in flight", () => {
    render(<PositionSelector account={ACCOUNT} explorerApiUrl={API_URL} onSelect={vi.fn()} />);
    expect(screen.getByTestId("position-selector-loading")).toBeInTheDocument();
  });
});

describe("PositionSelector — empty positions", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ positions: [] }),
        }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows empty state when no positions are returned", async () => {
    render(<PositionSelector account={ACCOUNT} explorerApiUrl={API_URL} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("position-selector-empty")).toBeInTheDocument());
  });
});

describe("PositionSelector — non-zero positions", () => {
  const mockPositions = [
    { vault_addr: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", shares: "10.000000" },
    { vault_addr: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", shares: "5.500000" },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ positions: mockPositions }),
        }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a radio button for each non-zero position", async () => {
    render(<PositionSelector account={ACCOUNT} explorerApiUrl={API_URL} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("position-selector")).toBeInTheDocument());
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
  });

  it("calls onSelect with vault address and shares when a position is clicked", async () => {
    const onSelect = vi.fn();
    render(<PositionSelector account={ACCOUNT} explorerApiUrl={API_URL} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByTestId("position-selector")).toBeInTheDocument());
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[0]);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(mockPositions[0].vault_addr, mockPositions[0].shares);
  });

  it("marks the selectedVault radio as checked", async () => {
    render(
      <PositionSelector
        account={ACCOUNT}
        explorerApiUrl={API_URL}
        onSelect={vi.fn()}
        selectedVault={"0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as `0x${string}`}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("position-selector")).toBeInTheDocument());
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
  });
});

describe("PositionSelector — zero-balance filtering", () => {
  const mixedPositions = [
    { vault_addr: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", shares: "0.000000" },
    { vault_addr: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", shares: "3.000000" },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ positions: mixedPositions }),
        }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits positions with zero shares", async () => {
    render(<PositionSelector account={ACCOUNT} explorerApiUrl={API_URL} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("position-selector")).toBeInTheDocument());
    // Only the non-zero position should appear.
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(1);
  });
});

describe("PositionSelector — API error", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an error message when the API call fails", async () => {
    render(<PositionSelector account={ACCOUNT} explorerApiUrl={API_URL} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("position-selector-error")).toBeInTheDocument());
    expect(screen.getByTestId("position-selector-error")).toHaveTextContent("positions API 500");
  });
});

// ---- DepositWithdrawTab insufficient-balance tests ----
// These tests override the wagmi mock to simulate a connected user with a
// known on-chain share balance, verifying the insufficient-balance guard.

describe("DepositWithdrawTab — insufficient balance guard (wagmi-connected mock)", () => {
  beforeEach(() => {
    // Override the top-level wagmi mock with a connected version that
    // returns a known shareBalance.
    vi.mock("wagmi", () => ({
      useAccount: () => ({
        address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        isConnected: true,
      }),
      useSimulateContract: () => ({ data: undefined, error: null }),
      useWriteContract: () => ({ writeContract: vi.fn(), isPending: false, data: undefined }),
      useReadContract: (args: { functionName?: string }) => {
        // shareBalance for the selected vault
        if (args?.functionName === "balanceOf") {
          return { data: 1_000_000n, refetch: vi.fn() }; // 1.000000 rmUSDC
        }
        return { data: undefined, refetch: vi.fn() };
      },
      useWaitForTransactionReceipt: () => ({ isFetching: false, isSuccess: false }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows insufficient-balance warning when shares input exceeds on-chain balance", async () => {
    render(<DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />);
    // Enter 2 rmUSDC but balance is 1 rmUSDC — should trigger the guard.
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "2" } });
    await waitFor(() =>
      expect(screen.getByTestId("withdraw-insufficient-balance")).toBeInTheDocument(),
    );
  });

  it("withdraw submit is disabled when balance is exceeded", async () => {
    render(<DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />);
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "2" } });
    await waitFor(() => expect(screen.getByTestId("withdraw-submit")).toBeDisabled());
  });
});
