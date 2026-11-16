import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "./helpers/render";
import { OneVaultFlow, oneVaultConfig } from "../../src/components/OneVaultFlow";
import { pinnedWriteTarget } from "../../src/lib/codePins";

const QUEUE = "0x1111111111111111111111111111111111111111" as const;
const USER = "0x2222222222222222222222222222222222222222" as const;
const mock = vi.hoisted(() => ({
  send: vi.fn(),
  chain: 8453,
  fail: "",
  pending: false,
  receipt: "",
  logs: false,
  getLogs: vi.fn(),
}));
const client = { getBlockNumber: async () => 1n, getLogs: mock.getLogs };
vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: true, address: USER, chainId: mock.chain }),
  usePublicClient: () => (mock.logs ? client : undefined),
  useWaitForTransactionReceipt: () => ({
    data: mock.receipt ? { status: mock.receipt, blockNumber: 123n } : undefined,
  }),
  useReadContract: ({ functionName }: { functionName: string }) => {
    const reads: Record<string, unknown> = {
      asset: QUEUE,
      share: QUEUE,
      decimals: 6,
      allowance: 5000000n,
      creditOf: [7n, 0n],
      quoteDeposit: {
        feeBps: 10n,
        cancelCutoff: 1800000000n,
        earliestSettle: 1800003600n,
        holdEnds: 1800007200n,
        refBandBps: 90,
        legBandBps: 100,
      },
      liveness: {
        keeperConfigured: true,
        queuePausedNow: false,
        queuePausedUntil: 0n,
        depositsStoppedNow: false,
        windDownActive: false,
        cancelBuffer: 900,
        maxPause: 172800,
      },
      pendingDepositRequest: 2n,
      claimableDepositRequest: 3n,
      pendingRedeemRequest: 4n,
      claimableRedeemRequest: 5n,
    };
    return {
      data: reads[functionName],
      isError: mock.fail === functionName,
      isStale: mock.fail === `stale-${functionName}`,
      isFetching: false,
      isLoading: false,
    };
  },
}));
vi.mock("../../src/lib/useGuardedWriteContract", () => ({
  useGuardedWriteContract: () => ({
    writeContract: mock.send,
    isPending: mock.pending,
    data: mock.receipt ? "0x1234567890123456" : undefined,
    error: mock.fail === "write" ? new Error("rejected") : null,
  }),
}));

beforeEach(() => {
  mock.send.mockReset();
  mock.chain = 8453;
  mock.fail = "";
  mock.pending = false;
  mock.receipt = "";
  mock.logs = false;
  mock.getLogs.mockReset();
});
function setup() {
  render(<OneVaultFlow queue={QUEUE} chainId={8453} fromBlock={1n} />);
  fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: "1.25" } });
}

describe("one-vault", () => {
  it("encodes requests, selected cancellation, and oldest-first claims", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Request deposit" }));
    expect(mock.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        address: QUEUE,
        chainId: 8453,
        functionName: "requestDeposit",
        args: [1250000n, USER],
      }),
    );
    fireEvent.change(screen.getByLabelText("Request ID"), { target: { value: "42" } });
    expect(screen.getByText("0.000002 USDC")).toBeTruthy();
    expect(screen.getByText("0.000003 USDC")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel selected request" }));
    expect(mock.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ functionName: "cancel", args: [42n] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Withdraw credit" }));
    expect(mock.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ functionName: "withdrawCredit" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Claim deposit" }));
    expect(mock.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ functionName: "deposit", args: [1250000n, USER] }),
    );
    expect(screen.getByText(/oldest eligible/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "redeem" } });
    fireEvent.click(screen.getByRole("button", { name: "Request redeem" }));
    expect(mock.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ functionName: "requestRedeem", args: [1250000n, USER] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Claim redeem" }));
    expect(mock.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ functionName: "redeem", args: [1250000n, USER, USER] }),
    );
  });
  it("refuses wrong chain and failed quote", () => {
    mock.chain = 1;
    setup();
    expect(
      (screen.getByRole("button", { name: "Request deposit" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mock.send).not.toHaveBeenCalled();
  });
  it("refuses failed quotes and displays wallet rejection", () => {
    mock.fail = "quoteDeposit";
    setup();
    expect(
      (screen.getByRole("button", { name: "Request deposit" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("unavailable");
  });
  it("shows wallet pending", () => {
    mock.pending = true;
    setup();
    expect(screen.getByTestId("one-vault-write-status").textContent).toContain(
      "confirm in your wallet",
    );
  });
  it("refuses stale queue terms", () => {
    mock.fail = "stale-liveness";
    setup();
    expect(
      (screen.getByRole("button", { name: "Request deposit" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("stale");
  });
  it("shows rejected transactions", () => {
    mock.fail = "write";
    setup();
    expect(screen.getByTestId("one-vault-write-error").textContent).toContain("rejected");
  });
  it("shows confirmed transactions", () => {
    mock.receipt = "success";
    setup();
    expect(screen.getByTestId("one-vault-write-status").textContent).toContain("confirmed");
  });
  it("discovers the owner's request IDs from queue events", async () => {
    mock.logs = true;
    mock.getLogs.mockResolvedValueOnce([{ args: { requestId: 42n } }]).mockResolvedValueOnce([]);
    setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Request 42" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Request 42" }));
    expect((screen.getByLabelText("Request ID") as HTMLInputElement).value).toBe("42");
  });
  it("pins custody taking requests and validates configuration", () => {
    expect(pinnedWriteTarget({ address: QUEUE, functionName: "requestDeposit" })).toBe(QUEUE);
    expect(pinnedWriteTarget({ address: QUEUE, functionName: "requestRedeem" })).toBe(QUEUE);
    expect(
      oneVaultConfig({
        VITE_ONE_VAULT_QUEUE_ADDRESS: QUEUE,
        VITE_ONE_VAULT_CHAIN_ID: "8453",
        VITE_ONE_VAULT_DEPLOY_BLOCK: "1",
      }),
    ).toEqual({ queue: QUEUE, chainId: 8453, fromBlock: 1n });
    expect(oneVaultConfig({ VITE_ONE_VAULT_QUEUE_ADDRESS: QUEUE })).toBeUndefined();
  });
});
