import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugPanel } from "../../src/components/DebugPanel";

const account = "0x1111111111111111111111111111111111111111" as const;

vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: account,
    connector: { name: "Injected" },
    isConnected: true,
    status: "connected",
  }),
  useBlockNumber: () => ({ data: 123n, error: null }),
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

function renderPanel() {
  return render(
    <DebugPanel
      open
      onClose={vi.fn()}
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

describe("DebugPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces chain, contract, wallet, and account state", () => {
    renderPanel();

    expect(screen.getByTestId("debug-dapp-version")).toHaveTextContent("0.1.0");
    expect(screen.getByTestId("debug-github-commit")).toHaveTextContent("test-commit");
    expect(screen.getByTestId("debug-env-class")).toHaveTextContent("devnet");
    expect(screen.getByTestId("debug-chain-id")).toHaveTextContent("918453");
    expect(screen.getByTestId("debug-block-number")).toHaveTextContent("123");
    expect(screen.getByTestId("debug-gateway-address")).toHaveTextContent("0x3333");
    expect(screen.getByTestId("debug-usdc-address")).toHaveTextContent("0x2222");
    expect(screen.getByTestId("debug-wallet-status")).toHaveTextContent("connected");
    expect(screen.getByTestId("connected-address")).toHaveTextContent(account);
    expect(screen.getByTestId("debug-registration-status")).toHaveTextContent("registered");
  });

  it("captures app console output while mounted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderPanel();

    await act(async () => {
      console.warn("operator warning", { code: "RPC" });
    });

    expect(screen.getByTestId("debug-log-list")).toHaveTextContent("operator warning");
    expect(screen.getByTestId("debug-log-list")).toHaveTextContent("RPC");
  });
});
