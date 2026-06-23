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
import { render, screen, fireEvent, waitFor } from "./helpers/render";
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
  // Field name `vault` mirrors the real explorer-api shape
  // (clients/explorer-api/src/model.rs `VaultPosition.vault`) — NOT
  // `vault_addr`. `fetchPositions` maps `vault` → `vault_addr`. Issue #1038:
  // a prior blind cast left `vault_addr` undefined and crashed the render.
  const mockPositions = [
    { vault: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", shares: "10.000000" },
    { vault: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", shares: "5.500000" },
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
    expect(onSelect).toHaveBeenCalledWith(mockPositions[0].vault, mockPositions[0].shares);
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

describe("PositionSelector — explorer-api `vault` shape (issue #1038 regression)", () => {
  // The exact non-zero position payload the explorer-api serves
  // (clients/explorer-api/src/model.rs `VaultPosition`): the address field is
  // `vault` (NOT `vault_addr`), plus `usdc_value`/`block_number`/`indexed_at`
  // and no `vault_name`. Captured from the failing router-deposit.spec trace.
  // Before the fix, `fetchPositions` cast this body straight to the dapp shape,
  // leaving `vault_addr` undefined; the first non-zero row then crashed the
  // render map at `p.vault_addr.toLowerCase()`.
  const apiPositions = [
    {
      vault: "0x17435cce3d1b4fa2e5f8a08ed921d57c6762a180",
      shares: "1000000000000000000000000000",
      usdc_value: "1000000835",
      block_number: 24,
      indexed_at: "2026-06-23T01:58:26.008525Z",
    },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ positions: apiPositions }),
        }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the position without throwing on undefined vault address", async () => {
    // The crash was a synchronous TypeError during render; if it regresses,
    // RTL surfaces it as a rejected render and this waitFor never resolves.
    render(<PositionSelector account={ACCOUNT} explorerApiUrl={API_URL} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("position-selector")).toBeInTheDocument());
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("calls onSelect with the mapped `vault` address on click", async () => {
    const onSelect = vi.fn();
    render(<PositionSelector account={ACCOUNT} explorerApiUrl={API_URL} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByTestId("position-selector")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("radio")[0]);
    expect(onSelect).toHaveBeenCalledWith(apiPositions[0].vault, apiPositions[0].shares);
  });
});

describe("PositionSelector — malformed positions (missing address)", () => {
  // Defence in depth: even if a row somehow lacks a vault address, the
  // component must not crash — it should simply omit that row.
  const malformed = [
    { shares: "5.000000" },
    { vault: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", shares: "2.000000" },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ positions: malformed }),
        }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits address-less rows and renders the valid one without throwing", async () => {
    render(<PositionSelector account={ACCOUNT} explorerApiUrl={API_URL} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("position-selector")).toBeInTheDocument());
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });
});

describe("PositionSelector — zero-balance filtering", () => {
  const mixedPositions = [
    { vault: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", shares: "0.000000" },
    { vault: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", shares: "3.000000" },
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
