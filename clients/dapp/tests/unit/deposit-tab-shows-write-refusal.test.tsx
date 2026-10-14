// QA plan U5 (finding DR-9, issue 1737 parts 1 and 4): a write the guard refuses, a wallet error and a
// transaction that reverted on chain are each SHOWN on the deposit tabs, instead of a button that seems to
// do nothing. The guard runs for real here (`useGuardedWriteContract` with the mainnet class and a fake
// wallet provider); only wagmi's hooks are replaced at the network boundary.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "./helpers/render";
import { keccak256, type Address } from "viem";
import { DepositWithdrawTab } from "../../src/components/DepositWithdrawTab";
import { RouterDepositTab } from "../../src/components/RouterDepositTab";
import { RuntimeConfigProvider } from "../../src/lib/RuntimeConfigContext";
import { VAULT_CODE_HASH_PIN_KEY } from "../../src/lib/codePins";

const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x2222222222222222222222222222222222222222" as Address;
const ROUTER = "0x3333333333333333333333333333333333333333" as Address;
const USER = "0x4444444444444444444444444444444444444444" as Address;
const CODE = "0x6001" as const;
const ctx = {
  gateway: USDC,
  vault: VAULT,
  router: ROUTER,
  gatewayCodeHashVerified: true,
  envClass: "mainnet" as const,
};

const writeContract = vi.fn();
const getCodeCalls: string[] = [];

/** What the wagmi boundary answers. Each test sets what it needs. */
const net = vi.hoisted(() => ({
  chainId: undefined as number | undefined,
  walletError: null as Error | null,
  hash: undefined as `0x${string}` | undefined,
  receipt: undefined as { status: string; blockNumber: bigint } | undefined,
}));

interface ContractOptions {
  address: Address;
  account?: Address;
  abi?: unknown;
  functionName: string;
  args?: readonly unknown[];
  query?: { enabled?: boolean };
}

const provider = {
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_getCode") {
      getCodeCalls.push(String(params?.[0]));
      return CODE;
    }
    throw new Error(`unexpected wallet call ${method}`);
  },
};

vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: USER,
    isConnected: true,
    chainId: net.chainId,
    connector: { getProvider: async () => provider },
  }),
  useReadContract: (opts: ContractOptions) => {
    let data: unknown;
    switch (opts.functionName) {
      case "allowance":
      case "balanceOf":
        data = 10_000_000n;
        break;
      case "getEffectiveWeights":
        data = [[VAULT], [10_000n]];
        break;
      case "previewDeposit":
        data =
          opts.address === ROUTER
            ? [
                {
                  vault: VAULT,
                  weightBps: 10_000n,
                  legAmount: 1_000_000n,
                  estShares: 1_000_000n,
                  unavailable: false,
                },
              ]
            : 1_000_000n;
        break;
    }
    return { data, refetch: vi.fn(), error: null };
  },
  useReadContracts: (opts: { contracts: ContractOptions[] }) => ({
    data: opts.contracts.map((c) => ({
      status: "success",
      result: c.functionName === "depositsPaused" ? false : 0n,
    })),
    refetch: vi.fn(),
  }),
  useSimulateContract: (opts: ContractOptions) => ({
    data: opts.query?.enabled
      ? {
          request: {
            account: opts.account,
            address: opts.address,
            abi: opts.abi,
            functionName: opts.functionName,
            args: opts.args,
          },
        }
      : undefined,
    error: null,
  }),
  useWriteContract: () => ({
    writeContract,
    writeContractAsync: vi.fn(),
    isPending: false,
    data: net.hash,
    error: net.walletError,
  }),
  useWaitForTransactionReceipt: (opts: { hash?: string }) => ({
    data: opts.hash ? net.receipt : undefined,
    isFetching: false,
    isSuccess: net.receipt?.status === "success",
    error: null,
  }),
}));

function renderDeposit(env: Record<string, string>) {
  render(
    <RuntimeConfigProvider config={env}>
      <DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />
    </RuntimeConfigProvider>,
  );
  fireEvent.change(screen.getByTestId("deposit-amount"), { target: { value: "1" } });
  const submit = screen.getByTestId("deposit-submit");
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
}

const MAINNET = { VITE_ENV_CLASS: "mainnet" };
const pinned = (hash: string) => ({
  ...MAINNET,
  [VAULT_CODE_HASH_PIN_KEY]: JSON.stringify({ [VAULT]: hash }),
});

describe("DepositWithdrawTab shows why a deposit was not sent", () => {
  beforeEach(() => {
    writeContract.mockClear();
    getCodeCalls.length = 0;
    net.chainId = 8453;
    net.walletError = null;
    net.hash = undefined;
    net.receipt = undefined;
  });

  it("shows the guard's refusal when the vault has no code-hash pin, and never calls the wallet", async () => {
    renderDeposit(MAINNET);
    const shown = await screen.findByTestId("deposit-write-error");
    expect(shown).toHaveTextContent("Deposit not sent");
    expect(shown).toHaveTextContent("no build-time code-hash pin");
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("shows the refusal when the vault's code does not match its pin", async () => {
    renderDeposit(pinned(`0x${"ab".repeat(32)}`));
    const shown = await screen.findByTestId("deposit-write-error");
    expect(shown).toHaveTextContent("not the pinned hash");
    expect(getCodeCalls.map((a) => a.toLowerCase())).toContain(VAULT.toLowerCase());
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("sends the deposit, pinned to Base, when the vault's code matches its pin", async () => {
    renderDeposit(pinned(keccak256(CODE)));
    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(1));
    const [request] = writeContract.mock.calls[0];
    expect(request.address).toBe(VAULT);
    expect(request.functionName).toBe("deposit");
    expect(request.chainId).toBe(8453);
    expect(screen.queryByTestId("deposit-write-error")).toBeNull();
  });

  it("shows a wallet error in one line", () => {
    net.chainId = undefined;
    net.walletError = Object.assign(new Error("long viem details\nversion: viem@2"), {
      shortMessage: "User rejected the request.",
    });
    render(<DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />);
    expect(screen.getByTestId("deposit-write-error")).toHaveTextContent(
      "Deposit not sent: User rejected the request.",
    );
    expect(screen.getByTestId("withdraw-write-error")).toHaveTextContent("Withdraw not sent");
  });

  it("shows a transaction that reverted on chain, with its block", () => {
    net.chainId = undefined;
    net.hash = `0x${"cd".repeat(32)}`;
    net.receipt = { status: "reverted", blockNumber: 42n };
    render(<DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />);
    expect(screen.getByTestId("deposit-write-reverted")).toHaveTextContent(
      "Deposit reverted on chain in block 42",
    );
  });

  it("shows a mined deposit as confirmed, and a sent one as waiting", () => {
    net.chainId = undefined;
    net.hash = `0x${"cd".repeat(32)}`;
    net.receipt = { status: "success", blockNumber: 7n };
    const { unmount } = render(
      <DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />,
    );
    expect(screen.getByTestId("deposit-write-status")).toHaveTextContent(
      "Deposit confirmed in block 7",
    );
    unmount();
    net.receipt = undefined;
    render(<DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />);
    expect(screen.getByTestId("deposit-write-status")).toHaveTextContent(
      "Waiting for confirmation",
    );
  });

  it("renders nothing while every write is idle", () => {
    net.chainId = undefined;
    render(<DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />);
    expect(screen.queryByTestId("deposit-write-error")).toBeNull();
    expect(screen.queryByTestId("deposit-write-status")).toBeNull();
    expect(screen.queryByTestId("withdraw-write-status")).toBeNull();
  });
});

describe("RouterDepositTab shows why a router deposit was not sent", () => {
  beforeEach(() => {
    writeContract.mockClear();
    net.chainId = 8453;
    net.walletError = null;
    net.hash = undefined;
    net.receipt = undefined;
  });

  it("shows the guard's refusal when the router has no code-hash pin, and never calls the wallet", async () => {
    render(
      <RuntimeConfigProvider config={{ ...MAINNET, VITE_ROUTER_ADDRESS: ROUTER }}>
        <RouterDepositTab routerAddress={ROUTER} usdcAddress={USDC} ctx={ctx} />
      </RuntimeConfigProvider>,
    );
    fireEvent.change(screen.getByTestId("router-deposit-tab-amount"), { target: { value: "1" } });
    const submit = screen.getByTestId("router-deposit-tab-submit");
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    const shown = await screen.findByTestId("router-deposit-tab-deposit-write-error");
    expect(shown).toHaveTextContent("Router deposit not sent");
    expect(shown).toHaveTextContent("no build-time code-hash pin");
    expect(writeContract).not.toHaveBeenCalled();
  });
});
