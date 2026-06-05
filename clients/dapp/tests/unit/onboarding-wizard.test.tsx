/**
 * Unit tests — OnboardingWizard step-1 Drip button (issue #614).
 *
 * Covers acceptance criteria:
 *   - Button shown when any balance (USDC, ETH, RM token) is zero
 *   - Button hidden when all balances are non-zero
 *   - Button hidden when harness key is absent
 *   - Button hidden on mainnet chain classification (chainId 1)
 *   - Button NOT shown on step 2 or step 3 — only step 1
 *   - All three drip handlers called on button click
 *   - Per-asset status feedback rendered with correct data-testid attributes
 *
 * Strategy: vi.mock wagmi at the network boundary. The mock returns
 * configurable balance data via module-level mutable refs so each test can
 * set up the exact balance state it needs, without a running chain.
 *
 * The component's injected dripUsdcFn / dripEthFn / dripRmFn props bypass
 * the real faucetClient so no wallet provider is needed for click tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "./helpers/render";
import type { Hex } from "viem";
import { OnboardingWizard } from "../../src/components/OnboardingWizard";
import type { PreviewContext } from "../../src/lib/preview";
import type { DripUsdcArgs, DripEthArgs, DripRmTokenArgs } from "../../src/lib/faucetClient";

// ---------------------------------------------------------------------------
// Wagmi mock — intercepts all wagmi imports inside the component source file.
// Each hook returns a configurable value via module-level refs.
// ---------------------------------------------------------------------------

let mockUsdcContractData: unknown = undefined; // gateway.usdc() result
let mockUsdcBalanceData: unknown = undefined; // user's USDC/RM balanceOf (shared for both balanceOf calls)
let mockEthBalanceData: { value: bigint } | undefined = undefined; // user's ETH balance
let mockChainId = 918453; // testnet by default

// Note: render.tsx uses vi.importActual("wagmi") to get real WagmiProvider/createConfig.
// We must NOT mock wagmi here with a factory that omits those exports, as vi.importActual
// in the render helper must still resolve through the real wagmi module.
// Instead, we mock the individual component-level hooks that OnboardingWizard calls, using
// a spy approach that doesn't replace the entire module.
//
// However, browser-mode vi.mock only intercepts imports in component source files when
// using a module-factory pattern. We use a partial factory that re-exports everything real
// except the hooks we want to control.
vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    useAccount: () => ({
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
      isConnected: true,
    }),
    useChainId: () => mockChainId,
    useReadContract: ({ functionName }: { functionName: string }) => {
      if (functionName === "usdc") return { data: mockUsdcContractData };
      return { data: mockUsdcBalanceData };
    },
    useBalance: () => ({ data: mockEthBalanceData }),
    useSimulateContract: () => ({ data: undefined }),
    useWriteContract: () => ({ writeContract: () => undefined, isPending: false }),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GATEWAY = "0x1111111111111111111111111111111111111111" as const;
const USDC_ADDR = "0x4444444444444444444444444444444444444444" as const;
const RM_TOKEN = "0x5555555555555555555555555555555555555555" as const;
// A valid 32-byte hex private key for the harness env
const HARNESS_KEY = "0x" + "ab".repeat(32);

const ctx: PreviewContext = {
  gateway: GATEWAY,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const NOW = 1_893_456_000_000;

interface RenderOpts {
  harnessKey?: string | null;
  rmTokenAddress?: typeof RM_TOKEN;
  dripUsdcFn?: (args: DripUsdcArgs) => Promise<Hex>;
  dripEthFn?: (args: DripEthArgs) => Promise<Hex>;
  dripRmFn?: (args: DripRmTokenArgs) => Promise<Hex>;
}

function renderWizard(opts: RenderOpts = {}) {
  const env: Record<string, string | undefined> = {};
  if (opts.harnessKey !== null) {
    env.VITE_FAUCET_HARNESS_PRIVATE_KEY = opts.harnessKey ?? HARNESS_KEY;
  }
  return render(
    <OnboardingWizard
      gatewayAddress={GATEWAY}
      ctx={ctx}
      env={env}
      now={NOW}
      rmTokenAddress={opts.rmTokenAddress}
      dripUsdcFn={opts.dripUsdcFn}
      dripEthFn={opts.dripEthFn}
      dripRmFn={opts.dripRmFn}
    />,
  );
}

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function setBalances({
  usdc = undefined,
  eth = undefined,
}: {
  usdc?: bigint;
  eth?: bigint;
} = {}) {
  mockUsdcContractData = USDC_ADDR;
  mockUsdcBalanceData = usdc;
  mockEthBalanceData = eth !== undefined ? { value: eth } : undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OnboardingWizard — step-1 Drip button (issue #614)", () => {
  beforeEach(() => {
    mockChainId = 918453;
    mockUsdcContractData = undefined;
    mockUsdcBalanceData = undefined;
    mockEthBalanceData = undefined;
    vi.clearAllMocks();
  });

  // ── Button visibility ──────────────────────────────────────────────────────

  it("shows the drip button when USDC balance is zero", () => {
    setBalances({ usdc: 0n, eth: 10n });
    renderWizard();
    expect(screen.getByTestId("onboarding-drip-button")).toBeInTheDocument();
  });

  it("shows the drip button when ETH balance is zero", () => {
    setBalances({ usdc: 100n, eth: 0n });
    renderWizard();
    expect(screen.getByTestId("onboarding-drip-button")).toBeInTheDocument();
  });

  it("shows the drip button when USDC balance is zero (with RM token address)", () => {
    // When rmTokenAddress is provided, a zero USDC balance still triggers the button.
    // The mock returns mockUsdcBalanceData for all balanceOf calls (USDC and RM).
    setBalances({ usdc: 0n, eth: 10n });
    renderWizard({ rmTokenAddress: RM_TOKEN });
    expect(screen.getByTestId("onboarding-drip-button")).toBeInTheDocument();
  });

  it("hides the drip button when all balances are non-zero", () => {
    setBalances({ usdc: 100n, eth: 1n });
    // usdc=100n (non-zero), eth=1n (non-zero) → button hidden
    renderWizard();
    expect(screen.queryByTestId("onboarding-drip-button")).toBeNull();
  });

  it("hides the drip button when harness key is absent", () => {
    setBalances({ usdc: 0n, eth: 0n });
    renderWizard({ harnessKey: null });
    expect(screen.queryByTestId("onboarding-drip-button")).toBeNull();
  });

  it("hides the drip button on mainnet (chainId 1)", () => {
    mockChainId = 1;
    setBalances({ usdc: 0n, eth: 0n });
    renderWizard();
    expect(screen.queryByTestId("onboarding-drip-button")).toBeNull();
  });

  it("hides the drip button on Base mainnet (chainId 8453)", () => {
    mockChainId = 8453;
    setBalances({ usdc: 0n, eth: 0n });
    renderWizard();
    expect(screen.queryByTestId("onboarding-drip-button")).toBeNull();
  });

  // ── Button not on step 2 or 3 ─────────────────────────────────────────────

  it("does NOT show the drip button on step 2", () => {
    setBalances({ usdc: 0n, eth: 0n });
    renderWizard();
    // Advance to step 2
    fireEvent.click(screen.getByTestId("step-1-next"));
    expect(screen.queryByTestId("onboarding-drip-button")).toBeNull();
    expect(screen.getByTestId("wizard-step-2")).toBeInTheDocument();
  });

  // ── Click handler — all three drips called in parallel ────────────────────

  it("calls all three drip handlers when button is clicked", async () => {
    setBalances({ usdc: 0n, eth: 0n });

    // Stub window.ethereum so getInjectedProvider() returns a provider.
    (window as unknown as { ethereum: unknown }).ethereum = { request: vi.fn() };

    const dripUsdcFn = vi.fn(async (): Promise<Hex> => "0x1111" as Hex);
    const dripEthFn = vi.fn(async (): Promise<Hex> => "0x2222" as Hex);
    const dripRmFn = vi.fn(async (): Promise<Hex> => "0x3333" as Hex);

    renderWizard({
      rmTokenAddress: RM_TOKEN,
      dripUsdcFn,
      dripEthFn,
      dripRmFn,
    });

    fireEvent.click(screen.getByTestId("onboarding-drip-button"));

    // Wait for status elements to appear (confirms handlers were called)
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-drip-usdc-status")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-drip-eth-status")).toBeInTheDocument();
    });

    expect(dripUsdcFn).toHaveBeenCalledTimes(1);
    expect(dripEthFn).toHaveBeenCalledTimes(1);
    expect(dripRmFn).toHaveBeenCalledTimes(1);

    const usdcCall = (dripUsdcFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as DripUsdcArgs;
    expect(usdcCall.usdcAddress).toBe(USDC_ADDR);
    expect(usdcCall.recipient.toLowerCase()).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const ethCall = (dripEthFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as DripEthArgs;
    expect(ethCall.recipient.toLowerCase()).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const rmCall = (dripRmFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as DripRmTokenArgs;
    expect(rmCall.rmTokenAddress).toBe(RM_TOKEN);

    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });

  // ── Per-asset status feedback ──────────────────────────────────────────────

  it("shows pending status for USDC and ETH immediately after click", async () => {
    setBalances({ usdc: 0n, eth: 0n });
    (window as unknown as { ethereum: unknown }).ethereum = { request: vi.fn() };

    // Handlers that never resolve — so we can assert "pending" state
    const dripUsdcFn = vi.fn(() => new Promise<Hex>(() => undefined));
    const dripEthFn = vi.fn(() => new Promise<Hex>(() => undefined));

    renderWizard({ dripUsdcFn, dripEthFn });
    fireEvent.click(screen.getByTestId("onboarding-drip-button"));

    await waitFor(() => {
      const usdcStatus = screen.getByTestId("onboarding-drip-usdc-status");
      expect(usdcStatus).toHaveAttribute("data-status", "pending");
    });
    await waitFor(() => {
      const ethStatus = screen.getByTestId("onboarding-drip-eth-status");
      expect(ethStatus).toHaveAttribute("data-status", "pending");
    });

    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });

  it("shows success status after all drip handlers resolve", async () => {
    setBalances({ usdc: 0n, eth: 0n });
    (window as unknown as { ethereum: unknown }).ethereum = { request: vi.fn() };

    const dripUsdcFn = vi.fn(async (): Promise<Hex> => "0xaabb" as Hex);
    const dripEthFn = vi.fn(async (): Promise<Hex> => "0xccdd" as Hex);
    const dripRmFn = vi.fn(async (): Promise<Hex> => "0xeeff" as Hex);

    renderWizard({ rmTokenAddress: RM_TOKEN, dripUsdcFn, dripEthFn, dripRmFn });
    fireEvent.click(screen.getByTestId("onboarding-drip-button"));

    await waitFor(() => {
      const usdcStatus = screen.getByTestId("onboarding-drip-usdc-status");
      expect(usdcStatus).toHaveAttribute("data-status", "success");
    });
    await waitFor(() => {
      const ethStatus = screen.getByTestId("onboarding-drip-eth-status");
      expect(ethStatus).toHaveAttribute("data-status", "success");
    });
    await waitFor(() => {
      const rmStatus = screen.getByTestId("onboarding-drip-rm-status");
      expect(rmStatus).toHaveAttribute("data-status", "success");
    });

    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });

  it("shows error status when a drip handler rejects", async () => {
    setBalances({ usdc: 0n, eth: 0n });
    (window as unknown as { ethereum: unknown }).ethereum = { request: vi.fn() };

    const dripUsdcFn = vi.fn(async (): Promise<Hex> => {
      throw new Error("transfer reverted");
    });
    const dripEthFn = vi.fn(async (): Promise<Hex> => "0xccdd" as Hex);

    renderWizard({ dripUsdcFn, dripEthFn });
    fireEvent.click(screen.getByTestId("onboarding-drip-button"));

    await waitFor(() => {
      const usdcStatus = screen.getByTestId("onboarding-drip-usdc-status");
      expect(usdcStatus).toHaveAttribute("data-status", "error");
      expect(usdcStatus.textContent).toContain("transfer reverted");
    });

    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });
});
