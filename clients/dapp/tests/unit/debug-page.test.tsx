import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebugPage } from "../../src/components/DebugPage";
import { clearCapturedEntries, initErrorCapture } from "../../src/lib/error-capture";

vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: "0x1111111111111111111111111111111111111111",
    connector: { name: "Injected" },
    isConnected: true,
    status: "connected",
  }),
  useBlockNumber: () => ({ data: 456n, error: null }),
  useChainId: () => 918453,
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useReadContract: ({ functionName }: { functionName: string }) => {
    if (functionName === "paused") return { data: false, error: null };
    if (functionName === "usdc") {
      return { data: "0x2222222222222222222222222222222222222222", error: null };
    }
    return { data: undefined, error: null };
  },
}));

vi.mock("../../src/lib/useVaultRegistration", () => ({
  useAgentRegistration: () => "registered",
}));

function renderPage() {
  return render(
    <DebugPage
      gatewayAddress="0x3333333333333333333333333333333333333333"
      vaultAddress="0x4444444444444444444444444444444444444444"
      registryAddress="0x5555555555555555555555555555555555555555"
      routerAddress="0x6666666666666666666666666666666666666666"
      envClass="devnet"
      explorerApiUrl="http://explorer.test"
      expectedCodeHash="0xabc"
      forkBlock="123456"
      forkTimestamp="2026-05-15T00:00:00Z"
      verificationState={{ status: "verified", computedHash: "0xabc" }}
    />,
  );
}

describe("DebugPage (/debug route)", () => {
  let cleanup: () => void;

  beforeEach(() => {
    clearCapturedEntries();
    cleanup = initErrorCapture();
  });

  afterEach(() => {
    cleanup();
    clearCapturedEntries();
    vi.restoreAllMocks();
  });

  it("renders without crashing and shows build info", () => {
    renderPage();
    expect(screen.getByTestId("debug-page")).toBeDefined();
    expect(screen.getByTestId("debug-dapp-version")).toHaveTextContent("0.1.0");
    expect(screen.getByTestId("debug-github-commit")).toHaveTextContent("test-commit");
    expect(screen.getByTestId("debug-env-class")).toHaveTextContent("devnet");
  });

  it("shows existing chain and contract state", () => {
    renderPage();
    expect(screen.getByTestId("debug-chain-id")).toHaveTextContent("918453");
    expect(screen.getByTestId("debug-block-number")).toHaveTextContent("456");
    expect(screen.getByTestId("debug-gateway-address")).toHaveTextContent("0x3333");
    expect(screen.getByTestId("debug-usdc-address")).toHaveTextContent("0x2222");
  });

  it("live feed shows entries after a captured error", async () => {
    renderPage();

    // Initially no entries.
    expect(screen.getByTestId("debug-logs-empty")).toBeDefined();

    await act(async () => {
      console.error("debug page test error");
    });

    expect(screen.getByTestId("debug-log-list")).toHaveTextContent("debug page test error");
    expect(screen.queryByTestId("debug-logs-empty")).toBeNull();
  });

  it("live feed shows entries after a captured warning", async () => {
    renderPage();

    await act(async () => {
      console.warn("debug page test warning");
    });

    expect(screen.getByTestId("debug-log-list")).toHaveTextContent("debug page test warning");
  });
});
